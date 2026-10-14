// 音源清单的 D1 存储层。
//
// 设计要点：
//  * **不改 device_playlists 一个字段**。新数据全部放新表，老客户端继续走老端点。
//  * 表结构在代码里 auto-create（和 sync-playlists.js 一样的容错风格），
//    这样现网不用先手动跑迁移也能起来；schema.sql 同步更新，供干净重建。
//  * 每次写操作把 sources_revision +1，客户端拿它做实时更新对账（配合 ETag/304）。

export const PLATFORMS = {
  qq: { displayName: "QQ 音乐", meting: "tencent", hyw: "tx", lx: "tx" },
  netease: { displayName: "网易云音乐", meting: "netease", hyw: "wy", lx: "wy" },
  kugou: { displayName: "酷狗音乐", meting: "kugou", hyw: "kg", lx: "kg" },
  kuwo: { displayName: "酷我音乐", meting: "kuwo", hyw: "kw", lx: "kw" },
  bilibili: { displayName: "哔哩哔哩", meting: "bilibili", hyw: "bili", lx: "bil" },
  migu: { displayName: "咪咕音乐", meting: "mguo", hyw: "mg", lx: "mg" },
  custom: { displayName: "自定义源", meting: "netease", hyw: "tx", lx: "wy" },
};

export const PROTOCOLS = ["meting", "hyw", "nxinxz", "openApi", "customJson", "lxjs"];

/** 与 iPhone `AggregatedSourceStore.defaultSources` / Windows `DEFAULT_SOURCES` 逐条对齐的 9 条。 */
export const DEFAULT_SOURCES = [
  { id: "default-qq-hyw", name: "QQ音乐 (HYW 极速无损解析)", platform: "qq", protocol: "hyw", base_url: "http://103.79.184.97/api/music/url", priority: 20 },
  { id: "default-netease-gdstudio", name: "网易云 (GDStudio 320k)", platform: "netease", protocol: "meting", base_url: "https://music-api.gdstudio.xyz/api.php", priority: 18 },
  { id: "default-kuwo-nxinxz", name: "酷我音乐 (NXINXZ 320k)", platform: "kuwo", protocol: "nxinxz", base_url: "http://music.nxinxz.com/kw.php", priority: 16 },
  { id: "default-kugou-hyw", name: "酷狗音乐 (HYW 极速解析)", platform: "kugou", protocol: "hyw", base_url: "http://103.79.184.97/api/music/url", priority: 15 },
  { id: "default-netease-meting-1", name: "网易云 (七洁雅 Meting)", platform: "netease", protocol: "meting", base_url: "https://api.qijieya.cn/meting", priority: 14 },
  { id: "default-netease-meting-3e0", name: "网易云 (DreamMeting 3e0)", platform: "netease", protocol: "meting", base_url: "https://music.3e0.cn", priority: 12 },
  { id: "default-kuwo-hyw", name: "酷我音乐 (HYW 线路)", platform: "kuwo", protocol: "hyw", base_url: "http://103.79.184.97/api/music/url", priority: 10 },
  { id: "default-qq-meting-1", name: "QQ音乐 (七洁雅 Meting 备用)", platform: "qq", protocol: "meting", base_url: "https://api.qijieya.cn/meting", priority: 8 },
  { id: "default-qq-openapi-1", name: "QQ音乐 (Open API 线路)", platform: "qq", protocol: "openApi", base_url: "https://tang.api.s01s.cn/music_open_api.php", priority: 6 },
];

const TABLES = [
  `CREATE TABLE IF NOT EXISTS music_sources (
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
  )`,
  `CREATE TABLE IF NOT EXISTS source_scripts (
    hash TEXT PRIMARY KEY,
    name TEXT,
    codec TEXT NOT NULL DEFAULT 'gzip+b64',
    body TEXT NOT NULL,
    raw_bytes INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS device_prefs (
    device_id TEXT PRIMARY KEY,
    home_title TEXT,
    extra_json TEXT,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS cf_sync_meta (
    key TEXT PRIMARY KEY,
    value TEXT
  )`,
];

