// lx（洛雪）js 音源的真正执行处：一个独立的 Cloudflare Worker（下称 runner）。
//
// 为什么不是"在 Pages Function 里直接跑脚本"—— 2026-10-14 在本机 workerd
// （wrangler 4.114 / compatibility_date 2025-08-01）同一次请求里实测：
//   启动阶段 new Function('return 6*7')      → 42 ✅（2025-06-01 起就是默认行为）
//   请求阶段 new Function('return 6*7')      → EvalError: Code generation from strings disallowed for this context
//   请求阶段 import(运行时算出的 data: URL)  → Error: No such module "data:..."
//   WebAssembly.compile(bytes)               → Wasm code generation disallowed by embedder
// 也就是说：Workers 只允许执行**部署时就写死在 bundle 里**的代码。用户脚本存在 D1，
// 只能在请求里取出来 → 在 Pages Function 里永远执行不了（quickjs-WASM 这条路本机也证不了）。
//
// 于是换成唯一站得住的边缘执行形态：
//   后台导入/删除音源 → 本模块把脚本正文包成 **Text 静态模块** + 一个固定入口 →
//   通过 Cloudflare REST API PUT /workers/scripts/<runner> 重新部署 runner（脚本此刻仍然是
//   "部署期就写死在 bundle 里的东西"，合法）→ 入口在**启动阶段**用 new Function 编译沙箱，
//   在**第一个请求**里才真正执行脚本并缓存，之后请求只做调用
//   → Pages Function 用服务绑定（或 workers.dev + Bearer）调它取直链。
// 为什么中间要过一道 new Function 而不是直接把沙箱写成 .js 模块：wrangler 打包必过 esbuild，
// 而 esbuild 解析混淆音源会直接拒绝整包（详见 lib/lx.js 顶部那段实测记录）。
// 执行仍然发生在 CF 边缘，App 侧不需要任何 js 运行时，符合"客户端只保存一个 URL"。
//
// 安全边界：部署只由后台（带 SOURCES_ADMIN_TOKEN）动作触发，客户端可读路径绝不会
// 携带 CF_API_TOKEN 去部署 Worker；runner 自身再要一个 LX_RUNNER_TOKEN 做二次门禁。

import { sandboxTemplate, gunzipText, lxSourceKey, lxMusicInfo } from "./lx.js";
import { loadScript, metaGet, metaSet, listSources } from "./store.js";

export const RUNNER_CONTRACT = "primuse.lx-runner.v1";
export const DEPLOYED_HASHES_KEY = "lx_runner_hashes_v1";
const COMPATIBILITY_DATE = "2025-08-01";
/** 免费计划单 Worker bundle 上限 3MiB(gzip)。原始 6MiB 大约压到 1.5MiB，留足余量。 */
export const MAX_RAW_BYTES = 6_000_000;

export function runnerName(env) {
  return String((env && env.LX_RUNNER_NAME) || "primuse-lx-runner").trim();
}

/* ── bundle 生成 ───────────────────────────────────────────────────────── */

/**
 * 生成 runner 的全部模块文件。entries: [{ hash, scriptText }]。
 *
 * 用户脚本一律以 **Text 模块**进 bundle，入口在**启动阶段**用 new Function 把它编成沙箱：
 *   —— 打包器（wrangler 必然过 esbuild）一旦解析脚本正文，混淆稿就会让整个 bundle 发布失败
 *      （`Cannot assign to "x" because it is a constant`；详见 lib/lx.js 里那段实测记录）；
 *   —— 而 Workers 只禁止"请求期"生成代码，启动期 new Function 本机实测允许，
 *      脚本此刻仍然是"部署期就写死在 bundle 里的静态资源"，没有破坏边缘执行的安全模型；
 *   —— 顺带和洛雪官方一致（官方也是 new Function(脚本文本)）。
 *   —— 但"编译"和"执行"必须分开：启动阶段真跑一句脚本，只要它顶层有 setTimeout / fetch，
 *      workerd 就报 Disallowed operation called within global scope（本机实测倒在 lx-玉宁熙 上）。
 *      所以入口只在启动期编译，factory() 留到第一个请求里惰性执行，成功的沙箱按 isolate 缓存。
 * 每个脚本的编译单独 try/catch：一条烂源不该把整个 runner 拖到起不来。
 */
