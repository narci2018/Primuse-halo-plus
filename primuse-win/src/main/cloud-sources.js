'use strict';
/**
 * 云端音乐源（cf-sync-server）—— 音乐源管理搬到了服务端，这一头是消费方。
 *
 * 用户的原话是"客户端只保存这个 URL 即可，通过解释这个 URL 即可获得可用的源；
 * 支持实时更新音乐源"。所以这里做四件事：
 *   1. GET 清单（带 deviceId + If-None-Match，304 就是"没变"，轮询很便宜）；
 *   2. 把清单解释成线路表（store.cloud.applySources），协议里多出来的 lxjs（洛雪 js 音源）
 *      本机跑不了 —— 脚本在 CF 的 runner Worker 里（Workers 请求期不允许生成代码），
 *      清单里的 runtime.lxjs = "server-runner" 就是这个意思，搜索/取流/歌词都经 /api/music-gateway；
 *   3. 需求 5：清单里的 settings.homeTitle 是服务端可设的首页文案（按 deviceId 关联）；
 *   4. 需求 2：本机也要能回答"能出声吗"，于是有 probeSource —— 搜索 → 解析直链 →
 *      真的用 Range 取 64KB 字节看魔数。**能访问不等于能播放**，延迟绿灯从来不是可用性。
 *
 * 拉不到清单（断网 / CF 挂了 / 契约不认识）时**绝不清空**本机线路：
 * 上一次检到能出声的那份照样能播，UI 上写明"用缓存"。向下兼容包括这一条。
 */

const { request, openStream, withUA } = require('./httpx');
const aggregated = require('./aggregated');
const store = require('./store');

const CONTRACT = 'primuse.music-sources.v1';
const PROBE_BYTES = 65536;
const AUDIO_MIN_BYTES = 8192;

/**
 * 音频魔数：和服务端 `protocols.js` 的 `sniffAudio` 一条不差 ——
 * ID3 / OggS / fLaC / MPEG 帧同步 / RIFF…WAVE / ISO-BMFF(mp4,m4a)。
 *
 * 这一段原来有两处写错，都是"把好源判成死源"的方向：
 *   - mp4 的 `ftyp` 四个字节按 f-t-p-y 比了（实际是 f-t-y-p，0x66 0x74 0x79 0x70），
 *     所以 m4a 直链永远认不出 —— QQ 音乐/网易云的 m4a 全在这一类里；
 *   - fLaC 与 RIFF/WAVE 压根没有。
 * 魔数认不出时不能直接判死：音频站给错 content-type 是常事，反过来也给对过却回 HTML 报错页
 * 更是旧延迟检测被骗的原因。所以判据是 **魔数成立，或 content-type 是音频且字节不像文本**。
 */
function looksLikeAudio(buffer) {
  if (!buffer || buffer.length < 12) return false;
  const b = buffer;
  const ascii = (at, text) => text.split('').every((ch, i) => b[at + i] === ch.charCodeAt(0));
  return (
    ascii(0, 'ID3') || // mp3 带 ID3v2 头
    ascii(0, 'OggS') || // ogg / opus
    ascii(0, 'fLaC') || // flac
    (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) || // MPEG / ADTS 帧同步
    (ascii(0, 'RIFF') && ascii(8, 'WAVE')) || // wav
    ascii(4, 'ftyp') // mp4 / m4a：前 4 字节是 box 长度，随便它写 0x18/0x20/0x1C
  );
}

