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
/// Batches of motion samples and the source they came from; the shape of each source's
/// samples is documented on MotionSample in UteBle.types.ts.
@property (nonatomic, copy, nullable) void (^onMotion)(NSString *source, NSArray<NSArray<NSNumber *> *> *samples);
/// Vendor SDK log lines, forwarded while a connect is in flight or while `sdkLogging` is on.
@property (nonatomic, copy, nullable) void (^onLog)(NSString *line);
/// Forward every SDK log line, not only during a connect. They include the raw packets ("App receive …").
@property (nonatomic, assign) BOOL sdkLogging;

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
/// Turns the clip's light on or off (the wearables' factory LED command). colors: UTELEDType bits,
/// 1 red, 2 green, 4 blue. colors 0: the watch's three-color LED test instead (on/off only).
/// Whether the ES100 honours either is unknown.
- (void)setLight:(BOOL)on colors:(NSInteger)colors completion:(UteBleResultCallback)completion
    NS_SWIFT_NAME(setLight(on:colors:completion:));
/// Asks the clip for heart rate (or blood oxygen). method "factory": the factory heart-rate test, which
/// answers again with each reading while on (open, worn 1/0, bpm; 0 until it has one). "spo2": the
/// factory blood-oxygen test, same shape. "measure": a one-off measurement (clickMeasurementType HRM);
/// its result comes later. Readings also arrive as onInput kind "heartRate" / "spo2". Firmware claims
/// the factory tests (isSupportHeartRateTest); whether the ES100 has the optical sensor is untested.
- (void)setHeartRate:(NSString *)method on:(BOOL)on completion:(UteBleResultCallback)completion
    NS_SWIFT_NAME(setHeartRate(_:on:completion:));
/// Turns one motion source on or off (see MotionSource in UteBle.types.ts). Polled sources ask every
/// `intervalMs`. 408: the clip didn't answer; -600: unknown source.
- (void)setMotionSource:(NSString *)source
                     on:(BOOL)on
             intervalMs:(NSInteger)intervalMs
             completion:(void (^)(NSInteger errorCode))completion
    NS_SWIFT_NAME(setMotionSource(_:on:intervalMs:completion:));
/// Today's activity totals as the SDK reports them (steps change when the clip moves).
- (void)readActivity:(UteBleResultCallback)completion NS_SWIFT_NAME(readActivity(completion:));
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