export function buildRunnerFiles(entries) {
  const list = (entries || []).filter((e) => e && e.hash && e.scriptText);
  const imports = [];
  const registry = [];
  const files = [];
  list.forEach((e, i) => {
    const alias = `m${i}`;
    // .txt 不是笔误：Text 模块的内容不会被任何 JS 解析器碰过，这正是我们要的。
    const path = `scripts/${e.hash}.txt`;
    imports.push(`import ${alias} from "./${path}";`);
    registry.push(`  [${JSON.stringify(e.hash)}, ${alias}],`);
    files.push({ path, content: e.scriptText, contentType: "text/plain", moduleType: "Text" });
  });
  const { prefix, suffix } = sandboxTemplate();

  const entry = `// 自动生成，请勿手改 —— ${RUNNER_CONTRACT}
// 由 primuse-sync-server 的后台在音源变更时通过 Cloudflare REST API 重新部署。
${imports.join("\n")}

const RAW = new Map([
${registry.join("\n")}
]);

// 沙箱模板两半（见 lib/lx.js 顶部那段实测记录）。脚本正文夹在中间，
// 前后各一个换行：脚本可能以行注释结尾，少一个换行会把后缀第一行吃掉。
const SANDBOX_PREFIX = ${JSON.stringify(prefix)};
const SANDBOX_SUFFIX = ${JSON.stringify(suffix)};

// 启动阶段只做**编译**，不做执行。这一步的分工是被实测逼出来的：
//   new Function(...)            → 只有启动期允许（请求期报 Code generation disallowed）
//   紧接着把脚本跑起来            → 启动期禁止（脚本顶层一句 setTimeout/fetch 就报
//      "Disallowed operation called within global scope"，本机倒在 lx-玉宁熙 上）
// 所以编译产物先收进 COMPILED，真正 factory() 留到第一个请求里惰性执行（那时 I/O 和定时器合法），
// 跑成功的沙箱再缓存进 SANDBOXES，一个 isolate 只初始化一次。
const COMPILED = new Map();
const BROKEN = new Map();
const SANDBOXES = new Map();
for (const [hash, text] of RAW) {
  try {
    COMPILED.set(hash, new Function(SANDBOX_PREFIX + "\\n" + String(text) + "\\n" + SANDBOX_SUFFIX));
  } catch (e) {
    BROKEN.set(hash, String(e && e.message ? e.message : e).slice(0, 300));
  }
}

// 返回 { mod } 或 { error, detail }。初始化失败不缓存：那可能是源站一时抽风，下次得重试。
function sandboxOf(hash) {
  const cached = SANDBOXES.get(hash);
  if (cached) return { mod: cached };
  const factory = COMPILED.get(hash);
  if (!factory) return { error: BROKEN.has(hash) ? "script_uncompilable" : "hash_not_deployed", detail: BROKEN.get(hash) || "" };
  try {
    const mod = factory();
    if (!mod || typeof mod.__request !== "function") return { error: "script_init_failed", detail: "脚本没有产出沙箱导出（__request 缺失）" };
    SANDBOXES.set(hash, mod);
    return { mod };
  } catch (e) {
    return { error: "script_init_failed", detail: String(e && e.message ? e.message : e).slice(0, 300) };
  }
}

const CONTRACT = ${JSON.stringify(RUNNER_CONTRACT)};

function safeEqual(a, b) {
  const x = String(a || "");
  const y = String(b || "");
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function unauthorized(request, env) {
  const want = (env && env.LX_RUNNER_TOKEN) || "";
  // 服务绑定调用时不设 token 也可以（外部本来就到不了）；一旦设了就必须匹配。
  if (!want) return null;
  const got = String(request.headers.get("authorization") || "");
  return safeEqual(got, "Bearer " + want) ? null : Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
}

export default {
  // 最外层再兜一次：任何没预料到的异常都要以 JSON 的形式回来。
  // Worker 里裸抛异常 = Cloudflare 回一张 "error code: 1101" 的纯文本页，
  // 调用方（体检、网关）就只能说"runner 返回不是 JSON"，把能修的问题说成天书。
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (e) {
      return Response.json({
        ok: false,
        error: "runner_exception",
        detail: String((e && (e.stack || e.message)) || e).slice(0, 500),
      }, { status: 500 });
    }
  },
};

async function handle(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({
        // ok 只表示"这个 Worker 起来了、能被调用"。某条源编译失败不叫不可达 ——
        // 它由 broken 单独报，runner-status/体检会把它读成那条源的问题，而不是整机的问题。
        ok: true,
        contract: CONTRACT,
        modules: RAW.size,
        compiled: COMPILED.size,
        initialized: SANDBOXES.size,
        // 部署集合按 RAW 报（不是按编译成功的报），否则一条烂源会让"该部署的集合 vs
        // 实装的集合"永远对不上，后台一直显示 stale、一直重部署。
        hashes: Array.from(RAW.keys()),
        broken: Array.from(BROKEN.entries()).map(([h, m]) => ({ hash: h, error: m })),
        bytes: Number((env && env.LX_RUNNER_BYTES) || 0),
      });
    }
    if (request.method !== "POST") return Response.json({ ok: false, error: "method not allowed" }, { status: 405 });
    const denied = unauthorized(request, env);
    if (denied) return denied;

    let body;
    try { body = await request.json(); } catch { return Response.json({ ok: false, error: "body must be JSON" }, { status: 400 }); }

    const hash = String(body.hash || "");
    const made = sandboxOf(hash);
    if (!made.mod) {
      const why = made.detail || (made.error === "script_uncompilable" ? "脚本编译失败" : "");
      return Response.json({ ok: false, error: made.error, detail: made.error === "hash_not_deployed" ? \`runner 里没有脚本 \${hash.slice(0, 16)}（共 \${RAW.size} 个模块）\` : \`\${hash.slice(0, 16)}：\${why}\`, hashes: Array.from(RAW.keys()).slice(0, 8) }, { status: made.error === "hash_not_deployed" ? 409 : 422 });
    }
    const mod = made.mod;
    const action = String(body.action || "musicUrl");
    const params = body.params || {};
    const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 20000, 1000), 28000);

    // 脚本靠 on(request) 注册处理器、靠 send(inited) 报平台；不 send(inited) 的也能干活，
    // 所以初始化超只记录不否决（否决权在体检那边）。
    let inited = null;
    try { inited = await Promise.race([mod.__waitInited(6000), new Promise((r) => setTimeout(() => r(null), 6500))]); } catch { inited = null; }

    // 问能力不问直链：不进用户处理器，避免"capabilities"被当成不支持的 action 报错。
    if (action === "capabilities") {
      return Response.json({ ok: true, result: mod.__registry.inited || null, alerts: (mod.__registry.alerts || []).slice(0, 5) });
    }

    const run = mod.__request(action, params);
    const guarded = await Promise.race([
      // .catch 不能省：脚本没活干时会 reject（"音源对该操作没有返回结果"、源站 500 之类），
      // 少这一句 Promise.race 就把异常抛穿 fetch，Cloudflare 直接回 HTTP 500 "error code: 1101"
      // 的纯文本 —— 体检读不到原因，只能说"runner 返回不是 JSON"，把一条能修的源冤枉成坏源。
      // （本机现网实测：非常刀/西瓜聚合源 的酷狗线、聚合API接口 全部栽在这上面。）
      Promise.resolve(run).then((v) => ({ kind: "value", v })).catch((e) => ({ kind: "error", e })),
      new Promise((r) => setTimeout(() => r({ kind: "timeout" }), timeoutMs)),
    ]);
    if (guarded.kind === "timeout") {
      return Response.json({ ok: false, error: "script_timeout", detail: \`\${action} 超过 \${timeoutMs}ms 没返回\`, inited }, { status: 504 });
    }
    if (guarded.kind === "error") {
      const e = guarded.e;
      return Response.json({
        ok: false,
        error: "script_exception",
        detail: \`\${hash.slice(0, 16)} · \${action}：\${String((e && e.message) || e).slice(0, 400)}\`,
        inited,
      }, { status: 422 });
    }
    return Response.json({ ok: true, result: guarded.v, inited });
}
`;
  return [{ path: "entry.mjs", content: entry, contentType: "application/javascript+module" }, ...files];
}

