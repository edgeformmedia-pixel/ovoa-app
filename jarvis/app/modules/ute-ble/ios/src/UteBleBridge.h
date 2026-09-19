#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

// All UTEBluetoothRYApi calls go through here so the Swift module never depends
// on how Swift imports the vendor's selectors and nullability, which shifts
// between Xcode releases. Only Foundation types cross this boundary.

typedef void (^UteBleResultCallback)(NSInteger errorCode, NSDictionary<NSString *, id> *_Nullable result)
    NS_SWIFT_NAME(UteBleResultCallback);
typedef void (^UteBleStatusCallback)(NSInteger errorCode, NSInteger result) NS_SWIFT_NAME(UteBleStatusCallback);

NS_SWIFT_NAME(UteBleBridge)
@interface UteBleBridge : NSObject

@property (class, nonatomic, readonly) UteBleBridge *shared;

@property (nonatomic, copy, nullable) void (^onDeviceFound)(NSDictionary<NSString *, id> *device);
@property (nonatomic, copy, nullable) void (^onConnectionChange)(NSInteger status, BOOL connected, NSString *_Nullable error);
@property (nonatomic, copy, nullable) void (^onBluetoothState)(NSInteger state, BOOL poweredOn);
@property (nonatomic, copy, nullable) void (^onClip)(NSData *data);
@property (nonatomic, copy, nullable) void (^onRecordStart)(NSDictionary<NSString *, id> *info);
@property (nonatomic, copy, nullable) void (^onRecordStop)(NSDictionary<NSString *, id> *info);
@property (nonatomic, copy, nullable) void (^onSyncProgress)(BOOL completed, NSInteger sessionId, NSInteger size, NSData *_Nullable data);
@property (nonatomic, copy, nullable) void (^onSyncComplete)(NSInteger sessionId);
/// The post-connect handshake: account check, then pairing confirmation.
@property (nonatomic, copy, nullable) void (^onPairing)(BOOL paired, NSString *message);
/// Vendor SDK log lines, forwarded only while a connect is in flight.
@property (nonatomic, copy, nullable) void (^onLog)(NSString *line);

- (NSString *)setUp NS_SWIFT_NAME(setUp());
- (void)startScan NS_SWIFT_NAME(startScan());
- (void)stopScan NS_SWIFT_NAME(stopScan());
- (BOOL)connectDeviceWithId:(NSString *)deviceId NS_SWIFT_NAME(connect(deviceId:));
- (BOOL)disconnectDevice NS_SWIFT_NAME(disconnect());
- (BOOL)connected NS_SWIFT_NAME(isConnected());
- (nullable NSDictionary<NSString *, id> *)connectedDeviceInfo NS_SWIFT_NAME(connectedDevice());

- (void)bindWithToken:(NSString *)token verify:(NSInteger)verify completion:(UteBleResultCallback)completion
    NS_SWIFT_NAME(bind(token:verify:completion:));
- (void)fetchStatus:(UteBleResultCallback)completion NS_SWIFT_NAME(getStatus(completion:));
- (void)fetchStorageInfo:(UteBleResultCallback)completion NS_SWIFT_NAME(getStorageInfo(completion:));
- (void)beginRecording:(UteBleResultCallback)completion NS_SWIFT_NAME(startRecord(completion:));
- (void)endRecording:(UteBleResultCallback)completion NS_SWIFT_NAME(stopRecord(completion:));
- (void)fetchFileList:(UteBleResultCallback)completion NS_SWIFT_NAME(listFiles(completion:));
- (void)syncFileWithSession:(NSInteger)sessionId
                   fileType:(NSInteger)fileType
                       size:(NSInteger)size
                 completion:(UteBleStatusCallback)completion NS_SWIFT_NAME(syncFile(sessionId:fileType:size:completion:));
- (void)cancelSync:(void (^)(NSInteger errorCode))completion NS_SWIFT_NAME(stopSync(completion:));
- (void)deleteFileWithSession:(NSInteger)sessionId
                     fileType:(NSInteger)fileType
                   completion:(UteBleStatusCallback)completion NS_SWIFT_NAME(deleteFile(sessionId:fileType:completion:));

@end

NS_ASSUME_NONNULL_END
