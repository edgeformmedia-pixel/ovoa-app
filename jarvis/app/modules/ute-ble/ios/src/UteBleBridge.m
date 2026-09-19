#import "UteBleBridge.h"
#import <objc/runtime.h>
#import <UTEBluetoothRYApi/UTEBluetoothRYApi.h>
#import <UTEBluetoothRYApi/UTEDeviceMgr.h>
#import <UTEBluetoothRYApi/UTERecordMgr.h>

static NSString *UteString(NSString *_Nullable value) {
  return value ?: @"";
}

/// The SDK reports success as UTEDeviceErrorNil (100000) on most calls and 0 on a few.
static NSInteger UteNormalize(NSInteger code) {
  return (code == UTEDeviceErrorNil || code == UTEDeviceErrorNone) ? 0 : code;
}

/// Every BOOL property of an SDK model object, by name.
static NSDictionary<NSString *, NSNumber *> *UteBoolProperties(NSObject *model) {
  NSMutableDictionary<NSString *, NSNumber *> *flags = [NSMutableDictionary new];
  unsigned int count = 0;
  objc_property_t *properties = class_copyPropertyList([model class], &count);
  for (unsigned int i = 0; i < count; i++) {
    NSString *name = @(property_getName(properties[i]));
    const char *attributes = property_getAttributes(properties[i]);
    // BOOL is encoded "TB" on arm64 ("Tc" on older ABIs).
    BOOL isBool = attributes && (strncmp(attributes, "TB", 2) == 0 || strncmp(attributes, "Tc", 2) == 0);
    if (!isBool) continue;
    @try {
      flags[name] = @([[model valueForKey:name] boolValue]);
    } @catch (NSException *exception) {
    }
  }
  free(properties);
  return flags;
}

/// How many times a short transfer is resumed from where it stopped, as the vendor demo does.
static const NSInteger UteMaxSyncResumes = 5;
/// A transfer that goes this long without data is over.
static const NSTimeInterval UteSyncStallSeconds = 15;

@interface UteBleBridge () <UTEBluetoothDelegate>
// connectDevice: wants the scanned UTEModelDevice back, so scan results are kept by identifier.
@property (nonatomic, strong) NSMutableDictionary<NSString *, UTEModelDevice *> *discovered;
@property (nonatomic, assign) BOOL recordListenersRegistered;
@property (nonatomic, assign) BOOL connecting;
/// Set only by a real "connected" status from the SDK. `connectStatus` can't be trusted on its own:
/// it starts at 0, which is UTEDevicesStatusConnected, so a fresh launch looked connected.
@property (nonatomic, assign) BOOL linked;
/// Timers of the polled motion sources, by source name (some answer one reading per request).
@property (nonatomic, strong) NSMutableDictionary<NSString *, NSTimer *> *pollTimers;

// The transfer in flight. The SDK hands data over in small pieces and sometimes stops
// short of the end; the demo appends the pieces itself and asks again for the rest.
@property (nonatomic, assign) NSInteger syncSession;
@property (nonatomic, assign) NSInteger syncFileType;
@property (nonatomic, assign) NSInteger syncExpected;
@property (nonatomic, assign) NSInteger syncResumes;
@property (nonatomic, assign) NSInteger syncGeneration;
@property (nonatomic, assign) BOOL syncSegmentEnded;
@property (nonatomic, strong, nullable) NSMutableData *syncBuffer;
@property (nonatomic, strong, nullable) NSDate *syncLastData;
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
    _pollTimers = [NSMutableDictionary new];
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
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    [mgr initUTEMgr];
  });
  // The manager holds its delegate weakly; this singleton keeps itself alive.
  mgr.delegate = self;
  __weak UteBleBridge *weakSelf = self;
  // The clip asks the user to confirm pairing (it buzzes) and reports the answer here.
  [[UTEDeviceMgr sharedInstance].accountTool onNotifyAppPair:^(BOOL pair) {
    [weakSelf reportPairing:pair message:pair ? @"device confirmed pairing" : @"device cancelled pairing"];
  }];
  [self registerRecordListeners];
  [self registerInputListeners];
  return UteString([mgr sdkVersion]);
}

- (void)startScan {
  // Keep earlier results: a retry may reconnect to a device found by a previous scan.
  [[self mgr] startScanDevices];
  // A clip that iOS already holds a link to (it is bonded, and ANCS keeps the link up)
  // stops advertising, so a scan alone would never find it again.
  for (UTEModelDevice *model in [self systemConnectedDevices]) {
    [self uteDiscoverDevices:model];
  }
}

