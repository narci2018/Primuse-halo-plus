'use strict';
/**
 * 聚合线路（在线音源）—— `primuse/Primuse/Services/AggregatedMusic/` 的 JS 等价实现。
 *
 * 逐文件对照的契约来源：
 *   - 线路清单与存储：AggregatedSourceStore.swift:18-122
 *   - 四类协议的搜索/取流/歌词：AggregatedMusicService.swift:109-457
 *   - 平台名映射：AggregatedMusicModels.swift:4-53
 * 字段名、query 参数名、默认值一律照抄，不要"顺手优化"—— 改了就和 iPhone 表现不一致。
 */

const { request, withUA } = require('./httpx');

const PLATFORMS = {
  qq: { displayName: 'QQ 音乐', badge: 'QQ', meting: 'tencent', hyw: 'tx' },
  netease: { displayName: '网易云音乐', badge: '163', meting: 'netease', hyw: 'wy' },
  kugou: { displayName: '酷狗音乐', badge: 'KG', meting: 'kugou', hyw: 'kg' },
  kuwo: { displayName: '酷我音乐', badge: 'KW', meting: 'kuwo', hyw: 'kw' },
  bilibili: { displayName: '哔哩哔哩', badge: 'Bili', meting: 'bilibili', hyw: 'bili' },
  custom: { displayName: '自定义源', badge: 'Custom', meting: 'netease', hyw: 'tx' },
};

const PROTOCOLS = {
  meting: 'Meting API',
  hyw: '落雪 / HYW 聚合源',
  nxinxz: 'NXINXZ 线路',
  openApi: 'Music Open API',
  customJson: '自定义 JSON',
};

/** 与 Swift `defaultSources`（AggregatedSourceStore.swift:18-102）完全一致的 9 条线路。 */
const DEFAULT_SOURCES = [
  { id: 'default-qq-hyw', name: 'QQ音乐 (HYW 极速无损解析)', platform: 'qq', protocolType: 'hyw', baseURL: 'http://103.79.184.97/api/music/url', isEnabled: true, priority: 20 },
  { id: 'default-netease-gdstudio', name: '网易云 (GDStudio 320k)', platform: 'netease', protocolType: 'meting', baseURL: 'https://music-api.gdstudio.xyz/api.php', isEnabled: true, priority: 18 },
  { id: 'default-kuwo-nxinxz', name: '酷我音乐 (NXINXZ 320k)', platform: 'kuwo', protocolType: 'nxinxz', baseURL: 'http://music.nxinxz.com/kw.php', isEnabled: true, priority: 16 },
  { id: 'default-kugou-hyw', name: '酷狗音乐 (HYW 极速解析)', platform: 'kugou', protocolType: 'hyw', baseURL: 'http://103.79.184.97/api/music/url', isEnabled: true, priority: 15 },
  { id: 'default-netease-meting-1', name: '网易云 (七洁雅 Meting)', platform: 'netease', protocolType: 'meting', baseURL: 'https://api.qijieya.cn/meting', isEnabled: true, priority: 14 },
  { id: 'default-netease-meting-3e0', name: '网易云 (DreamMeting 3e0)', platform: 'netease', protocolType: 'meting', baseURL: 'https://music.3e0.cn', isEnabled: true, priority: 12 },
  { id: 'default-kuwo-hyw', name: '酷我音乐 (HYW 线路)', platform: 'kuwo', protocolType: 'hyw', baseURL: 'http://103.79.184.97/api/music/url', isEnabled: true, priority: 10 },
  { id: 'default-qq-meting-1', name: 'QQ音乐 (七洁雅 Meting 备用)', platform: 'qq', protocolType: 'meting', baseURL: 'https://api.qijieya.cn/meting', isEnabled: true, priority: 8 },
  { id: 'default-qq-openapi-1', name: 'QQ音乐 (Open API 线路)', platform: 'qq', protocolType: 'openApi', baseURL: 'https://tang.api.s01s.cn/music_open_api.php', isEnabled: true, priority: 6 },
];

/** 对应 Swift `loadSources()`（:104-122）：存量 + 缺省项按 id 合并，再按 priority 降序。 */
function normalizeSources(stored) {
  const list = Array.isArray(stored) ? stored.slice() : [];
  const known = new Set(list.map((s) => s.id));
  for (const def of DEFAULT_SOURCES) {
    if (!known.has(def.id)) list.push({ ...def });
  }
  for (let i = 0; i < list.length; i += 1) {
    list[i] = {
      latencyMs: 0,
      protocolType: 'meting',
      platform: 'netease',
      isEnabled: true,
      priority: 0,
      ...list[i],
    };
    if (!list[i].id) list[i].id = `custom-${i}-${Date.now()}`;
  }
  list.sort((a, b) => b.priority - a.priority);
  return list;
}

