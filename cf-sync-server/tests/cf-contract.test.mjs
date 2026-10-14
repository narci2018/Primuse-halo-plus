// CF 服务端契约测试（本地 workerd 起真服务，打真 HTTP，断言真响应）。
//
//   npm test            # 起 wrangler pages dev + 全量断言（含联网项）
//   node tests/cf-contract.test.mjs --no-net   # 只跑不依赖第三方站点的断言
//
// 三条硬规矩（都是被真实事故教出来的）：
//  1. 只连本地 workerd 的 D1（--persist-to .cf-local），绝不碰线上 halo-music-db；
//  2. 断言看"渲染出来的结果"——状态码、body 字段、启停位、字节数，不看代码写了什么；
//  3. 联网项如果因第三方线路挂了而失败，明确标成 UNVERIFIED/FAILED，不许静默变绿。

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startLxRunner } from "./lx-runner.mjs";
import { probeAudio } from "../functions/lib/protocols.js";
import { normalizeLxSearch } from "../functions/lib/runner.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 端口每次都换一个新的：上一轮被强杀的 workerd 可能还占着旧端口，
// 表现为"服务已 Ready 但请求永远不到"，排查起来非常费劲。
const PORT = Number(process.env.CF_TEST_PORT || 8800 + (Date.now() % 180));
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = "local-dev-admin-token";
const CHECK = "local-dev-check-token";
const USE_NET = !process.argv.includes("--no-net");

const results = [];
let failed = 0;

function record(name, ok, note = "") {
  results.push({ name, ok, note });
  if (!ok) failed += 1;
  console.log(`${ok ? "OK  " : "FAIL"} | ${name}${note ? ` — ${note}` : ""}`);
}

function jhead() {
  return { "content-type": "application/json" };
}

async function req(p, { method = "GET", body, token, headers = {}, etag } = {}) {
  const h = { ...headers };
  if (body) h["content-type"] = "application/json";
  if (token) h.authorization = `Bearer ${token}`;
  if (etag) h["if-none-match"] = etag;
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: h,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  const text = await res.text();
  try {
    json = JSON.parse(text);
  } catch {
    /* 304 / HTML 都走这里 */
  }
  return { status: res.status, json, text, etag: res.headers.get("etag") };
}

const ADMIN_POST = (p, body, token = ADMIN) => req(`/api/${p}`, { method: "POST", body, token: token === null ? undefined : token });

function waitReady(ms = 120000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        // 单次探测必须带超时：请求打进去却无人应答（端口被僵尸 workerd 占着、
        // 或 D1 文件被锁）时，没有超时的 fetch 会把整个测试挂到总超时都看不出原因。
        const r = await fetch(`${BASE}/api/sync-playlists`, { signal: AbortSignal.timeout(2000) });
        if (r.status < 500) return resolve();
      } catch {
        /* 还没起来 */
      }
      if (Date.now() - start > ms) {
        return reject(new Error(`workerd 启动超时（${BASE} 无响应）\n${logsTail()}`));
      }
      setTimeout(tick, 500);
    };
    tick();
  });
}

let childLogs = [];
function logsTail() {
  return childLogs.join("").split("\n").slice(-20).join("\n");
}

/** 上一轮被强杀的 workerd 会锁住 .cf-local 并占着端口，先把整类残留清掉。 */
function killLeftovers() {
  if (process.platform !== "win32") return;
  spawnSync("taskkill", ["/F", "/IM", "workerd.exe"], { stdio: "ignore" });
}

function sha1(file) {
  return createHash("sha1").update(readFileSync(file)).digest("hex");
}

/**
 * workerd 是 npx → node → worker.exe 三层子进程，SIGTERM 在 Windows 上杀不干净，
 * 残留进程会锁住 .cf-local 让下一次运行连启动都失败。用 taskkill /T 连树端掉。
 */