let schemaReady = null;

/** 建表只做一次/isolate；失败也缓存，避免每个请求都打四条 D1 写。 */
export async function ensureSchema(env) {
  if (schemaReady) return schemaReady;
  const errs = [];
  for (const sql of TABLES) {
    try {
      await env.DB.prepare(sql).run();
    } catch (e) {
      errs.push(String(e && e.message ? e.message : e));
    }
  }
  if (errs.length === TABLES.length) {
    schemaReady = null;
    throw new Error(`D1 建表失败：${errs[0]}`);
  }
  schemaReady = { errs };
  return schemaReady;
}

/**
 * 首次访问时把内置 9 条灌进 D1（id 与两端客户端完全一致）。
 * 只在表为空时执行，灌完由 D1 接管"唯一真相"；客户端本地那 9 条从此降级为断网兜底。
 */
export async function seedDefaults(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM music_sources").first();
  if (row && Number(row.n) > 0) return 0;
  const now = Date.now();
  const stmts = DEFAULT_SOURCES.map((s) =>
    env.DB.prepare(
      `INSERT INTO music_sources (id, name, platform, protocol, base_url, quality, enabled, priority, check_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '320k', 1, ?, 'unchecked', ?, ?)`
    ).bind(s.id, s.name, s.platform, s.protocol, s.base_url, s.priority, now, now)
  );
  if (stmts.length) await env.DB.batch(stmts);
  return stmts.length;
}

function toInt(v, dflt = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : dflt;
}

export function normalizeSource(input, existing = null) {
  const platform = String(input.platform || input.platformType || (existing && existing.platform) || "custom").trim();
  const protocol = String(input.protocol || input.protocolType || (existing && existing.protocol) || "meting").trim();
  if (!PLATFORMS[platform]) throw new Error(`未知平台：${platform}（可用：${Object.keys(PLATFORMS).join(", ")}）`);
  if (PROTOCOLS.indexOf(protocol) < 0) throw new Error(`未知协议：${protocol}（可用：${PROTOCOLS.join(", ")}）`);
  const name = String(input.name || (existing && existing.name) || `${PLATFORMS[platform].displayName}线路`).trim();
  const baseURL = String(input.baseURL || input.base_url || (existing && existing.base_url) || "").trim();
  if (protocol !== "lxjs" && !/^https?:\/\//i.test(baseURL)) {
    throw new Error("接口地址必须以 http:// 或 https:// 开头");
  }
  if (protocol === "lxjs" && !(input.scriptHash || input.script_hash || (existing && existing.script_hash))) {
    throw new Error("洛雪 js 音源必须先导入脚本（scriptHash 缺失）");
  }
  return {
    id: String(input.id || (existing && existing.id) || `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`).trim(),
    name,
    platform,
    protocol,
    baseURL,
    scriptHash: input.scriptHash || input.script_hash || (existing && existing.script_hash) || null,
    quality: String(input.quality || (existing && existing.quality) || "320k").trim(),
    enabled: input.enabled === undefined || input.enabled === null ? (existing ? Number(existing.enabled) === 1 : true) : Boolean(input.enabled && input.enabled !== 0 && input.enabled !== "0"),
    // enabled_locked = 1 表示"用户手动指定"，体检不再自动改它的启停状态。
    enabledLocked: input.enabledLocked === undefined || input.enabledLocked === null ? (existing ? Number(existing.enabled_locked) === 1 : false) : Boolean(input.enabledLocked && input.enabledLocked !== 0 && input.enabledLocked !== "0"),
    priority: toInt(input.priority, existing ? Number(existing.priority) : 0),
    note: String(input.note !== undefined ? input.note : (existing && existing.note) || "").trim(),
  };
}

export async function listSources(env, { includeDisabled = true } = {}) {
  const sql = `SELECT * FROM music_sources ${includeDisabled ? "" : "WHERE enabled = 1"} ORDER BY priority DESC, updated_at DESC`;
  const res = await env.DB.prepare(sql).all();
  return (res && res.results) || [];
}

