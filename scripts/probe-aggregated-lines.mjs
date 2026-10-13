// Read-only health probe for the aggregated (third-party) music lines that the
// Primuse client reaches directly, i.e. AggregatedSourceStore.defaultSources.
//
// Why this exists: the cross-platform plan (docs/cross-platform-plan.md, decision
// D6) says the Windows client gets 酷狗/酷我 by hitting these lines from the
// Electron main process instead of the Cloudflare backend. That only holds if the
// lines actually answer search AND stream resolution. A line that returns results
// but an empty body for ?type=url is unusable, so each line is probed for both.
//
// Request shapes mirror the Swift builders exactly — including the two places
// where Swift ignores the configured baseURL and hardcodes a host — so the matrix
// reflects what the shipped client really does, not what the config claims.
//
// Usage: node scripts/probe-aggregated-lines.mjs [keyword] [--timeout=7000]

const KEYWORD = (process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "晴天").trim();
const TIMEOUT = Number((process.argv.find((a) => a.startsWith("--timeout=")) || "").split("=")[1] || 7000);
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)";

const METING_SERVER = { qq: "tencent", netease: "netease", kugou: "kugou", kuwo: "kuwo", bilibili: "bilibili" };
const HYW_KEY = { qq: "tx", netease: "wy", kugou: "kg", kuwo: "kw", bilibili: "bili" };

// id, platform, protocol, baseURL — verbatim from AggregatedSourceStore.swift:18-101
const LINES = [
  { id: "default-qq-hyw",        platform: "qq",      protocol: "hyw",     base: "http://103.79.184.97/api/music/url" },
  { id: "default-netease-gdstudio", platform: "netease", protocol: "meting", base: "https://music-api.gdstudio.xyz/api.php" },
  { id: "default-kuwo-nxinxz",   platform: "kuwo",    protocol: "nxinxz",  base: "http://music.nxinxz.com/kw.php" },
  { id: "default-kugou-hyw",     platform: "kugou",   protocol: "hyw",     base: "http://103.79.184.97/api/music/url" },
  { id: "default-netease-meting-1", platform: "netease", protocol: "meting", base: "https://api.qijieya.cn/meting" },
  { id: "default-netease-meting-3e0", platform: "netease", protocol: "meting", base: "https://music.3e0.cn" },
  { id: "default-kuwo-hyw",      platform: "kuwo",    protocol: "hyw",     base: "http://103.79.184.97/api/music/url" },
  { id: "default-qq-meting-1",   platform: "qq",      protocol: "meting",  base: "https://api.qijieya.cn/meting" },
  { id: "default-qq-openapi-1",  platform: "qq",      protocol: "openApi", base: "https://tang.api.s01s.cn/music_open_api.php" },
];

function searchUrl(line) {
  const k = encodeURIComponent(KEYWORD);
  const base = line.base.replace(/\/+$/, "");
  const server = METING_SERVER[line.platform];
  switch (line.protocol) {
    case "meting":
      return base.includes("api.php")
        ? `${base}?types=search&count=20&source=${server}&pages=1&name=${k}`
        : `${base}?type=search&id=${k}&server=${server}&limit=20`;
    // .hyw and .nxinxz search branches ignore line.base entirely (AggregatedMusicService.swift:133-169)
    case "hyw":
      if (line.platform === "qq") return `https://api.qijieya.cn/meting?type=search&id=${k}&server=tencent&limit=20`;
      if (line.platform === "kugou") return `https://api.qijieya.cn/meting?type=search&id=${k}&server=kugou&limit=20`;
      if (line.platform === "kuwo") return `https://music-api.gdstudio.xyz/api.php?types=search&count=20&source=kuwo&name=${k}`;
      return `https://music-api.gdstudio.xyz/api.php?types=search&count=20&source=netease&name=${k}`;
    case "nxinxz":
      return `https://music-api.gdstudio.xyz/api.php?types=search&count=20&source=kuwo&name=${k}`;
    case "openApi":
      return `${base}?msg=${k}&type=json`;
    default:
      return null; // .customJson returns [] in the client
  }
}