function killChild(child) {
  if (!child || child.killed) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

function wipeLocalState() {
  try {
    rmSync(path.join(ROOT, ".cf-local"), { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  } catch (e) {
    console.log(`WARN | 清空 .cf-local 失败（${String(e && e.code ? e.code : e)}），本次结果可能与上次状态相关`);
  }
}

async function main() {
  // ── 1. 老端点文件必须一个字节没动（向下兼容的机械证明）────────────────
  const legacy = path.join(ROOT, "functions/api/sync-playlists.js");
  const legacyHash = sha1(legacy);
  record("老端点 sync-playlists.js 存在且可读", existsSync(legacy), legacyHash);

  // Windows 上 npx 是 .cmd，必须走 shell；PORT 是上面 Number() 过的，没有注入面。
  // 本地 D1 每次清空：断言里有"seed 恰好 9 条""删除内置线路"这类状态相关项，
  // 留状态会让第二次运行必然变红——那是测试的问题，不是被测代码的问题。
  killLeftovers();
  wipeLocalState();

  // 洛雪 js 音源的执行体：后台将来是用 Cloudflare API 把这份 bundle 部署成 Worker，
  // 本地契约测试里直接用同一份生成代码起一个真 workerd，对端不 mock。
  const RUNNER_TOKEN = "contract-runner-token";
  const runnerFiles = ["忆音音源_v1.js", "gdstudio音乐源 v1.0.1（仅支持网易）.js"];
  let runner = null;
  try {
    runner = await startLxRunner({ files: runnerFiles, port: PORT + 1, token: RUNNER_TOKEN });
    console.log(`runner 就绪 ${runner.base}（模块 ${runner.health?.modules}，hash ${runner.hashes.map((h) => h.slice(0, 8)).join(",")}）`);
  } catch (e) {
    console.log(`WARN | runner 没起来，lxjs 用例会变红：${String(e && e.message ? e.message : e).slice(0, 200)}`);
  }
  const runnerVars = runner
    // pages dev 没有 --var（那是 wrangler dev 的写法），这里必须用 -b KEY=VALUE；
    // 上一版传 --var 被 yargs 静默吃掉，env.LX_RUNNER_URL 是空的，lxjs 全线报"目标未配置"。
    ? `-b LX_RUNNER_URL=${runner.base} -b LX_RUNNER_TOKEN=${RUNNER_TOKEN} `
    : "";
  const child = spawn(
    // wrangler.toml 里只留 D1 绑定，令牌走同目录 .env：
    // Pages 生产环境的令牌是后台 Secret，部署时再带一份同名 [vars] 会被判成
    // "Binding name 'SOURCES_ADMIN_TOKEN' already in use"，整次发布失败。
    `npx --yes wrangler pages dev public --port ${PORT} --ip 127.0.0.1 --persist-to .cf-local ${runnerVars}`,
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], shell: true, env: { ...process.env, WRANGLER_LOG: "warn" } }
  );
  const logs = [];
  child.stdout.on("data", (d) => {
    logs.push(String(d));
    childLogs.push(String(d));
  });
  child.stderr.on("data", (d) => {
    logs.push(String(d));
    childLogs.push(String(d));
  });

  try {
    await waitReady();
    console.log(`workerd 就绪 ${BASE}\n`);

    // ── 2. 老契约回归：设备概览 / 备份往返 / 删除 ────────────────────────
    const overview = await req("/api/sync-playlists");
    record("老端点 GET 概览仍返回 code 0 + devices", overview.status === 200 && overview.json && overview.json.code === 0 && Array.isArray(overview.json.data.devices), JSON.stringify(overview.json && overview.json.code));

    const devId = "CF-TEST-DEVICE-0001";
    const playlists = [{ id: "p1", name: "我喜欢", songs: [{ id: "s1", title: "晴天", artist: "周杰伦" }] }, { id: "p2", name: "测试单", songs: [] }];
    const backup = await req("/api/sync-playlists", { method: "POST", body: { deviceId: devId, deviceName: "契约测试机", platform: "Windows", playlists } });
    record("老端点 POST 备份成功（playlistCount/songCount 正确）", backup.json?.code === 0 && backup.json.data.playlistCount === 2 && backup.json.data.songCount === 1, JSON.stringify(backup.json?.data || backup.json?.error));

    const pulled = await req(`/api/sync-playlists?deviceId=${devId}`);
    const roundTrip = JSON.stringify(pulled.json?.data?.playlists) === JSON.stringify(playlists);
    record("老端点 GET 取回的歌单与写入逐字节一致", pulled.json?.code === 0 && roundTrip, JSON.stringify(pulled.json?.data?.playlists || pulled.json?.error).slice(0, 120));

    const detail = await req(`/api/sync-playlists?deviceId=${devId}&playlistId=p1`);
    record("老端点 playlistId 详情仍可用", detail.json?.code === 0 && detail.json.data.playlist.name === "我喜欢", JSON.stringify(detail.json?.data?.playlist?.name));

    const missing = await req("/api/sync-playlists?deviceId=不存在的设备");
    record("老端点未知设备仍是 404 + code 404", missing.status === 404 && missing.json?.code === 404, String(missing.status));

    const deleted = await req(`/api/sync-playlists?deviceId=${devId}`, { method: "DELETE" });
    record("老端点 DELETE 设备仍可用", deleted.json?.code === 0, JSON.stringify(deleted.json?.data));

    // ── 3. manifest 契约（新）────────────────────────────────────────────
    const man = await req("/api/music-sources");
    const d = man.json?.data;
    record("manifest GET code 0 + contract v1", man.json?.code === 0 && d?.contract === "primuse.music-sources.v1", JSON.stringify({ code: man.json?.code, contract: d?.contract, err: man.json?.error }));
    record("manifest 首次访问自动 seed 了 9 条内置线路", Array.isArray(d?.sources) && d.sources.length === 9, `实际 ${d?.sources?.length} 条`);

    const clientDefaults = readFileSync(path.join(ROOT, "../primuse-win/src/main/aggregated.js"), "utf8");
    const idsInManifest = (d?.sources || []).map((s) => s.id).sort();
    const expectedIds = [...clientDefaults.matchAll(/id:\s*'(default-[^']+)'/g)].map((m) => m[1]).sort();
    record("manifest 的 id/priority 与客户端 DEFAULT_SOURCES 完全一致", JSON.stringify(idsInManifest) === JSON.stringify(expectedIds), `manifest ${idsInManifest.length} · 客户端 ${expectedIds.length} · ${idsInManifest.join(",")}`);
    const prio = (d?.sources || []).slice().sort((a, b) => b.priority - a.priority).map((s) => s.priority);
    record("优先级序列保持 20/18/16/15/14/12/10/8/6", JSON.stringify(prio) === JSON.stringify([20, 18, 16, 15, 14, 12, 10, 8, 6]), prio.join("/"));
    record("manifest 暴露网关地址与协议枚举", d?.gateway?.base === "/api/music-gateway" && Array.isArray(d.protocols) && d.protocols.includes("lxjs"), JSON.stringify(d?.gateway));
    record("首页文案默认值 = 首页（未设置时不空）", d?.settings?.homeTitle === "首页" && d?.settings?.homeTitleFrom === "default", JSON.stringify(d?.settings));

    const etag = man.etag;
    const revalidated = await req("/api/music-sources", { etag });
    record("ETag 命中返回 304（实时更新靠它）", revalidated.status === 304, `etag=${etag} → ${revalidated.status}`);

    // ── 4. 写接口门禁 ────────────────────────────────────────────────────
    const noToken = await ADMIN_POST("music-sources", { action: "upsert", name: "X", platform: "netease", protocol: "meting", baseURL: "https://example.com/api.php" }, null);
    record("无令牌的写请求被拒（401）", noToken.status === 401 && noToken.json?.code === 401, JSON.stringify(noToken.json?.error));
    const badToken = await ADMIN_POST("music-sources", { action: "delete", id: "default-qq-hyw" }, "wrong-token");
    record("错令牌的写请求被拒（401）", badToken.status === 401, String(badToken.status));
    const delDefault = await ADMIN_POST("music-sources", { action: "delete", id: "default-qq-hyw" });
    record("带正确令牌可以删除内置线路（管理权在服务端）", delDefault.json?.code === 0, JSON.stringify(delDefault.json?.data || delDefault.json?.error));
    const revAfterWrite = await req("/api/music-sources");
    record("每次写操作都推高 revision（客户端靠它实时更新）", (revAfterWrite.json?.data?.revision || 0) > (d?.revision || 0), `revision ${d?.revision} → ${revAfterWrite.json?.data?.revision}`);
    record("写操作后 ETag 变化，旧 ETag 不再命中", revAfterWrite.etag !== etag && (await req("/api/music-sources", { etag })).status === 200, `${etag} → ${revAfterWrite.etag}`);

    // ── 5. 设备偏好（需求 5：首页文案按 deviceId 关联）────────────────────
    await ADMIN_POST("music-sources", { action: "global-settings", homeTitle: "免费音乐" });
    const globalView = await req("/api/music-sources");
    record("全局默认首页文案生效（未覆盖的设备）", globalView.json?.data?.settings?.homeTitle === "免费音乐" && globalView.json?.data?.settings?.homeTitleFrom === "global", JSON.stringify(globalView.json?.data?.settings));

    await ADMIN_POST("music-sources", { action: "prefs", deviceId: "E1DF9B73-IPHONE-OLIVE", homeTitle: "我的音乐" });
    const deviceView = await req("/api/music-sources?deviceId=E1DF9B73-IPHONE-OLIVE");
    const otherView = await req("/api/music-sources?deviceId=别的设备");
    record("按 deviceId 关联的文案只影响该设备", deviceView.json?.data?.settings?.homeTitle === "我的音乐" && deviceView.json?.data?.settings?.homeTitleFrom === "device", JSON.stringify(deviceView.json?.data?.settings));
    record("其它设备仍拿全局默认", otherView.json?.data?.settings?.homeTitle === "免费音乐", JSON.stringify(otherView.json?.data?.settings?.homeTitle));

    // ── 6. 导入 js 音源（需求 3）+ 洛雪运行时（需求 1/4 的执行侧）─────────
    const samplePath = path.join(ROOT, "../音源文件/忆音音源_v1.js");
    const sample = readFileSync(samplePath, "utf8");
    const imported = await ADMIN_POST("music-sources", { action: "import-js", script: sample, filename: "忆音音源_v1.js", priority: 30 });
    const impData = imported.json?.data;
    record("导入洛雪 js 音源成功并按声明平台拆条", imported.json?.code === 0 && Array.isArray(impData?.sources) && impData.sources.length >= 2, JSON.stringify({ platforms: impData?.platforms, n: impData?.sources?.length, err: imported.json?.error }));
    record("导入后清单里能看到 lxjs 源并带脚本指纹", (impData?.sources || []).every((s) => s.protocol === "lxjs" && s.hasScript && s.scriptHash), JSON.stringify((impData?.sources || []).map((s) => [s.id, s.platform, s.hasScript])));
    record("脚本名从 @name 注释里解析出来", impData?.meta?.name === "忆音音源", JSON.stringify(impData?.meta));

    const rejected = await ADMIN_POST("music-sources", { action: "import-js", script: "console.log('我不是音源')" });
    record("不像音源的 js 被拒（不污染清单）", rejected.status === 400 && /洛雪/.test(String(rejected.json?.error)), JSON.stringify(rejected.json?.error));

    // gzip 往返：存进去的正文必须能原样解出来
    const scriptBack = await req(`/api/music-sources?script=${impData.sources[0].id}`, { token: ADMIN });
    const sameText = scriptBack.json?.data?.script?.text === sample;
    record("脚本 gzip+base64 存 D1 后原样取回（1KB 用例）", sameText, `长度 ${scriptBack.json?.data?.script?.text?.length} vs ${sample.length}`);

    const bigPath = path.join(ROOT, "../音源文件/长青SVIP音源v1.2.0（全平台支持无损）.js");
    if (existsSync(bigPath)) {
      const big = readFileSync(bigPath, "utf8");
      const bigIn = await ADMIN_POST("music-sources", { action: "import-js", script: big, filename: "长青SVIP", priority: 2 });
      const back = await req(`/api/music-sources?script=${bigIn.json?.data?.sources?.[0]?.id}`, { token: ADMIN });
      record("24KB 级真实音源 gzip 往返一致", bigIn.json?.code === 0 && back.json?.data?.script?.text === big, `原文 ${big.length}B · 存回 ${(back.json?.data?.script?.text || "").length}B · gzip ${(bigIn.json?.data?.sources?.[0]?.note || "")}`);
    }

    // ── 7. 检测全部可用（需求 2）：不可用 → 停用 + 建议删除 ────────────────
    if (USE_NET) {
      // 3e0 那条实测恒回 {"error":"unknown type"}：搜索阶段就该判不可用。
      const dead = await ADMIN_POST("music-sources", { action: "check-one", id: "default-netease-meting-3e0" }, CHECK);
      const deadSrc = dead.json?.data?.source;
      record("已知死线路体检判非 ok（不再是延迟绿灯）", dead.json?.code === 0 && deadSrc && deadSrc.check.status !== "ok", JSON.stringify({ status: deadSrc?.check?.status, detail: deadSrc?.check?.detail }));
      record("不可用的源被自动停用", deadSrc && deadSrc.enabled === false, `enabled=${deadSrc?.enabled}`);
      record("不可用的源带上删除建议", deadSrc && deadSrc.suggestDelete === true, `suggestDelete=${deadSrc?.suggestDelete}`);

      const alive = await ADMIN_POST("music-sources", { action: "check-one", id: "default-netease-gdstudio" }, CHECK);
      const aliveSrc = alive.json?.data?.source;
      record("GDStudio 网易云体检 = 真取到音频（>8KB audio）", alive.json?.code === 0 && aliveSrc?.check.status === "ok" && aliveSrc.check.bytes > 8192, JSON.stringify({ status: aliveSrc?.check?.status, bytes: aliveSrc?.check?.bytes, detail: aliveSrc?.check?.detail }));

      const lxId = impData.sources.find((s) => s.platform === "netease")?.id;
      const lxCheck = await ADMIN_POST("music-sources", { action: "check-one", id: lxId }, CHECK);
      const lxSrc = lxCheck.json?.data?.source;
      record(
        "lxjs 音源的体检是「真出声」判据（经 runner Worker）",
        lxCheck.json?.code === 0 && lxSrc?.check.status === "ok" && lxSrc.check.bytes > 8192,
        JSON.stringify({ status: lxSrc?.check?.status, bytes: lxSrc?.check?.bytes, detail: String(lxSrc?.check?.detail || "").slice(0, 200) })
      );
      record("能出声的 lxjs 音源保持启用、不被建议删除", lxSrc && lxSrc.enabled === true && lxSrc.suggestDelete === false, `enabled=${lxSrc?.enabled} suggestDelete=${lxSrc?.suggestDelete}`);

      // ── 7b. runner 的运维面：状态可查、缺凭据时不乱部署 ──────────────────
      const rstat = await ADMIN_POST("music-sources", { action: "runner-status", }, ADMIN);
      const rd = rstat.json?.data;
      record("runner-status 打得通对端并报告模块数", rstat.json?.code === 0 && rd?.reachable === true && rd.modules >= 2, JSON.stringify({ reachable: rd?.reachable, modules: rd?.modules, err: rd?.error }));
      record(
        "runner-status 里「想部署的集合」= 启用的 lxjs 源（不是 runner 里现成的）",
        Array.isArray(rd?.desiredHashes) && rd.desiredHashes.includes(impData.hash) && rd.desiredHashes.length === 2,
        JSON.stringify({ desired: rd?.desiredHashes?.map((h) => h.slice(0, 8)), live: rd?.liveHashes?.map((h) => h.slice(0, 8)) })
      );
      record("脚本集合和 runner 现装不一致时如实报 stale", rd?.stale === true, `stale=${rd?.stale}（本地没有 CF 凭据，装不了长青那条）`);
      record("没配 CF 凭据时 canDeploy=false（不把缺凭据伪装成已部署）", rd?.canDeploy === false, `canDeploy=${rd?.canDeploy}`);

      // stale 的比较基准必须是 runner 自己上报的哈希，而不是 D1 里那份"上次部署动作写回的记录"：
      // 本机 wrangler 那条路径（scripts/deploy-runner.mjs）用不到 Workers API，记录只能事后补，
      // 只看记录会永远回答"需要重部署"，把已经对齐的边缘说成没对齐。
      record(
        "runner-status 按 runner 实装判定 stale，记录差异单独标 recordNeedsSync",
        rd?.staleBasedOn === "runner" && rd?.recordNeedsSync === true && (rd?.deployedHashes || []).length === 0,
        JSON.stringify({ basedOn: rd?.staleBasedOn, stale: rd?.stale, needsSync: rd?.recordNeedsSync, recorded: (rd?.deployedHashes || []).length })
      );

      const tr = await ADMIN_POST("music-sources", { action: "trust-runner" }, ADMIN);
      const trd = tr.json?.data;
      record(
        "trust-runner：把 runner 上报的哈希写回 D1 的部署记录",
        tr.json?.code === 0 && Array.isArray(trd?.hashes) && trd.hashes.length >= 1,
        JSON.stringify({ code: tr.json?.code, message: tr.json?.message, n: (trd?.hashes || []).length })
      );

      const rstat2 = await ADMIN_POST("music-sources", { action: "runner-status" }, ADMIN);
      const rd2 = rstat2.json?.data;
      record(
        "对齐之后：recordNeedsSync 归 false，且 stale 仍按 runner 实装如实回答",
        rd2?.recordNeedsSync === false && rd2?.stale === true && (rd2?.deployedHashes || []).length === (rd2?.liveHashes || []).length,
        JSON.stringify({ needsSync: rd2?.recordNeedsSync, stale: rd2?.stale, recorded: (rd2?.deployedHashes || []).length, live: (rd2?.liveHashes || []).length })
      );

      const rdep = await ADMIN_POST("music-sources", { action: "deploy-runner" }, ADMIN);
      record(
        "缺凭据时 deploy-runner 明确跳过，不发任何对外请求",
        rdep.json?.code === 0 && rdep.json?.data?.deployed === false && rdep.json?.data?.skipped === "no_credentials",
        JSON.stringify(rdep.json?.data || rdep.json?.error)
      );
      record(
        "清单里被导入的脚本 sha256 与 runner 实际加载的对得上（同一段字节）",
        (rd?.liveHashes || []).includes(impData.hash),
        JSON.stringify({ imported: impData.hash.slice(0, 12), live: (rd?.liveHashes || []).map((h) => h.slice(0, 12)) })
      );

      // ── 8. 网关：搜索 / 取直链（含 lxjs 边缘执行）────────────────────────
      const caps = await req("/api/music-gateway?action=capabilities&deviceId=CF-TEST");
      record("网关 capabilities 在线并统计协议", caps.json?.code === 0 && caps.json.data?.contract === "primuse.music-gateway.v1" && !!caps.json.data?.byProtocol, JSON.stringify(caps.json?.data?.byProtocol || caps.json?.error));

      const gwSearch = await req("/api/music-gateway?action=search&keyword=晴天&platform=netease&deviceId=CF-TEST");
      const first = gwSearch.json?.data?.results?.[0];
      record("网关搜索有结果并返回标准曲型", gwSearch.json?.code === 0 && gwSearch.json.data.count > 0 && first?.rawID && first.id.startsWith("agg_netease_"), JSON.stringify({ count: gwSearch.json?.data?.count, sample: first && `${first.title}/${first.artist}`, notes: (gwSearch.json?.data?.notes || []).length }));

      const gwUrl = await req(`/api/music-gateway?action=url&platform=netease&rawID=${first ? first.rawID : ""}&deviceId=CF-TEST`);
      record("网关解析出可播直链", gwUrl.json?.code === 0 && /^https?:\/\//.test(String(gwUrl.json.data.url)), JSON.stringify({ source: gwUrl.json?.data?.sourceName, url: String(gwUrl.json?.data?.url || gwUrl.json?.error).slice(0, 70) }));

      const gwLx = await req(`/api/music-gateway?action=url&platform=netease&rawID=${first ? first.rawID : ""}&sourceId=${impData.sources.find((s) => s.platform === "netease")?.id}&deviceId=CF-TEST`);
      const lxUrl = String(gwLx.json?.data?.url || "");
      const lxProbe = gwLx.json?.code === 0 && /^https?:\/\//.test(lxUrl) ? await probeAudio(lxUrl) : null;
      record("lxjs 音源经 runner Worker 返回直链（边缘执行成立）", gwLx.json?.code === 0 && /^https?:\/\//.test(lxUrl), JSON.stringify({ source: gwLx.json?.data?.sourceName, url: lxUrl.slice(0, 70), err: gwLx.json?.error }));
      if (lxProbe) {
        record(
          "该直链在字节层真是音频（不是「声称 audio/mpeg」就算）",
          lxProbe.playable === true && lxProbe.magic === true && lxProbe.looksText === false && lxProbe.bytes > 8192,
          JSON.stringify({ status: lxProbe.status, bytes: lxProbe.bytes, ct: lxProbe.contentType, magic: lxProbe.magic, head: lxProbe.head, host: lxProbe.finalHost })
        );
      }

      const blocked = await req(`/api/music-gateway?action=url&platform=netease&rawID=x&sourceId=default-netease-meting-3e0&deviceId=CF-TEST`);
      record("已停用/体检不可用的源指名点姓时返回 409", blocked.status === 409 || blocked.json?.code === 409, JSON.stringify({ status: blocked.status, error: String(blocked.json?.error || "").slice(0, 80) }));

      // ── 9. 体检结论必须改变清单本身（客户端只看 usable / suggestions）────
      const finalMan = await req("/api/music-sources");
      const finSrcs = finalMan.json?.data?.sources || [];
      const deadRow = finSrcs.find((s) => s.id === "default-netease-meting-3e0");
      record("不可用源不出现在 usable 列表里", Array.isArray(finalMan.json?.data?.usable) && deadRow && !finalMan.json.data.usable.includes(deadRow.id), JSON.stringify({ usable: finalMan.json?.data?.usable, deadEnabled: deadRow?.enabled }));
      record("删除建议随清单下发（客户端能显示「建议删除该源」）", (finalMan.json?.data?.suggestions || []).some((s) => s.id === "default-netease-meting-3e0"), JSON.stringify((finalMan.json?.data?.suggestions || []).slice(0, 2)));

      // 客户端只看 usable：体检判可行的 lxjs 源必须下发到清单里。
      const lxUsableId = impData.sources.find((s) => s.platform === "netease")?.id;
      record("能出声的 lxjs 源进入清单 usable（客户端据此就能用它）", finalMan.json?.data?.usable?.includes(lxUsableId), JSON.stringify({ usable: finalMan.json?.data?.usable }));
      record("清单里 lxjs 源的 check 字段带 runner 取到的真实字节数", (finSrcs.find((s) => s.id === lxUsableId)?.check?.bytes || 0) > 8192, JSON.stringify(finSrcs.find((s) => s.id === lxUsableId)?.check));
    } else {
      console.log("SKIP | 联网断言（--no-net）");
    }

    // ── 7c. 搜索结果归一（纯函数，不联网）────────────────────────────────
    // 体检一条 lxjs 源需要真实歌曲 id，而"脚本自己会搜"是各家脚本的自选动作，
    // 返回形状五花八门（裸数组 / {list} / {data:{list}}）。这里把归一化钉住，
    // 免得现网又出现"源明明搜到了歌，我们却报检不出样本"。
    const shapes = [
      ["裸数组（非常刀的形状）", [{ name: "晴天", singer: "周杰伦", id: "MUSIC_228908", source: "kw" }], ["MUSIC_228908"]],
      ["{list:[…]}（官方洛雪形状）", { total: 30, list: [{ id: "3440441479", name: "晴天" }] }, ["3440441479"]],
      ["{data:{list:[…]}}/嵌套 musicInfo", { data: { list: [{ musicInfo: { id: "0012345678" } }] } }, ["0012345678"]],
      ["垃圾返回", "not json", []],
      ["过短的伪 id 不收", [{ id: "1" }], []],
    ];
    for (const [label, input, expect] of shapes) {
      const got = normalizeLxSearch(input).map((i) => i.rawID);
      record(`搜索结果归一：${label}`, JSON.stringify(got) === JSON.stringify(expect), `得到 ${JSON.stringify(got)}`);
    }

  } catch (e) {
    record("测试执行未抛异常", false, String(e && e.message ? e.message : e));
  } finally {
    killChild(child);
    // 先收 pages dev 再收 runner：runner 那棵进程树里也有 workerd，反过来会互相踩。
    if (runner) {
      try { runner.stop(); } catch { /* 收尾失败不影响结论 */ }
    }
  }

  console.log(`\n合计 ${results.length} 项，失败 ${failed} 项`);
  if (failed) {
    console.log("\n--- workerd 末尾日志 ---");
    console.log(logs.join("").split("\n").slice(-25).join("\n"));
  }
  process.exit(failed ? 1 : 0);
}

main();
