// 洛雪音乐（lx-music）格式 js 音源的沙箱封装与调用入口。
//
// 先记一件实测事实，免得有人再走回头路。本机 workerd（wrangler 4.114 / 2025-08-01）同一次请求里：
//   eval('6*7') / new Function(...)   启动阶段 → 42 ✅（compatibility_date ≥ 2025-06-01 是默认）
//   eval / new Function(...)          请求阶段 → EvalError: Code generation from strings disallowed
//   import(运行期算出的 data: URL)     请求阶段 → Error: No such module "data:..."
//   WebAssembly.compile(bytes)                  → Wasm code generation disallowed by embedder
// （写死成字面量的 data: import 能跑，是因为 esbuild 在构建期就把它内联进 bundle 了，不是运行期能力。）
// 结论：Workers/Pages Functions 里**不存在**"把 D1 取出的脚本文本当代码执行"的合法通道。
//
// 所以执行位置在 runner Worker（lib/runner.js）：本模块负责把用户脚本包成 ESM 模块源码，
// runner 在部署时用**字面量** import 它们；runner.js 里的 lxMusicUrl() 则是 Pages Function 侧
// 通过 runner 取直链的调用封装。
//
// 沙箱手法：**在模块顶层用 `const globalThis = {...}` 遮蔽真实全局**，把沙箱对象塞进去，
// 这样用户脚本里的 `const { EVENT_NAMES, on, send, request } = globalThis.lx` 拿到的就是我们的
// 实现；模块自己的导出（__registry/__request）跨请求复用 on() 注册的处理器，
// 不依赖 isolate 外的任何内存表。

const LX_VERSION = "1.36.0";

/* ── 编码 / 压缩 ───────────────────────────────────────────────────────── */

