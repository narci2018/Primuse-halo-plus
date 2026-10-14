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
import { probeAudio, sniffAudio } from "../functions/lib/protocols.js";
import { normalizeLxSearch } from "../functions/lib/runner.js";
import { verdictEffect, ERROR_GRACE } from "../functions/lib/store.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 端口每次都换一个新的：上一轮被强杀的 workerd 可能还占着旧端口，
// 表现为"服务已 Ready 但请求永远不到"，排查起来非常费劲。
const PORT = Number(process.env.CF_TEST_PORT || 8800 + (Date.now() % 180));
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = "local-dev-admin-token";
const CHECK = "local-dev-check-token";
const USE_NET = !process.argv.includes("--no-net");

/**
 * 一个"声明了 search 能力"的假洛雪源（用例，不是真音源）。
 *
 * 为什么必须是假的：现网那 23 个脚本里会搜的都不稳定（今天能搜明天卡密），
 * 而"网关把会搜的洛雪源并进搜索结果"和"样本池靠源自己喂"这两件事需要一条确定性用例。
 *
 * 注意它返回的是**真实存在的网易云歌曲 id**（晴天的 3440441479）：搜索结果会被喂进样本池，
 * 返回一个编造的 id 就等于往池子里投毒 —— 后面别的源体检时会先拿到这个假 id，
 * 解析不到直链，被误判成坏源。用例可以假，进池子的数据不能假。
 */
const FAKE_SEARCH_SCRIPT = [
  "/*",
  " * @name 用例音源（会搜索）",
  " * @version 1.0.0",
  " * @author cf-contract",
  " * @description 测试用例：声明 search 能力并返回固定结果，不真的联网",
  " */",
  "globalThis.lx.send(globalThis.lx.EVENT_NAMES.inited, {",
  "  type: 'music',",
  "  sources: { wy: { name: '用例音源', type: 'music', actions: ['musicUrl', 'search'], qualitys: ['128k', '320k'] } },",
  "});",
  "globalThis.lx.on(globalThis.lx.EVENT_NAMES.request, function (req) {",
  "  if (req.action === 'search') {",
  "    var kw = (req.info && req.info.keyword) || req.keyword || '';",
  "    return [{ id: '3440441479', name: '晴天（用例）', singer: '周杰伦', album: { name: '叶惠美' }, interval: 269, source: 'wy' }];",
  "  }",
  "  if (req.action === 'musicUrl') return Promise.reject(new Error('用例：不解析直链'));",
  "  return null;",
  "});",
].join("\n");

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