/**
 * 打成 Workers 上传接口的 multipart 正文。
 * 接口要求：part 名 `metadata`（application/json）+ 每个模块 part 名 `modules/<路径>`、
 * filename 为路径、Content-Type 为 application/javascript+module。
 */
export function buildRunnerUploadForm({ files, token, bytes, migrations = null }) {
  const fd = new FormData();
  const metadata = {
    main_module: "entry.mjs",
    compatibility_date: COMPATIBILITY_DATE,
    bindings: [],
    tags: [],
  };
  if (token) metadata.bindings.push({ type: "plain_text", name: "LX_RUNNER_TOKEN", text: String(token) });
  if (bytes) metadata.bindings.push({ type: "plain_text", name: "LX_RUNNER_BYTES", text: String(bytes) });
  if (migrations) metadata.migrations = migrations;
  // 模块类型必须逐个声明：入口是 ESModule，音源正文是 Text（见 lx.js 顶部那段实测记录）。
  // 不写 modules 的话 API 只认 main_module + 上传部分，会按扩展名猜；把 .txt 猜成 JS 模块，
  // 就等于让打包器去解析混淆稿 —— 那个"整包发布失败"的老问题立刻回来。
  metadata.modules = files.map((f) => ({ type: f.moduleType || "ESModule", path: f.path }));
  // metadata 必须是**文件部分**（带 filename），否则 API 认不出来。
  fd.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata");
  for (const f of files) {
    fd.append(`modules/${f.path}`, new Blob([f.content], { type: f.contentType || "application/javascript+module" }), f.path);
  }
  return fd;
}

