-- The index the per-device upload throttle actually needs (src/logs.ts).
--
-- The throttle asks "how many rows has this device stored in the last hour?",
-- which filters on (device_id, received_at). The only index covering device_id
-- is device_logs_device (device_id, time) from 0009, so SQLite narrowed to the
-- device and then scanned every one of its rows — 35,000 of them for the phone
-- that has been uploading all week — on every single upload. That is a lot of
-- work to decide not to do any work, and it is worst exactly during a flood,
-- when uploads arrive every three seconds.
CREATE INDEX IF NOT EXISTS device_logs_device_received ON device_logs (device_id, received_at);
