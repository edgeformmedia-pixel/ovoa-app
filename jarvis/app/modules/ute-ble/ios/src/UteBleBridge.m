#import "UteBleBridge.h"
#import <UTEBluetoothRYApi/UTEBluetoothRYApi.h>
#import <UTEBluetoothRYApi/UTEDeviceMgr.h>
#import <UTEBluetoothRYApi/UTERecordMgr.h>

static NSString *UteString(NSString *_Nullable value) {
  return value ?: @"";
}

@interface UteBleBridge () <UTEBluetoothDelegate>
// connectDevice: wants the scanned UTEModelDevice back, so scan results are kept by identifier.
@property (nonatomic, strong) NSMutableDictionary<NSString *, UTEModelDevice *> *discovered;
@property (nonatomic, assign) BOOL recordListenersRegistered;
@property (nonatomic, assign) BOOL connecting;
@end

@implementation UteBleBridge

+ (UteBleBridge *)shared {
  static UteBleBridge *instance;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    instance = [UteBleBridge new];
  });
  return instance;
}

- (instancetype)init {
  if ((self = [super init])) {
    _discovered = [NSMutableDictionary new];
  }
  return self;
}

- (UTEBluetoothMgr *)mgr {
  return [UTEBluetoothMgr sharedInstance];
}

- (UTERecordMgr *)recordMgr {
  return [UTEDeviceMgr sharedInstance].recordMgr;
}

#pragma mark - Connection

- (NSString *)setUp {
  UTEBluetoothMgr *mgr = [self mgr];
  [mgr initUTEMgr];
  // The manager holds its delegate weakly; this singleton keeps itself alive.
  mgr.delegate = self;
  __weak UteBleBridge *weakSelf = self;
  // The clip asks the user to confirm pairing (it buzzes) and reports the answer here.
  [[UTEDeviceMgr sharedInstance].accountTool onNotifyAppPair:^(BOOL pair) {
    [weakSelf reportPairing:pair message:pair ? @"device confirmed pairing" : @"device cancelled pairing"];
  }];
  [self registerRecordListeners];
  return UteString([mgr sdkVersion]);
}

- (void)startScan {
  // Keep earlier results: a retry may reconnect to a device found by a previous scan.
  [[self mgr] startScanDevices];
}

- (void)stopScan {
  [[self mgr] stopScanDevices];
}

- (BOOL)connectDeviceWithId:(NSString *)deviceId {
  UTEModelDevice *model = self.discovered[deviceId];
  if (!model) return NO;
  self.connecting = YES;
  UTEModelDevice *stale = [self mgr].connnectModel;
  if (stale) [[self mgr] disconnectDevices:stale];
  [[self mgr] stopScanDevices];
  // The vendor demo waits 0.5 s between stopping the scan (or a disconnect) and connecting.
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    [[self mgr] connectDevice:model];
  });
  return YES;
}

- (BOOL)disconnectDevice {
  UTEModelDevice *model = [self mgr].connnectModel;
  if (!model) return NO;
  return [[self mgr] disconnectDevices:model];
}

- (BOOL)connected {
  return [self mgr].connectStatus == UTEDevicesStatusConnected;
}

- (nullable NSDictionary<NSString *, id> *)connectedDeviceInfo {
  UTEModelDevice *model = [self mgr].connnectModel;
  if (!model || ![self connected]) return nil;
  UTEModelDeviceElement *element = model.element;
  return @{
    @"name" : UteString(model.name),
    @"address" : UteString(model.addressStr),
    @"model" : UteString(element.model),
    @"firmware" : UteString(model.version),
    @"serialNumber" : UteString(element.serialNumber),
    @"hasAIRecording" : @(model.hasAIRecording),
    @"hasAIRecordRealTime" : @(model.hasAIRecordRealTime),
  };
}

#pragma mark - UTEBluetoothDelegate

- (void)uteDiscoverDevices:(UTEModelDevice *)model {
  if (!model) return;
  NSString *deviceId = model.identifier.length ? model.identifier : model.name;
  if (!deviceId.length) return;
  self.discovered[deviceId] = model;
  void (^handler)(NSDictionary<NSString *, id> *) = self.onDeviceFound;
  if (handler) {
    handler(@{
      @"id" : deviceId,
      @"name" : UteString(model.name),
      @"address" : UteString(model.advertisementAddress),
      @"rssi" : @(model.rssi),
    });
  }
}

- (void)uteDevicesStatus:(UTEDevicesStatus)status error:(NSError *)error userInfo:(NSDictionary *)info {
  if (status != UTEDevicesStatusConnecting) self.connecting = NO;
  void (^handler)(NSInteger, BOOL, NSString *_Nullable) = self.onConnectionChange;
  // The CoreBluetooth code matters: 14/15 mean the iPhone's saved pairing for the clip is stale.
  NSString *message = error ? [NSString stringWithFormat:@"%@ (CB %ld)", error.localizedDescription, (long)error.code] : nil;
  if (handler) handler(status, status == UTEDevicesStatusConnected, message);
  if (status == UTEDevicesStatusConnected) [self handshake];
}

