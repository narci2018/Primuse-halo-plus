-- Primuse 歌单同步 + 音乐源管理中心 数据库初始化结构
--
-- 说明：线上库（halo-music-db）里 device_playlists 早就存在，服务端代码用
-- CREATE TABLE IF NOT EXISTS 兜底；本文件用于干净重建一份完整库。
-- 新增的表全部是"附加"，不动 device_playlists 任何一个字段 —— 向下兼容的硬约束。

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

-- 音源清单（服务端成为唯一真相；客户端本地那份降级为断网兜底）
CREATE TABLE IF NOT EXISTS music_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  protocol TEXT NOT NULL,
  base_url TEXT,
  script_hash TEXT,
  quality TEXT DEFAULT '320k',
  enabled INTEGER NOT NULL DEFAULT 1,
  enabled_locked INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  check_status TEXT NOT NULL DEFAULT 'unchecked',
  check_detail TEXT,
  check_bytes INTEGER NOT NULL DEFAULT 0,
  checked_at INTEGER NOT NULL DEFAULT 0,
  fail_streak INTEGER NOT NULL DEFAULT 0,
  suggest_delete INTEGER NOT NULL DEFAULT 0,
  source_count INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_music_sources_enabled ON music_sources(enabled, priority);

-- 洛雪 js 音源正文：gzip + base64 存一行（最大的 1.8MB 混淆稿压完约几百 KB，
-- 不新建 KV/R2，也就不需要额外权限；Workers 里 DecompressionStream('gzip') 可用）
CREATE TABLE IF NOT EXISTS source_scripts (
  hash TEXT PRIMARY KEY,
  name TEXT,
  codec TEXT NOT NULL DEFAULT 'gzip+b64',
  body TEXT NOT NULL,
  raw_bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 每设备界面偏好（需求 5：首页 header 文案按"本机唯一标识"关联）
CREATE TABLE IF NOT EXISTS device_prefs (
  device_id TEXT PRIMARY KEY,
  home_title TEXT,
  extra_json TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cf_sync_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