- (void)stopScan {
  [[self mgr] stopScanDevices];
}

- (NSArray<UTEModelDevice *> *)systemConnectedDevices {
  // 56FF is the service the SDK reports reading from the ES100 on connect.
  NSMutableArray<NSString *> *services = [NSMutableArray arrayWithObject:@"56FF"];
  NSString *sdkService = [self mgr].SERVICE_UUID;
  if (sdkService.length && ![services containsObject:sdkService]) [services addObject:sdkService];
  @try {
    return [[self mgr] retrieveConnectedDeviceWithServers:services] ?: @[];
  } @catch (NSException *exception) {
    return @[];
  }
}

- (BOOL)connectDeviceWithId:(NSString *)deviceId {
  UTEModelDevice *model = self.discovered[deviceId];
  if (!model) {
    for (UTEModelDevice *candidate in [self systemConnectedDevices]) {
      if ([candidate.identifier isEqualToString:deviceId]) {
        model = candidate;
        self.discovered[deviceId] = candidate;
      }
    }
  }
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
  return self.linked && [self mgr].connnectModel != nil && [self mgr].connectStatus == UTEDevicesStatusConnected;
}

- (nullable NSDictionary<NSString *, id> *)connectedDeviceInfo {
  UTEModelDevice *model = [self mgr].connnectModel;
  if (!model || ![self connected]) return nil;
  UTEModelDeviceElement *element = model.element;
  return @{
    @"id" : UteString(model.identifier),
    @"name" : UteString(model.name),
    @"address" : UteString(model.addressStr),
    @"model" : UteString(element.model),
    @"firmware" : UteString(model.version),
    @"serialNumber" : UteString(element.serialNumber),
    @"hasAIRecording" : @(model.hasAIRecording),
    @"hasAIRecordRealTime" : @(model.hasAIRecordRealTime),
  };
}

- (NSDictionary<NSString *, NSNumber *> *)capabilities {
  UTEModelDevice *model = [self mgr].connnectModel;
  if (!model) return @{};
  NSMutableDictionary<NSString *, NSNumber *> *flags = [NSMutableDictionary new];
  [UteBoolProperties(model) enumerateKeysAndObjectsUsingBlock:^(NSString *name, NSNumber *value, BOOL *stop) {
    if ([name hasPrefix:@"has"]) flags[name] = value;
  }];
  return flags;
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
  self.linked = status == UTEDevicesStatusConnected;
  void (^handler)(NSInteger, BOOL, NSString *_Nullable) = self.onConnectionChange;
  // The CoreBluetooth code matters: 14/15 mean the iPhone's saved pairing for the clip is stale.
  NSString *message = error ? [NSString stringWithFormat:@"%@ (CB %ld)", error.localizedDescription, (long)error.code] : nil;
  if (handler) handler(status, status == UTEDevicesStatusConnected, message);
  if (status == UTEDevicesStatusConnected) [self handshake];
  // A dropped link ends any transfer; hand back what arrived instead of hanging.
  if (status == UTEDevicesStatusDisconnected && self.syncBuffer) {
    [self finishSync:@"the clip disconnected during the transfer"];
  }
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
  // Tell the firmware it is worn on the left (0 = left, 1 = right). Harmless if it ignores this.
  if (paired) [[UTEDeviceMgr sharedInstance] setWearingHands:0 Block:^(NSInteger errorCode) {}];
  void (^handler)(BOOL, NSString *) = self.onPairing;
  if (handler) handler(paired, message);
}

- (void)reportInput:(NSDictionary<NSString *, id> *)input {
  void (^handler)(NSDictionary<NSString *, id> *) = self.onInput;
  if (!handler) return;
  dispatch_async(dispatch_get_main_queue(), ^{
    handler(input);
  });
}

- (void)uteBluetoothStatus:(UTEBluetoothStatus)status {
  void (^handler)(NSInteger, BOOL) = self.onBluetoothState;
  if (handler) handler(status, status == UTEBluetoothStatusOpen);
}

- (void)uteSDKLog:(NSString *)str {
  void (^handler)(NSString *) = self.onLog;
  if ((self.connecting || self.sdkLogging) && str.length && handler) handler(str);
}

- (void)uteDeviceRecordingClip:(NSData *)data error:(NSError *)error {
  void (^handler)(NSData *) = self.onClip;
  if (data && handler) handler(data);
}

#pragma mark - Pairing and state

