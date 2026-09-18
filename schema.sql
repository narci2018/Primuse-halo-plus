CREATE TABLE IF NOT EXISTS "user" (
  username TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS music_sessions (
  token TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (username) REFERENCES "user"(username) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_music_sessions_username ON music_sessions(username);
CREATE INDEX IF NOT EXISTS idx_music_sessions_expires_at ON music_sessions(expires_at);

CREATE TABLE IF NOT EXISTS music_libraries (
  username TEXT PRIMARY KEY,
  library_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (username) REFERENCES "user"(username) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS music_cache (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_music_cache_expires_at ON music_cache(expires_at);

CREATE TABLE IF NOT EXISTS search_cache (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_search_cache_expires_at ON search_cache(expires_at);

CREATE TABLE IF NOT EXISTS subsonic_auth (
  username TEXT PRIMARY KEY,
  subsonic_secret TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (username) REFERENCES "user"(username) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS device_playlists (
  device_id TEXT PRIMARY KEY,
  device_name TEXT,
  platform TEXT,
  playlists_json TEXT NOT NULL,
  playlist_count INTEGER DEFAULT 0,
  song_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_device_playlists_updated ON device_playlists(updated_at);
