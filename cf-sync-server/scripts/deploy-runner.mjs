// 把"当前启用的洛雪 js 音源"打成 runner Worker 并部署上线。
//
// 为什么要有这个本地脚本，而不是只靠后台的「重新部署 runner」按钮：
// Cloudflare 边缘禁止请求期生成代码，所以 runner 只能在**部署期**把脚本编成静态模块；
// 后台按钮走的是 Workers API（需要 Pages 上配 CF_ACCOUNT_ID / CF_API_TOKEN）。本机已经
// `wrangler login` 过，这条路径不需要那个 API Token，也能在配 Token 之前把 runner 先上线。
//
// 用法：
//   node scripts/deploy-runner.mjs          # 读远端 D1 → 生成 bundle → wrangler deploy
//   node scripts/deploy-runner.mjs --dry    # 只生成 bundle，不部署（看清单用）
//
// 它只做读 D1 + 部署自己那一个 Worker，不碰歌单表、不碰 Pages。

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildRunnerFiles, runnerName, RUNNER_CONTRACT, MAX_RAW_BYTES, DEPLOYED_HASHES_KEY } from "../functions/lib/runner.js";
import { gunzipText, sha256Hex } from "../functions/lib/lx.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const OUT_DIR = path.join(ROOT, ".runner-deploy");
const D1_NAME = process.env.D1_NAME || "halo-music-db";
const dry = process.argv.includes("--dry");