- (void)bindWithToken:(NSString *)token verify:(NSInteger)verify completion:(UteBleResultCallback)completion {
  // osType 1 = iOS; the vendor says BleVersion is always 0.
  [[self recordMgr] appBindRecordDevice:1 BleVersion:0 Verify:verify Token:token Block:^(NSInteger errorCode, UTEModelRecordBindInfo *model) {
    NSInteger code = UteNormalize(errorCode);
    if (code != 0 || !model) {
      completion(code ?: -601, nil);
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
    NSInteger code = UteNormalize(errorCode);
    if (code != 0 || !model) {
      completion(code ?: -601, nil);
      return;
    }
    completion(0, @{
      @"state" : @(model.state),
      @"recording" : @(model.state == UTERecordStateTypeRecording),
      @"usbConnected" : @(model.udisk == 1),
      @"privacyMode" : @(model.privacy == 1),
      @"keyState" : @(model.key_state),
      @"micMode" : @(model.mic_mode),
    });
  }];
}

- (void)fetchStorageInfo:(UteBleResultCallback)completion {
  [[self recordMgr] getStorageCapacityInfoBlock:^(NSInteger errorCode, UTEModelRecordStorageInfo *model) {
    NSInteger code = UteNormalize(errorCode);
    if (code != 0 || !model) {
      completion(code ?: -601, nil);
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

- (void)fetchBattery:(UteBleResultCallback)completion {
  [[UTEDeviceMgr sharedInstance] getBatteryInfoModel:^(UTEModelBatteryInfo *model, NSInteger errorCode) {
    NSInteger code = UteNormalize(errorCode);
    if (code != 0 || !model) {
      completion(code ?: -601, nil);
      return;
    }
    completion(0, @{
      @"percent" : @(model.value),
      // 0 on battery, 1 charging, 2 fully charged.
      @"charging" : @(model.status == UTEBatteryStatusCharging),
      @"full" : @(model.status == UTEBatteryStatusChargingFully),
      @"low" : @(model.lowBattery == 1),
    });
  }];
}

- (void)fetchRssi:(UteBleResultCallback)completion {
  if (![self connected]) {
    completion(-1000, nil);
    return;
  }
  [[self mgr] readDeviceRSSI:^(NSInteger rssi) {
    dispatch_async(dispatch_get_main_queue(), ^{
      completion(0, @{@"rssi" : @(rssi)});
    });
  }];
}

- (void)fetchEncodingConfig:(UteBleResultCallback)completion {
  [[self recordMgr] getRecordEncodingConfigurationBlock:^(NSInteger errorCode, NSArray<UTEModelRecordEncodingConfig *> *configArray) {
    NSInteger code = UteNormalize(errorCode);
    if (code != 0) {
      completion(code, nil);
      return;
    }
    NSMutableArray<NSDictionary<NSString *, id> *> *formats = [NSMutableArray new];
    for (UTEModelRecordEncodingConfig *config in configArray ?: @[]) {
      [formats addObject:@{
        @"type" : @(config.type),
        @"channels" : @(config.channal),
        @"sampleRate" : @(config.sampleRate),
        @"bits" : @(config.sampleBit),
        @"bitRate" : @(config.bitRate),
      }];
    }
    completion(0, @{@"formats" : formats});
  }];
}

#pragma mark - Motion

/// Some factory commands never answer on firmware that lacks the feature; this makes sure the caller hears back once.
static UteBleResultCallback UteOnce(UteBleResultCallback completion, NSTimeInterval timeout) {
  __block BOOL done = NO;
  UteBleResultCallback once = ^(NSInteger errorCode, NSDictionary<NSString *, id> *_Nullable result) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (done) return;
      done = YES;
      completion(errorCode, result);
    });
  };
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(timeout * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    once(408, nil);
  });
  return once;
}

- (void)probeSensors:(UteBleResultCallback)completion {
  UteBleResultCallback reply = UteOnce(completion, 5);
  [[UTEDeviceMgr sharedInstance] checkFactoryFuntion:^(UTEModelFactoryFuntion *model) {
    if (!model) {
      reply(-601, nil);
      return;
    }
    reply(0, @{
      @"accelerometer" : @(model.isSupportG_sensorTest || model.isSupportGsensorTest),
      @"gyroscope" : @(model.isSupportGyroscopeTest),
      @"button" : @(model.isSupportKeyTest),
      @"motor" : @(model.isSupportMotorSwitchTest),
      // Every factory test the firmware claims, by name (e.g. isSupportG_sensorTest = the older g-sensor command).
      @"all" : UteBoolProperties(model),
    });
  }];
}

- (void)readGyro:(UteBleResultCallback)completion {
  UteBleResultCallback reply = UteOnce(completion, 3);
  [[UTEDeviceMgr sharedInstance] factoryReadGyroData:^(NSInteger range, NSInteger x, NSInteger y, NSInteger z) {
    reply(0, @{@"range" : @(range), @"x" : @(x), @"y" : @(y), @"z" : @(z)});
  }];
}

- (void)setMotionStream:(BOOL)on completion:(void (^)(NSInteger))completion {
  UTEMgrGame *game = [UTEDeviceMgr sharedInstance].game;
  if (on) {
    __weak UteBleBridge *weakSelf = self;
    [game onNotifyGameOperateBlock:^(NSInteger errorCode, NSArray<UTEModelGameOperate *> *arrayModels) {
      if (UteNormalize(errorCode) != 0 || !arrayModels.count) return;
      NSMutableArray<NSArray<NSNumber *> *> *samples = [NSMutableArray arrayWithCapacity:arrayModels.count];
      for (UTEModelGameOperate *m in arrayModels) {
        [samples addObject:@[ @(m.x), @(m.y), @(m.Speed), @(m.X_Throw), @(m.Y_Throw), @(m.Speed_Throw) ]];
      }
      [weakSelf reportMotion:@"game" samples:samples];
    }];
  }
  // 1 start, 0 stop. Firmware without the game stream may never answer, so time out (408).
  UteBleResultCallback reply = UteOnce(^(NSInteger errorCode, NSDictionary<NSString *, id> *_Nullable result) {
    completion(errorCode);
  }, 4);
  [game sendGameStatus:on ? 1 : 0 Block:^(NSInteger errorCode) {
    reply(UteNormalize(errorCode), nil);
  }];
}

- (void)reportMotion:(NSString *)source samples:(NSArray<NSArray<NSNumber *> *> *)samples {
  void (^handler)(NSString *, NSArray<NSArray<NSNumber *> *> *) = self.onMotion;
  if (!handler || !samples.count) return;
  dispatch_async(dispatch_get_main_queue(), ^{
    handler(source, samples);
  });
}

/// Motion sources for twist-to-listen and the motion probe (Dev tools → Motion lab). The ES100
/// ignored the game stream (sendGameStatus never answered, 2026-09-19) and answered the g-sensor
/// test once per connection; which source really streams is what the probe finds out.
/// Polled sources ask again every `intervalMs`.
- (void)setMotionSource:(NSString *)source
                     on:(BOOL)on
             intervalMs:(NSInteger)intervalMs
             completion:(void (^)(NSInteger errorCode))completion {
  [self stopPolling:source];
  if ([source isEqualToString:@"game"]) {
    [self setMotionStream:on completion:completion];
    return;
  }
  UteBleResultCallback reply = UteOnce(^(NSInteger errorCode, NSDictionary<NSString *, id> *_Nullable result) {
    completion(errorCode);
  }, 4);
  __weak UteBleBridge *weakSelf = self;
  UTEDeviceMgr *dev = [UTEDeviceMgr sharedInstance];
  NSTimeInterval every = MAX(intervalMs, 20) / 1000.0;

  // Wearables (glasses/earbuds) factory accelerometer: 6-axis (angle, x, y, z) or 3-axis.
  if ([source isEqualToString:@"wear6"] || [source isEqualToString:@"wear3"]) {
    UTEMgrWear *wear = dev.wear;
    BOOL six = [source isEqualToString:@"wear6"];
    if (on && six) {
      [wear onNotifyFactoryGsensor6:^(NSInteger angle, NSInteger x, NSInteger y, NSInteger z) {
        [weakSelf reportMotion:@"wear6" samples:@[ @[ @(x), @(y), @(z), @(angle) ] ]];
      }];
    } else if (on) {
      [wear onNotifyFactoryGsensor3:^(NSInteger x, NSInteger y, NSInteger z) {
        [weakSelf reportMotion:@"wear3" samples:@[ @[ @(x), @(y), @(z) ] ]];
      }];
    }
    void (^done)(BOOL, UTEDeviceError) = ^(BOOL success, UTEDeviceError errorCode) {
      NSInteger code = UteNormalize(errorCode);
      reply(success ? 0 : (code != 0 ? code : -2), nil);
    };
    if (six) {
      [wear factoryGsensor6:on block:done];
    } else {
      [wear factoryGsensor3:on block:done];
    }
    return;
  }

  // Watch factory accelerometer test: x, y, z, speed, range. The open command has no reply.
  // "gsensorOnce" opens it once, "gsensor" opens it again every interval, and "gsensorToggle"
  // closes and reopens it (an open may be ignored while the test is already running).
  if ([@[ @"gsensor", @"gsensorOnce", @"gsensorToggle" ] containsObject:source]) {
    if (on) {
      [dev factoryGsensorTestBlock:^(NSInteger range, NSInteger x, NSInteger y, NSInteger z, NSInteger speed) {
        [weakSelf reportMotion:source samples:@[ @[ @(x), @(y), @(z), @(speed), @(range) ] ]];
      }];
      [dev factoryOpenTestGsensor:YES];
      if ([source isEqualToString:@"gsensor"]) {
        [self poll:source every:every block:^{
          [[UTEDeviceMgr sharedInstance] factoryOpenTestGsensor:YES];
        }];
      } else if ([source isEqualToString:@"gsensorToggle"]) {
        [self poll:source every:every block:^{
          UTEDeviceMgr *mgr = [UTEDeviceMgr sharedInstance];
          [mgr factoryOpenTestGsensor:NO];
          dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.05 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
            [mgr factoryOpenTestGsensor:YES];
          });
        }];
      }
    } else {
      [dev factoryOpenTestGsensor:NO];
    }
    reply(0, nil);
    return;
  }

  // Gyroscope test, the newer command (cmd 1 on, 0 off). x, y, z are in thousandths; the vendor
  // says shaking the device makes them non-zero. Sample: x, y, z, state, result.
  // "gyro3" sends it once and listens; "gyro3poll" sends it again every interval.
  if ([source isEqualToString:@"gyro3"] || [source isEqualToString:@"gyro3poll"]) {
    if (!on) {
      [dev factoryGyroscope3CMD:0 Block:nil];
      reply(0, nil);
      return;
    }
    void (^onReading)(NSInteger, NSInteger, NSInteger, NSInteger, NSInteger) =
        ^(NSInteger state, NSInteger x, NSInteger y, NSInteger z, NSInteger result) {
          [weakSelf reportMotion:source samples:@[ @[ @(x), @(y), @(z), @(state), @(result) ] ]];
          reply(0, nil);
        };
    [dev factoryGyroscope3CMD:1 Block:onReading];
    if ([source isEqualToString:@"gyro3poll"]) {
      [self poll:source every:every block:^{
        [[UTEDeviceMgr sharedInstance] factoryGyroscope3CMD:1 Block:onReading];
      }];
    }
    return;
  }

  // Gyroscope, the older command: one reading per request, so ask every interval. Sample: x, y, z, range.
  if ([source isEqualToString:@"gyro"]) {
    if (on) {
      [self poll:source every:every block:^{
        [[UTEDeviceMgr sharedInstance] factoryReadGyroData:^(NSInteger range, NSInteger x, NSInteger y, NSInteger z) {
          [weakSelf reportMotion:@"gyro" samples:@[ @[ @(x), @(y), @(z), @(range) ] ]];
        }];
      }];
    }
    reply(0, nil);
    return;
  }

  // The live health frame the clip pushes on its own (about once a minute on watches).
  // Sample: step, calorie, distance, dynamic heart rate. Listening can't be turned off, so off ignores it.
  if ([source isEqualToString:@"frame"]) {
    if (on) {
      [dev onNotifyCurrentData:^(UTEModelMotionFrameItemContent *model) {
        if (!model) return;
        [weakSelf reportMotion:@"frame"
                       samples:@[ @[ @(model.step), @(model.calorie), @(model.distance), @(model.dynamicHeartRate) ] ]];
      }];
    }
    reply(0, nil);
    return;
  }

  reply(-600, nil);
}

