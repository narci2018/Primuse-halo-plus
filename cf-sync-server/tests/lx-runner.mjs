// 把 lib/runner.js 生成的 bundle 真跑起来（wrangler dev），给契约测试当"边缘执行"的对端。
//
// 为什么不 mock：整条链唯一没被证过的就是"部署期静态模块 + 沙箱"在 workerd 里能不能出声。
// mock 一个 runner 等于什么都没测。这里起的正是后台将来经 Cloudflare API 部署的那同一份 bundle。

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildRunnerFiles } from "../functions/lib/runner.js";
import { sha256Hex } from "../functions/lib/lx.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

export async function startLxRunner({ files, port, token, timeoutMs = 180000 }) {
  // Windows 上"进程已死、目录句柄还没放"是常态（上一轮 taskkill 掉 workerd 后
  // 立刻 rmSync 就 EPERM 了）。所以先尽力清旧的，清不掉就换一个带 pid 的目录名——
  // 测试要的是"这一轮跑的是这一轮生成的 bundle"，目录复用本来就不是必需。
  let outDir = path.join(ROOT, ".runner-contract");
  const tryRemove = (p) => {
    try {
      rmSync(p, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 });
      return true;
    } catch {
      return false;
    }
  };
  if (!tryRemove(outDir) || existsSync(outDir)) {
    outDir = path.join(ROOT, `.runner-contract-${process.pid}`);
    tryRemove(outDir);
  }
  mkdirSync(outDir, { recursive: true });

  const entries = [];
  for (const f of files) {
    // 内联脚本：{ name, scriptText }。用于那些"真实文件里学不到"的形状 ——
    // 比如声明了 search 能力的音源（现网那 23 个文件里能搜的都不稳定，测试要的是确定性）。
    if (f && typeof f === "object" && f.scriptText) {
      entries.push({ hash: await sha256Hex(f.scriptText), name: f.name || "inline", scriptText: f.scriptText });
      continue;
    }
    const abs = path.isAbsolute(f) ? f : path.resolve(ROOT, "..", "音源文件", f);
    if (!existsSync(abs)) throw new Error(`缺少音源文件：${abs}`);
    const text = readFileSync(abs, "utf8");
    entries.push({ hash: await sha256Hex(text), name: path.basename(abs), scriptText: text });
  }
  for (const fl of buildRunnerFiles(entries)) {
    const abs = path.join(outDir, fl.path);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, fl.content, "utf8");
  }
  writeFileSync(
    path.join(outDir, "wrangler.toml"),
    // 别给 scripts/*.txt 写显式的 [[rules]] type = "Text"：wrangler 自带
    // {"type":"Text","globs":["**/*.txt","**/*.html","**/*.sql"]}，同 type 重复声明会被它的
    // module-collector 判成 "previous rule with the same type was not marked as
    // fallthrough = true"，runner 直接起不来（本机实测）。Text 就靠这条默认规则拿到。
    `name = "primuse-lx-runner-contract"\nmain = "entry.mjs"\ncompatibility_date = "2025-08-01"\n\n[vars]\nLX_RUNNER_TOKEN = "${token}"\n`
  );

  const child = spawn(`npx --yes wrangler dev --port ${port} --ip 127.0.0.1 --local`, {
    cwd: outDir,
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
    windowsHide: true,
    env: { ...process.env, WRANGLER_LOG: "warn" },
  });
  let buf = "";
  child.stdout.on("data", (d) => { buf += String(d); });
  child.stderr.on("data", (d) => { buf += String(d); });

  // 别靠解析 stdout 等就绪：WRANGLER_LOG=warn 会把 "Ready on" 那行一起压掉，
  // 上一版就是这么"启动超时"的——而 workerd 其实已经在监听了（端口都占着）。
  // 直接轮询对端自己的 /health，只有真答话才算起来。
  const base = `http://127.0.0.1:${port}`;
  let health = null;
  const start = Date.now();
  for (;;) {
    health = await fetch(`${base}/health`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (health && health.contract) break;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`runner 启动超时（${timeoutMs}ms 内 /health 没答话）：\n${buf.slice(-1800)}`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  return {
    child,
    base,
    outDir,
    health,
    hashes: (health && health.hashes) || [],
    // 只端掉自己这一棵进程树：pages dev 也是 workerd，全局 /IM 会把它一起杀了。
    stop() {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
      rmSync(outDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 });
    },
  };
}