/** 对应 Swift `enabledSources(for:)`（:159-167）：custom 平台参与所有平台的解析。 */
function enabledSources(sources, platform = null) {
  return sources
    .filter((s) => s.isEnabled)
    .filter((s) => (platform ? s.platform === platform || s.platform === 'custom' : true))
    .sort((a, b) => b.priority - a.priority);
}

function trimBase(baseURL) {
  return String(baseURL || '').replace(/\/+$/g, '');
}

function qs(base, params) {
  const joined = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v ?? ''))}`)
    .join('&');
  return `${base}${base.includes('?') ? '&' : '?'}${joined}`;
}

/** Swift:190-241 */
function parseMetingSearch(json, platform, sourceName) {
  let list = Array.isArray(json) ? json : null;
  // 多一层容错：个别线路把数组包在 data/list 里返回（Swift 只认顶层数组，这里不会少结果，只会多）
  if (!list && json && typeof json === 'object') {
    list = Array.isArray(json.data) ? json.data : Array.isArray(json.list) ? json.list : null;
  }
  if (!list) return [];

  const out = [];
  for (const dict of list) {
    if (!dict || typeof dict !== 'object') continue;
    let id = firstField(dict, ['id', 'url_id', 'songmid']);
    if (!id && (typeof dict.url === 'string' || typeof dict.lrc === 'string')) {
      const m = /(?<=id=)[^&]+/.exec(String(dict.url || dict.lrc));
      if (m) id = m[0];
    }
    const name = firstField(dict, ['name', 'title', 'song_name']);
    let artist = '';
    if (typeof dict.artist === 'string') artist = dict.artist;
    else if (Array.isArray(dict.artist)) artist = dict.artist.filter((x) => typeof x === 'string').join(', ');
    else if (typeof dict.author === 'string') artist = dict.author;
    const album = typeof dict.album === 'string' ? dict.album : firstField(dict, ['album_name']);
    const pic = typeof dict.pic === 'string' ? dict.pic : typeof dict.cover === 'string' ? dict.cover : null;

    // 时长：Swift 硬编码 210（已知缺陷，docs/cross-platform-plan.md §12「假时长 210」）。
    // 这里改为"能解析就填真实值，解析不到给 0"，UI 把 0 显示成 "--"。
    const duration = pickDuration(dict);

    if (!id || !name) continue;
    out.push({
      id: `agg_${platform}_${id}`,
      rawID: id,
      title: name,
      artist,
      album,
      duration,
      coverURL: pic,
      platform,
      sourceName,
      kind: 'aggregated',
    });
  }
  return out;
}

/** Swift:243-282 */
function parseOpenApi(json, platform, sourceName) {
  let list = Array.isArray(json) ? json : null;
  if (!list && json && typeof json === 'object') {
    list = Array.isArray(json.data) ? json.data : Array.isArray(json.list) ? json.list : null;
  }
  if (!list) return [];

  const out = [];
  for (const dict of list) {
    if (!dict || typeof dict !== 'object') continue;
    const mid = firstField(dict, ['song_mid', 'mid', 'id']);
    const name = firstField(dict, ['song_name', 'song_title', 'name']);
    const artist = firstField(dict, ['singer_name', 'artist']);
    const album = firstField(dict, ['album_name', 'album']);
    const pic = firstField(dict, ['album_pic', 'pic', 'cover']);
    const duration = pickDuration(dict);
    if (!mid || !name) continue;
    out.push({
      id: `agg_${platform}_${mid}`,
      rawID: mid,
      title: name,
      artist,
      album,
      duration,
      coverURL: typeof pic === 'string' ? pic : null,
      platform,
      sourceName,
      kind: 'aggregated',
    });
  }
  return out;
}

function firstField(dict, keys) {
  for (const key of keys) {
    const v = dict[key];
    if (v === undefined || v === null) continue;
    const s = String(v);
    if (s && s !== '<null>' && s !== 'nil' && s !== 'null') return s;
  }
  return '';
}

function pickDuration(dict) {
  const candidates = [dict.duration, dict.song_play_time, dict.interval, dict.time, dict.second, dict.dur];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length) {
      const n = Number(c[0]);
      if (Number.isFinite(n) && n > 0) return n > 3000 ? Math.round(n / 1000) : n;
      continue;
    }
    if (typeof c === 'string' && /^\d+:\d+/.test(c)) {
      const [m, s] = c.split(':').map(Number);
      if (Number.isFinite(m) && Number.isFinite(s)) return m * 60 + s;
    }
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n > 3000 ? Math.round(n / 1000) : n;
  }
  return 0;
}

/** Swift:109-186 —— 四类协议各自的搜索 URL 规则 */
function searchURLFor(source, keyword) {
  const kw = encodeURIComponent(keyword);
  const base = trimBase(source.baseURL);
  const server = (PLATFORMS[source.platform] || PLATFORMS.custom).meting;

  switch (source.protocolType) {
    case 'meting':
      return base.includes('api.php')
        ? `${base}?types=search&count=20&source=${server}&pages=1&name=${kw}`
        : `${base}?type=search&id=${kw}&server=${server}&limit=20`;

    // hyw 的搜索不走用户配的 baseURL，而是按平台打固定的 meting 站点（Swift:133-146）
    case 'hyw': {
      if (source.platform === 'qq') return `https://api.qijieya.cn/meting?type=search&id=${kw}&server=tencent&limit=20`;
      if (source.platform === 'kugou') return `https://api.qijieya.cn/meting?type=search&id=${kw}&server=kugou&limit=20`;
      if (source.platform === 'kuwo') return `https://music-api.gdstudio.xyz/api.php?types=search&count=20&source=kuwo&name=${kw}`;
      if (source.platform === 'netease') return `https://music-api.gdstudio.xyz/api.php?types=search&count=20&source=netease&name=${kw}`;
      return null;
    }

    case 'nxinxz':
      return `https://music-api.gdstudio.xyz/api.php?types=search&count=20&source=kuwo&name=${kw}`;

    case 'openApi':
      return `${base}?msg=${kw}&type=json`;

    default:
      return null; // customJson：Swift 侧同样返回空数组（:183-184）
  }
}