- (void)poll:(NSString *)source every:(NSTimeInterval)seconds block:(void (^)(void))block {
  [self stopPolling:source];
  self.pollTimers[source] = [NSTimer scheduledTimerWithTimeInterval:seconds
                                                            repeats:YES
                                                              block:^(NSTimer *_Nonnull timer) {
    block();
  }];
}

- (void)stopPolling:(NSString *)source {
  [self.pollTimers[source] invalidate];
  [self.pollTimers removeObjectForKey:source];
}

- (void)readActivity:(UteBleResultCallback)completion {
  UteBleResultCallback reply = UteOnce(completion, 5);
  [[UTEDeviceMgr sharedInstance] getCurrentDayTotalWorkoutData:^(UTEModelTodayStep *model, NSInteger errorCode, NSDictionary *uteDict) {
    NSInteger code = UteNormalize(errorCode);
    // The dictionary is the SDK's own description of the totals; only its text crosses over.
    reply(code, @{@"totals" : UteString([uteDict description]), @"calories" : @(model.totalCalorie)});
  }];
}

- (void)probeWearFunctions:(UteBleResultCallback)completion {
  UteBleResultCallback reply = UteOnce(completion, 4);
  [[UTEDeviceMgr sharedInstance].wear factoryReadFunction:^(NSArray<UTEWearFunctionModel *> *array, UTEDeviceError errorCode) {
    NSMutableArray<NSDictionary *> *functions = [NSMutableArray array];
    for (UTEWearFunctionModel *m in array) {
      [functions addObject:@{@"type" : @(m.type), @"value" : @(m.value)}];
    }
    reply(UteNormalize(errorCode), @{@"functions" : functions});
  }];
}

