#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

// All UTEBluetoothRYApi calls go through here so the Swift module never depends
// on how Swift imports the vendor's selectors and nullability, which shifts
// between Xcode releases. Only Foundation types cross this boundary.
//
// Error codes are normalized: 0 means success. The SDK itself reports success as
// UTEDeviceErrorNil (100000) on most calls and 0 on a few, which is why every
// record call used to look like a failure.

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
@property (nonatomic, copy, nullable) void (^onSyncProgress)(NSInteger sessionId, NSInteger received, NSInteger total);
/// A transfer ended: `data` is everything received (possibly short), `error` is set when nothing usable arrived.
@property (nonatomic, copy, nullable) void (^onSyncFinished)(NSInteger sessionId, NSData *data, NSString *_Nullable error);
/// The post-connect handshake: account check, then pairing confirmation.
@property (nonatomic, copy, nullable) void (^onPairing)(BOOL paired, NSString *message);
/// Anything else the clip reports on its own: battery, AI/voice button, voice data.
@property (nonatomic, copy, nullable) void (^onInput)(NSDictionary<NSString *, id> *input);
/// Batches of motion samples and the source they came from ("game": [x, y, speed, xThrow, yThrow, speedThrow];
/// "wear6": [x, y, z, angle]; "wear3"/"gyro": [x, y, z]; "gsensor": [x, y, z, speed]).
@property (nonatomic, copy, nullable) void (^onMotion)(NSString *source, NSArray<NSArray<NSNumber *> *> *samples);
/// Vendor SDK log lines, forwarded only while a connect is in flight.
@property (nonatomic, copy, nullable) void (^onLog)(NSString *line);

- (NSString *)setUp NS_SWIFT_NAME(setUp());
- (void)startScan NS_SWIFT_NAME(startScan());
- (void)stopScan NS_SWIFT_NAME(stopScan());
- (BOOL)connectDeviceWithId:(NSString *)deviceId NS_SWIFT_NAME(connect(deviceId:));
- (BOOL)disconnectDevice NS_SWIFT_NAME(disconnect());
- (BOOL)connected NS_SWIFT_NAME(isConnected());
- (nullable NSDictionary<NSString *, id> *)connectedDeviceInfo NS_SWIFT_NAME(connectedDevice());
/// Every `has…` flag on the connected device model, by name.
- (NSDictionary<NSString *, NSNumber *> *)capabilities NS_SWIFT_NAME(capabilities());

- (void)bindWithToken:(NSString *)token verify:(NSInteger)verify completion:(UteBleResultCallback)completion
    NS_SWIFT_NAME(bind(token:verify:completion:));
- (void)fetchStatus:(UteBleResultCallback)completion NS_SWIFT_NAME(getStatus(completion:));
- (void)fetchStorageInfo:(UteBleResultCallback)completion NS_SWIFT_NAME(getStorageInfo(completion:));
- (void)fetchBattery:(UteBleResultCallback)completion NS_SWIFT_NAME(getBattery(completion:));
- (void)fetchRssi:(UteBleResultCallback)completion NS_SWIFT_NAME(getRssi(completion:));
- (void)fetchEncodingConfig:(UteBleResultCallback)completion NS_SWIFT_NAME(getEncodingConfig(completion:));
/// Which sensor self-tests the firmware claims (accelerometer, gyroscope, button, motor).
- (void)probeSensors:(UteBleResultCallback)completion NS_SWIFT_NAME(probeSensors(completion:));
/// One gyroscope reading (factory command): range, x, y, z.
- (void)readGyro:(UteBleResultCallback)completion NS_SWIFT_NAME(readGyro(completion:));
/// Starts or stops the motion stream (the SDK's "motion-sensing game" feed).
- (void)setMotionStream:(BOOL)on completion:(void (^)(NSInteger errorCode))completion
    NS_SWIFT_NAME(setMotionStream(on:completion:));
/// Vibrates the clip. option 1: find-device on/off, 2: factoryVibration, 3: factory motor test.
- (void)buzz:(NSInteger)count option:(NSInteger)option completion:(UteBleResultCallback)completion
    NS_SWIFT_NAME(buzz(count:option:completion:));
/// Turns one motion source on or off: "game", "wear6", "wear3", "gsensor" or "gyro". 408: the clip didn't answer.
- (void)setMotionSource:(NSString *)source on:(BOOL)on completion:(void (^)(NSInteger errorCode))completion
    NS_SWIFT_NAME(setMotionSource(_:on:completion:));
/// Which factory functions a wearable reports (type = UTEWearFunction, e.g. 7 Gsensor3, 9 Gsensor6).
- (void)probeWearFunctions:(UteBleResultCallback)completion NS_SWIFT_NAME(probeWearFunctions(completion:));
- (void)beginRecording:(UteBleResultCallback)completion NS_SWIFT_NAME(startRecord(completion:));
- (void)pauseRecordingSession:(NSInteger)sessionId completion:(UteBleResultCallback)completion
    NS_SWIFT_NAME(pauseRecord(sessionId:completion:));
- (void)resumeRecordingSession:(NSInteger)sessionId completion:(UteBleResultCallback)completion
    NS_SWIFT_NAME(resumeRecord(sessionId:completion:));
- (void)endRecording:(UteBleResultCallback)completion NS_SWIFT_NAME(stopRecord(completion:));
- (void)fetchFileList:(UteBleResultCallback)completion NS_SWIFT_NAME(listFiles(completion:));
/// Starts pulling a file. `completion` reports whether the clip accepted the request;
/// the data arrives through onSyncProgress / onSyncFinished.
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