function wranglerJson(args) {
  const r = spawnSync("npx", ["--yes", "wrangler", ...args], { cwd: ROOT, encoding: "utf8", shell: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`wrangler ${args.join(" ")} 失败：${String(r.stderr || r.stdout).slice(-600)}`);
  const text = String(r.stdout);
  // d1 --json 的输出是一个数组（每条语句一个对象），前面还混着 wrangler 自己的横幅。
  const bracket = text.indexOf("[");
  const start = bracket >= 0 ? bracket : text.indexOf("{");
  const end = Math.max(text.lastIndexOf("]"), text.lastIndexOf("}"));
  if (start < 0 || end < start) throw new Error(`wrangler 输出里找不到 JSON：${text.slice(0, 300)}`);
  return JSON.parse(text.slice(start, end + 1));
}

/**
 * SELECT 必须走 --command：实测 `--file` 的 --json 输出里 results 只有执行统计
 * （"Total queries executed" 那种），没有查询出来的行。
 * Windows 上 shell:true 会把参数再拆一次，所以 SQL 自己带一对双引号。
 */
function d1Select(sql) {
  return wranglerJson(["d1", "execute", D1_NAME, "--remote", "--json", "--command", `"${sql.replace(/"/g, '\\"')}"`]);
}

/** d1 --json 的输出是一个数组（每条语句一个对象）；这里统一取第一条的 results。 */
function rowsOf(out) {
  const first = Array.isArray(out) ? out[0] : out;
  return (first && first.results) || [];
}

const BODY_BATCH_BYTES = 1_500_000;

/**
 * 脚本正文必须**分批**取，不能一条 SQL 把 22 个 body 一起拉回来：
 * 一次取全部（约 3.5MB base64）时，D1 的 /query 接口回的是
 * "The given account is not valid or is not authorized to access this service [code: 7403]"
 * —— 一个和体积毫无关系的鉴权文案，本机实测（把 body 列去掉就正常，单取一条小的也正常）。
 * 所以先拿清单，再按 raw_bytes 累加到 ~1.5MB 一批地取正文。
 */
function loadBodies(metas) {
  const byHash = new Map();
  let batch = [];
  let acc = 0;
  const flush = () => {
    if (!batch.length) return;
    const list = batch.map((h) => `'${h.replace(/'/g, "")}'`).join(",");
    const rows = rowsOf(d1Select(`SELECT hash, body FROM source_scripts WHERE hash IN (${list})`));
    for (const r of rows) if (r && r.hash) byHash.set(r.hash, r.body);
    console.log(`  · 取回 ${rows.length} 份正文（本批 ${batch.length} 个 hash，约 ${acc}B 原始量）`);
    batch = [];
    acc = 0;
  };
  for (const m of metas) {
    const size = Number(m.raw_bytes || 0);
    if (batch.length && acc + size > BODY_BATCH_BYTES) flush();
    batch.push(m.hash);
    acc += size;
  }
  flush();
  return byHash;
}

function readSecretsFile() {
  const f = path.join(ROOT, ".deploy-secrets.txt");
  const out = {};
  if (!existsSync(f)) return out;
  for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function main() {
  const secrets = readSecretsFile();
  const token = process.env.LX_RUNNER_TOKEN || secrets.LX_RUNNER_TOKEN || "";
  if (!token) throw new Error("没有 LX_RUNNER_TOKEN（.deploy-secrets.txt 或环境变量）；runner 不带令牌就会拒掉所有调用");

  // 和后台同一条口径：**清单里所有 lxjs 源的脚本，停用的也带上**。
  // 停用的不带上线，它就永远是 runner_missing（观测盲区 → 维持现状 → 维持停用），
  // 误杀的洛雪源就再也翻不了案 —— 详见 functions/lib/runner.js 里 desiredScriptSet 的注释。
  const metas = rowsOf(
    d1Select(
      "SELECT s.hash AS hash, s.name AS name, s.raw_bytes AS raw_bytes FROM source_scripts s " +
        "JOIN music_sources m ON m.script_hash = s.hash WHERE m.protocol = 'lxjs' " +
        "GROUP BY s.hash ORDER BY MAX(m.enabled) DESC, MIN(m.priority) DESC"
    )
  ).filter((r) => r && r.hash);
  console.log(`远端 D1 里的 lxjs 脚本（含已停用的，供翻案重检）：${metas.length} 个`);
  const bodies = metas.length ? loadBodies(metas) : new Map();

  const entries = [];
  let total = 0;
  for (const row of metas) {
    const body = bodies.get(row.hash);
    if (!body) {
      console.log(`  ⏭  ${row.hash.slice(0, 12)} 没取到正文（分批查询漏了？），跳过`);
      continue;
    }
    let text;
    try {
      text = await gunzipText(body);

    } catch (e) {
      console.log(`  ⏭  ${row.hash.slice(0, 12)} 解压失败：${e.message}`);
      continue;
    }
    const hash = await sha256Hex(text);
    if (hash !== row.hash) {
      console.log(`  ⏭  ${row.hash.slice(0, 12)} 存回的字节和指纹对不上（算出来 ${hash.slice(0, 12)}），跳过`);
      continue;
    }
    const size = new TextEncoder().encode(text).length;
    // 和后台 syncRunner 同一个预算，别让两条路径产出不同的 bundle。
    if (total + size > MAX_RAW_BYTES) {
      console.log(`  ⏭  ${hash.slice(0, 12)} 超出 bundle 预算（已用 ${total}B + ${size}B > ${MAX_RAW_BYTES}B）`);
      continue;
    }
    total += size;
    entries.push({ hash, name: row.name || "", bytes: size, scriptText: text });
    console.log(`  • ${hash.slice(0, 12)} ${(row.name || "").slice(0, 40)} · ${size}B`);
  }
  if (!entries.length) console.log("  （一个都没有 —— runner 会是个空壳，先导入 js 音源再部署）");

  rmSync(OUT_DIR, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 });
  mkdirSync(path.join(OUT_DIR, "scripts"), { recursive: true });
  for (const f of buildRunnerFiles(entries)) {
    const abs = path.join(OUT_DIR, f.path);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content, "utf8");
  }
  const name = runnerName({ LX_RUNNER_NAME: process.env.LX_RUNNER_NAME });
  // 这里**不写** [[rules]]：wrangler 自带 {"type":"Text","globs":["**/*.txt","**/*.html","**/*.sql"]}，
  // 同 type 再声明一次会被它的 module-collector 判成 "previous rule with the same type was
  // not marked as fallthrough = true"，整包起不来（本机实测）。后台那条路径走 Workers REST API，
  // 是在 metadata.modules 里逐个显式声明 type = "Text"，两条路径拿到的是同一个形态。
  writeFileSync(
    path.join(OUT_DIR, "wrangler.toml"),
    [
      `name = "${name}"`,
      'main = "entry.mjs"',
      'compatibility_date = "2025-08-01"',
      "",
      "[vars]",
      `LX_RUNNER_TOKEN = "${token}"`,
      `LX_RUNNER_BYTES = "${total}"`,
      `LX_RUNNER_CONTRACT = "${RUNNER_CONTRACT}"`,
      "",
    ].join("\n")
  );
  console.log(`bundle：${entries.length} 个模块 · 脚本正文合计 ${total}B → ${OUT_DIR}`);
  if (dry) {
    console.log("--dry：只生成，不部署。");
    return;
  }

  const r = spawnSync("npx", ["--yes", "wrangler", "deploy"], { cwd: OUT_DIR, encoding: "utf8", shell: true });
  const out = String(r.stdout || "") + String(r.stderr || "");
  console.log(out.split(/\r?\n/).filter((l) => l.trim()).slice(-14).join("\n"));
  if (r.status !== 0) throw new Error("wrangler deploy 失败");
  const url = /https:\/\/[a-z0-9.-]+\.workers\.dev/i.exec(out);
  console.log(`\nrunner 已部署：${name}`);
  console.log(url ? `workers.dev 地址：${url[0]}/${name}` : "（输出里没找到 workers.dev 地址；Pages 侧请配 LX_RUNNER_URL 或加服务绑定）");

  // 部署完把"runner 实际加载了哪些脚本"回写进 D1 的部署记录。
  // 为什么绕一圈走 Pages 的 trust-runner，而不是这里直接写 D1：写记录只留一个口径
  // （trustRunnerHashes 读 runner 的 /health），本机和后台两条部署路径共用它，
  // 不会出现"两边各记一套哈希"。这一步失败不影响 runner 已经上线这件事，所以只提示不抛错。
  await trustRunnerViaPages(secrets, entries.length);
}

