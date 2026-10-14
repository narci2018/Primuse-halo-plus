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

async function waitReady(child, { timeoutMs = 150000 } = {}) {
  const start = Date.now();
  let buf = "";
  return new Promise((resolve, reject) => {
    const onData = (b) => {
      buf += String(b);
      if (/Ready on/i.test(buf)) {
        child.stdout.off("data", onData);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        child.stdout.off("data", onData);
        reject(new Error(`runner dev 启动超时\n${buf.slice(-2000)}`));
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (b) => { buf += String(b); });
  });
}

async function post(body, { token = TOKEN } = {}) {
  const res = await fetch(`${BASE}/`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
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

  const files = buildRunnerFiles(entries);
  for (const f of files) {
    const abs = path.join(OUT_DIR, f.path);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content, "utf8");
  }
  writeFileSync(
    path.join(OUT_DIR, "wrangler.toml"),
    `name = "primuse-lx-runner-e2e"\nmain = "entry.mjs"\ncompatibility_date = "2025-08-01"\n\n[vars]\nLX_RUNNER_TOKEN = "${TOKEN}"\n`
  );

  console.log(`\nbundle 文件：${files.map((f) => `${f.path}(${f.content.length}B)`).join(", ")}`);
  assert(files.some((f) => f.path === "scripts/__lx_console.mjs"), "bundle 带上了 console 垫片模块");
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
      entries.every((e) => (health.hashes || []).includes(e.hash)),
      "三个脚本的 sha256 都在 runner 注册表里",
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
      const cq = verdicts.find((v) => v.name === chosen[2]);
      assert(cq.ok === true, "混淆脚本（长青 SVIP）在沙箱里也能执行到底", cq.ok ? `直链 ${String(cq.url).slice(0, 60)}` : String(cq.err).slice(0, 160));
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
