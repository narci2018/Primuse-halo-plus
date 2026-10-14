
function bytesFromB64Shim(b64) { const bin = atob(String(b64).replace(/\s+/g, "")); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i); return out; }
function b64FromBytesShim(bytes) { let s = ""; const chunk = 0x8000; for (let i = 0; i < bytes.length; i += chunk) { s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)); } return btoa(s); }


const __reg = { handlers: {}, inited: null, initedAt: 0, alerts: [], name: "", error: null };
const __EVENT_NAMES = { inited: "inited", updateAlert: "updateAlert", changeUpdateSource: "changeUpdateSource", request: "request", keyDown: "keyDown" };
function __on(event, fn) { (__reg.handlers[event] || (__reg.handlers[event] = [])).push(fn); }
function __off(event, fn) { const a = __reg.handlers[event]; if (!a) return; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
function __parseBody(text, ct) {
  if (!text) return text;
  if (/json/i.test(ct || "")) { try { return JSON.parse(text); } catch (e) { return text; } }
  return text;
}
async function __doRequest(url, options) {
  const opt = options || {};
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), Number(opt.timeout) > 0 ? Number(opt.timeout) : 15000);
  try {
    const headers = {};
    const src = opt.headers || {};
    for (const k of Object.keys(src)) headers[k] = String(src[k]);
    const res = await fetch(url, {
      method: String(opt.method || "GET").toUpperCase(),
      headers,
      body: opt.body === undefined || opt.body === null ? undefined : (typeof opt.body === "string" ? opt.body : JSON.stringify(opt.body)),
      redirect: "follow",
      signal: ctl.signal,
    });
    const text = await res.text();
    return {
      statusCode: res.status,
      headers: (() => { const o = {}; res.headers.forEach((v, k) => { o[k] = v; }); return o; })(),
      body: __parseBody(text, res.headers.get("content-type")),
      text,
    };
  } finally { clearTimeout(to); }
}
const __cache = new Map();
const __lx = {
  EVENT_NAMES: __EVENT_NAMES,
  version: "1.36.0",
  on: __on,
  off: __off,
  once(event, fn) { __on(event, function wrap(data) { __off(event, wrap); return fn(data); }); },
  send(event, data) {
    if (event === "inited") { __reg.inited = data || {}; __reg.initedAt = Date.now(); return; }
    if (event === "updateAlert") { __reg.alerts.push(data); return; }
  },
  sendMain() {},
  request(url, options, cb) {
    const p = __doRequest(url, options);
    if (typeof cb === "function") { p.then((r) => cb(null, r)).catch((e) => cb(e, null)); return; }
    return p;
  },
  criticalRequest(url, options) { return __doRequest(url, options); },
  module: {
    crypto: {
      async aesEncrypt(buffer, mode, key, iv) {
        const k = await crypto.subtle.importKey("raw", key instanceof Uint8Array ? key : bytesFromB64Global(key), { name: "AES-CBC", length: 256 }, false, ["encrypt"]);
        const out = await crypto.subtle.encrypt({ name: "AES-CBC", iv }, k, buffer);
        return new Uint8Array(out);
      },
    },
  },
  cache: {
    get(k) { const v = __cache.get(String(k)); return v && Date.now() < v.exp ? v.val : null; },
    set(k, v, ttl) { __cache.set(String(k), { val: v, exp: Date.now() + (Number(ttl) || 3600000) }); },
    has(k) { return __cache.has(String(k)); },
    remove(k) { __cache.delete(String(k)); },
  },
  log(...args) { console.log("[lx]", ...args); },
  info(...args) { console.log("[lx]", ...args); },
  err(...args) { console.error("[lx]", ...args); },
  error(...args) { console.error("[lx]", ...args); },
  warn(...args) { console.warn("[lx]", ...args); },
};
const globalThis = {
  lx: __lx,
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  fetch, Response, Request, Headers, AbortController, AbortSignal,
  TextEncoder, TextDecoder, URL, URLSearchParams, Blob,
  btoa, atob, encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
  JSON, Math, Date, Object, Array, String, Number, Boolean, Error, TypeError, RangeError, Promise,
  RegExp, Map, Set, WeakMap, WeakSet, Symbol, Proxy, Reflect,
  Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array,
  ArrayBuffer, DataView, Uint8ClampedArray, BigInt64Array, BigUint64Array, BigInt, isNaN, isFinite,
  parseInt, parseFloat, undefined, NaN, Infinity,
  crypto, performance, structuredClone, queueMicrotask,
};
globalThis.window = globalThis;
globalThis.self = globalThis;
globalThis.globalThis = globalThis;
const window = globalThis;
const self = globalThis;
const Buffer = {
  from: (data, enc) => {
    if (typeof data === "string") {
      const b = enc === "base64" ? bytesFromB64Global(data) : new TextEncoder().encode(data);
      return Object.assign(b, { toString: (e2) => (e2 === "base64" ? b64FromBytesGlobal(b) : new TextDecoder().decode(b)) });
    }
    return Object.assign(new Uint8Array(data), { toString: () => new TextDecoder().decode(new Uint8Array(data)) });
  },
  isBuffer: () => false,
  alloc: (n) => new Uint8Array(n),
};
function bytesFromB64Global(s) { return bytesFromB64Shim(s); }
function b64FromBytesGlobal(b) { return b64FromBytesShim(b); }

