// 现网逐条体检：跑「检测全部可用」这条链路，产出"真能出声"名单。
//
// 为什么要有这个本地脚本：后台面板里那个按钮做的是同一件事，但它要人守着网页看进度；
// 22 条洛雪 js 源一条条过（搜 → 解析直链 → 真的用 Range 取 64KB 音频），
// 用脚本跑完能直接把名单打出来、存成文件，改完源再跑一次就能对比。
//
// 用法：
//   node scripts/check-live.mjs                      # 全部启用的源，关键词「晴天」
//   node scripts/check-live.mjs --keyword=青花瓷
//   node scripts/check-live.mjs --only=lxjs-84de7276c0-netease   # 只检某几条（逗号分隔）
//   node scripts/check-live.mjs --base=https://xxx.pages.dev
//
// 写操作范围：check-one 会把体检结果写回 D1，并按用户要求把**确实不可用**的源停用 + 标删除建议。
// "检不出结果"（没有样本 / runner 没装这条 / 协议不做搜索）不会停用，这是口径的分界线。

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const BASE = (process.env.PAGES_BASE_URL || "https://primuse-sync-server.pages.dev").replace(/\/+$/, "");
const OUT = path.join(ROOT, ".check-live.json");

function arg(name, dflt) {
  const m = new RegExp(`^--${name}=(.*)$`).exec(process.argv.find((a) => a.startsWith(`--${name}=`)) || "");
  return m ? m[1] : dflt;
}

function readSecretsFile() {
  const f = path.join(ROOT, ".deploy-secrets.txt");
  const out = {};
  try {
    for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2];
    }
  } catch {
    /* 没有密钥文件就全靠环境变量 */
  }
  return out;
}

const secrets = readSecretsFile();
// 体检令牌优先：它的权限比管理令牌小，CI/脚本该用小的那个。
const TOKEN = process.env.SOURCES_CHECK_TOKEN || secrets.SOURCES_CHECK_TOKEN || process.env.SOURCES_ADMIN_TOKEN || secrets.SOURCES_ADMIN_TOKEN || "";
if (!TOKEN) {
  console.error("没有 SOURCES_CHECK_TOKEN / SOURCES_ADMIN_TOKEN（.deploy-secrets.txt 或环境变量）");
  process.exit(1);
}

async function post(action, body) {
  const res = await fetch(`${BASE}/api/music-sources?action=${action}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body || {}),
    // 体检一条最长是「搜 + 解析 + 取音频」三段网络，给足但不能没有：
    // 没有超时的话一条卡住的源能把整个脚本挂死。
    signal: AbortSignal.timeout(180000),
  });
  const json = await res.json().catch(() => null);
  if (!json || json.code !== 0) {
    throw new Error(`${action} 失败（HTTP ${res.status}）：${(json && (json.error || json.message)) || "无响应"}`);
  }
  return json.data;
}

const keyword = arg("keyword", "晴天");
const only = arg("only", "").split(",").map((s) => s.trim()).filter(Boolean);
// --all=1：把**已停用**的源也扫一遍。判据改了（或第三方站自己缓过来了）之后，
// 只按 check-plan 的"启用的源"重跑永远洗不掉误杀 —— 被停用的那条已经不在计划里了。
// 体检一条就会按新结论改写启停位，所以这是"翻案"唯一的入口。
const includeDisabled = arg("all", "") !== "";

const plan = await post("check-plan", { keyword });
let list = plan.plan;
if (includeDisabled) {
  const res = await fetch(`${BASE}/api/music-sources?deviceId=check-live-all`, { signal: AbortSignal.timeout(45000) });
  const srcs = ((await res.json().catch(() => null))?.data?.sources) || [];
  const seen = new Set(list.map((p) => p.id));
  list = list.concat(srcs.filter((s) => !seen.has(s.id)).map((s) => ({ id: s.id, name: s.name, platform: s.platform, protocol: s.protocol, wasDisabled: true })));
  if (srcs.length) console.log(`（--all：清单共 ${srcs.length} 条，含已停用的 ${srcs.filter((s) => !s.enabled).length} 条一起重检）\n`);
}
const todo = list.filter((p) => (only.length ? only.includes(p.id) : true));
console.log(`现网：${BASE}`);
console.log(`本次体检 ${todo.length} 条（启用的 ${plan.plan.length} 条${includeDisabled ? " + 已停用的 " + (list.length - plan.plan.length) + " 条" : ""}），关键词「${keyword}」\n`);

const results = [];
for (let i = 0; i < todo.length; i++) {
  const p = todo[i];
  const tag = `${String(i + 1).padStart(2)}/${todo.length}`;
  try {
    const d = await post("check-one", { id: p.id, keyword });
    const r = d.result || {};
    results.push({ ...p, status: r.status, detail: r.detail, bytes: r.bytes, enabled: d.source?.enabled, suggestDelete: d.source?.suggestDelete });
    const mark = r.status === "ok" ? "✅" : ["no_sample", "runner_missing", "unsupported"].includes(r.status) ? "⚠️" : "❌";
    const flip = p.wasDisabled && d.source?.enabled === true ? " → 已复活（旧结论是误杀）" : d.source && d.source.enabled === false ? " → 已停用" : "";
    console.log(`${mark} ${tag} ${p.name}（${p.protocol}）· ${r.status} · ${r.bytes || 0}B${flip}`);
    if (r.status !== "ok") console.log(`      ${String(r.detail || "").slice(0, 220)}`);
  } catch (e) {
    results.push({ ...p, status: "probe_error", detail: String(e && e.message ? e.message : e), bytes: 0 });
    console.log(`💥 ${tag} ${p.name}：${String(e && e.message ? e.message : e).slice(0, 200)}`);
  }
  writeFileSync(OUT, JSON.stringify({ base: BASE, keyword, at: new Date().toISOString(), results }, null, 2), "utf8");
}

const okList = results.filter((r) => r.status === "ok");
// 口径和 store.js 的 writeCheckResult 保持一致：**只有"检不出结果"才不停用**。
// 这里不再枚举坏状态（上一版漏了 resolve_fail，28/30 的差值就是这么来的），
// 改成"不是 ok、也不是盲区，就是判死"，将来新增判死状态也不会漏报。
const INCONCLUSIVE = ["no_sample", "runner_missing", "unsupported"];
const dead = results.filter((r) => r.status !== "ok" && INCONCLUSIVE.indexOf(r.status) < 0);
const blind = results.filter((r) => INCONCLUSIVE.indexOf(r.status) >= 0);

console.log(`\n── 名单（已写回 ${OUT}）──────────────────────────`);
console.log(`✅ 真能出声：${okList.length} 条`);
const revived = results.filter((r) => r.wasDisabled && r.enabled === true);
if (revived.length) console.log(`   其中 ${revived.length} 条是从"已停用"里被新判据救回来的（旧结论属误杀）：${revived.map((r) => r.name).join("、")}`);
for (const r of okList) console.log(`   · ${r.name}（${r.platform}/${r.protocol}）· ${r.bytes}B`);
console.log(`❌ 判为不可用（已停用 + 建议删除）：${dead.length} 条`);
for (const r of dead) console.log(`   · ${r.name} · ${r.status} · ${String(r.detail || "").slice(0, 120)}`);
console.log(`⚠️ 检不出结果（观测盲区，不停用）：${blind.length} 条`);
for (const r of blind) console.log(`   · ${r.name} · ${r.status} · ${String(r.detail || "").slice(0, 120)}`);