export async function getSource(env, id) {
  if (!id) return null;
  const row = await env.DB.prepare("SELECT * FROM music_sources WHERE id = ?").bind(String(id).trim()).first();
  return row || null;
}

export async function upsertSource(env, src) {
  const now = Date.now();
  const created = (await getSource(env, src.id)) || null;
  await env.DB.prepare(
    `INSERT INTO music_sources
      (id, name, platform, protocol, base_url, script_hash, quality, enabled, enabled_locked, priority, note,
       check_status, check_detail, check_bytes, checked_at, fail_streak, suggest_delete, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?, ?,?, ?,?)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, platform=excluded.platform, protocol=excluded.protocol, base_url=excluded.base_url,
       script_hash=excluded.script_hash, quality=excluded.quality, enabled=excluded.enabled,
       enabled_locked=excluded.enabled_locked, priority=excluded.priority, note=excluded.note,
       check_status=excluded.check_status, check_detail=excluded.check_detail, check_bytes=excluded.check_bytes,
       checked_at=excluded.checked_at, fail_streak=excluded.fail_streak, suggest_delete=excluded.suggest_delete,
       updated_at=excluded.updated_at`
  ).bind(
    src.id, src.name, src.platform, src.protocol, src.baseURL || null, src.scriptHash || null, src.quality,
    src.enabled ? 1 : 0, src.enabledLocked ? 1 : 0, src.priority, src.note || null,
    (created && created.check_status) || "unchecked", (created && created.check_detail) || null,
    created ? Number(created.check_bytes) : 0, created ? Number(created.checked_at) : 0,
    created ? Number(created.fail_streak) : 0, created ? Number(created.suggest_delete) : 0,
    created ? Number(created.created_at) : now, now
  ).run();
  return getSource(env, src.id);
}

export async function deleteSource(env, id) {
  const r = await env.DB.prepare("DELETE FROM music_sources WHERE id = ?").bind(String(id).trim()).run();
  return meta(r).changes;
}

export async function writeCheckResult(env, id, result) {
  const now = Date.now();
  const cur = await getSource(env, id);
  const pass = result.status === "ok";
  // 「检不出结果」和「检出不行」是两回事，必须分开（用户要求停用/建议删除只针对后者）：
  //   no_sample       洛雪音源不会搜索，样本池空着时我们根本没有可考的歌曲 id —— 观测盲区
  //   runner_missing  runner Worker 没部署该脚本/不可达 —— 服务端自己的基础设施问题
  //   unsupported     customJson 协议两端都不做搜索 —— 按定义无法验证
  // 这三种如果也去停用，就是把"我没看清"当成"它不行"，会误杀好源。
  // 反过来 script_uncompilable（脚本在 runner 沙箱里连编译都过不去）不在这里：
  // 那是这条源永远出不了声，停用 + 建议删除才对得上"能播的源才有价值"。
  const inconclusive = ["no_sample", "runner_missing", "unsupported"].indexOf(result.status) >= 0;
  const streak = pass ? 0 : inconclusive ? Number((cur && cur.fail_streak) || 0) : Number((cur && cur.fail_streak) || 0) + 1;
  // 检不到可用的源：直接停用 + 建议删除（用户明确要求）。用户手动锁过启停的源不动它的 enabled。
  const enabled = cur && Number(cur.enabled_locked) === 1
    ? Number(cur.enabled)
    : pass || inconclusive ? Number((cur && cur.enabled) ?? 1) : 0;
  await env.DB.prepare(
    `UPDATE music_sources SET
       check_status=?, check_detail=?, check_bytes=?, checked_at=?, fail_streak=?, suggest_delete=?, enabled=?, updated_at=?
     WHERE id=?`
  ).bind(
    result.status, String(result.detail || "").slice(0, 500), Number(result.bytes || 0), now, streak,
    pass || inconclusive ? 0 : 1, enabled, now, String(id)
  ).run();
  return { enabled: enabled === 1, failStreak: streak, suggestDelete: pass || inconclusive ? 0 : 1, inconclusive };
}