/* ── 脚本集合 ──────────────────────────────────────────────────────────── */

/**
 * runner 该带哪些脚本：**清单里所有 lxjs 音源的脚本，停用的也带上。**
 *
 * 直觉上"停用的没必要占 bundle 额度"很合理，实测却造出一洗不掉的死账：
 * 一条洛雪源被停用之后它的脚本就从 bundle 里消失，重检时 runner 回
 * `runner_missing`，而 runner_missing 属于观测盲区 —— 判据是"没看清就维持现状"，
 * 于是它永远维持着"停用"，即使当初是误杀。HTTP 线路没这个问题（不依赖任何部署产物）。
 * 所以要让"翻案"对洛雪源同样成立，脚本就必须在它被停用之后**仍然可执行**。
 * 预算兜得住：现网 22 个脚本共 2.66MB，上限 6MB。
 * 真超了才按"启用优先"裁剪，并把被丢掉的脚本报成 skipped（不许静默丢）。
 */
export async function desiredScriptSet(env) {
  const rows = await listSources(env);
  const lx = rows.filter((r) => r.protocol === "lxjs" && r.script_hash);
  const order = new Map(lx.map((r, i) => [String(r.script_hash), i]));
  const hashes = Array.from(new Set(lx.map((r) => String(r.script_hash)))).sort((a, b) => {
    const on = (h) => lx.some((r) => String(r.script_hash) === h && Number(r.enabled) === 1) ? 0 : 1;
    return on(a) - on(b) || Number(order.get(a)) - Number(order.get(b));
  });
  const entries = [];
  const skipped = [];
  let total = 0;
  for (const h of hashes) {
    const rec = await loadScript(env, h);
    if (!rec) { skipped.push({ hash: h, reason: "D1 里没有正文" }); continue; }
    let text;
    try {
      text = await gunzipText(rec.body);
    } catch (e) {
      skipped.push({ hash: h, reason: `解压失败：${String(e && e.message ? e.message : e)}` });
      continue;
    }
    const size = Number(rec.raw_bytes || new TextEncoder().encode(text).length);
    if (total + size > MAX_RAW_BYTES) { skipped.push({ hash: h, reason: `超出 bundle 预算（已用 ${total}B + ${size}B > ${MAX_RAW_BYTES}B）` }); continue; }
    total += size;
    entries.push({ hash: h, name: rec.name || "", bytes: size, scriptText: text });
  }
  return { entries, skipped, totalBytes: total, hashes: entries.map((e) => e.hash).sort() };
}

