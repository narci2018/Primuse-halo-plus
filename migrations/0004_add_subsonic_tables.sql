-- Subsonic API tables.
--
-- These were referenced by functions/rest/[[catchall]].js and
-- functions/api/login.js but were only ever created by schema.sql, so a D1
-- database initialised from migrations/ silently failed every Subsonic token
-- auth (`code 40, Wrong username or password`) and all /rest/* debug logging.
-- schema.sql additionally lacked subsonic_request_log entirely.
-- This migration makes the migrations/ path converge with schema.sql; both use
-- IF NOT EXISTS so re-applying over an existing database is a no-op.

CREATE TABLE IF NOT EXISTS subsonic_auth (
  username TEXT PRIMARY KEY,
  subsonic_secret TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (username) REFERENCES "user"(username) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS subsonic_request_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  action TEXT NOT NULL,
  url TEXT NOT NULL,
  headers TEXT
);

CREATE INDEX IF NOT EXISTS idx_subsonic_request_log_created_at ON subsonic_request_log(created_at);
CREATE INDEX IF NOT EXISTS idx_subsonic_request_log_action ON subsonic_request_log(action);