/** 网关搜索里"被扫过却没出歌"的洛雪源留下的说明。空数组意味着静默丢弃 —— 那是代码坏了。 */
const lxNotesOf = (res) => (res.json?.data?.notes || []).filter((n) => String(n.id).startsWith("lxjs-"));

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
  const runnerFiles = [
    "忆音音源_v1.js",
    "gdstudio音乐源 v1.0.1（仅支持网易）.js",
    // 用例源也要真进 bundle：网关的洛雪搜索走的是"真问 runner 要 capabilities"，
    // 拿一个只存在于 D1、不在 bundle 里的源测不出这条链。
    { name: "〔用例〕会搜索的假源.js", scriptText: FAKE_SEARCH_SCRIPT },
  ];
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
    // 客户端只看这张表决定"这条协议的活儿在哪儿干"：lxjs 必须写清是服务端 runner 算的，
    // 否则将来某个客户端会去本地装一个 js 运行时，把"客户端只保存一个 URL"这条要求破掉。
    record("manifest 用 runtime 说清每类协议在哪儿算（lxjs=服务端）", d?.runtime?.lxjs === "server-runner" && d?.runtime?.meting === "client-or-gateway" && d?.runtime?.customJson === "none", JSON.stringify(d?.runtime));
    record("manifest 的网关条目带给人读的说明（客户端排错时直接显示）", typeof d?.gateway?.note === "string" && /runner/i.test(d.gateway.note), String(d?.gateway?.note || "").slice(0, 60));
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

    // 用例源（会搜索）：后面两条断言都靠它 —— 网关把洛雪搜索结果并进来看，
    // 以及"某条 HTTP 线路的搜索站挂了，但样本池里有别的源喂的真实 id"时体检该怎么判。
    const fakeIn = await ADMIN_POST("music-sources", { action: "import-js", script: FAKE_SEARCH_SCRIPT, filename: "〔用例〕会搜索的假源.js", priority: 25 });
    const fakeSrc = (fakeIn.json?.data?.sources || []).find((s) => s.platform === "netease");
    record("导入会搜索的用例音源（它同时是 runner bundle 里的一个模块）", fakeIn.json?.code === 0 && !!fakeSrc && fakeSrc.protocol === "lxjs" && fakeSrc.enabled === true, JSON.stringify({ n: (fakeIn.json?.data?.sources || []).length, id: fakeSrc?.id, err: fakeIn.json?.error }));

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
      // "判死 + 停用 + 建议删除"这条断言用一条**合成**的死线路来测：example.com 永远返回 HTML，
      // 搜索拿不到条目、解析拿不到直链。不用现网线路，因为第三方站点的状态隔天就变，
      // 拿它做断言第二天就变成随机红绿灯 —— 那是被测对象选错了，不是代码的问题。
      const mkDead = await ADMIN_POST("music-sources", {
        action: "upsert", id: "contract-dead-line", name: "〔用例〕永远播不出的线路",
        platform: "netease", protocol: "meting", baseURL: "https://example.com/api.php", priority: 1,
      });
      record("建好用例死线路（后台写接口）", mkDead.json?.code === 0, JSON.stringify(mkDead.json?.error || mkDead.json?.data?.source?.id));

      const dead = await ADMIN_POST("music-sources", { action: "check-one", id: "contract-dead-line" }, CHECK);
      const deadSrc = dead.json?.data?.source;
      record("已知死线路体检判非 ok（不再是延迟绿灯）", dead.json?.code === 0 && deadSrc && deadSrc.check.status !== "ok", JSON.stringify({ status: deadSrc?.check?.status, detail: deadSrc?.check?.detail }));
      record("不可用的源被自动停用", deadSrc && deadSrc.enabled === false, `enabled=${deadSrc?.enabled}`);
      record("不可用的源带上删除建议", deadSrc && deadSrc.suggestDelete === true, `suggestDelete=${deadSrc?.suggestDelete}`);
      // 判死的理由必须是"播放层面的失败"。第三方解析站的 /search 路径会单独挂（520、unknown type、要卡密），
      // 而 /url 那条可能还是好的 —— 只看搜索就把源判死，会杀掉还能用的解析线路。
      // 所以搜索没结果时要退回样本池里的真实歌曲 id 继续验播放（池子由会搜的源自己喂）。
      record(
        "死线路的理由是播不出，不是「搜索没结果/没有样本」",
        ["search_empty", "no_sample", "unchecked"].indexOf(deadSrc?.check?.status) < 0,
        JSON.stringify({ status: deadSrc?.check?.status, detail: String(deadSrc?.check?.detail || "").slice(0, 120) })
      );

      // 现网实测：3e0 那条的 /search 恒回 {"error":"unknown type"}，但 /url 是能出声的。
      // 旧实现给它判过 search_empty 并停用 —— 那正是这次要消灭的误杀。这里钉住"结论必须是播放层面的"，
      // 而不断言 ok/不 ok：它到底能不能播由它的站点今天的心情决定，不由我们的判据决定。
      const searchBroken = await ADMIN_POST("music-sources", { action: "check-one", id: "default-netease-meting-3e0" }, CHECK);
      const brokenSrc = searchBroken.json?.data?.source;
      record(
        "搜索接口坏的线路也会被喂真实歌曲 id 验播放（结论落在播放层）",
        ["ok", "resolve_fail", "audio_fail", "script_error", "error", "timeout"].indexOf(brokenSrc?.check?.status) >= 0,
        JSON.stringify({ status: brokenSrc?.check?.status, detail: String(brokenSrc?.check?.detail || "").slice(0, 140) })
      );

      const alive = await ADMIN_POST("music-sources", { action: "check-one", id: "default-netease-gdstudio" }, CHECK);
      const aliveSrc = alive.json?.data?.source;
      record("GDStudio 网易云体检 = 真取到音频（>8KB audio）", alive.json?.code === 0 && aliveSrc?.check.status === "ok" && aliveSrc.check.bytes > 8192, JSON.stringify({ status: aliveSrc?.check?.status, bytes: aliveSrc?.check?.bytes, detail: aliveSrc?.check?.detail }));

      // 误杀必须能翻案：体检把"停用"写进 D1 之后，那条源就不在 check-plan 里了，
      // 判据修好、或者站点自己缓过来，都不会自动把它捞回来 —— 除非"检到 ok"本身就把启停位写回 1。
      // 上一版 writeCheckResult 保留旧 enabled（pass 也只当"维持现状"），现网那批被搜索接口害死的线路
      // 就永远躺在建议删除里。这条用例先让它被误停，再把地址换成能播的那条，验它能自己活过来。
      const reviveId = "contract-misjudged-line";
      const gbaseUrl = ((await req("/api/music-sources")).json?.data?.sources || []).find((s) => s.id === "default-netease-gdstudio")?.baseURL;
      await ADMIN_POST("music-sources", {
        action: "upsert", id: reviveId, name: "〔用例〕先被误停、之后能救回的线路",
        platform: "netease", protocol: "meting", baseURL: "https://example.com/api.php", priority: 1,
      });
      const firstVerdict = await ADMIN_POST("music-sources", { action: "check-one", id: reviveId }, CHECK);
      record("用例线路先被体检停用（后面才谈翻案）", firstVerdict.json?.data?.source?.enabled === false && firstVerdict.json?.data?.source?.enabledLocked !== true, `enabled=${firstVerdict.json?.data?.source?.enabled} locked=${firstVerdict.json?.data?.source?.enabledLocked}`);
      // 只改地址、不碰 enabled：碰了 enabled 就是"用户手动指定"（锁定），体检不再有权改它。
      await ADMIN_POST("music-sources", { action: "upsert", id: reviveId, name: "〔用例〕先被误停、之后能救回的线路", platform: "netease", protocol: "meting", baseURL: gbaseUrl, priority: 1 });
      const second = await ADMIN_POST("music-sources", { action: "check-one", id: reviveId }, CHECK);
      const revived = second.json?.data?.source;
      record("检到能出声就把之前误停的源救回来（enabled 0→1）", second.json?.code === 0 && revived?.enabled === true, JSON.stringify({ status: revived?.check?.status, enabled: revived?.enabled }));
      record("翻案后删除建议一并撤掉", revived?.suggestDelete === false && !(revived?.check?.status !== "ok"), JSON.stringify({ suggestDelete: revived?.suggestDelete }));
      record("翻案的源重新出现在 usable 里（客户端马上能用它）", (await req("/api/music-sources")).json?.data?.usable?.includes(reviveId), JSON.stringify(((await req("/api/music-sources")).json?.data?.usable || []).slice(0, 5)));
      await ADMIN_POST("music-sources", { action: "delete", id: reviveId });

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
      // "该部署的集合" = 清单里**所有** lxjs 源的脚本，停用的也算。
      // 这里刻意从清单现算而不是写死数字：用例里导入的源会变（本轮就多了一条会搜的假源），
      // 写死长度的断言只会逼人去改断言，而不是暴露真正的偏差。
      const nowMan = await req("/api/music-sources");
      const allLx = Array.from(new Set((nowMan.json?.data?.sources || []).filter((s) => s.protocol === "lxjs").map((s) => s.scriptHash))).sort();
      record(
        "runner-status 里「想部署的集合」= 清单里全部 lxjs 源（不是 runner 里现成的）",
        Array.isArray(rd?.desiredHashes) && JSON.stringify(rd.desiredHashes.slice().sort()) === JSON.stringify(allLx) && allLx.includes(impData.hash) && allLx.includes(fakeSrc?.scriptHash),
        JSON.stringify({ desired: rd?.desiredHashes?.map((h) => String(h).slice(0, 8)), want: allLx.map((h) => String(h).slice(0, 8)), live: rd?.liveHashes?.map((h) => String(h).slice(0, 8)) })
      );
      // 停用的洛雪源**不许**掉出 bundle：掉出去之后它的重检永远回 runner_missing，
      // 而 runner_missing 是观测盲区（维持现状），于是"停用"这个状态自己把自己焊死了 ——
      // 当初若是误杀，就再也没有翻案的通道。HTTP 线路没这问题（不依赖部署产物）。
      const offToggle = await ADMIN_POST("music-sources", { action: "toggle", id: fakeSrc.id, enabled: false }, ADMIN);
      const rdOff = (await ADMIN_POST("music-sources", { action: "runner-status" }, ADMIN)).json?.data;
      record(
        "把一条 lxjs 源停用后，它的脚本仍在「想部署的集合」里（保留翻案通道）",
        offToggle.json?.data?.source?.enabled === false && (rdOff?.desiredHashes || []).includes(fakeSrc.scriptHash),
        JSON.stringify({ enabled: offToggle.json?.data?.source?.enabled, wanted: (rdOff?.desiredHashes || []).map((h) => String(h).slice(0, 8)) })
      );
      await ADMIN_POST("music-sources", { action: "toggle", id: fakeSrc.id, enabled: true }, ADMIN);
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
      // 每条结果自带 protocol + sourceId：客户端拿到结果就能决定"本地直连播"还是"交给网关播"，
      // 不用回头在清单里找那一条（清单可能已经被后台改掉了，那种情况下结果就是孤儿）。
      const gwAll = gwSearch.json?.data?.results || [];
      record(
        "搜索结果每条都带 protocol/sourceId/rawID（自描述，客户端不必回查清单）",
        gwAll.length > 0 && gwAll.every((r) => r.protocol && r.sourceId && r.rawID),
        JSON.stringify(gwAll.slice(0, 3).map((r) => [r.protocol, r.sourceId]))
      );
      record(
        "网关搜索对每条被扫的洛雪源都给了交代（没歌就写明原因，不静默丢弃）",
        lxNotesOf(gwSearch).length > 0 && lxNotesOf(gwSearch).every((n) => n.note && n.name),
        JSON.stringify(lxNotesOf(gwSearch).map((n) => `${n.name}:${n.note}`).slice(0, 4))
      );

      const gwUrl = await req(`/api/music-gateway?action=url&platform=netease&rawID=${first ? first.rawID : ""}&deviceId=CF-TEST`);
      record("网关解析出可播直链", gwUrl.json?.code === 0 && /^https?:\/\//.test(String(gwUrl.json.data.url)), JSON.stringify({ source: gwUrl.json?.data?.sourceName, url: String(gwUrl.json?.data?.url || gwUrl.json?.error).slice(0, 70) }));

      // 洛雪源能不能参与搜索，取决于它自己有没有实现 search（官方协议只保证 musicUrl）。
      // 用一个只有用例源答得出的关键词来测：HTTP 线路必然搜不到，结果里若出现 lxjs，
      // 就证明"问 capabilities → 只搜会搜的源 → 归一成标准曲型"这一整条链在真 runner 上成立。
      const gwLxSearch = await req(`/api/music-gateway?action=search&keyword=${encodeURIComponent("用例独有词zzz")}&platform=netease&deviceId=CF-TEST`);
      const lxHit = (gwLxSearch.json?.data?.results || []).find((r) => r.protocol === "lxjs");
      record(
        "网关搜索把会搜的洛雪源并进结果（客户端只用一个入口就能拿到它的歌）",
        gwLxSearch.json?.code === 0 && !!lxHit,
        JSON.stringify({ count: gwLxSearch.json?.data?.count, notes: (gwLxSearch.json?.data?.notes || []).length, err: gwLxSearch.json?.error })
      );
      record(
        "洛雪搜索结果归一成标准曲型（agg_ id / 标题 / 歌手 / 时长 / 来源都带上）",
        !!lxHit && lxHit.id === `agg_netease_${lxHit.rawID}` && !!lxHit.title && !!lxHit.artist && lxHit.sourceId === (fakeSrc && fakeSrc.id) && Number(lxHit.duration) > 0,
        JSON.stringify(lxHit && { id: lxHit.id, title: lxHit.title, artist: lxHit.artist, album: lxHit.album, duration: lxHit.duration, sourceId: String(lxHit.sourceId).slice(0, 20) })
      );

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

      const blocked = await req(`/api/music-gateway?action=url&platform=netease&rawID=x&sourceId=contract-dead-line&deviceId=CF-TEST`);
      record("已停用/体检不可用的源指名点姓时返回 409", blocked.status === 409 || blocked.json?.code === 409, JSON.stringify({ status: blocked.status, error: String(blocked.json?.error || "").slice(0, 80) }));

      // ── 9. 体检结论必须改变清单本身（客户端只看 usable / suggestions）────
      const finalMan = await req("/api/music-sources");
      const finSrcs = finalMan.json?.data?.sources || [];
      const deadRow = finSrcs.find((s) => s.id === "contract-dead-line");
      record("不可用源不出现在 usable 列表里", Array.isArray(finalMan.json?.data?.usable) && deadRow && !finalMan.json.data.usable.includes(deadRow.id), JSON.stringify({ usable: finalMan.json?.data?.usable, deadEnabled: deadRow?.enabled }));
      record("删除建议随清单下发（客户端能显示「建议删除该源」）", (finalMan.json?.data?.suggestions || []).some((s) => s.id === "contract-dead-line"), JSON.stringify((finalMan.json?.data?.suggestions || []).slice(0, 2)));
      // 用例源不该出现在客户端视野里（它没有真实歌曲，且 example.com 永远播不出）——
      // 判死之后它必须被停用，清单的 usable 也就不会带上它；这条断言防的是"死源漏进可用清单"。
      record("判死的用例线路被下发停用位（客户端不该拿它去解析）", deadRow && deadRow.enabled === false && deadRow.suggestDelete === true, JSON.stringify({ enabled: deadRow?.enabled, suggestDelete: deadRow?.suggestDelete }));

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
    // 只有 id 的结果在 UI 上是一行空白，所以专辑/封面/时长/歌手数组这些上屏字段也要归一。
    const rich = normalizeLxSearch([
      { id: "3440441479", name: "晴天", singer: [{ name: "周杰伦", hash: "x" }], album: { name: "叶惠美" }, picUrl: "https://p1.music.126.net/x/3440441479.jpg", interval: 269 },
    ])[0] || {};
    record(
      "搜索结果归一：歌手数组、专辑对象、封面 URL、时长都落到曲型上",
      rich.artist === "周杰伦" && rich.album === "叶惠美" && /^https:\/\//.test(String(rich.coverURL || "")) && Number(rich.duration) === 269,
      JSON.stringify({ artist: rich.artist, album: rich.album, duration: rich.duration, cover: String(rich.coverURL || "").slice(0, 24) })
    );

    // ── 7d. 体检启停判据（纯函数，不联网）────────────────────────────────
    // verdictEffect 是唯一决定"这条源在客户端是启用还是停用"的地方，而它的三个分支
    // 每一个都是现网真实误杀/漏杀换来的，必须钉死：
    //   检到能出声 → **置回启用**（上一版只写"不行就停用"，导致误杀过的坏源永远洗不掉）；
    //   观测盲区（no_sample/runner_missing/unsupported）与自己没测成（error 未达宽限）→ 维持现状；
    //   真不行 → 停用 + 建议删除；用户手动锁过启停的，一律不动 enabled。
    const row = (over = {}) => ({ enabled: 1, enabled_locked: 0, fail_streak: 0, ...over });
    const veCases = [
      [
        "检到能出声 → 启用位从 0 复活为 1，删除建议清零",
        verdictEffect({ status: "ok" }, row({ enabled: 0, fail_streak: 4 })),
        (v) => v.enabled === 1 && v.suggestDelete === 0 && v.streak === 0 && v.pass === true && v.blind === false,
      ],
      [
        "观测盲区（no_sample）→ 不动启用位，也不建议删除",
        verdictEffect({ status: "no_sample" }, row({ enabled: 0 })),
        (v) => v.enabled === 0 && v.suggestDelete === 0 && v.blind === true && v.streak === 0,
      ],
      [
        "runner 没部署（runner_missing）是服务端自己的问题，不能算源的头",
        verdictEffect({ status: "runner_missing" }, row()),
        (v) => v.enabled === 1 && v.suggestDelete === 0 && v.blind === true,
      ],
      [
        "customJson 两端都不做搜索（unsupported）→ 按定义无从判断，维持现状",
        verdictEffect({ status: "unsupported" }, row({ enabled: 0 })),
        (v) => v.enabled === 0 && v.suggestDelete === 0 && v.blind === true,
      ],
      [
        "我们自己没测成（error）第 1 次 → 宽限，绝不停用",
        verdictEffect({ status: "error" }, row()),
        (v) => v.enabled === 1 && v.suggestDelete === 0 && v.blind === true && v.flakyProbe === true && v.streak === 1,
      ],
      [
        "我们自己没测成（error）第 2 次 → 还在宽限内",
        verdictEffect({ status: "error" }, row({ fail_streak: 1 })),
        (v) => v.enabled === 1 && v.blind === true && v.streak === 2,
      ],
      [
        `我们自己没测成（error）连着第 3 次 → 不再是运气，停用并建议删除`,
        verdictEffect({ status: "error" }, row({ fail_streak: 2 })),
        (v) => v.enabled === 0 && v.suggestDelete === 1 && v.blind === false && v.flakyProbe === false && v.streak === 3,
      ],
      [
        "真不行（解析无直链）→ 第一次就停用 + 建议删除，不拖",
        verdictEffect({ status: "resolve_fail" }, row()),
        (v) => v.enabled === 0 && v.suggestDelete === 1 && v.blind === false && v.streak === 1,
      ],
      [
        "脚本连编译都过不去（script_uncompilable）→ 永远出不了声，判死",
        verdictEffect({ status: "script_uncompilable" }, row()),
        (v) => v.enabled === 0 && v.suggestDelete === 1 && v.blind === false,
      ],
      [
        "用户手动启用（locked）的坏源：体检不许把它关掉",
        verdictEffect({ status: "resolve_fail" }, row({ enabled: 1, enabled_locked: 1 })),
        (v) => v.enabled === 1 && v.locked === true,
      ],
      [
        "用户手动停用的好源：体检也不许把它打开（但删除建议照样清零）",
        verdictEffect({ status: "ok" }, row({ enabled: 0, enabled_locked: 1 })),
        (v) => v.enabled === 0 && v.suggestDelete === 0,
      ],
      [
        "未知状态一律按「不行」处理，不许因为判据没覆盖就静默放行",
        verdictEffect({ status: "something_new" }, row()),
        (v) => v.enabled === 0 && v.suggestDelete === 1 && v.blind === false,
      ],
    ];
    for (const [label, got, okFn] of veCases) {
      record(`启停判据：${label}`, okFn(got), JSON.stringify(got));
    }
    // 宽限次数本身就是判据的一部分，写死成 3：单次观测失败说明不了任何事。
    record("启停判据：error 宽限次数是 3（连续 3 次才动手）", Number(ERROR_GRACE) === 3, `实得 ${ERROR_GRACE}`);

    // ── 7e. 音频魔数判据（这一条决定"能不能出声"，两类误杀都出在它身上）────────
    // 旧实现有两处写死的字节错位：head 只截 3 个字节 → OggS/fLaC 的四字节魔数永远比不中；
    // mp4 只认 size 字段正好是 0x18/0x20 的那两种 → 其余 m4a 全被判成"不是音频"。
    // 更关键的是 playable 旧口径只看 content-type：真音频配了 text/plain 就被判死。
    // 客户端 src/main/cloud-sources.js 用同一套判据，两边各钉一遍（见 primuse-win 的契约测试）。
    const u8 = (arr) => Uint8Array.from(arr);
    const str = (s) => u8([...s].map((c) => c.charCodeAt(0)));
    const pad = (b, n = 40) => { const size = Math.max(n, b.length); const o = new Uint8Array(size); o.set(b); return o; };
    const sniffCases = [
      ["mp3（ID3v2 头）", pad(str("ID3\x03\x00\x00")), (s) => s.magic === true],
      ["mp3（裸帧同步 0xFFFx）", pad([0xff, 0xfb, 0x90, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0]), (s) => s.magic === true],
      ["ogg/opus（OggS）", pad(str("OggS\x00\x02\x00\x00")), (s) => s.magic === true],
      ["flac（fLaC）", pad(str("fLaC\x00\x00\x00\x22")), (s) => s.magic === true],
      ["wav（RIFF....WAVE）", pad(str("RIFF\x00\x00\x00\x00WAVEfmt ")), (s) => s.magic === true],
      ["m4a（ftyp，box size 不是 0x18/0x20）", pad(str("\x00\x00\x00\x1cftypM4A \x00\x00\x00\x00")), (s) => s.magic === true],
      ["mp4（ftyp isom）", pad(str("\x00\x00\x00 ftypisom\x00\x00\x02\x00")), (s) => s.magic === true],
      ["HTML 反爬页", pad(str("<html><body>checking your browser</body></html>")), (s) => s.magic === false && s.looksText === true],
      ["报错 JSON", pad(str('{"error":"sign failed"}   ' + "x".repeat(40))), (s) => s.magic === false && s.looksText === true],
      ["XML 网关拦截页", pad(str('<?xml version="1.0"?><Error><Code>NoSuchKey</Code></Error>')), (s) => s.magic === false && s.looksText === true],
    ];
    for (const [label, bytes, okFn] of sniffCases) {
      const s = sniffAudio(bytes);
      record(`魔数判据：${label}`, okFn(s), JSON.stringify(s));
    }
    record("魔数判据：字节不足 12 个时不误判（空响应/半截流）", sniffAudio(new Uint8Array(0)).magic === false && sniffAudio(u8([0x49, 0x44, 0x33])).magic === true, "ID3 只要前三字节就到齐");

    // 取字节的整条判据：本机起一个小服务器，四种组合都过一遍（不联网，--no-net 也照跑）。
    const MP3 = Buffer.concat([Buffer.from("ID3\x03\x00\x00\x00\x00\x00\x00"), Buffer.alloc(20000, 0x7f)]);
    const HTML = Buffer.concat([Buffer.from("<html><body>404 Not Found</body></html>"), Buffer.alloc(20000, 0x41)]);
    const httpMod = await import("node:http");
    // 计数是这条用例的"真跑到了"证据：workerd 要是连不上 127.0.0.1，下面那两条断言
    // 会因为"搜索请求就抛异常"而照样落 error —— 结论对，但那不是我们要测的那一跳。
    const stallHits = { search: 0, url: 0, stall: 0 };
    const sniffServer = httpMod.createServer((rq, rs) => {
      const u = new URL(rq.url, "http://127.0.0.1");
      const q = u.searchParams;
      // 合成线路的 meting 接口：搜索给两条真条目，解析把播放地址指向 /stall（永远不返回正文）。
      if (u.pathname === "/api.php") {
        if (q.get("types") === "search") {
          stallHits.search += 1;
          rs.writeHead(200, { "content-type": "application/json" });
          return rs.end(JSON.stringify([{ id: "1", name: "晴天", artist: "周杰伦", duration: 269 }, { id: "2", name: "搁浅", artist: "周杰伦", duration: 254 }]));
        }
        stallHits.url += 1;
        rs.writeHead(200, { "content-type": "application/json" });
        return rs.end(JSON.stringify({ url: `http://127.0.0.1:${sniffServer.address().port}/stall` }));
      }
      if (u.pathname === "/stall") {
        // 只回头部、永不结束：probeAudio 的 15 秒预算会把它掐掉，抛 AbortError。
        stallHits.stall += 1;
        rs.writeHead(200, { "content-type": "audio/mpeg" });
        return undefined;
      }
      const kind = q.get("kind") || "mp3-audio-ct";
      const body = kind === "html-lied-as-audio" || kind === "html" ? HTML : MP3;
      const ct =
        kind === "mp3-wrong-ct" ? "text/plain; charset=utf-8"
        : kind === "mp3-no-ct" ? ""
        : kind === "html-lied-as-audio" ? "audio/mpeg"
        : "audio/mpeg";
      rs.writeHead(200, ct ? { "content-type": ct, "content-length": String(body.length) } : { "content-length": String(body.length) });
      rs.end(body);
    });
    await new Promise((r) => sniffServer.listen(0, "127.0.0.1", r));
    const sniffBase = `http://127.0.0.1:${sniffServer.address().port}/t?kind=`;
    try {
      const honest = await probeAudio(`${sniffBase}mp3-audio-ct`);
      record("取字节判据：content-type 与字节都对 → 可播", honest.playable === true && honest.magic === true && honest.bytes > 8192, JSON.stringify({ status: honest.status, ct: honest.contentType, bytes: honest.bytes, magic: honest.magic }));
      const wrongCT = await probeAudio(`${sniffBase}mp3-wrong-ct`);
      record("取字节判据：真音频但服务器把 content-type 写错了 → 仍可播（旧口径在这误杀）", wrongCT.playable === true && wrongCT.magic === true && /text/i.test(wrongCT.contentType), JSON.stringify({ ct: wrongCT.contentType, magic: wrongCT.magic, playable: wrongCT.playable }));
      const noCT = await probeAudio(`${sniffBase}mp3-no-ct`);
      record("取字节判据：干脆没给 content-type，字节是音频 → 仍可播", noCT.playable === true && noCT.magic === true, JSON.stringify({ ct: noCT.contentType, magic: noCT.magic, playable: noCT.playable }));
      const liar = await probeAudio(`${sniffBase}html-lied-as-audio`);
      record("取字节判据：挂着 audio/mpeg 的 HTML 报错页 → 判不可播（旧延迟检测就是在这被骗绿的）", liar.playable === false && liar.looksText === true && liar.magic === false, JSON.stringify({ ct: liar.contentType, magic: liar.magic, looksText: liar.looksText, playable: liar.playable }));
      const ranged = await probeAudio(`${sniffBase}mp3-audio-ct`);
      record("取字节判据：只取前 64KB，不为了体检下载整首歌", ranged.bytes <= 65536, `${ranged.bytes}B`);

      // ── 7f. 「我们这边取字节超时」不许算成源坏了（checkSource 的异常通路，走真 workerd）
      // 现网真事故：2026-10-14 体检里「墨澜聚合音源 (网易云音乐)」三条样本全回
      // "The operation was aborted"（我们自己的 15 秒 fetch 预算），上一次体检它还是 ok，
      // 这一次就成了"建议删除"。根因是 checkLxSource 把 probeAudio 的异常一起 catch 进了
      // audio_fail —— HTTP 线路反而是对的（异常一路抛到 checkSource 的 catch，落成 error，有 3 次宽限）。
      // 现在两条协议同路：取字节这一跳抛异常 → error → 不停用、不建议删除。
      // 这里用本机 /stall（只回头部、永不结束）造出这个超时，不依赖任何第三方站点。
      const stallId = "contract-stall-line";
      const mkStall = await ADMIN_POST("music-sources", {
        action: "upsert", id: stallId, name: "〔用例〕取字节超时的线路",
        platform: "netease", protocol: "meting", baseURL: `http://127.0.0.1:${sniffServer.address().port}/api.php`, priority: 1,
      });
      record("建好「取字节超时」用例线路", mkStall.json?.code === 0, JSON.stringify(mkStall.json?.error || stallId));
      const stalled = await ADMIN_POST("music-sources", { action: "check-one", id: stallId }, CHECK);
      const stallSrc = stalled.json?.data?.source;
      record(
        "取字节超时落成 error（我们没测成），不是 audio_fail/resolve_fail",
        stallSrc && stallSrc.check.status === "error",
        JSON.stringify({ status: stallSrc?.check?.status, detail: String(stallSrc?.check?.detail || "").slice(0, 140) })
      );
      record(
        "这种结论不停用、不建议删除，只记一次失败（连续 3 次才动手）",
        stallSrc && stallSrc.enabled === true && stallSrc.suggestDelete === false && Number(stallSrc.check.failStreak) === 1,
        JSON.stringify({ enabled: stallSrc?.enabled, suggestDelete: stallSrc?.suggestDelete, failStreak: stallSrc?.check?.failStreak })
      );
      record(
        "这条用例真的走到了「取字节」那一跳（不是 workerd 连不上本机导致的假绿）",
        stallHits.search >= 1 && stallHits.url >= 1 && stallHits.stall >= 1,
        JSON.stringify(stallHits)
      );
      // 收尾用 delete（服务端只有 upsert/toggle/delete/check/check-one 这几个动作，
      // 写错动作名的话这条用例会留下一具尸体线路，污染下一次体检的名单）。
      const delStall = await ADMIN_POST("music-sources", { action: "delete", id: stallId }, ADMIN);
      record("用例线路收尾删除（动作名必须是 delete）", delStall.json?.code === 0, JSON.stringify(delStall.json?.error || delStall.json));
    } finally {
      sniffServer.close();
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