/** 反爬页、报错 JSON、登录跳转 —— 全都长这样（服务端同一条正则）。 */
function looksLikeText(buffer) {
  if (!buffer || !buffer.length) return false;
  const asText = buffer.subarray(0, 64).toString('utf8');
  return /^\s*(<\?xml|<!DOCTYPE|<html|<HTML|\{|\[)/.test(asText);
}

/** 服务端认的那几种"声称是音频"的 content-type。 */
function audioContentType(ct) {
  return /^(audio|application\/octet-stream|video\/mp2a)/i.test(String(ct || ''));
}

/** 一条直链到底能不能出声 —— 服务端与本机共用这一条口径：
 *  字节够长 + 不像文本 + （命中魔数 或 服务器确实给的是音频 content-type）。 */
function isPlayableAudio({ bytes, magic, textish, contentType }) {
  return bytes > AUDIO_MIN_BYTES && !textish && (magic || audioContentType(contentType));
}

function originOf(urlString) {
  try {
    return new URL(urlString).origin;
  } catch {
    return '';
  }
}

/** 清单给的 gateway.base 是相对当前 Pages 项目的（"/api/music-gateway"），要拼成绝对地址。 */
function gatewayBase(manifest = store.cloud.manifest()) {
  const base = (manifest && manifest.gateway && manifest.gateway.base) || '/api/music-gateway';
  const origin = originOf(store.cloud.config().manifestURL);
  if (!origin) return null;
  return /^https?:\/\//i.test(base) ? base.replace(/\/+$/, '') : `${origin}${base}`;
}

/** 清单里一条源 → 本机线路表的形状（字段名沿用 iPhone/Windows 侧的 protocolType/isEnabled）。 */
function toLocalSource(s, usableSet) {
  return {
    id: s.id,
    name: s.name,
    platform: s.platform,
    protocolType: s.protocol,
    baseURL: s.baseURL || '',
    isEnabled: Boolean(s.enabled),
    priority: Number(s.priority) || 0,
    quality: s.quality || '320k',
    cloud: true,
    scriptHash: s.scriptHash || null,
    check: s.check || null,
    suggestDelete: Boolean(s.suggestDelete),
    usable: usableSet.has(s.id),
    latencyMs: 0,
  };
}

/**
 * 清单落成线路。
 *
 * 过滤规则要说清楚：**lxjs 但没有脚本指纹的不进线路表**（走网关也解析不了，留着只会
 * 让播放变成一次注定失败的请求）；HTTP 类但没有合法 baseURL 的同样不留。
 * 其它一律照清单下发 —— 包括"检不出结果"（no_sample / unchecked）的那些，
 * 因为服务端把它们停在 enabled=1 上是有意的：观测盲区不等于源坏了。
 */
function toLocalSources(manifest) {
  const usableSet = new Set(manifest && manifest.usable ? manifest.usable : []);
  return ((manifest && manifest.sources) || [])
    .filter((s) => s && s.id && (s.protocol === 'lxjs' ? Boolean(s.scriptHash) : /^https?:\/\//i.test(String(s.baseURL || ''))))
    .map((s) => toLocalSource(s, usableSet));
}

/**
 * 拉清单。
 * @param {{force?:boolean}} [opts] force=true 时不带 If-None-Match（后台刚改过源，客户端主动刷）
 * @returns {Promise<{ok:boolean, changed:boolean, revision?:number, sources?:any[], settings?:any, error?:string, contract?:string}>}
 */
async function refresh({ force = false } = {}) {
  const cfg = store.cloud.config();
  const url = new URL(cfg.manifestURL);
  if (cfg.deviceId) url.searchParams.set('deviceId', cfg.deviceId);
  const headers = withUA({ Accept: 'application/json' });
  if (!force && cfg.etag) headers['If-None-Match'] = cfg.etag;

  let res;
  try {
    res = await request(url.toString(), { headers, timeoutMs: 15000 });
  } catch (error) {
    store.cloud.setError(error.message);
    return { ok: false, changed: false, error: error.message, cached: Boolean(cfg.hasManifest), sources: store.aggregated.list() };
  }

  if (res.statusCode === 304) {
    store.cloud.setFetched({});
    return { ok: true, changed: false, revision: cfg.revision, sources: store.aggregated.list(), settings: (store.cloud.manifest() || {}).settings || null };
  }
  if (res.statusCode !== 200 || !res.json) {
    const msg = (res.json && (res.json.error || res.json.message)) || `清单拉取失败（HTTP ${res.statusCode}）`;
    store.cloud.setError(msg);
    return { ok: false, changed: false, error: msg, cached: Boolean(cfg.hasManifest), sources: store.aggregated.list() };
  }
  const data = res.json.data;
  // 契约不对就整份拒绝：认不得的清单硬解释一遍，比不解释更糟（会把线路表写成一堆空壳）。
  if (!data || data.contract !== CONTRACT) {
    const msg = `清单契约不是 ${CONTRACT}（拿到 ${data && data.contract ? data.contract : '无 contract 字段'}），本机继续使用缓存`;
    store.cloud.setError(msg);
    return { ok: false, changed: false, error: msg, cached: Boolean(cfg.hasManifest), sources: store.aggregated.list(), contract: data && data.contract };
  }

  store.cloud.setFetched({ etag: res.headers.etag || '', revision: data.revision, manifest: data });
  const applied = store.cloud.applySources(toLocalSources(data));
  return {
    ok: true,
    changed: true,
    revision: Number(data.revision),
    contract: data.contract,
    sources: applied,
    settings: data.settings || null,
    usable: data.usable || [],
    suggestions: data.suggestions || [],
    runtime: data.runtime || null,
    gateway: gatewayBase(data),
  };
}

/** 网关调用。所有 lxjs 源的搜索/取流/歌词都走这里；deviceId 是网关的必填项（它替本机转发第三方）。 */
async function gateway(action, payload = {}, timeoutMs = 20000) {
  const base = gatewayBase();
  if (!base) throw new Error('还没有云端清单，走不了音乐网关');
  const deviceId = store.cloud.config().deviceId;
  const res = await request(`${base}?action=${encodeURIComponent(action)}${deviceId ? `&deviceId=${encodeURIComponent(deviceId)}` : ''}`, {
    method: 'POST',
    headers: withUA({ 'content-type': 'application/json' }),
    body: JSON.stringify({ action, ...payload }),
    timeoutMs,
  });
  if (!res.json || res.json.code !== 0) {
    throw new Error((res.json && (res.json.error || res.json.message)) || `网关 HTTP ${res.statusCode}`);
  }
  return res.json.data;
}

/**
 * 给 aggregated 用的钩子。
 * 只有清单里真的有 lxjs 源时才值得挂上（否则多一次无谓的网关请求）。
 */
function hooks() {
  const hasLxjs = store.cloud.sources().some((s) => s.protocolType === 'lxjs' && s.isEnabled);
  if (!hasLxjs) return {};
  return {
    gatewaySearch: async (keyword) => {
      const data = await gateway('search', { keyword, limit: 20 }, 25000);
      // 网关回来的曲型字段和本机一致（rawID/title/artist/album/duration/coverURL/platform/sourceId），
      // 只补两件事：标出它是云端来的、把 sourceName 兜底成清单里的名字。
      const nameById = new Map(store.cloud.sources().map((s) => [s.id, s.name]));
      return (data.results || []).map((r) => ({
        ...r,
        kind: 'aggregated',
        sourceName: r.sourceName || nameById.get(r.sourceId) || r.sourceName,
        viaCloud: true,
      }));
    },
    gatewayResolve: async (source, rawID) => {
      const data = await gateway('url', { sourceId: source.id, rawID, platform: source.platform, quality: source.quality || '320k' }, 25000);
      return data && /^https?:\/\//i.test(String(data.url || '')) ? data.url : null;
    },
    gatewayLyric: async (source, rawID) => {
      const data = await gateway('lyric', { sourceId: source.id, rawID, platform: source.platform }, 20000);
      const lrc = data && (data.lyric || data.lrc);
      return typeof lrc === 'string' && lrc.includes('[') ? lrc : null;
    },
  };
}

/**
 * 搜索用的关键词。服务端体检现在用的是「晴天」，清单里目前没有下发这个字段；
 * 万一以后下发了（`check.keyword`），本机就跟着用同一个 —— 两边检同一首歌，
 * 结论对不上时才有得谈。
 */
function probeKeyword(manifest = store.cloud.manifest()) {
  const k = manifest && manifest.check && manifest.check.keyword;
  return typeof k === 'string' && k.trim() ? k.trim().slice(0, 40) : '晴天';
}

/**
 * 真的去取一段字节，然后在字节层判定（见上面 looksLikeAudio 的注释）。
 * 取够判定需要的量就主动断开 —— 体检要过几十条源，别把流量花在下载整首歌上。
 *
 * **传输层失败一律 reject**（超时、连接被重置、DNS 挂了、Body 半路断了）。
 * 服务端 `probeAudio` 用的是 `fetch` + `AbortSignal`，这几种情况本来就会抛；
 * 客户端早先把它咽成"0 字节、不可播"，等于把"我们没测成"上报成"这条源死了"，
 * 两边口径就分叉了。现在统一成：抛出去 → 调用方落 'error'（有 3 次宽限）。
 */
async function probeAudio(url) {
  const opened = await openStream(url, { range: `bytes=0-${PROBE_BYTES - 1}` });
  const chunks = [];
  let got = 0;
  let settled = false;
  return await new Promise((resolve, reject) => {
    const stream = opened.stream;
    const cut = () => {
      try {
        if (stream.destroy) stream.destroy();
        else if (stream.abort) stream.abort();
        else stream.resume();
      } catch {
        /* 断开失败不影响已经拿到的判定 */
      }
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      const buffer = Buffer.concat(chunks);
      const contentType = String(opened.headers['content-type'] || '');
      const magic = looksLikeAudio(buffer);
      const textish = looksLikeText(buffer);
      const out = {
        status: opened.statusCode,
        contentType,
        bytes: buffer.length,
        magic,
        textish,
        // audio 就是最终结论：能不能出声只看这一个字段，别再在调用处各写一遍判据。
        audio: isPlayableAudio({ bytes: buffer.length, magic, textish, contentType }),
        host: originOf(opened.finalUrl || url),
      };
      cut();
      resolve(out);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cut();
      reject(error instanceof Error ? error : new Error(`取字节失败 ${String((error && error.message) || error)}`));
    };
    stream.on('data', (c) => {
      chunks.push(c);
      got += c.length;
      if (got >= PROBE_BYTES) finish();
    });
    stream.on('end', finish);
    stream.on('error', fail);
  });
}

/**
 * 本机版"检测全部可用"（需求 2）。
 *
 * 判据和服务端一致：搜索 → 解析直链 → Range 取字节看是不是真音频。
 * 洛雪 js 源本机跑不了脚本，所以它的结论**只能用服务端体检下发的那份**（check 字段），
 * 这里如实标 origin:"server"，绝不伪装成本机测出来的。
 *
 * @returns {Promise<{id:string,status:string,detail:string,bytes:number,origin:string,enabled:boolean}>}
 */
async function probeSource(source, keyword = probeKeyword()) {
  if (source.protocolType === 'lxjs') {
    const c = source.check || {};
    return {
      id: source.id,
      status: c.status || 'unchecked',
      detail: c.detail || '服务端还没体检过这条',
      bytes: Number(c.bytes) || 0,
      origin: 'server',
      enabled: Boolean(source.isEnabled),
      suggestDelete: Boolean(source.suggestDelete),
    };
  }
  const items = await aggregated.searchSingleSource(source, keyword);
  if (!items.length) {
    return { id: source.id, status: 'search_empty', detail: '搜索没有结果（该线路的搜索接口可能单独挂了，正在用样本 id 复核）', bytes: 0, origin: 'local', enabled: Boolean(source.isEnabled) };
  }
  const tried = [];
  for (const item of items.slice(0, 3)) {
    const url = await aggregated.resolveFromSource(source, item.rawID);
    if (!url) {
      tried.push(`解析无直链 ${item.title || item.rawID}`);
      continue;
    }
    // 取字节这一跳**不放进 try**：probeAudio 抛异常（超时没回数据、连接被重置、DNS 挂了）
    // 是"我们这次没测成"，不是"这条源给的东西不能播"。让它一路抛到 checkAll 的 catch，
    // 结论落成 error —— 和服务端 verdictEffect 的 ERROR_GRACE 一样，别把瞎掉判成死刑。
    const a = await probeAudio(url);
    if (a.audio) {
      return {
        id: source.id,
        status: 'ok',
        detail: `${item.title || ''} / ${item.artist || ''} · HTTP ${a.status} ${a.contentType.split(';')[0]} ${a.bytes}B${a.magic ? ' 命中音频魔数' : ' 按 content-type 判定'}`,
        bytes: a.bytes,
        origin: 'local',
        enabled: Boolean(source.isEnabled),
      };
    }
    tried.push(`直链不可播 ${a.status} ${a.contentType || '无 content-type'} ${a.bytes}B${a.textish ? ' 实为文本' : ''}`);
  }
  return { id: source.id, status: 'resolve_fail', detail: tried.join(' / ').slice(0, 300), bytes: 0, origin: 'local', enabled: Boolean(source.isEnabled) };
}

/**
 * 逐条过一遍（并发压到 4，第三方站点都可能慢），每条出结论就回调 —— 界面要能看着进度走。
 * @param {any[]} sources
 * @param {(v:any)=>void} [onVerdict]
 */
async function checkAll(sources, onVerdict) {
  const list = sources.filter((s) => s.isEnabled);
  const verdicts = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(4, list.length) }, async () => {
    while (i < list.length) {
      const source = list[i++];
      let v;
      try {
        v = await probeSource(source);
      } catch (error) {
        v = { id: source.id, status: 'error', detail: error.message, bytes: 0, origin: 'local', enabled: Boolean(source.isEnabled) };
      }
      verdicts.push(v);
      if (typeof onVerdict === 'function') onVerdict(v);
    }
  });
  await Promise.all(workers);
  return verdicts;
}

module.exports = {
  CONTRACT,
  AUDIO_MIN_BYTES,
  looksLikeAudio,
  looksLikeText,
  audioContentType,
  isPlayableAudio,
  gatewayBase,
  toLocalSources,
  probeKeyword,
  refresh,
  gateway,
  hooks,
  probeSource,
  probeAudio,
  checkAll,
  config: () => store.cloud.config(),
  manifest: () => store.cloud.manifest(),
  setManifestURL: (url) => store.cloud.setManifestURL(url),
};