/*!
 * @name 忆音音源
 * @description 支持Q音网易320k
 * @version v1
 * @author 竹佀＆玥然OvO
 */
const { EVENT_NAMES, on, send } = globalThis.lx

const getAudioUrl = (source, musicInfo) => {
    const platform = source === 'tx' ? 'tencent' : 'netease'
    const songId = musicInfo.songmid || musicInfo.id
    
    if (!songId) {
        throw new Error('找不到歌曲ID')
    }
    
    return `https://music.3e0.cn/?server=${platform}&type=url&id=${songId}`
}

on(EVENT_NAMES.request, ({ source, action, info }) => {
    if (action !== 'musicUrl') {
        return Promise.reject(new Error('仅支持musicUrl操作'))
    }
    
    try {
        const url = getAudioUrl(source, info.musicInfo)
        
        console.log(`[DreamMeting] 返回链接: ${url}`)
        console.log(`[DreamMeting] 音质: 320k`)
        
        return Promise.resolve(url)
        
    } catch (error) {
        console.error(`[DreamMeting] 错误: ${error.message}`)
        return Promise.reject(new Error(`[DreamMeting] ${error.message}`))
    }
})

send(EVENT_NAMES.inited, {
    openDevTools: false,
    sources: {
        tx: {
            name: 'QQ音乐 - DreamMeting',
            type: 'music',
            actions: ['musicUrl'],
            qualitys: ['320k']
        },
        wy: {
            name: '网易云音乐 - DreamMeting',
            type: 'music',
            actions: ['musicUrl'],
            qualitys: ['320k']
        }
    }
})

console.log('音源初始化完成')

export const __registry = __reg;
export function __waitInited(timeoutMs) {
  if (__reg.inited) return Promise.resolve(__reg.inited);
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (__reg.inited) return resolve(__reg.inited);
      if (Date.now() - start > timeoutMs) return reject(new Error("音源初始化超时（脚本没有 send(inited)）"));
      setTimeout(tick, 25);
    };
    setTimeout(tick, 0);
  });
}
export async function __request(action, params) {
  const list = __reg.handlers && __reg.handlers.request ? __reg.handlers.request.slice() : [];
  if (!list.length) throw new Error("音源脚本未注册 request 处理器（on(EVENT_NAMES.request)）");
  const errors = [];
  for (const fn of list) {
    try {
      const r = fn({ action, ...params });
      const v = r && typeof r.then === "function" ? await r : r;
      if (v === undefined || v === null) continue;
      return v;
    } catch (e) {
      errors.push(String(e && e.message ? e.message : e));
    }
  }
  throw new Error(errors.length ? errors.join(" / ").slice(0, 300) : "音源对该操作没有返回结果");
}
export const __inited = () => __reg.inited;