function resolveUrl(line, rawID) {
  const base = line.base.replace(/\/+$/, "");
  const server = METING_SERVER[line.platform];
  switch (line.protocol) {
    case "meting":
      return base.includes("api.php")
        ? `${base}?types=url&source=${server}&id=${encodeURIComponent(rawID)}&br=320`
        : `${base}?server=${server}&type=url&id=${encodeURIComponent(rawID)}&br=320`;
    case "hyw":
      return `${base}?source=${HYW_KEY[line.platform]}&songId=${encodeURIComponent(rawID)}&quality=320k`;
    case "nxinxz":
      return `${base}?id=${encodeURIComponent(rawID)}&level=320k&type=mp3`;
    case "openApi":
      return `${base}?msg=${encodeURIComponent(rawID)}&type=url`;
    default:
      return null;
  }
}

function lyricUrl(line, rawID) {
  const base = line.base.replace(/\/+$/, "");
  const server = METING_SERVER[line.platform];
  switch (line.protocol) {
    case "meting":
      return base.includes("api.php")
        ? `${base}?types=lyric&source=${server}&id=${encodeURIComponent(rawID)}`
        : `${base}?server=${server}&type=lrc&id=${encodeURIComponent(rawID)}`;
    case "hyw":
      return `${base}?source=${HYW_KEY[line.platform]}&songId=${encodeURIComponent(rawID)}&type=lrc`;
    case "nxinxz":
      return `${base}?msg=${encodeURIComponent(rawID)}&type=lrc`;
    default:
      return null;
  }
}