- (void)buzz:(NSInteger)count option:(NSInteger)option completion:(UteBleResultCallback)completion {
  UTEDeviceMgr *dev = [UTEDeviceMgr sharedInstance];
  NSInteger pulses = MAX(1, count);
  int64_t offAfter = (int64_t)(0.25 * pulses * NSEC_PER_SEC);
  NSDictionary *info = @{@"option" : @(option)};
  if (option == 2) {
    // Declared in the header but never used by the vendor demo; it has no callback.
    [dev factoryVibration:pulses];
    dispatch_async(dispatch_get_main_queue(), ^{ completion(0, info); });
    return;
  }
  UteBleResultCallback reply = UteOnce(completion, 3);
  if (option == 3) {
    // Factory motor test: state 1 = ok.
    [dev factoryMotorTestCMD:1 Block:^(NSInteger state) {
      reply(state == 1 ? 0 : -2, info);  // 0 = failed; -2 reads as "the clip refused"
    }];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, offAfter), dispatch_get_main_queue(), ^{
      [dev factoryMotorTestCMD:0 Block:nil];
    });
    return;
  }
  // Option 1: "find my device" on, then off.
  [dev setFindWearCmd:1 block:^(NSInteger errorCode, NSDictionary *uteDict) {
    reply(UteNormalize(errorCode), info);
  }];
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, offAfter), dispatch_get_main_queue(), ^{
    [dev setFindWearCmd:0 block:^(NSInteger errorCode, NSDictionary *uteDict) {}];
  });
}

