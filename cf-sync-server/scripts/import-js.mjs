// 把一个目录里的洛雪 js 音源批量导入 CF 服务端（走的就是后台面板那同一个接口）。
//
// 为什么用 HTTP 而不是直接写 D1：import-js 里有一整套判据——正文必须像洛雪音源
// （找得到 globalThis.lx / EVENT_NAMES）、要解析 @name、要按脚本声明的平台拆成多条音源、
// 要 gzip 存正文并推 revision。绕过它直接塞库，清单就会和真实管理能力脱节。
//
// 用法： node scripts/import-js.mjs [目录] [--priority=5] [--only=名字片段] [--dry]

import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith("--"));
const positional = args.filter((a) => !a.startsWith("--"));

const DIR = path.resolve(ROOT, positional[0] || "..\\音源文件");
const PRIORITY = Number((flags.find((f) => f.startsWith("--priority=")) || "--priority=5").split("=")[1]);
const ONLY = (flags.find((f) => f.startsWith("--only=")) || "").split("=")[1] || "";
const DRY = flags.includes("--dry");

function envLine(file, key) {
  try {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && m[1] === key) return m[2];
    }
  } catch { /* 没有文件就走环境变量 */ }
  return "";
}

const BASE = process.env.PRIMUSE_CF_BASE || "https://primuse-sync-server.pages.dev";
const TOKEN = process.env.SOURCES_ADMIN_TOKEN || envLine(path.join(ROOT, ".deploy-secrets.txt"), "SOURCES_ADMIN_TOKEN");

async function importOne(file) {
  const text = readFileSync(file, "utf8");
  if (text.indexOf("globalThis.lx") < 0 && text.indexOf("EVENT_NAMES") < 0) {
    return { file: path.basename(file), skipped: "正文不像洛雪音源" };
  }
  if (DRY) return { file: path.basename(file), dry: true, bytes: text.length };
  const res = await fetch(`${BASE}/api/music-sources?action=import-js`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ filename: path.basename(file), script: text, priority: PRIORITY }),
  });
  const j = await res.json().catch(() => null);
  if (!j || j.code !== 0) {
    return { file: path.basename(file), error: (j && j.error) || `HTTP ${res.status}`, bytes: text.length };
  }
  return {
    file: path.basename(file),
    name: (j.data.meta && j.data.meta.name) || "(无名)",
    hash: String(j.data.hash || "").slice(0, 12),
    platforms: j.data.platforms || [],
    sources: (j.data.sources || []).map((s) => s.id),
    bytes: text.length,
  };
}

async function main() {
  if (!existsSync(DIR)) throw new Error(`目录不存在：${DIR}`);
  if (!DRY && !TOKEN) throw new Error("没有 SOURCES_ADMIN_TOKEN（.deploy-secrets.txt 或环境变量）");
  const files = readdirSync(DIR).filter((f) => /\.js$/i.test(f)).filter((f) => !ONLY || f.indexOf(ONLY) >= 0).map((f) => path.join(DIR, f));
  console.log(`目标：${BASE}\n待导入 ${files.length} 个 js 文件（优先级 ${PRIORITY}）\n`);
  const rows = [];
  for (const f of files) {
    const r = await importOne(f);
    rows.push(r);
    const tag = r.error ? "❌" : r.skipped ? "⏭ " : r.dry ? "· " : "✅";
    console.log(`${tag} ${r.file.slice(0, 42).padEnd(44)} ${(r.name || r.skipped || r.error || "").slice(0, 34).padEnd(36)} ${(String(r.hash || "") + " " + (r.platforms || []).join("/")).slice(0, 30)}`);
    // 服务端有按隔离区的限流；导入是写操作，间隔放宽一点更稳。
    if (!DRY) await new Promise((x) => setTimeout(x, 350));
  }
  const okN = rows.filter((r) => r.sources && r.sources.length).length;
  console.log(`\n成功 ${okN} / ${rows.length}；新增音源 ${rows.reduce((a, r) => a + ((r.sources || []).length), 0)} 条`);
}

main().catch((e) => {
  console.error(`导入中断：${e && e.message ? e.message : e}`);
  process.exit(1);
});
