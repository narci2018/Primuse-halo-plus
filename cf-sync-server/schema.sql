-- Primuse 歌单同步数据库初始化结构
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
