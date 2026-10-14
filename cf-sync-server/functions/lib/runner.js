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
//   后台导入/删除音源 → 本模块把所有脚本包成 sandbox 模块 + 一个固定入口 →
//   通过 Cloudflare REST API PUT /workers/scripts/<runner> 重新部署 runner（脚本此刻变成
//   "构建期静态模块"，合法）→ Pages Function 用服务绑定（或 workers.dev + Bearer）调它取直链。
// 执行仍然发生在 CF 边缘，App 侧不需要任何 js 运行时，符合"客户端只保存一个 URL"。
//
// 安全边界：部署只由后台（带 SOURCES_ADMIN_TOKEN）动作触发，客户端可读路径绝不会
// 携带 CF_API_TOKEN 去部署 Worker；runner 自身再要一个 LX_RUNNER_TOKEN 做二次门禁。

import { buildSandboxModule, gunzipText, lxSourceKey, lxMusicInfo, LX_CONSOLE_MODULE } from "./lx.js";
import { loadScript, metaGet, metaSet, listSources } from "./store.js";

export const RUNNER_CONTRACT = "primuse.lx-runner.v1";
const DEPLOYED_HASHES_KEY = "lx_runner_hashes_v1";
const COMPATIBILITY_DATE = "2025-08-01";
/** 免费计划单 Worker bundle 上限 3MiB(gzip)。原始 6MiB 大约压到 1.5MiB，留足余量。 */
const MAX_RAW_BYTES = 6_000_000;

export function runnerName(env) {
  return String((env && env.LX_RUNNER_NAME) || "primuse-lx-runner").trim();
}

/* ── bundle 生成 ───────────────────────────────────────────────────────── */

/**
 * 生成 runner 的全部模块文件。entries: [{ hash, scriptText }]。
 * 每个脚本走 buildSandboxModule()（已被 tests/sandbox-probe.mjs 证明能独立跑通），
 * 入口用**字面量** import 它们——这正是 Workers 允许的唯一动态代码形态：静态。
 */
export function buildRunnerFiles(entries) {
  const list = (entries || []).filter((e) => e && e.hash && e.scriptText);
  const imports = [];
  const registry = [];
  const files = [];
  list.forEach((e, i) => {
    const alias = `m${i}`;
    const path = `scripts/${e.hash}.mjs`;
    imports.push(`import * as ${alias} from "./${path}";`);
    registry.push(`  [${JSON.stringify(e.hash)}, ${alias}],`);
    files.push({ path, content: buildSandboxModule(e.scriptText), contentType: "application/javascript+module" });
  });
  // 沙箱模块统一 import "./__lx_console.mjs"，所以这个垫片必须和它们同目录。
  if (list.length) {
    files.push({ path: "scripts/__lx_console.mjs", content: LX_CONSOLE_MODULE, contentType: "application/javascript+module" });
  }

  const entry = `// 自动生成，请勿手改 —— ${RUNNER_CONTRACT}
// 由 primuse-sync-server 的后台在音源变更时通过 Cloudflare REST API 重新部署。
${imports.join("\n")}

const REGISTRY = new Map([
${registry.join("\n")}
]);

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
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        contract: CONTRACT,
        modules: REGISTRY.size,
        hashes: Array.from(REGISTRY.keys()),
        bytes: Number((env && env.LX_RUNNER_BYTES) || 0),
      });
    }
    if (request.method !== "POST") return Response.json({ ok: false, error: "method not allowed" }, { status: 405 });
    const denied = unauthorized(request, env);
    if (denied) return denied;

    let body;
    try { body = await request.json(); } catch { return Response.json({ ok: false, error: "body must be JSON" }, { status: 400 }); }

    const hash = String(body.hash || "");
    const mod = REGISTRY.get(hash);
    if (!mod) {
      return Response.json({ ok: false, error: "hash_not_deployed", detail: \`runner 里没有脚本 \${hash.slice(0, 16)}（共 \${REGISTRY.size} 个模块）\`, hashes: Array.from(REGISTRY.keys()).slice(0, 8) }, { status: 409 });
    }
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
      Promise.resolve(run).then((v) => ({ kind: "value", v })),
      new Promise((r) => setTimeout(() => r({ kind: "timeout" }), timeoutMs)),
    ]);
    if (guarded.kind === "timeout") {
      return Response.json({ ok: false, error: "script_timeout", detail: \`\${action} 超过 \${timeoutMs}ms 没返回\`, inited }, { status: 504 });
    }
    return Response.json({ ok: true, result: guarded.v, inited });
  },
};
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
  // metadata 必须是**文件部分**（带 filename），否则 API 认不出来。
  fd.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata");
  for (const f of files) {
    fd.append(`modules/${f.path}`, new Blob([f.content], { type: f.contentType || "application/javascript+module" }), f.path);
  }
  return fd;
}

/* ── 脚本集合 ──────────────────────────────────────────────────────────── */

/** runner 该带哪些脚本：只看**启用**的 lxjs 音源（停用的没必要占 bundle 额度）。 */
export async function desiredScriptSet(env) {
  const rows = await listSources(env);
  const wanted = rows.filter((r) => r.protocol === "lxjs" && Number(r.enabled) === 1 && r.script_hash);
  const hashes = Array.from(new Set(wanted.map((r) => String(r.script_hash))));
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