#pragma mark - Recording

- (void)beginRecording:(UteBleResultCallback)completion {
  // type 1 = normal recording; 2 is simultaneous-translation mode.
  [[self recordMgr] startRecord:1 Block:^(NSInteger errorCode, UTEModelRecordInfo *model) {
    NSInteger code = UteNormalize(errorCode);
    if (code != 0 || !model) {
      completion(code ?: -601, nil);
      return;
    }
    // result: 0 started, 1 storage full, 2 USB mode, 3 hardware error, 4 already recording, 5 Wi-Fi mode.
    completion(0, @{@"sessionId" : @(model.sessionID), @"result" : @(model.reslut), @"scene" : @(model.scene)});
  }];
}

- (void)pauseRecordingSession:(NSInteger)sessionId completion:(UteBleResultCallback)completion {
  [[self recordMgr] pauseRecord:sessionId Block:^(NSInteger errorCode, UTEModelRecordPauseInfo *model) {
    NSInteger code = UteNormalize(errorCode);
    if (code != 0 || !model) {
      completion(code ?: -601, nil);
      return;
    }
    // result: 0 paused, 1 already paused, 2 wrong session, 3 unknown error.
    completion(0, @{@"sessionId" : @(model.sessionID), @"result" : @(model.reslut)});
  }];
}

- (void)resumeRecordingSession:(NSInteger)sessionId completion:(UteBleResultCallback)completion {
  [[self recordMgr] resetRecord:sessionId withScene:UTERecordingSceneNormal Block:^(NSInteger errorCode, UTEModelRecordInfo *model) {
    NSInteger code = UteNormalize(errorCode);
    if (code != 0 || !model) {
      completion(code ?: -601, nil);
      return;
    }
    completion(0, @{@"sessionId" : @(model.sessionID), @"result" : @(model.reslut)});
  }];
}