/**
 * 回写部署记录。为什么要等：Cloudflare 换 Worker 版本不是瞬时的 —— 本机实测
 * `wrangler deploy` 打印完 Version ID 之后的约 30 秒里，workers.dev 仍在跑**上一个版本**，
 * 这时读 /health 拿到的是旧哈希集合，记录就写错了（表现为后台一直显示"部署记录和实装不一致"）。
 * 所以按"期望模块数"重试，等到边缘真的换上新版本再写。
 */
async function trustRunnerViaPages(secrets, expectedModules = 0) {
  const base = (process.env.PAGES_BASE_URL || "https://primuse-sync-server.pages.dev").replace(/\/+$/, "");
  const admin = process.env.SOURCES_ADMIN_TOKEN || secrets.SOURCES_ADMIN_TOKEN || "";
  if (!admin) {
    console.log('⚠️ 没有 SOURCES_ADMIN_TOKEN，跳过回写部署记录（后台点一次"查询状态"就能看到"记录待对齐"）');
    return;
  }
  const deadline = Date.now() + 120000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/music-sources?action=trust-runner`, {
        method: "POST",
        headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(60000),
      });
      const j = await res.json().catch(() => null);
      const n = j && j.data && Array.isArray(j.data.hashes) ? j.data.hashes.length : 0;
      if (!res.ok || !j || j.code !== 0) {
        console.log(`⚠️ 回写部署记录失败（HTTP ${res.status}）：${(j && (j.error || j.message)) || "无响应"} —— runner 本身已上线，体检不受影响`);
        return;
      }
      if (!expectedModules || n === expectedModules) {
        console.log(`✅ 部署记录已对齐：runner 当前加载 ${n} 个脚本`);
        return;
      }
      // 版本还没切过来：等一会儿重试，别把旧集合写进记录。
      last = `边缘仍是 ${n} 个模块（本次部署 ${expectedModules} 个）`;
    } catch (e) {
      last = `够不到 ${base}：${String(e && e.message ? e.message : e)}`;
    }
    console.log(`  …  ${last}，20s 后重试`);
    await new Promise((r) => setTimeout(r, 20000));
  }
  console.log(`⚠️ 等满 120s 边缘仍未切版本（${last}）。runner 已部署成功，稍后在后台点"对齐部署记录"即可。`);
}

main().catch((e) => {
  console.error(`部署中断：${e && e.message ? e.message : e}`);
  process.exit(1);
});