/// What the vendor demo does on every connect: send our account id, and if the
/// clip accepts it, confirm pairing and set its clock. Without this the clip
/// keeps buzzing for confirmation and never finishes connecting.
- (void)handshake {
  __weak UteBleBridge *weakSelf = self;
  UTEAccountTool *account = [UTEDeviceMgr sharedInstance].accountTool;
  [account phoneSendWatchAccountWith:[self accountId] block:^(NSInteger result, NSInteger errorCode, NSDictionary *uteDict) {
    dispatch_async(dispatch_get_main_queue(), ^{
      // 0 same account, 1 bound to another account, 2 no account yet.
      if (result == 1) {
        [weakSelf reportPairing:NO message:@"clip is bound to another app - unbind it there (or factory reset) and retry"];
        return;
      }
      [account notifyDevicePair:YES block:^(BOOL blePair, NSInteger pairError) {
        dispatch_async(dispatch_get_main_queue(), ^{
          [weakSelf reportPairing:blePair message:[NSString stringWithFormat:@"pair confirm %@ (error %ld)", blePair ? @"ok" : @"refused", (long)pairError]];
        });
      }];
      [weakSelf syncClock];
    });
  }];
}

- (void)syncClock {
  NSInteger seconds = [[NSTimeZone localTimeZone] secondsFromGMT];
  [[UTEDeviceMgr sharedInstance] setTimeClock:(NSInteger)[[NSDate date] timeIntervalSince1970]
                                     timeZone:seconds / 3600
                                 minuteOffset:labs(seconds % 3600 / 60)
                                        block:nil];
}

/// A stable 20-character id, like the demo's. The clip remembers it and only accepts this app afterwards.
- (NSString *)accountId {
  NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
  NSString *saved = [defaults stringForKey:@"ute-ble.accountId"];
  if (saved.length) return saved;
  NSString *fresh = [[[[NSUUID UUID] UUIDString] stringByReplacingOccurrencesOfString:@"-" withString:@""] substringToIndex:20];
  [defaults setObject:fresh forKey:@"ute-ble.accountId"];
  return fresh;
}

- (void)reportPairing:(BOOL)paired message:(NSString *)message {
  void (^handler)(BOOL, NSString *) = self.onPairing;
  if (handler) handler(paired, message);
}

- (void)uteBluetoothStatus:(UTEBluetoothStatus)status {
  void (^handler)(NSInteger, BOOL) = self.onBluetoothState;
  if (handler) handler(status, status == UTEBluetoothStatusOpen);
}

- (void)uteSDKLog:(NSString *)str {
  void (^handler)(NSString *) = self.onLog;
  if (self.connecting && str.length && handler) handler(str);
}

- (void)uteDeviceRecordingClip:(NSData *)data error:(NSError *)error {
  void (^handler)(NSData *) = self.onClip;
  if (data && handler) handler(data);
}

#pragma mark - Pairing and state

- (void)bindWithToken:(NSString *)token verify:(NSInteger)verify completion:(UteBleResultCallback)completion {
  // osType 1 = iOS; the vendor says BleVersion is always 0.
  [[self recordMgr] appBindRecordDevice:1 BleVersion:0 Verify:verify Token:token Block:^(NSInteger errorCode, UTEModelRecordBindInfo *model) {
    if (errorCode != 0 || !model) {
      completion(errorCode, nil);
      return;
    }
    completion(0, @{
      @"ssn" : UteString(model.ssn),
      @"bound" : @(model.binded == 1),
      @"refuseCause" : @(model.refuse_cause),
      @"micMode" : @(model.mic_mode),
    });
  }];
}

- (void)fetchStatus:(UteBleResultCallback)completion {
  [[self recordMgr] getRecordStatusBlock:^(NSInteger errorCode, UTEModelRecordStatus *model) {
    if (errorCode != 0 || !model) {
      completion(errorCode, nil);
      return;
    }
    completion(0, @{
      @"state" : @(model.state),
      @"recording" : @(model.state == UTERecordStateTypeRecording),
      @"usbConnected" : @(model.udisk == 1),
      @"privacyMode" : @(model.privacy == 1),
    });
  }];
}

- (void)fetchStorageInfo:(UteBleResultCallback)completion {
  [[self recordMgr] getStorageCapacityInfoBlock:^(NSInteger errorCode, UTEModelRecordStorageInfo *model) {
    if (errorCode != 0 || !model) {
      completion(errorCode, nil);
      return;
    }
    completion(0, @{
      @"totalKB" : @(model.total),
      @"freeKB" : @(model.free),
      @"bytesPerSecond" : @(model.rec_size_ps),
      @"full" : @(model.no_free_size == 1),
    });
  }];
}