async function searchSingleSource(source, keyword) {
  const urlString = searchURLFor(source, keyword);
  if (!urlString) return [];
  try {
    const res = await request(urlString, { headers: withUA(), timeoutMs: 6000 });
    if (res.statusCode !== 200) return [];
    if (source.protocolType === 'openApi') return parseOpenApi(res.json, source.platform, source.name);
    return parseMetingSearch(res.json, source.platform, source.name);
  } catch {
    return [];
  }
}

/**
 * 对应 Swift `search(query:)`（:29-97）：并发所有启用线路，按 `platform:rawID` 去重，
 * 并且**渐进上屏** —— 一条线路回来就立刻推给 UI，不等慢线路。
 */
async function searchAll(sources, keyword, onPartial) {
  const trimmed = String(keyword || '').trim();
  if (!trimmed) return [];
  const list = enabledSources(sources);
  if (!list.length) throw new Error('未启用任何聚合音乐源，请在设置中配置并启用音源。');

  const seen = new Set();
  const aggregated = [];
  let done = 0;

  await Promise.all(
    list.map(async (source) => {
      const items = await searchSingleSource(source, trimmed);
      done += 1;
      let hasNew = false;
      for (const item of items) {
        const key = `${item.platform}:${item.rawID}`;
        if (seen.has(key)) continue;
        seen.add(key);
        aggregated.push(item);
        hasNew = true;
      }
      if (typeof onPartial === 'function' && (hasNew || done === list.length)) {
        onPartial(aggregated.slice(), { done, total: list.length });
      }
    })
  );

  return aggregated;
}

const STREAM_TTL_MS = 10 * 60 * 1000;
const streamCache = new Map();
const lyricCache = new Map();