export async function deployedHashes(env) {
  try {
    const j = JSON.parse((await metaGet(env, DEPLOYED_HASHES_KEY, "[]")) || "[]");
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

async function recordDeployed(env, hashes) {
  await metaSet(env, DEPLOYED_HASHES_KEY, JSON.stringify(hashes.slice().sort()));
}

function uuid() {
  return crypto.randomUUID();
}

async function workerExists(env, name) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/scripts/${name}`, {
    method: "GET",
    headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, "content-type": "application/json" },
  });
  // 存在的脚本返回 200 + JSON 元信息；不存在返回 404（cf 也可能给 7003/10007）。
  return res.status === 200;
}

/* ── 部署 ──────────────────────────────────────────────────────────────── */

/**
 * 把当前启用的 lxjs 脚本集部署成 runner。幂等：内容集合没变就跳过（force 可强推）。
 * 返回 { deployed, changed, hashes, skipped, bytes, api }。
 */
export async function syncRunner(env, { force = false, reason = "" } = {}) {
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
    return {
      deployed: false,
      changed: false,
      needsSetup: true,
      // 与 maybeSyncRunner 的跳过口径保持一致：客户端/后台只要看到 skipped 就知道
      // "这不是部署失败，是根本没配凭据"，不该把它读成已部署。
      skipped: "no_credentials",
      error: "缺少 CF_ACCOUNT_ID / CF_API_TOKEN（Pages  Secrets），无法部署 runner Worker",
    };
  }
  const wanted = await desiredScriptSet(env);
  const before = await deployedHashes(env);
  const same = !force && JSON.stringify(before.slice().sort()) === JSON.stringify(wanted.hashes);
  if (same) return { deployed: false, changed: false, hashes: wanted.hashes, skipped: wanted.skipped, bytes: wanted.totalBytes, reason };

  const name = runnerName(env);
  const files = buildRunnerFiles(wanted.entries);
  const exists = await workerExists(env, name);
  const fd = buildRunnerUploadForm({
    files,
    token: env.LX_RUNNER_TOKEN || "",
    bytes: wanted.totalBytes,
    // 只在"这个脚本还没有"时声明格式迁移；已存在再发 tag 会被 API 拒绝。
    migrations: exists ? null : { tag: uuid(), old_tag: null, new_tag: uuid() },
  });

  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/scripts/${name}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${env.CF_API_TOKEN}` },
    body: fd,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }

  if (!json || json.success !== true) {
    return {
      deployed: false,
      changed: false,
      error: `runner 部署失败 HTTP ${res.status}：${(json && json.errors && JSON.stringify(json.errors).slice(0, 300)) || text.slice(0, 300)}`,
      hashes: wanted.hashes,
      skipped: wanted.skipped,
      bytes: wanted.totalBytes,
      reason,
    };
  }

  await recordDeployed(env, wanted.hashes);
  // workers.dev 的 URL 只在没开服务绑定时用得上；这里顺手解析一次并写进 meta，省得调用方再问。
  const info = await resolveRunnerTarget(env, name).catch(() => null);
  return {
    deployed: true,
    changed: true,
    script: name,
    hashes: wanted.hashes,
    modules: files.length,
    skipped: wanted.skipped,
    bytes: wanted.totalBytes,
    target: info && info.target,
    reason,
    id: json.result && json.result.id,
  };
}

/* ── 调用 ──────────────────────────────────────────────────────────────── */

/**
 * runner 怎么够到：优先服务绑定（LX_RUNNER），其次 LX_RUNNER_URL（workers.dev），
 * 最后用 API 查账号的 workers.dev 子域拼出来。
 */
export async function resolveRunnerTarget(env, name = runnerName(env)) {
  if (env.LX_RUNNER && typeof env.LX_RUNNER.fetch === "function") {
    return { kind: "service-binding", base: `https://${name}`, name };
  }
  const explicit = String(env.LX_RUNNER_URL || "").trim().replace(/\/+$/, "");
  if (explicit) return { kind: "url", base: explicit, name };
  if (env.CF_ACCOUNT_ID && env.CF_API_TOKEN) {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/subdomain`, {
      headers: { authorization: `Bearer ${env.CF_API_TOKEN}` },
    });
    const json = await res.json().catch(() => null);
    const sub = json && json.success && json.result && json.result.subdomain;
    if (sub) return { kind: "workers-dev", base: `https://${sub}.workers.dev`, name };
  }
  return null;
}

