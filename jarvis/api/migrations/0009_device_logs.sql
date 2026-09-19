-- Live logs uploaded by the app (console output, errors, voice and ES100 events)
-- so problems on the phone can be read without the phone. Kept for 7 days.
CREATE TABLE device_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id  TEXT NOT NULL,
  user_id    TEXT,
  session_id TEXT NOT NULL,
  app_build  TEXT,
  time       INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  text       TEXT NOT NULL,
  detail     TEXT,
  received_at INTEGER NOT NULL
);
CREATE INDEX device_logs_time ON device_logs (time);
CREATE INDEX device_logs_device ON device_logs (device_id, time);
