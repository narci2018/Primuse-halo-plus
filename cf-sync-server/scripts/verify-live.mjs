// 现网只读验证：一条命令回答"这套 CF 服务在线上到底通不通"。
//
// 全脚本没有任何写操作（不发管理令牌、不 POST 音源表、不改设备偏好），
// 可以在任意时刻重复跑，包括体检正在跑的时候。它验证的是**用户实际会走的那条路**：
// 客户端只保存一个 URL → 清单 → 搜索 → 解析直链 → 真的取回可播音频字节。
//
// 用法：
//   node scripts/verify-live.mjs
//   node scripts/verify-live.mjs --base=https://xxx.pages.dev
//
// 为什么要单独有它：本地契约测试（tests/cf-contract.test.mjs）证明的是代码逻辑，
// 而 Pages 的 Secrets/绑定是按部署生效的 —— 线上漏配一个 LX_RUNNER_URL，
// 本地全绿、现网所有 lxjs 源一起变哑。这层漂移只有打真线上才能发现。

const BASE = (process.env.PAGES_BASE_URL || "https://primuse-sync-server.pages.dev").replace(/\/+$/, "");
const DEV = "verify-live-readonly";

let pass = 0;
const fails = [];
function check(name, ok, note = "") {
  if (ok) { pass += 1; console.log(`OK   | ${name}${note ? " — " + note : ""}`); }
  else { fails.push(name); console.log(`FAIL | ${name}${note ? " — " + note : ""}`); }
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(45000) });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function post(action, body, prefix = "music-gateway") {
  const res = await fetch(`${BASE}/api/${prefix}?action=${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(90000),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** 只看字节能不能真播：音频魔数 + 体量，不看"声称的 content-type"。 */
async function fetchAudio(url) {
  const res = await fetch(url, {
    headers: { range: "bytes=0-65535", "user-agent": "Mozilla/5.0" },
    redirect: "follow",
    signal: AbortSignal.timeout(45000),
  });
  const buf = new Uint8Array(await res.arrayBuffer());
  const magic =
    (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) || // ID3
    (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) || // MPEG 帧同步
    (buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) || // OggS
    (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70); // mp4 ftyp
  return { status: res.status, ct: res.headers.get("content-type") || "", bytes: buf.length, magic, host: new URL(res.url).hostname };
}

console.log(`现网只读验证：${BASE}\n`);

// ── 1. 向下兼容：老端点必须还认 ────────────────────────────────────────
const legacy = await get("/api/sync-playlists");
check(
  "歌单端点 /api/sync-playlists 仍在线（新增音乐源管理没有动坏老功能）",
  legacy.status === 200 && legacy.json?.code === 0 && Array.isArray(legacy.json?.data?.devices),
  `HTTP ${legacy.status} · 设备 ${(legacy.json?.data?.devices || []).length} 台`
);

// ── 2. 清单（客户端唯一需要保存的那个 URL）────────────────────────────
const manifest = await get(`/api/music-sources?deviceId=${DEV}`);
const m = manifest.json?.data;
check("清单契约 primuse.music-sources.v1", manifest.status === 200 && m?.contract === "primuse.music-sources.v1", `revision=${m?.revision}`);
check("清单里有网关地址与可用动作", Boolean(m?.gateway?.base) && Array.isArray(m?.gateway?.actions), JSON.stringify(m?.gateway || null));
// runtime 是客户端"哪些协议我在本地算、哪些必须交给服务端"的唯一依据。
// 它曾经一直是 undefined —— 因为清单正文由一个永远不会被调用的 manifest() 死代码拼，
// 现网走的是另一条路。契约测试盯不住"两条路"，所以这条要在线上再断一次。
check(
  "清单带 runtime：lxjs 标明由服务端 runner 执行，其余协议可本地直连",
  m?.runtime?.lxjs === "server-runner" && m?.runtime?.meting === "client-or-gateway" && m?.runtime?.customJson === "none",
  JSON.stringify(m?.runtime || null)
);
check(
  "清单带「首页文案」设置（需求 5：服务端可设、按本机唯一标识关联）",
  Boolean(m?.settings) && typeof m.settings.homeTitle === "string" && m.settings.homeTitle.length > 0 && m.settings.deviceId === DEV,
  JSON.stringify(m?.settings || null)
);
const usable = (m?.usable || []).length;
check("体检结论已进清单：usable 非空", usable > 0, `启用 ${(m?.sources || []).filter((s) => s.enabled).length} 条 · usable ${usable} 条 · 建议删除 ${(m?.suggestions || []).length} 条`);
const usableLxjs = (m?.sources || []).filter((s) => m.usable.includes(s.id) && s.protocol === "lxjs");
check("usable 里有 lxjs 源（洛雪 js 音源在线上真的可用）", usableLxjs.length > 0, `${usableLxjs.length} 条：${usableLxjs.slice(0, 3).map((s) => s.name).join("、")}`);

// ETag → 304：客户端"实时更新"就靠它（轮询便宜，变了才拉正文）。
const tag = (await fetch(`${BASE}/api/music-sources?deviceId=${DEV}`, { signal: AbortSignal.timeout(30000) })).headers.get("etag");
const again = await fetch(`${BASE}/api/music-sources?deviceId=${DEV}`, { headers: { "if-none-match": tag || "" }, signal: AbortSignal.timeout(30000) });
check("清单支持 ETag → 304（客户端轮询不重复下载正文）", Boolean(tag) && again.status === 304, `ETag=${tag} · 第二次 HTTP ${again.status}`);

// ── 3. 网关：搜索 → 解析 → 真取音频 ────────────────────────────────────
const caps = await post("capabilities", {});
check("网关 capabilities 在线并给出各协议启用数", caps.json?.code === 0 && Number(caps.json?.data?.enabledSourceCount) > 0, JSON.stringify(caps.json?.data?.byProtocol));

const search = await post("search", { action: "search", keyword: "晴天", platform: "netease", limit: 5 });
const hit = search.json?.data?.results?.[0];
check("网关搜索有结果", search.json?.code === 0 && Number(search.json?.data?.count) > 0, `命中 ${search.json?.data?.count ?? 0} 条 · 首选 ${hit?.title} / ${hit?.artist}`);

// 洛雪源能不能被搜到，决定客户端要不要自己再装一套搜索。这里**不能**断言"必须搜到歌"：
// 官方洛雪协议只保证 musicUrl，搜索是各家脚本自己加的，而且它们的搜索站自己会挂
// （实测 2026-10-14：4 条被扫的源里 2 条未声明 search、1 条返回非 JSON、1 条答"该平台不支持搜索"）。
// 能确定的是网关必须**诚实**：每条被扫的 lxjs 源要么进结果，要么在 notes 里留下原因 ——
// 静默丢掉就是代码坏了（lxBallot 没 await、capabilities 判错、异常被吞）。
const lxFromGw = (search.json?.data?.results || []).filter((r) => r.protocol === "lxjs");
const lxNotes = (search.json?.data?.notes || []).filter((n) => String(n.id).startsWith("lxjs-"));
const triedLx = new Set([...lxFromGw.map((r) => r.sourceId), ...lxNotes.map((n) => n.id)]);
check(
  "网关搜索对每条被扫的洛雪源都给了交代（进结果或写明落选原因，不静默丢弃）",
  lxNotes.length > 0 && [...lxNotes].every((n) => n.note && n.name),
  `洛雪进结果 ${lxFromGw.length} 条 · 有交代 ${triedLx.size} 条 · ${lxNotes.map((n) => `${n.name}:${n.note}`).join(" / ").slice(0, 260)}`
);
check(
  "每条搜索结果都自带 protocol/sourceId（客户端据此决定本地播还是走网关，不用回查清单）",
  (search.json?.data?.results || []).length > 0 && (search.json?.data?.results || []).every((r) => r.protocol && r.sourceId && r.rawID),
  JSON.stringify((search.json?.data?.results || []).slice(0, 2).map((r) => [r.protocol, r.sourceId, r.rawID]))
);

const rawUrl = await post("url", { action: "url", rawID: hit?.rawID, platform: hit?.platform || "netease", quality: "320k" });
const url = rawUrl.json?.data?.url;
check(`网关能解析出直链（来源 ${rawUrl.json?.data?.sourceName || "?"} / ${rawUrl.json?.data?.protocol || "?"}）`, Boolean(url), String(url).slice(0, 70));
if (url) {
  const a = await fetchAudio(url);
  check("该直链在字节层真是音频（HTTP 206 + 魔数 + >8KB）", a.status === 206 && a.magic && a.bytes > 8192, `${a.status} ${a.ct.split(";")[0]} ${a.bytes}B 魔数=${a.magic} 源站=${a.host}`);
}

// 指名点姓走 lxjs：这一步才真正穿过 runner Worker（Pages → runner → 第三方站）。
const lx = usableLxjs[0];
if (lx) {
  const lxUrl = await post("url", { action: "url", sourceId: lx.id, rawID: hit?.rawID, platform: lx.platform, quality: "320k" });
  const u2 = lxUrl.json?.data?.url;
  check(`lxjs 源经 runner 解析出直链（${lx.name}）`, Boolean(u2), u2 ? String(u2).slice(0, 70) : JSON.stringify(lxUrl.json || {}).slice(0, 200));
  if (u2) {
    const a2 = await fetchAudio(u2);
    check("runner 给的直链也是真音频", a2.status === 206 && a2.magic && a2.bytes > 8192, `${a2.status} ${a2.ct.split(";")[0]} ${a2.bytes}B 魔数=${a2.magic} 源站=${a2.host}`);
  }
}

// ── 4. 判死要拦：被体检停用/判不可用的源，指名点姓必须被拒 ──────────────
const dead = (m?.suggestions || [])[0];
if (dead) {
  const denied = await post("url", { action: "url", sourceId: dead.id, rawID: hit?.rawID || "108914", platform: "netease" });
  check("不可用的源指名点姓时返回 409（不把死源伪装成能播）", denied.status === 409 || denied.json?.code === 409, `HTTP ${denied.status} · ${String(denied.json?.error || denied.json?.message || "").slice(0, 120)}`);
}

// ── 5. 脚本正文取不回明文（清单不外泄源码，只给哈希）───────────────────
const noScriptField = (m?.sources || []).every((s) => !s.script || !s.scriptText);
check("清单里不含脚本正文（只有 scriptHash，源码不外泄）", noScriptField, `字段样例 ${Object.keys(m?.sources?.[0] || {}).join("/")}`);

console.log(`\n==== 现网只读验证：${pass} 通过 / ${fails.length} 失败 ====`);
for (const f of fails) console.log(`  ❌ ${f}`);
process.exit(fails.length ? 1 : 0);