/** 调 runner。这里收敛成一条 Promise，出错一律 Error（调用方按 message 分类）。 */
export async function runnerInvoke(env, payload, { timeoutMs = 25000 } = {}) {
  const target = await resolveRunnerTarget(env);
  if (!target) throw new Error("runner_unavailable：既没有 LX_RUNNER 服务绑定，也没有 CF_ACCOUNT_ID/CF_API_TOKEN 可解析 workers.dev");

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const headers = { "content-type": "application/json" };
    if (env.LX_RUNNER_TOKEN) headers.authorization = `Bearer ${env.LX_RUNNER_TOKEN}`;
    const init = { method: "POST", headers, body: JSON.stringify(payload), signal: ctl.signal };
    const res = target.kind === "service-binding"
      ? await env.LX_RUNNER.fetch(new Request(`${target.base}/`, init))
      : await fetch(`${target.base}/`, init);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    if (!json) throw new Error(`runner 返回不是 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
    if (json.ok !== true) {
      const err = new Error(String(json.detail || json.error || "runner 调用失败").slice(0, 400));
      err.runnerError = json.error;
      throw err;
    }
    return json;
  } catch (e) {
    if (String(e && e.name) === "AbortError") throw new Error(`runner 调用超时（${timeoutMs}ms）`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** runner 健康检查（后台面板和契约测试都用它）。 */
export async function runnerHealth(env) {
  const target = await resolveRunnerTarget(env);
  if (!target) return { reachable: false, error: "runner 目标未配置" };
  try {
    const res = target.kind === "service-binding"
      ? await env.LX_RUNNER.fetch(new Request(`${target.base}/health`, { headers: env.LX_RUNNER_TOKEN ? { authorization: `Bearer ${env.LX_RUNNER_TOKEN}` } : {} }))
      : await fetch(`${target.base}/health`, { headers: env.LX_RUNNER_TOKEN ? { authorization: `Bearer ${env.LX_RUNNER_TOKEN}` } : {} });
    const json = await res.json().catch(() => null);
    return { reachable: Boolean(json && json.ok), target, ...(json || {}) };
  } catch (e) {
    return { reachable: false, target, error: String(e && e.message ? e.message : e) };
  }
}

/** 部署动作改了脚本集合时，把 D1 记录的哈希集合换成 runner 实际加载的。 */
export async function trustRunnerHashes(env) {
  const health = await runnerHealth(env);
  if (!health.reachable || !Array.isArray(health.hashes)) return health;
  await recordDeployed(env, health.hashes);
  return health;
}

/* ── Pages Function 侧的 lx 调用入口 ───────────────────────────────────── */

/**
 * 跑一个洛雪音源拿播放直链：脚本在 runner 里执行，这里拼协议参数并校验返回值。
 * @param {object} env CF env（需 LX_RUNNER 服务绑定，或 LX_RUNNER_URL / CF_* 密钥）
 * @param {object} p { hash, platform, rawID, quality }
 */
export async function lxMusicUrl(env, { hash, platform, rawID, quality = "320k" }) {
  if (!hash) throw new Error("lx 音源缺少 scriptHash");
  const out = await runnerInvoke(env, {
    hash,
    action: "musicUrl",
    // 脚本各家读的字段不一样：DreamMeting 读 info.quality，gdstudio 读 info.type，
    // 还有的直接看 info.startQuality。全部填成同一个音质，免得源明明能用却因为字段名被判死。
    params: { source: lxSourceKey(platform), info: { musicInfo: lxMusicInfo(rawID), type: quality, quality, startQuality: quality } },
  });
  const v = out.result;
  if (typeof v === "string" && /^https?:\/\//i.test(v)) return { url: v, sources: out.inited || null };
  if (v && typeof v.url === "string" && /^https?:\/\//i.test(v.url)) return { url: v.url, sources: out.inited || null };
  throw new Error(`音源返回值不是直链：${String(JSON.stringify(v)).slice(0, 160)}`);
}

/** 问 runner：这个脚本声明了哪些平台/音质。返回 lx 的 inited 负载（{sources:{wy:{...}}}），拿不到就 null。 */
export async function lxDetectPlatforms(env, hash) {
  const out = await runnerInvoke(env, { hash, action: "capabilities", params: {} }).catch(() => null);
  if (!out) return null;
  return out.result || out.inited || null;
}

/**
 * 同上，但**按 hash 缓存在 isolate 里**（默认 10 分钟）。
 *
 * 为什么要缓存：capabilities 这次问话在 runner 里也要等 `__waitInited`（最多 6.5s），
 * 而"这条源会不会搜"是个几乎不变的事实 —— 每次用户搜索都重新问一遍，等于给搜索白加一跳。
 * 缓存失败（null）也记，否则坏源会把每次搜索都拖慢。
 */
const capCache = new Map();
export async function lxCapabilities(env, hash, { ttlMs = 600000 } = {}) {
  const hit = capCache.get(hash);
  if (hit && Date.now() - hit.at < ttlMs) return hit.v;
  const v = await lxDetectPlatforms(env, hash);
  capCache.set(hash, { at: Date.now(), v });
  if (capCache.size > 200) {
    // 别让缓存无限长：按写入时间淘汰最早的一半（isolate 内存也是资源）。
    const keys = Array.from(capCache.keys()).slice(0, 100);
    for (const k of keys) if (k !== hash) capCache.delete(k);
  }
  return v;
}

/** 脚本在 inited 负载里声明的 actions 有没有 search。认不到就 false（宁可不搜，也不为"猜"付一次超时）。 */
export function lxSupportsSearch(caps) {
  if (!caps || typeof caps !== "object") return false;
  const sources = caps.sources || {};
  for (const key of Object.keys(sources)) {
    const actions = sources[key] && sources[key].actions;
    if (Array.isArray(actions) && actions.some((a) => String(a).toLowerCase() === "search")) return true;
  }
  return false;
}

/**
 * 让脚本自己搜一次歌。
 *
 * 官方洛雪协议里音源只保证 musicUrl，搜索是各家自己加的（本机的 22 个脚本里就有一部分实现了），
 * 而体检一条 lxjs 源需要**真实的歌曲 id** —— 样本池只能靠会搜索的线路喂。所以这里把"脚本自己能搜"
 * 变成可用信息：搜到了就喂样本池，让那条源能被体检；搜不到就照旧回答"检不出结果"（绝不停用）。
 * 参数字段各家读的不一样（keyword / query / prompt / text），全部填满，免得源明明能搜却被判"不支持"。
 */
export async function lxSearch(env, { hash, platform, keyword = "晴天", limit = 8, timeoutMs = 12000 }) {
  const source = lxSourceKey(platform);
  const info = { keyword, query: keyword, prompt: keyword, text: keyword, page: 1, limit, type: "music", rctype: "music" };
  const out = await runnerInvoke(env, {
    hash,
    action: "search",
    params: { source, type: "music", rctype: "music", page: 1, limit, ...info, info },
  }, { timeoutMs });
  return normalizeLxSearch(out.result);
}

/**
 * 搜索结果归一成 [{ rawID, title, artist, album, coverURL, duration }]。
 *
 * 返回形状各家不同（裸数组 / {list} / {data:{list}} / 嵌 musicInfo），字段名也各家不同，
 * 所以这里全部按"多填几个候选键"处理 —— 少一个字段只是 UI 上少一行，少一个 id 就是整条结果作废。
 * 除了 rawID，其余字段是给客户端直接上屏用的（专辑、封面、时长），别让客户端再去查详情。
 */
export function normalizeLxSearch(v) {
  const raw = Array.isArray(v)
    ? v
    : (v && (v.list || (v.data && v.data.list) || (v.source && v.source.list))) || [];
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const it of raw) {
    if (!it) continue;
    const m = it.musicInfo || it.rawData?.musicInfo || it;
    const id = String(m.id ?? m.rawId ?? m.songmid ?? m.mid ?? m.hash ?? m.midCode ?? "").trim();
    if (id.length < 4) continue;
    const album = typeof m.album === "string" ? m.album : (m.album && (m.album.name || m.album.title)) || "";
    const pic = m.picUrl || m.img || m.coverUrl || m.cover || (m.album && (m.album.picUrl || m.album.img)) || "";
    const seconds = Number(m.interval ?? m.duration ?? m.playTime ?? 0);
    out.push({
      rawID: id,
      title: text(m.name || m.title || "").slice(0, 80),
      artist: text(m.singer || m.artist || "").slice(0, 80),
      album: text(album).slice(0, 80),
      coverURL: typeof pic === "string" && /^https?:\/\//i.test(pic) ? pic.slice(0, 300) : null,
      duration: Number.isFinite(seconds) && seconds > 0 && seconds < 86400 ? Math.round(seconds) : 0,
    });
    if (out.length >= 12) break;
  }
  return out;
}

/** 洛雪的 singer 有时是数组（[{name, hash}]），有时是字符串；UI 只想要一行字。 */
function text(x) {
  if (typeof x === "string") return x;
  if (Array.isArray(x)) {
    return x.map((i) => (typeof i === "string" ? i : (i && (i.name || i.title)) || "")).filter(Boolean).join(", ");
  }
  if (x && typeof x === "object") return String(x.name || x.title || "");
  return "";
}