/** 对应 Swift `resolveStreamURLFromSource`（:307-386） */
async function resolveFromSource(source, rawID) {
  const base = trimBase(source.baseURL);
  const server = (PLATFORMS[source.platform] || PLATFORMS.custom).meting;

  try {
    switch (source.protocolType) {
      case 'meting': {
        const urlString = base.includes('api.php')
          ? `${base}?types=url&source=${server}&id=${encodeURIComponent(rawID)}&br=320`
          : `${base}?server=${server}&type=url&id=${encodeURIComponent(rawID)}&br=320`;
        const endpoint = new URL(urlString);
        const res = await request(urlString, { headers: withUA(), timeoutMs: 8000 });
        // 三种答案形态与 Swift 一致：302 落地页 / JSON.url / 纯文本 http 直链
        if (res.redirected && !res.finalUrl.includes('type=url') && !res.finalUrl.includes('types=url')) {
          return res.finalUrl;
        }
        if (res.statusCode === 200) {
          const fromJson = res.json && typeof res.json.url === 'string' ? res.json.url : null;
          if (fromJson) return fromJson;
          const text = res.text.trim();
          if (text.startsWith('http')) return text;
        }
        void endpoint;
        return null;
      }

      case 'hyw': {
        const key = (PLATFORMS[source.platform] || PLATFORMS.custom).hyw;
        const urlString = `${base}?source=${key}&songId=${encodeURIComponent(rawID)}&quality=320k`;
        const res = await request(urlString, { headers: withUA(), timeoutMs: 8000 });
        if (res.json && typeof res.json.url === 'string' && res.json.url) return res.json.url;
        if (res.json && res.json.data && typeof res.json.data.url === 'string' && res.json.data.url) return res.json.data.url;
        return null;
      }

      case 'nxinxz':
        // Swift 直接把这条 URL 当播放地址（:361-365），由 302 跳到真 mp3，所以本地代理要透传 Range + 跟随跳转
        return `${base}?id=${encodeURIComponent(rawID)}&level=320k&type=mp3`;

      case 'openApi': {
        const urlString = `${base}?msg=${encodeURIComponent(rawID)}&type=url`;
        const res = await request(urlString, { timeoutMs: 8000 });
        if (res.json && typeof res.json.url === 'string' && res.json.url) return res.json.url;
        if (res.json && typeof res.json.data === 'string' && res.json.data.startsWith('http')) return res.json.data;
        return null;
      }

      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** 对应 Swift `resolveStreamURL`（:286-305）：按优先级逐条试，命中即缓存。 */
async function resolveStreamURL(sources, platform, rawID, force = false) {
  const cacheKey = `${platform}:${rawID}`;
  if (!force) {
    const hit = streamCache.get(cacheKey);
    if (hit && Date.now() - hit.at < STREAM_TTL_MS) return hit.url;
  }
  streamCache.delete(cacheKey);

  const candidates = enabledSources(sources, platform);
  if (!candidates.length) throw new Error('未配置可用音源线路');

  for (const source of candidates) {
    const url = await resolveFromSource(source, rawID);
    if (url) {
      streamCache.set(cacheKey, { url, at: Date.now() });
      return url;
    }
  }
  throw new Error('全部音源线路解析均失败，请在设置中更换或启用备用线路');
}

/** 对应 Swift `resolveLyricsFromSource`（:406-457）+ `resolveLyrics`（:390-404） */
async function resolveLyrics(sources, platform, rawID) {
  const cacheKey = `${platform}:${rawID}`;
  if (lyricCache.has(cacheKey)) return lyricCache.get(cacheKey);

  const server = (PLATFORMS[platform] || PLATFORMS.custom).meting;
  for (const source of enabledSources(sources, platform)) {
    const base = trimBase(source.baseURL);
    let urlString = null;
    let expectJson = false;

    switch (source.protocolType) {
      case 'meting':
        urlString = base.includes('api.php')
          ? `${base}?types=lyric&source=${server}&id=${encodeURIComponent(rawID)}`
          : `${base}?server=${server}&type=lrc&id=${encodeURIComponent(rawID)}`;
        expectJson = true;
        break;
      case 'hyw':
      case 'nxinxz':
        urlString = `https://api.qijieya.cn/meting?server=${server}&type=lrc&id=${encodeURIComponent(rawID)}`;
        break;
      case 'openApi':
        urlString = `${base}?msg=${encodeURIComponent(rawID)}&type=lrc`;
        break;
      default:
        continue;
    }

    try {
      const res = await request(urlString, { timeoutMs: 6000 });
      if (expectJson && res.json) {
        const lrc = typeof res.json.lyric === 'string' ? res.json.lyric : typeof res.json.lrc === 'string' ? res.json.lrc : null;
        if (lrc) {
          lyricCache.set(cacheKey, lrc);
          return lrc;
        }
      }
      if (res.text && res.text.includes('[')) {
        lyricCache.set(cacheKey, res.text);
        return res.text;
      }
    } catch {
      /* 换下一条线路 */
    }
  }
  return null;
}

/** 对应 Swift `ping`（AggregatedSourceStore.swift:169-201）：HEAD 失败退化成 GET。 */
async function pingSource(source) {
  const start = Date.now();
  try {
    await request(source.baseURL, { method: 'HEAD', timeoutMs: 4000 });
    return Date.now() - start;
  } catch {
    try {
      await request(source.baseURL, { timeoutMs: 4000 });
      return Date.now() - start;
    } catch {
      return -1;
    }
  }
}

module.exports = {
  PLATFORMS,
  PROTOCOLS,
  DEFAULT_SOURCES,
  normalizeSources,
  enabledSources,
  searchAll,
  resolveStreamURL,
  resolveLyrics,
  pingSource,
  streamCache,
};