export async function getDevicePref(env, deviceId) {
  if (!deviceId) return null;
  const row = await env.DB.prepare("SELECT * FROM device_prefs WHERE device_id = ?").bind(String(deviceId).trim()).first();
  return row || null;
}

export async function setDevicePref(env, deviceId, fields) {
  const now = Date.now();
  const cur = await getDevicePref(env, deviceId);
  const homeTitle = fields.homeTitle === undefined ? (cur && cur.home_title) || null : String(fields.homeTitle).slice(0, 60);
  const extra = fields.extra === undefined ? (cur && cur.extra_json) || null : JSON.stringify(fields.extra);
  await env.DB.prepare(
    `INSERT INTO device_prefs (device_id, home_title, extra_json, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(device_id) DO UPDATE SET home_title=excluded.home_title, extra_json=excluded.extra_json, updated_at=excluded.updated_at`
  ).bind(String(deviceId).trim(), homeTitle === "" ? null : homeTitle, extra, now).run();
  return getDevicePref(env, deviceId);
}

/** 全局默认值（首页文案这类）放 cf_sync_meta，客户端没有 deviceId 或设备没单独设置时用它。 */
export async function metaGet(env, key, dflt = null) {
  const row = await env.DB.prepare("SELECT value FROM cf_sync_meta WHERE key = ?").bind(key).first();
  return row && row.value !== null && row.value !== undefined ? row.value : dflt;
}

export async function metaSet(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO cf_sync_meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  ).bind(key, String(value)).run();
}

export async function bumpRevision(env) {
  const cur = Number((await metaGet(env, "sources_revision", "0")) || 0);
  const next = cur + 1;
  await metaSet(env, "sources_revision", String(next));
  await metaSet(env, "sources_revision_at", String(Date.now()));
  return next;
}

export async function currentRevision(env) {
  return {
    revision: Number((await metaGet(env, "sources_revision", "0")) || 0),
    revisionAt: Number((await metaGet(env, "sources_revision_at", "0")) || 0),
  };
}

export async function saveScript(env, { hash, name, gzipBase64, rawBytes }) {
  const now = Date.now();
  const cur = await env.DB.prepare("SELECT hash FROM source_scripts WHERE hash = ?").bind(hash).first();
  await env.DB.prepare(
    `INSERT INTO source_scripts (hash, name, codec, body, raw_bytes, created_at, updated_at) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(hash) DO UPDATE SET name=excluded.name, codec=excluded.codec, body=excluded.body, raw_bytes=excluded.raw_bytes, updated_at=excluded.updated_at`
  ).bind(hash, name || null, "gzip+b64", gzipBase64, Number(rawBytes || 0), cur ? Number(cur.created_at || now) : now, now).run();
  return { hash, reused: Boolean(cur) };
}

export async function loadScript(env, hash) {
  if (!hash) return null;
  const row = await env.DB.prepare("SELECT * FROM source_scripts WHERE hash = ?").bind(String(hash)).first();
  return row || null;
}

export function meta(row) {
  const out = row && row.meta ? row.meta : {};
  return { changes: Number(out.changes || 0), duration: Number(out.duration || 0) };
}

export function publicSource(row) {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    protocol: row.protocol,
    baseURL: row.base_url || "",
    scriptHash: row.script_hash || null,
    hasScript: Boolean(row.script_hash),
    quality: row.quality || "320k",
    enabled: Number(row.enabled) === 1,
    enabledLocked: Number(row.enabled_locked) === 1,
    priority: Number(row.priority || 0),
    note: row.note || "",
    check: {
      status: row.check_status || "unchecked",
      detail: row.check_detail || "",
      bytes: Number(row.check_bytes || 0),
      checkedAt: Number(row.checked_at || 0),
      failStreak: Number(row.fail_streak || 0),
    },
    suggestDelete: Number(row.suggest_delete) === 1,
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
  };
}
