// runner 端到端验证：把真实音源脚本打包成 Worker bundle，用真实 workerd 跑起来，
// 再走"取直链 → Range 真取音频"全链。这是对需求 2「一定要能播放的源才有价值」和服务端
// 执行通道（runner Worker）本身的证明，不看属性、只看 observable 结果。
//
//   node tests/runner-e2e.mjs            跑全部（含联网取音频）
//   node tests/runner-e2e.mjs --no-net   只跑不联网的部分（门禁/健康检查/能力声明）
//
// 为什么必须这样测：Pages Function 里无法执行运行期取出的脚本文本（Workers 禁止请求期生成
// 代码，见 lib/runner.js 顶部实测记录），唯一合法的边缘执行形态是"部署期就写进 bundle 的静态
// 模块"。所以本测试直接构造那个 bundle，在 workerd 里把它跑活。

import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildRunnerFiles, RUNNER_CONTRACT } from "../functions/lib/runner.js";
import { sha256Hex } from "../functions/lib/lx.js";
import { probeAudio } from "../functions/lib/protocols.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = path.resolve(ROOT, "..", "音源文件");
const OUT_DIR = path.join(ROOT, ".runner-e2e");
const TOKEN = "e2e-runner-token";
const PORT = 8700 + (Date.now() % 120);
const BASE = `http://127.0.0.1:${PORT}`;
const USE_NET = !process.argv.includes("--no-net");
const NETEASE_ID = "3440441479"; // 晴天，网易云上一个长期存在的真实 id