- (void)endRecording:(UteBleResultCallback)completion {
  [[self recordMgr] stopRecordBlock:^(NSInteger errorCode, UTEModelRecordStopInfo *model) {
    NSInteger code = UteNormalize(errorCode);
    if (code != 0 || !model) {
      completion(code ?: -601, nil);
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
    NSInteger code = UteNormalize(errorCode);
    if (code != 0 || !model) {
      completion(code ?: -601, nil);
      return;
    }
    NSMutableArray<NSDictionary<NSString *, id> *> *files = [NSMutableArray new];
    for (UTEModelRecordFileInfo *file in model.fileArray ?: @[]) {
      // fileName is the sessionID, as an integer; it is also the recording's start time (unix seconds).
      [files addObject:@{@"sessionId" : @(file.fileName), @"size" : @(file.fileSize), @"type" : @(file.type)}];
    }
    completion(0, @{@"count" : @(model.count), @"files" : files});
  }];
}

- (void)syncFileWithSession:(NSInteger)sessionId
                   fileType:(NSInteger)fileType
                       size:(NSInteger)size
                 completion:(UteBleStatusCallback)completion {
  self.syncGeneration++;
  self.syncSession = sessionId;
  self.syncFileType = fileType;
  self.syncExpected = size;
  self.syncResumes = 0;
  self.syncBuffer = [NSMutableData new];
  [self requestSyncFrom:0 completion:completion];
  [self watchSyncStall:self.syncGeneration];
}

- (void)requestSyncFrom:(NSInteger)start completion:(nullable UteBleStatusCallback)completion {
  self.syncSegmentEnded = NO;
  self.syncLastData = [NSDate date];
  __weak UteBleBridge *weakSelf = self;
  [[self recordMgr] syncRecordData:self.syncSession
                        startIndex:start
                          endIndex:self.syncExpected
                          fileType:(UTERecordingFileType)self.syncFileType
                             Block:^(NSInteger errorCode, NSInteger sessionID, NSInteger result) {
                               NSInteger code = UteNormalize(errorCode);
                               BOOL refused = code != 0 || result != 0;
                               // result: 0 ok, 1 filesystem error, 2 missing, 3 interrupted. No data follows a refusal.
                               if (completion) {
                                 if (refused) {
                                   // The caller hears about it through `completion`; drop the transfer quietly.
                                   weakSelf.syncBuffer = nil;
                                   weakSelf.syncGeneration++;
                                 }
                                 completion(code, result);
                               } else if (refused) {
                                 [weakSelf finishSync:[NSString stringWithFormat:@"resume refused (error %ld, result %ld)", (long)code, (long)result]];
                               }
                             }];
}

- (void)watchSyncStall:(NSInteger)generation {
  __weak UteBleBridge *weakSelf = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(3 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    UteBleBridge *strongSelf = weakSelf;
    if (!strongSelf || !strongSelf.syncBuffer || strongSelf.syncGeneration != generation) return;
    if ([[NSDate date] timeIntervalSinceDate:strongSelf.syncLastData] > UteSyncStallSeconds) {
      [strongSelf finishSync:@"the clip stopped sending data"];
      return;
    }
    [strongSelf watchSyncStall:generation];
  });
}

/// Called when the clip says a segment is done: resume if short, otherwise hand the data over.
- (void)syncSegmentDidEnd {
  if (!self.syncBuffer || self.syncSegmentEnded) return;
  self.syncSegmentEnded = YES;
  NSInteger generation = self.syncGeneration;
  // Both "completed" callbacks fire, in either order; let the second one land before deciding.
  __weak UteBleBridge *weakSelf = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.3 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    UteBleBridge *strongSelf = weakSelf;
    if (!strongSelf || !strongSelf.syncBuffer || strongSelf.syncGeneration != generation) return;
    NSInteger have = (NSInteger)strongSelf.syncBuffer.length;
    if (have < strongSelf.syncExpected && strongSelf.syncResumes < UteMaxSyncResumes) {
      strongSelf.syncResumes++;
      [strongSelf requestSyncFrom:have completion:nil];
      return;
    }
    [strongSelf finishSync:nil];
  });
}

- (void)finishSync:(nullable NSString *)error {
  NSMutableData *data = self.syncBuffer;
  if (!data) return;
  self.syncBuffer = nil;
  self.syncGeneration++;
  void (^handler)(NSInteger, NSData *, NSString *_Nullable) = self.onSyncFinished;
  NSString *reason = data.length ? nil : (error ?: @"the clip sent no data");
  if (handler) handler(self.syncSession, data, reason);
}

- (void)cancelSync:(void (^)(NSInteger))completion {
  __weak UteBleBridge *weakSelf = self;
  [[self recordMgr] stopSyncRecordDataBlock:^(NSInteger errorCode) {
    dispatch_async(dispatch_get_main_queue(), ^{
      UteBleBridge *strongSelf = weakSelf;
      if (strongSelf.syncBuffer) {
        strongSelf.syncBuffer = [NSMutableData new];
        [strongSelf finishSync:@"cancelled"];
      }
      completion(UteNormalize(errorCode));
    });
  }];
}