export function b64FromBytes(bytes) {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

export function bytesFromB64(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function gzipBase64(text) {
  const cs = new CompressionStream("gzip");
  const stream = new Response(new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(cs));
  return b64FromBytes(new Uint8Array(await stream.arrayBuffer()));
}

export async function gunzipText(bodyBase64) {
  const ds = new DecompressionStream("gzip");
  const bytes = bytesFromB64(bodyBase64);
  const stream = new Response(new Blob([bytes]).stream().pipeThrough(ds));
  return await stream.text();
}

/* ── 沙箱模块构造 ─────────────────────────────────────────────────────── */

// console 垫片必须在"任何 const console 遮蔽"之前拿到真实 console。
// 早年它单独成一个 ESM 模块（scripts/__lx_console.mjs），改成 CommonJS 沙箱之后不能那么干了：
// 一个 .cjs 里没法 import 兄弟模块，所以这里把它做成"在 IIFE 之外先抓住真 console"的工厂，
// 再把结果作为 IIFE 形参注进沙箱 —— 形参遮蔽只影响函数体内部，取真值发生在遮蔽之前。
const CONSOLE_FACTORY = `var __lxRealConsole = (typeof console === "object" && console) ? console : { log: function(){}, error: function(){}, warn: function(){}, info: function(){} };
var __lxMakeConsole = function () {
  var base = __lxRealConsole;
  var out = {};
  var PASS = ["log", "info", "warn", "error"];
  var FLAT = ["debug", "trace", "assert", "dir", "dirxml", "table", "count", "countReset", "time", "timeEnd", "timeLog", "group", "groupCollapsed", "groupEnd"];
  for (var i = 0; i < PASS.length; i++) { var k = PASS[i]; out[k] = typeof base[k] === "function" ? base[k].bind(base) : function () {}; }
  // workerd 没有 group/groupEnd 这类分组方法；音源脚本拿它们只是为了好看，降级成一行 log 就行。
  for (var j = 0; j < FLAT.length; j++) { var k2 = FLAT[j]; out[k2] = function () { var a = [k2].slice.call(arguments); out.log.apply(out, a); }; }
  return out;
};
`;

/**
 * 沙箱模板：把用户脚本包成"一段函数体文本"，由 runner 在**启动阶段**用
 * `new Function(prefix + 脚本正文 + suffix)` 执行。
 *
 * 为什么要绕到 new Function，而不是把沙箱直接写成 Worker 的 .mjs/.cjs 模块 —— 实测硬约束：
 * wrangler 打包必过 esbuild，而 esbuild 会把这类写法判成编译错误、整包发布失败：
 *   X [ERROR] Cannot assign to "o" because it is a constant
 *   X [ERROR] Cannot assign to "q" because it is a constant
 * 混淆音源里很常见：同一作用域先 `const q=...`，后面又 `q=...`，靠 try/catch 兜着 ——
 * 这在 V8 里只在**执行到那一行**时才 TypeError，语法上完全合法，但 esbuild 属于"静态就能
 * 看出迟早炸"就拒绝输出的那一类。改成 CommonJS 也救不了（本机实测：.cjs 一样报这两条），
 * 因为约束来自"打包器要解析这份文本"，跟严格/宽松模式无关。
 * 唯一既符合 Workers"请求期禁止生成代码"、又不让 esbuild 碰用户脚本的形态：
 *   脚本以 **Text 模块**进 bundle（部署期写死，合法）→ 启动期 new Function 编译（实测允许）
 *   → 请求期只做调用。顺带这也正是洛雪官方执行音源的方式，语义最贴近。
 *
 * 沙箱整体套进一个函数作用域：`const globalThis = {...}` 只遮蔽这个函数；真实 console
 * 从 IIFE 形参递进来（形参遮蔽不影响取值点，取值发生在遮蔽之前）。
 *
 * 注意：这里产出的是"生成的代码"，改动时务必保持脚本正文原样插入、不做转义，
 * 并且前后各留一个换行 —— 用户脚本可能以行注释结尾，少一个换行就会把后缀吃掉。
 */
const SANDBOX_TEMPLATE = (() => {
  const prelude = `

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
  version: ${JSON.stringify(LX_VERSION)},
  // 脚本常拿 lx.env 判断跑在手机还是电脑上（只影响它打不打日志），给个明确值省得它 undefined 分支报错。
  env: "mobile",
  supportsEnv: true,
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
`;

  // 沙箱里不能引用模块外的东西，所以把 base64 工具以字符串形式再嵌一份（避免 import 路径问题）。
  const helpers = `
function bytesFromB64Shim(b64) { const bin = atob(String(b64).replace(/\\s+/g, "")); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i); return out; }
function b64FromBytesShim(bytes) { let s = ""; const chunk = 0x8000; for (let i = 0; i < bytes.length; i += chunk) { s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)); } return btoa(s); }
`;

  const epilogue = `
const __registry = __reg;
function __waitInited(timeoutMs) {
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
async function __request(action, params) {
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
const __inited = () => __reg.inited;
`;

  // 前缀：真 console 工厂 + IIFE 开始；后缀：导出收口 + IIFE 结束 + 函数体 return。
  const prefix = `${CONSOLE_FACTORY}var __lxSandbox = (function (console) {\n${helpers}\n${prelude}\n`;
  const suffix = `
${epilogue}
  return { __registry: __registry, __waitInited: __waitInited, __request: __request, __inited: __inited };
})(__lxMakeConsole());
return __lxSandbox;
`;
  return { prefix, suffix };
})();

/** 沙箱模板的两半（runner 把它们作为字面量写进入口，脚本正文夹在中间）。 */
export function sandboxTemplate() {
  return SANDBOX_TEMPLATE;
}

/**
 * 生成交给 `new Function` 的**函数体**。名字沿用旧的 buildSandboxModule，
 * 语义已经不同：旧版产出一个可独立 require 的 CommonJS 模块，这版产出一段函数体文本，
 * 里面不含任何 import/export —— 用户脚本永远不该被打包器解析。
 */
export function buildSandboxModule(userScript) {
  const { prefix, suffix } = SANDBOX_TEMPLATE;
  return `${prefix}\n${userScript}\n${suffix}`;
}


/** 平台 → 洛雪音源内部用的 source key（tx/wy/kg/kw/mg/bil）。 */
export function lxSourceKey(platform) {
  return { qq: "tx", netease: "wy", kugou: "kg", kuwo: "kw", migu: "mg", bilibili: "bil" }[platform] || "wy";
}

/** 不同音源读的字段名不一样（tx 用 songmid、wy 用 id、kg 用 hash），全部塞满。 */
export function lxMusicInfo(rawID) {
  const id = String(rawID);
  return { id, songmid: id, mid: id, hash: id, singer: "", name: "", interval: 0 };
}

/**
 * 取直链的调用入口在 lib/runner.js（lxMusicUrl / lxDetectPlatforms）：
 * 脚本真正的执行位置是 runner Worker，本模块只提供沙箱源码与协议参数拼装。
 */

export function lxMeta(scriptText) {
  const pick = (key) => {
    const m = new RegExp(`@${key}\\s+([^\\r\\n*]+)`).exec(scriptText.slice(0, 4000));
    return m ? m[1].trim() : "";
  };
  const inited = /\{\s*sources\s*:\s*\{/.exec(scriptText);
  return {
    name: pick("name") || "未命名音源",
    description: pick("description"),
    version: pick("version"),
    author: pick("author"),
    declaresSources: Boolean(inited),
  };
}