#pragma mark - Recording

- (void)beginRecording:(UteBleResultCallback)completion {
  // type 1 = normal recording; 2 is simultaneous-translation mode.
  [[self recordMgr] startRecord:1 Block:^(NSInteger errorCode, UTEModelRecordInfo *model) {
    if (errorCode != 0 || !model) {
      completion(errorCode, nil);
      return;
    }
    completion(0, @{@"sessionId" : @(model.sessionID), @"result" : @(model.reslut)});
  }];
}

- (void)endRecording:(UteBleResultCallback)completion {
  [[self recordMgr] stopRecordBlock:^(NSInteger errorCode, UTEModelRecordStopInfo *model) {
    if (errorCode != 0 || !model) {
      completion(errorCode, nil);
      return;
    }
    completion(0, @{
      @"sessionId" : @(model.sessionID),
      @"saved" : @(model.file_exist == 1),
      @"fileSize" : @(model.file_size),
    });
  }];
}

#pragma mark - Files

- (void)fetchFileList:(UteBleResultCallback)completion {
  // The device ignores this while it is recording or in USB mode.
  [[self recordMgr] getRecordFileList:0 StartSession:0 OnlyOne:0 Block:^(NSInteger errorCode, UTEModelRecordFileListInfo *model) {
    if (errorCode != 0 || !model) {
      completion(errorCode, nil);
      return;
    }
    NSMutableArray<NSDictionary<NSString *, id> *> *files = [NSMutableArray new];
    for (UTEModelRecordFileInfo *file in model.fileArray ?: @[]) {
      // fileName is the sessionID, as an integer.
      [files addObject:@{@"sessionId" : @(file.fileName), @"size" : @(file.fileSize), @"type" : @(file.type)}];
    }
    completion(0, @{@"count" : @(model.count), @"files" : files});
  }];
}

- (void)syncFileWithSession:(NSInteger)sessionId
                   fileType:(NSInteger)fileType
                       size:(NSInteger)size
                 completion:(UteBleStatusCallback)completion {
  [[self recordMgr] syncRecordData:sessionId
                        startIndex:0
                          endIndex:size
                          fileType:(UTERecordingFileType)fileType
                             Block:^(NSInteger errorCode, NSInteger sessionID, NSInteger result) {
                               completion(errorCode, result);
                             }];
}

- (void)cancelSync:(void (^)(NSInteger))completion {
  [[self recordMgr] stopSyncRecordDataBlock:^(NSInteger errorCode) {
    completion(errorCode);
  }];
}

- (void)deleteFileWithSession:(NSInteger)sessionId fileType:(NSInteger)fileType completion:(UteBleStatusCallback)completion {
  [[self recordMgr] deletelRecordFile:sessionId
                             fileType:(UTERecordingFileType)fileType
                                Block:^(NSInteger errorCode, NSInteger sessionID, NSInteger result) {
                                  completion(errorCode, result);
                                }];
}

#pragma mark - Device-initiated notifications

- (void)registerRecordListeners {
  if (self.recordListenersRegistered) return;
  self.recordListenersRegistered = YES;

  __weak UteBleBridge *weakSelf = self;
  UTERecordMgr *recordMgr = [self recordMgr];

  [recordMgr onNotifyStartRecordBlock:^(NSInteger errorCode, UTEModelRecordInfo *model) {
    void (^handler)(NSDictionary<NSString *, id> *) = weakSelf.onRecordStart;
    if (!model || !handler) return;
    handler(@{
      @"sessionId" : @(model.sessionID),
      // type 1 = the device's own button started it, 2 = the app did.
      @"startedByDevice" : @(model.type == 1),
      @"scene" : @(model.scene),
    });
  }];

  [recordMgr onNotifyStopRecordBlock:^(NSInteger errorCode, UTEModelRecordStopInfo *model) {
    void (^handler)(NSDictionary<NSString *, id> *) = weakSelf.onRecordStop;
    if (!model || !handler) return;
    handler(@{
      @"sessionId" : @(model.sessionID),
      @"saved" : @(model.file_exist == 1),
      @"fileSize" : @(model.file_size),
    });
  }];

  [recordMgr onNotifySyncRecordDataBlock:^(BOOL isCompleted, NSInteger sessionID, NSInteger size, NSData *subData, NSData *completeData) {
    void (^handler)(BOOL, NSInteger, NSInteger, NSData *_Nullable) = weakSelf.onSyncProgress;
    if (handler) handler(isCompleted, sessionID, size, completeData);
  }];

  [recordMgr onNotifySyncRecordDataCompleteBlock:^(NSInteger sessionID) {
    void (^handler)(NSInteger) = weakSelf.onSyncComplete;
    if (handler) handler(sessionID);
  }];
}

@end