- (void)deleteFileWithSession:(NSInteger)sessionId fileType:(NSInteger)fileType completion:(UteBleStatusCallback)completion {
  [[self recordMgr] deletelRecordFile:sessionId
                             fileType:(UTERecordingFileType)fileType
                                Block:^(NSInteger errorCode, NSInteger sessionID, NSInteger result) {
                                  completion(UteNormalize(errorCode), result);
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
      @"startedByDevice" : @(model.type == 1),
      @"saved" : @(model.file_exist == 1),
      @"fileSize" : @(model.file_size),
    });
  }];

  [recordMgr onNotifySyncRecordDataBlock:^(BOOL isCompleted, NSInteger sessionID, NSInteger size, NSData *subData, NSData *completeData) {
    dispatch_async(dispatch_get_main_queue(), ^{
      UteBleBridge *strongSelf = weakSelf;
      if (!strongSelf || !strongSelf.syncBuffer || sessionID != strongSelf.syncSession) return;
      strongSelf.syncLastData = [NSDate date];
      if (!isCompleted) {
        if (subData.length) [strongSelf.syncBuffer appendData:subData];
      } else if (completeData.length > strongSelf.syncBuffer.length && completeData.length <= (NSUInteger)strongSelf.syncExpected) {
        // Only trust the SDK's own copy when it holds more than we assembled (a single, unresumed segment).
        [strongSelf.syncBuffer setData:completeData];
      }
      void (^progress)(NSInteger, NSInteger, NSInteger) = strongSelf.onSyncProgress;
      if (progress) progress(sessionID, (NSInteger)strongSelf.syncBuffer.length, strongSelf.syncExpected);
      if (isCompleted) [strongSelf syncSegmentDidEnd];
    });
  }];

  [recordMgr onNotifySyncRecordDataCompleteBlock:^(NSInteger sessionID) {
    dispatch_async(dispatch_get_main_queue(), ^{
      UteBleBridge *strongSelf = weakSelf;
      if (!strongSelf || sessionID != strongSelf.syncSession) return;
      [strongSelf syncSegmentDidEnd];
    });
  }];
}

/// Everything else the clip reports unprompted, forwarded as onInput events.
- (void)registerInputListeners {
  static dispatch_once_t once;
  __weak UteBleBridge *weakSelf = self;
  dispatch_once(&once, ^{
    UTEDeviceMgr *device = [UTEDeviceMgr sharedInstance];

    [device onNofityBatteryModel:^(UTEModelBatteryInfo *model) {
      if (!model) return;
      [weakSelf reportInput:@{
        @"kind" : @"battery",
        @"value" : @(model.value),
        @"detail" : model.status == UTEBatteryStatusCharging ? @"charging"
                    : model.status == UTEBatteryStatusChargingFully ? @"full"
                    : model.lowBattery == 1 ? @"low" : @"on battery",
      }];
    }];

    // The clip's AI/voice button, if its firmware has one: 1 enter, 2 start recording,
    // 3 stop recording, 4 exit, 5 "open the app", 6/7 recognition failed/succeeded.
    [device.chatGPT onNotifyChatGPTStatus:^(UTEChatGPTStatus status) {
      [weakSelf reportInput:@{@"kind" : @"voiceButton", @"value" : @(status)}];
    }];

    // Audio the voice button captured, as opus.
    [device.chatGPT onNotifyChatGPTVoiceData:^(NSInteger errorCode, NSData *opus) {
      [weakSelf reportInput:@{@"kind" : @"voiceData", @"value" : @(opus.length), @"detail" : @"complete"}];
    }];
    [device.chatGPT onNotifyUploadVoiceDataBlock:^(BOOL isCompleted, NSData *opus) {
      [weakSelf reportInput:@{@"kind" : @"voiceData", @"value" : @(opus.length), @"detail" : isCompleted ? @"complete" : @"streaming"}];
    }];

    // Taken off / put back on (watches). value: state; detail: UTEOffWristModel and the clip's timestamp.
    [device onNotifyOffWristBlock:^(NSInteger timestamp, UTEOffWristModel model, NSInteger state) {
      [weakSelf reportInput:@{
        @"kind" : @"offWrist",
        @"value" : @(state),
        @"detail" : [NSString stringWithFormat:@"model %ld at %ld", (long)model, (long)timestamp],
      }];
    }];
  });
}

@end