// Mirrors parseMetingSearchResults' id fallback chain (…:197-208) plus the openApi shape.
function pickID(item) {
  for (const key of ["id", "url_id", "songmid", "songId"]) {
    const v = item[key];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  for (const key of ["url", "lrc"]) {
    const m = /id=([^&]+)/.exec(String(item[key] ?? ""));
    if (m) return m[1];
  }
  return "";
}

async function get(url, { range } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  const t0 = Date.now();
  try {
    const headers = { "User-Agent": UA };
    // Audio probes must never pull a whole track down; a 4 KiB ranged GET is enough
    // to prove the endpoint yields sound.
    if (range) headers.Range = range;
    const resp = await fetch(url, { signal: ctrl.signal, redirect: "follow", headers });
    const body = await resp.text();
    return { status: resp.status, ct: (resp.headers.get("content-type") || "").split(";")[0], body, ms: Date.now() - t0, finalUrl: resp.url };
  } catch (err) {
    return { status: 0, ct: "", body: "", ms: Date.now() - t0, error: err.name === "AbortError" ? `timeout>${TIMEOUT}ms` : String(err.cause?.code || err.message) };
  } finally {
    clearTimeout(timer);
  }
}

// A resolve endpoint is "audio" only if the payload is really sound: either the
// response is an audio content-type, or the final URL left the API host entirely.
function judgeAudio(res, requestUrl) {
  if (res.error) return `FAIL(${res.error})`;
  if (res.status >= 400) return `FAIL(http ${res.status})`;
  if (/audio|video|octet-stream/.test(res.ct) && res.body.length > 1024) return `AUDIO(${res.ct}, ${res.body.length}B)`;
  if (res.status === 200 && res.body.trim() === "") return "EMPTY-BODY";
  const preview = res.body.replace(/\s+/g, " ").slice(0, 60);
  if (/^https?:/.test(preview) && !preview.includes("type=url")) return `URL(${preview.slice(0, 70)})`;
  try {
    if (res.finalUrl && new URL(res.finalUrl).host !== new URL(requestUrl).host) return `REDIRECT(${new URL(res.finalUrl).host})`;
  } catch { /* ignore */ }
  return `NOT-AUDIO(ct=${res.ct || "-"}, ${preview.slice(0, 50) || "empty"})`;
}

const rows = [];
// These public endpoints flap: the same host returned 200 minutes before a 503.
// One retry on 5xx/timeout keeps a transient outage from being recorded as a dead line.
async function getWithRetry(url, opts) {
  const first = await get(url, opts);
  const flaky = first.error || first.status >= 500 || (first.status === 200 && first.body.trim() === "" && !opts?.range);
  if (!flaky) return first;
  await new Promise((r) => setTimeout(r, 1200));
  const second = await get(url, opts);
  return second.status < first.status || second.error ? first : second;
}

for (const line of LINES) {
  const s = searchUrl(line);
  const sr = await getWithRetry(s);
  let items = [];
  try {
    const json = JSON.parse(sr.body);
    items = Array.isArray(json) ? json : (json?.data ?? json?.list ?? json?.result ?? []);
    if (!Array.isArray(items)) items = [];
  } catch { /* not JSON — treated as a failed search below */ }
  const first = items[0];
  const rawID = first ? pickID(first) : "";
  const title = first ? String(first.name ?? first.title ?? first.song_name ?? "") : "";

  let audio = "—";
  let lyric = "—";
  if (rawID) {
    const ru = resolveUrl(line, rawID);
    if (ru) {
      const rr = await getWithRetry(ru, { range: "bytes=0-4096" });
      // Two shapes hand back a bare URL: plain text, or JSON {"url": "…"} — both are
      // handled by resolveStreamURLFromSource (AggregatedMusicService.swift:329-341),
      // so the probe has to follow them the same way the client does.
      let candidate = "";
      const text = rr.body.trim();
      if (/^https?:\/\/\S+$/.test(text) && !text.includes("type=url")) candidate = text;
      else {
        try {
          const j = JSON.parse(text);
          if (typeof j?.url === "string" && j.url.startsWith("http")) candidate = j.url;
        } catch { /* not JSON */ }
      }
      if (candidate) {
        const probe = await getWithRetry(candidate, { range: "bytes=0-4096" });
        audio = `URL→${judgeAudio(probe, candidate)}`;
      } else {
        audio = judgeAudio(rr, ru);
      }
    }
    const lu = lyricUrl(line, rawID);
    if (lu) {
      const lr = await get(lu);
      lyric = lr.error ? `FAIL(${lr.error})` : (lr.status === 200 && /\[.*:\d/.test(lr.body) ? `LRC(${lr.body.length}B)` :
        lr.status === 200 && lr.body.trim() ? `TEXT(${lr.body.replace(/\s+/g, " ").slice(0, 40)})` : `EMPTY(${lr.status})`);
    }
  }

  rows.push({
    line: line.id,
    plat: line.platform,
    proto: line.protocol,
    search: sr.error ? `FAIL(${sr.error})` : `http ${sr.status} → ${items.length}${items.length ? ` (“${title}”, id=${rawID || "?"})` : ` ${sr.body.replace(/\s+/g, " ").slice(0, 46)}`}`,
    audio,
    lyric,
  });
}

console.log(`聚合线路体检 · 关键词「${KEYWORD}」 · 超时 ${TIMEOUT}ms · ${new Date().toISOString()}\n`);
for (const r of rows) {
  console.log(`[${r.plat.padEnd(7)}|${r.proto.padEnd(7)}] ${r.line}`);
  console.log(`   搜索: ${r.search}`);
  console.log(`   取流: ${r.audio}`);
  console.log(`   歌词: ${r.lyric}`);
}
const searchOK = rows.filter((r) => /→ [1-9]/.test(r.search)).length;
const audioOK = rows.filter((r) => r.audio.includes("AUDIO")).length;
const lrcOK = rows.filter((r) => /^LRC/.test(r.lyric)).length;
console.log(`\n小结: 搜索可用 ${searchOK}/${rows.length} · 取流可用 ${audioOK}/${rows.length} · 歌词可用 ${lrcOK}/${rows.length}`);
for (const p of ["netease", "qq", "kugou", "kuwo"]) {
  const mine = rows.filter((r) => r.plat === p);
  const playable = mine.filter((r) => r.audio.includes("AUDIO")).map((r) => r.line);
  console.log(`   ${p.padEnd(8)}: ${playable.length ? `可播 ← ${playable.join(", ")}` : "无可播线路" + (mine.some((r) => /→ [1-9]/.test(r.search)) ? "（仅有搜索结果，不能播）" : "（搜索也不通）")}`);
}
console.log("注: 本脚本只发 GET，不写入任何系统；取流为空/非音频的线路不能用于播放，仅有搜索结果的线路不算可用。");