let pass = 0;
const fails = [];
function assert(cond, label, detail) {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${label}${detail ? ` —— ${detail}` : ""}`);
  } else {
    fails.push(label + (detail ? ` —— ${detail}` : ""));
    console.log(`  ❌ ${label}${detail ? ` —— ${detail}` : ""}`);
  }
}

function killLeftovers() {
  spawnSync("taskkill", ["/F", "/IM", "workerd.exe"], { stdio: "ignore" });
}

function pickScript(name) {
  const p = path.join(SRC_DIR, name);
  if (!existsSync(p)) throw new Error(`找不到音源文件：${p}`);
  return readFileSync(p, "utf8");
}

async function waitReady(child, { timeoutMs = 180000 } = {}) {
  // 不能只等 stdout 里的 "Ready on"：WRANGLER_LOG 级别一变、或者 wrangler 换了措辞，
  // 就会把一个已经健康的服务读成"启动超时"（本项目踩过）。所以以 /health 探测为准，
  // 日志只在失败时作为诊断证据打印出来。
  const buf = { text: "" };
  const onData = (b) => { buf.text += String(b); };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        child.stdout.off("data", onData);
        child.stderr.off("data", onData);
        return;
      }
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      lastErr = String(e && e.message ? e.message : e);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  child.stdout.off("data", onData);
  child.stderr.off("data", onData);
  throw new Error(`runner dev 启动超时（${timeoutMs}ms）；最后一次探测：${lastErr}\n${buf.text.slice(-3000)}`);
}

async function post(body, { token = TOKEN } = {}) {
  // 必须带超时：runner 里的音源脚本可以发起任意久的网络请求，
  // 必须带超时：runner 里的音源脚本能发起任意久的网络请求，测试侧一旦等死，
  // 整个套件就只剩"无输出"这一种现象，很难归因（本机就出现过一次二十分钟零输出）。
  const res = await fetch(`${BASE}/`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  }).catch((e) => null) || null;
  if (!res) return { status: 0, json: null, text: "（本地测试侧 fetch 超时/失败）" };
  const text = await res.text().catch(() => "");

  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text };
}

async function main() {
  killLeftovers();
  rmSync(OUT_DIR, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
  mkdirSync(OUT_DIR, { recursive: true });

  const chosen = [
    "gdstudio音乐源 v1.0.1（仅支持网易）.js",
    "忆音音源_v1.js",
    "长青SVIP音源v1.2.0（全平台支持无损）.js",
    // 回归用例：这个混淆稿曾经让 esbuild 直接报
    // `X [ERROR] Cannot assign to "q" because it is a constant` —— 无论 .mjs 还是 .cjs，
    // 只要打包器**解析**用户脚本就会判死（本机实测；当初"Workers ESM 严格模式"的说法是误诊，
    // 真正的约束是"打包器不能看到用户代码"）。洛雪官方是用 new Function 宽松执行音源的，
    // 所以这里必须是 Text 模块 + 启动期 new Function。它一旦再进打包器就必然发布失败，
    // 所以它要一直留在用例里。
    "lx-玉宁熙V1.2.2.js",
  ];
  const entries = [];
  const byName = {};
  console.log("准备 bundle：");
  for (const name of chosen) {
    const text = pickScript(name);
    const hash = await sha256Hex(text);
    entries.push({ hash, name, scriptText: text });
    byName[name] = hash;
    console.log(`  ${name} → ${hash.slice(0, 12)} (${text.length}B)`);
  }

  // 一个"能编译、但请求期一定抛异常"的假源。它存在的理由是一条现网事故：
  // 用户脚本抛异常时，Promise.race 把异常抛穿了 fetch，Cloudflare 回的是
  // HTTP 500 + "error code: 1101" 纯文本，体检只能说"runner 返回不是 JSON"，
  // 把「酷狗上游挂了」这种可诊断的坏源，显示成一桩无法解释的基础设施故障。
  const brokenName = "〔用例〕请求期抛异常的假源";
  const brokenText =
    'globalThis.lx.send(globalThis.lx.EVENT_NAMES.inited, { type: "broken_fixture", sources: { wy: { name: "用例", type: "music", actions: ["musicUrl"], qualitys: ["320k"] } } });\n' +
    'globalThis.lx.on(globalThis.lx.EVENT_NAMES.request, () => { throw new Error("用例：上游 503"); });\n';
  const brokenHash = await sha256Hex(brokenText);
  entries.push({ hash: brokenHash, name: brokenName, scriptText: brokenText });
  byName[brokenName] = brokenHash;
  console.log(`  ${brokenName} → ${brokenHash.slice(0, 12)} (${brokenText.length}B)`);

  const files = buildRunnerFiles(entries);
  for (const f of files) {
    const abs = path.join(OUT_DIR, f.path);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content, "utf8");
  }
  writeFileSync(
    path.join(OUT_DIR, "wrangler.toml"),
    `name = "primuse-lx-runner-e2e"
main = "entry.mjs"
compatibility_date = "2025-08-01"

# 不要再给 scripts/*.txt 写 [[rules]] type = "Text"：wrangler 自带
# {"type":"Text","globs":["**/*.txt","**/*.html","**/*.sql"]}，同 type 再声明一次会被
# 它的 module-collector 判成 "a previous rule with the same type was not marked as
# fallthrough = true"，整包直接起不来（本机实测）。走 Workers REST API 部署时才是
# 在 metadata.modules 里逐个显式声明 type，两条路径都要各自对上这个前提。

[vars]
LX_RUNNER_TOKEN = "${TOKEN}"
`
  );

  console.log(`\nbundle 文件：${files.map((f) => `${f.path}(${f.content.length}B)`).join(", ")}`);

  // 先用 node --check 把生成的入口过一遍语法。这条守卫的价值在**快**：
  // 入口模板是拼出来的字符串，少一个花括号要等 workerd 起不来、3 分钟超时才看得见
  // （本机就这么栽过一次：entry.mjs:177 "Unexpected ,"）。
  {
    const tmp = path.join(OUT_DIR, ".entry-syntax.mjs");
    writeFileSync(tmp, files.find((f) => f.path === "entry.mjs").content, "utf8");
    const chk = spawnSync(process.execPath, ["--check", tmp], { encoding: "utf8" });
    assert(chk.status === 0, "生成的 entry.mjs 语法自检通过（拼字符串的模板要有快速守卫）", String(chk.stderr || chk.stdout).slice(0, 300));
    rmSync(tmp, { force: true });
  }

  const scriptMods = files.filter((f) => f.path.startsWith("scripts/"));
  const entryFile = files.find((f) => f.path === "entry.mjs");
  assert(scriptMods.length === entries.length, "每个音源脚本各自一个模块", `${scriptMods.length}/${entries.length}`);
  assert(
    scriptMods.every((f) => f.path.endsWith(".txt") && f.moduleType === "Text"),
    "音源正文以 Text 模块进 bundle（esbuild 一旦解析混淆稿就整包发布失败）",
    scriptMods.map((f) => f.moduleType).join("/")
  );
  assert(
    scriptMods.every((f, i) => f.content === entries[i].scriptText),
    "模块正文 = 用户脚本原样字节，一个字符都没包（打包器看不到用户代码）",
    ""
  );
  assert(
    entryFile && /new Function\(/.test(entryFile.content) && entryFile.content.includes("SANDBOX_PREFIX"),
    "入口在启动阶段用 new Function + 沙箱模板编译脚本（Workers 只禁请求期生成代码）",
    ""
  );
  assert(files.every((f) => !/^\s*import\s.*data:/m.test(f.content)), "bundle 里没有运行期 data: import", "只有静态相对路径 import");

  const child = spawn("npx", ["--yes", "wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1", "--local"], {
    cwd: OUT_DIR,
    shell: true,
    windowsHide: true,
  });
  try {
    await waitReady(child);
    console.log(`\nrunner 已在 ${BASE} 起来（真实 workerd）`);

    const health = await fetch(`${BASE}/health`).then((r) => r.json());
    assert(health.ok === true, "GET /health 返回 ok");
    assert(health.contract === RUNNER_CONTRACT, "健康检查带契约标识", health.contract);
    assert(health.modules === entries.length, `加载了 ${entries.length} 个音源模块`, `实际 ${health.modules}`);
    assert(
      (health.broken || []).length === 0 && health.compiled === entries.length,
      "四个脚本在 workerd 里全部编译通过（含那份 147KB 混淆稿）",
      `compiled=${health.compiled} broken=${JSON.stringify(health.broken || []).slice(0, 200)}`
    );
    // 启动阶段只编译、不执行：脚本顶层的 setTimeout/fetch 在 global scope 里是非法操作，
    // 真跑了才会知道 —— 所以这里要求"初始化过的个数"起步为 0，被调用过才涨。
    assert(health.initialized === 0, "刚起来的 isolate 里没有任何脚本被执行过（启动期只编译）", `initialized=${health.initialized}`);

    assert(
      entries.every((e) => (health.hashes || []).includes(e.hash)),
      "全部测试脚本的 sha256 都在 runner 注册表里",
      (health.hashes || []).map((h) => h.slice(0, 8)).join(",")
    );

    const noAuth = await post({ hash: byName[chosen[0]], action: "musicUrl", params: {} }, { token: "" });
    assert(noAuth.status === 401, "不带 Bearer 的调用被拒（runner 不是公网代理）", `HTTP ${noAuth.status}`);

    const caps = await post({ hash: byName[chosen[0]], action: "capabilities", params: {} });
    assert(caps.json && caps.json.ok === true, "capabilities 调用成功");
    const inited = (caps.json && caps.json.result) || {};
    const capSources = inited.sources || inited;
    assert(Object.keys(capSources).length >= 1, "脚本自己声明了可用平台", Object.keys(capSources).join("/"));

    const unknown = await post({ hash: "0".repeat(64), action: "musicUrl", params: {} });
    assert(unknown.status === 409 && unknown.json && unknown.json.error === "hash_not_deployed", "没部署的 hash 明确报 hash_not_deployed", JSON.stringify(unknown.json && unknown.json.error));

    // 抛异常的脚本必须**以 JSON 交出异常**：变成 Cloudflare 的 "error code: 1101" 纯文本
    // 就等于把"这条源的上游挂了"降级成"runner 坏了"，体检和后台都读不到原因。
    const boom = await post({ hash: byName[brokenName], action: "musicUrl", params: { source: "wy", info: { musicInfo: { id: NETEASE_ID } } } });
    assert(
      boom.json && boom.json.ok === false && boom.json.error === "script_exception",
      "脚本请求期抛异常 → JSON 里的 script_exception（不是 1101 纯文本）",
      boom.json ? `${boom.json.error} · ${String(boom.json.detail || "").slice(0, 80)}` : `非 JSON HTTP ${boom.status}: ${String(boom.text).slice(0, 120)}`
    );
    assert(
      boom.json && String(boom.json.detail || "").includes("用例：上游 503"),
      "异常原文透传给调用方（体检详情里能看到脚本自己说的是哪一句）",
      String((boom.json && boom.json.detail) || "").slice(0, 140)
    );
    const stillHealthy = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json()).catch(() => null);
    assert(
      stillHealthy && stillHealthy.ok === true && (stillHealthy.broken || []).length === 0,
      "一条脚本抛异常不污染别的源，也不把它算成「编译失败」",
      JSON.stringify({ ok: stillHealthy && stillHealthy.ok, broken: (stillHealthy && stillHealthy.broken || []).length })
    );

    if (USE_NET) {
      // 每个脚本都真跑一遍"取直链 → Range 取音频"。这里不断言某个源必须成功或必须失败
      // （第三方站会活也会死），断言的是：管道对每一个源都能给出**由字节决定的结论**。
      const verdicts = [];
      for (const name of chosen) {
        const r = await post({
          hash: byName[name],
          action: "musicUrl",
          params: {
            source: "wy",
            info: {
              musicInfo: { id: NETEASE_ID, songmid: NETEASE_ID, mid: NETEASE_ID, hash: NETEASE_ID, name: "晴天", singer: "周杰伦", interval: 254 },
              type: "320k",
              quality: "320k",
              startQuality: "320k",
            },
          },
        });
        const j = r.json;
        const url = j && j.ok ? (typeof j.result === "string" ? j.result : j.result && j.result.url) : null;
        let probe = null;
        if (/^https?:\/\//i.test(String(url))) probe = await probeAudio(url);
        verdicts.push({ name, ok: Boolean(j && j.ok), url, err: j ? j.error || j.detail : `非 JSON 响应 HTTP ${r.status}: ${String(r.text).slice(0, 160)}`, probe });
        const line = `${name}\n      直链：${String(url || "（无）").slice(0, 96)}\n      取流：${probe ? `${probe.status} ${probe.contentType.split(";")[0]} ${probe.bytes}B magic=${probe.magic} 文本特征=${probe.looksText} 源站=${probe.finalHost}` : "未取到链接"}\n      结论：${probe && probe.playable ? "能出声 ✅" : "不能出声 ❌"}`;
        console.log(`    · ${line}`);
        if (probe && probe.playable) {
          assert(probe.magic === true, `${name}：判"能出声"时字节层确实有音频魔数`, `head=${probe.head} ct=${probe.contentType.split(";")[0]}`);
        }
      }
      for (const v of verdicts) {
        assert(v.ok === true || typeof v.err === "string" && v.err.length > 0, `${v.name}：要么给直链，要么给明确错误（不存在"静默没结果"）`, v.ok ? "给了直链" : v.err.slice(0, 120));
      }
      const playable = verdicts.filter((v) => v.probe && v.probe.playable);
      assert(playable.length >= 1, "至少一个 js 音源经 runner 拿到了真能出声的直链", `${playable.length}/${verdicts.length} 个源可播`);
      // 混淆脚本能不能活着跑完，决定"多多益善"能不能兑现。
      const cq = verdicts.find((v) => v.name === "长青SVIP音源v1.2.0（全平台支持无损）.js");
      assert(cq.ok === true, "混淆脚本（长青 SVIP）在沙箱里也能执行到底", cq.ok ? `直链 ${String(cq.url).slice(0, 60)}` : String(cq.err).slice(0, 160));
      // 这个曾经连 bundle 都编译不过；能跑到底（哪怕源站死了给出明确错误）才算沙箱形态对了。
      const yn = verdicts.find((v) => v.name === "lx-玉宁熙V1.2.2.js");
      assert(yn.ok === true || (typeof yn.err === "string" && yn.err.length > 0), "严格模式陷阱脚本（lx-玉宁熙）已能进沙箱并跑到终点", yn.ok ? `直链 ${String(yn.url).slice(0, 60)}` : String(yn.err).slice(0, 160));

    } else {
      console.log("  ⏭  联网用例被 --no-net 跳过");
    }
  } finally {
    spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
    killLeftovers();
    rmSync(OUT_DIR, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
  }

  console.log(`\n==== runner 端到端：${pass} 通过 / ${fails.length} 失败 ====`);
  for (const f of fails) console.log(`  ❌ ${f}`);
  if (fails.length) process.exit(1);
}

main().catch((e) => {
  console.error("测试自身出错：", e && e.stack ? e.stack : e);
  process.exit(2);
});
