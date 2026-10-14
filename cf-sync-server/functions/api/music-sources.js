// /api/music-sources —— 音乐源管理中心（读开放、写门禁）
//
// 客户端只需要保存这一个 URL（连同已有的歌单同步 URL），开机拉一次 manifest 就拿到：
//   可用源清单 + 每条的最新体检结论 + 服务端建议（是否该删） + 该设备的界面文案（首页 header）。
// 实时更新靠 revision + ETag/304：清单没变时是一个空 body 的 304，几乎零成本。
//
// 与 /api/sync-playlists 的关系：完全独立、纯新增。那个端点保持原样，老客户端不受任何影响。

import { ok, fail, corsHeaders, checkAdmin, deviceIdOf } from "../lib/common.js";
import {
  ensureSchema,
  seedDefaults,
  listSources,
  getSource,
  upsertSource,
  deleteSource,
  normalizeSource,
  writeCheckResult,
  bumpRevision,
  currentRevision,
  getDevicePref,
  setDevicePref,
  metaGet,
  metaSet,
  saveScript,
  loadScript,
  publicSource,
  PLATFORMS,
  PROTOCOLS,
} from "../lib/store.js";
import { checkSource } from "../lib/check.js";
import { gzipBase64, sha256Hex, lxMeta, gunzipText } from "../lib/lx.js";
import {
  RUNNER_CONTRACT,
  runnerName,
  syncRunner,
  runnerHealth,
  desiredScriptSet,
  deployedHashes,
  trustRunnerHashes,
} from "../lib/runner.js";

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function onRequestGet({ request, env }) {
  if (!env || !env.DB) return fail(500, "D1 数据库未绑定（env.DB 为空）", 500);
  try {
    await ensureSchema(env);
    await seedDefaults(env);
  } catch (e) {
    return fail(500, `存储初始化失败：${String(e && e.message ? e.message : e)}`, 500);
  }

  const url = new URL(request.url);
  const deviceId = deviceIdOf(request);
  const revision = await currentRevision(env);
  const etag = `W/"rev-${revision.revision}"`;
  const inm = request.headers.get("If-None-Match");
  if (inm && inm === etag && url.searchParams.get("force") !== "1") {
    return new Response(null, { status: 304, headers: { ...corsHeaders(), ETag: etag } });
  }

  const wantAll = url.searchParams.get("all") !== "0";
  const rows = await listSources(env, { includeDisabled: wantAll });
  const pub = rows.map(publicSource);
  const pref = deviceId ? await getDevicePref(env, deviceId) : null;
  const globalTitle = await metaGet(env, "home_title_default", "");

  let script = null;
  const scriptId = url.searchParams.get("script");
  if (scriptId) {
    // 仅给后台导出/排错用：把脚本正文还原成文本回给管理端（要令牌）。
    const gate = checkAdmin(request, env);
    if (!gate.ok) return gate.response;
    const row = await getSource(env, scriptId);
    if (row && row.script_hash) {
      const rec = await loadScript(env, row.script_hash);
      if (rec) script = { hash: rec.hash, rawBytes: Number(rec.raw_bytes), text: await gunzipText(rec.body) };
    }
  }

  return ok(
    {
      revision: revision.revision,
      revisionAt: revision.revisionAt,
      serverTime: Date.now(),
      contract: "primuse.music-sources.v1",
      settings: {
        homeTitle: (pref && pref.home_title) || globalTitle || "首页",
        homeTitleFrom: pref && pref.home_title ? "device" : globalTitle ? "global" : "default",
        deviceId: deviceId || "",
      },
      platforms: Object.keys(PLATFORMS).map((k) => ({ id: k, displayName: PLATFORMS[k].displayName, meting: PLATFORMS[k].meting, hyw: PLATFORMS[k].hyw, lx: PLATFORMS[k].lx })),
      protocols: PROTOCOLS.slice(),
      gateway: {
        base: "/api/music-gateway",
        actions: ["search", "url", "lyric", "capabilities"],
        note: "lxjs（洛雪 js 音源）由服务端的 runner Worker 执行，客户端必须走网关；其余协议客户端可以本地直连，也可统一走网关。",
      },
      // 每类协议"在哪儿算"：客户端据此决定要不要本地实现。lxjs 只有服务端能算，
      // customJson 两端都不做搜索（Swift :183-184），所以 none。
      runtime: {
        meting: "client-or-gateway",
        hyw: "client-or-gateway",
        nxinxz: "client-or-gateway",
        openApi: "client-or-gateway",
        customJson: "none",
        lxjs: "server-runner",
      },
      sources: pub,
      usable: pub.filter((s) => s.enabled && s.check.status === "ok").map((s) => s.id),
      suggestions: pub.filter((s) => s.suggestDelete).map((s) => ({ id: s.id, name: s.name, reason: s.check.detail, status: s.check.status })),
      script,
    },
    "获取成功",
    { ETag: etag, "Cache-Control": "no-cache" }
  );
}

export async function onRequestPost({ request, env }) {
  if (!env || !env.DB) return fail(500, "D1 数据库未绑定（env.DB 为空）", 500);
  let body;
  try {
    body = await request.json();
  } catch {
    return fail(400, "请求体必须是合法 JSON", 400);
  }
  const url = new URL(request.url);
  const action = String(url.searchParams.get("action") || body.action || "").trim().toLowerCase();

  await ensureSchema(env);
  await seedDefaults(env);

  // 体检允许用低权限的 SOURCES_CHECK_TOKEN；其余写操作只认管理令牌。
  const isCheck = action === "check-one" || action === "check-plan";
  let gate = checkAdmin(request, env);
  if (!gate.ok && isCheck && env.SOURCES_CHECK_TOKEN) {
    const bearer = String(request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    gate = bearer && bearer === env.SOURCES_CHECK_TOKEN ? { ok: true } : gate;
  }
  if (!gate.ok) return gate.response;

  if (action === "upsert") {
    let src;
    try {
      const existing = await getSource(env, body.id);
      src = normalizeSource(body, existing);
    } catch (e) {
      return fail(400, String(e && e.message ? e.message : e), 400);
    }
    // 用户手动改过启停 = 锁定，体检不再自动开关它。
    if (body.enabled !== undefined && body.enabled !== null) src.enabledLocked = true;
    const row = await upsertSource(env, src);
    const rev = await bumpRevision(env);
    const runner = await maybeSyncRunner(env, `upsert ${src.id}`);
    return ok({ source: publicSource(row), revision: rev, runner }, "已保存");
  }

  if (action === "toggle") {
    const row = await getSource(env, body.id);
    if (!row) return fail(404, "未找到该音源", 404);
    const next = normalizeSource({ ...row, enabled: body.enabled === undefined ? Number(row.enabled) !== 1 : body.enabled }, row);
    next.enabledLocked = true;
    const saved = await upsertSource(env, next);
    const rev = await bumpRevision(env);
    const runner = await maybeSyncRunner(env, `toggle ${body.id}`);
    return ok({ source: publicSource(saved), revision: rev, runner }, Number(saved.enabled) === 1 ? "已启用" : "已停用");
  }

  if (action === "delete") {
    const changes = await deleteSource(env, body.id);
    if (!changes) return fail(404, "未找到该音源（或已被删除）", 404);
    const rev = await bumpRevision(env);
    const runner = await maybeSyncRunner(env, `delete ${body.id}`);
    return ok({ id: body.id, revision: rev, runner }, "已删除");
  }

  // ── runner Worker（洛雪 js 音源的执行体）───────────────────────────────
  if (action === "deploy-runner") {
    const runner = await syncRunner(env, { force: body.force === true || url.searchParams.get("force") === "1", reason: "manual" });
    if (runner.deployed) await trustRunnerHashes(env);
    return ok({ contract: RUNNER_CONTRACT, script: runnerName(env), ...runner }, runner.deployed ? "runner 已重新部署" : "runner 无需变更或未部署");
  }

  // 本机 wrangler 那条部署路径（scripts/deploy-runner.mjs）用不到 Workers API，部署完没法回写 D1。
  // 这个动作把 D1 的"已部署哈希"对齐成 runner 当前真正加载的那份，后台和本机部署共用一个真相。
  if (action === "trust-runner") {
    const health = await trustRunnerHashes(env);
    if (!health.reachable || !Array.isArray(health.hashes)) {
      return fail(409, "runner 不可达或没有上报哈希，无法对齐部署记录", 409);
    }
    return ok({ hashes: health.hashes.slice().sort(), modules: health.hashes.length }, "已把部署记录对齐到 runner 实际加载的脚本集");
  }

  if (action === "runner-status") {
    const wanted = await desiredScriptSet(env);
    const deployed = await deployedHashes(env);
    const health = await runnerHealth(env);
    // 比较基准优先用 runner 自己上报的 /health.hashes —— 真相在边缘那个 Worker 里。
    // D1 记的那份只是"上次部署动作写回的哈希"，而本机 wrangler 部署路径（scripts/deploy-runner.mjs）
    // 走不了 Workers API，如果只看这份记录，后台会永远显示 stale、永远提示重部署。
    const live = health.reachable && Array.isArray(health.hashes) ? health.hashes : null;
    const compared = live || deployed;
    const stale = JSON.stringify(wanted.hashes.slice().sort()) !== JSON.stringify(compared.slice().sort());
    return ok({
      contract: RUNNER_CONTRACT,
      script: runnerName(env),
      target: health.target || null,
      reachable: Boolean(health.reachable),
      modules: Number(health.modules || 0),
      // runner 里"装上了但编译不过"的脚本：Text 模块 + 启动期 new Function 的形态下，
      // 单条源语法有问题只影响它自己（其余源照常干活），所以这里必须单独报给后台看。
      compiled: Number(health.compiled ?? health.modules ?? 0),
      broken: Array.isArray(health.broken) ? health.broken : [],
      liveHashes: Array.isArray(health.hashes) ? health.hashes : null,
      desiredHashes: wanted.hashes,
      deployedHashes: deployed,
      // 上面 stale 是按哪个口径算出来的：runner 上报（可信）/ D1 记录（够不到 runner 时才用）。
      staleBasedOn: live ? "runner" : "record",
      // 记录本身和现实不一致 —— 说明这次是本机 wrangler 部署的、没回写 D1，点一下对齐即可。
      recordNeedsSync: Boolean(live) && JSON.stringify(live.slice().sort()) !== JSON.stringify(deployed.slice().sort()),
      stale,
      skipped: wanted.skipped,
      bytes: wanted.totalBytes,
      canDeploy: Boolean(env.CF_ACCOUNT_ID && env.CF_API_TOKEN),
      error: health.error || null,
    }, stale ? "runner 与音源表不一致，需要重新部署" : "runner 与音源表一致");
  }

  if (action === "reorder") {
    const order = Array.isArray(body.order) ? body.order : [];
    if (!order.length) return fail(400, "缺少 order（音源 id 数组，从高优先级到低）", 400);
    const now = Date.now();
    const stmts = order.map((id, idx) =>
      env.DB.prepare("UPDATE music_sources SET priority = ?, updated_at = ? WHERE id = ?").bind(order.length - idx, now, String(id))
    );
    await env.DB.batch(stmts);
    const rev = await bumpRevision(env);
    return ok({ revision: rev, count: stmts.length }, "优先级已更新");
  }

  if (action === "import-js") {
    const filename = String(body.filename || "").trim();
    let text = body.script;
    if (typeof text !== "string" || !text.trim()) return fail(400, "缺少 script（js 音源正文）", 400);
    if (text.length > 6_000_000) return fail(413, "脚本过大（>6MB）", 413);
    // 允许前端直接传已经解开的文本；也允许传 base64（二进制混淆稿常见）
    if (body.encoding === "base64") {
      try {
        text = new TextDecoder().decode(Uint8Array.from(atob(text.replace(/\s+/g, "")), (c) => c.charCodeAt(0)));
      } catch (e) {
        return fail(400, `base64 解码失败：${String(e && e.message ? e.message : e)}`, 400);
      }
    }
    const meta = lxMeta(text);
    if (text.indexOf("globalThis.lx") < 0 && text.indexOf("EVENT_NAMES") < 0) {
      return fail(400, "不像洛雪音源脚本（没找到 globalThis.lx / EVENT_NAMES），已拒绝写入", 400);
    }
    const hash = await sha256Hex(text);
    const gz = await gzipBase64(text);
    await saveScript(env, { hash, name: meta.name || filename, gzipBase64: gz, rawBytes: new TextEncoder().encode(text).length });
    const platforms = detectPlatforms(text);
    const created = [];
    for (const p of platforms.length ? platforms : ["netease"]) {
      const src = normalizeSource({
        id: body.id || `lxjs-${hash.slice(0, 10)}-${p}`,
        name: `${meta.name || filename || "洛雪音源"} (${PLATFORMS[p].displayName})`,
        platform: p,
        protocol: "lxjs",
        quality: body.quality || "320k",
        priority: Number(body.priority ?? 5),
        note: [meta.version, meta.author, meta.description].filter(Boolean).join(" · ").slice(0, 300),
        scriptHash: hash,
      });
      created.push(publicSource(await upsertSource(env, src)));
    }
    const rev = await bumpRevision(env);
    const runner = await maybeSyncRunner(env, `import-js ${hash.slice(0, 10)}`);
    return ok({ hash, meta, platforms, sources: created, revision: rev, runner }, `已导入 ${created.length} 条音源`);
  }

  if (action === "check-plan") {
    const rows = await listSources(env);
    const ids = rows.filter((r) => Number(r.enabled) === 1).map((r) => ({ id: r.id, name: r.name, platform: r.platform, protocol: r.protocol }));
    // 一次 HTTP 请求只检一条：Cloudflare 免费计划单个请求的子请求数有上限（50），
    // 全部塞进一次调用必然超；由调用方（后台/客户端）逐条循环，还能顺便显示进度。
    return ok({ plan: ids, keyword: String(body.keyword || "晴天"), revision: (await currentRevision(env)).revision }, "体检计划");
  }

  if (action === "check-one") {
    const row = await getSource(env, body.id);
    if (!row) return fail(404, "未找到该音源", 404);
    const keyword = String(body.keyword || "晴天").slice(0, 40) || "晴天";
    const result = await checkSource(env, row, keyword);
    const applied = await writeCheckResult(env, row.id, result);
    const rev = await bumpRevision(env);
    const fresh = await getSource(env, row.id);
    return ok({
      result,
      applied,
      source: publicSource(fresh),
      revision: rev,
      advice: applied.suggestDelete ? "该源不可用，已自动停用，建议删除" : applied.enabled ? "" : "已停用",
    }, result.status === "ok" ? "可用" : "不可用");
  }

  if (action === "prefs") {
    const deviceId = String(body.deviceId || deviceIdOf(request, body)).trim();
    if (!deviceId) return fail(400, "缺少 deviceId", 400);
    if (body.homeTitle !== undefined) {
      await setDevicePref(env, deviceId, { homeTitle: body.homeTitle === null ? "" : String(body.homeTitle).slice(0, 60) });
    }
    if (body.extra !== undefined) {
      const cur = await getDevicePref(env, deviceId);
      await setDevicePref(env, deviceId, { extra: body.extra === null ? null : { ...safeJson(cur && cur.extra_json), ...body.extra } });
    }
    const rev = await bumpRevision(env);
    return ok({ deviceId, pref: await getDevicePref(env, deviceId), revision: rev }, "设备偏好已保存");
  }

  if (action === "global-settings") {
    if (body.homeTitle !== undefined) await metaSet(env, "home_title_default", String(body.homeTitle).slice(0, 60));
    const rev = await bumpRevision(env);
    return ok({ homeTitle: await metaGet(env, "home_title_default", ""), revision: rev }, "全局默认已保存");
  }

  if (action === "devices") {
    // 后台要按 deviceId 设文案，得先看到有哪些设备。直接复用老表，只读。
    const rows = await env.DB.prepare("SELECT device_id, device_name, platform, playlist_count, song_count, updated_at FROM device_playlists ORDER BY updated_at DESC LIMIT 100").all();
    return ok({ devices: (rows && rows.results) || [] }, "设备列表");
  }

  return fail(400, `未知 action：${action || "(空)"}（可用：upsert/toggle/delete/reorder/import-js/check-plan/check-one/prefs/global-settings/devices/deploy-runner/runner-status/trust-runner）`, 400);
}

/**
 * 只有"确实可能有变化 + 确实有能力部署"时才去碰 Cloudflare API：
 * 没有 CF_ACCOUNT_ID/CF_API_TOKEN（本机测试、或后台还没配密钥）一律直接返回，
 * 免得每次写操作都对外网发一个必然失败的请求。
 */
async function maybeSyncRunner(env, reason) {
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
    return { deployed: false, skipped: "no_credentials", note: "未配置 CF_ACCOUNT_ID / CF_API_TOKEN，runner 未自动部署" , reason };
  }
  const r = await syncRunner(env, { reason });
  if (r.deployed) await trustRunnerHashes(env);
  return r;
}

function safeJson(text) {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return {};
  }
}
/**
 * 从洛雪脚本里猜它覆盖哪些平台：
 * 1) `send(inited, { sources: { tx, wy, kg, kw, mg } })` 声明的键；
 * 2) 正文里出现的平台字面量。
 * 一个脚本可能被拆成多条音源（每平台一条），这样清单里的 platform 字段仍然有意义。
 */
function detectPlatforms(text) {
  const keys = new Set();
  const lxToPlatform = { tx: "qq", wy: "netease", kg: "kugou", kw: "kuwo", mg: "migu", bil: "bilibili", mguo: "migu" };
  const declared = /sources\s*:\s*\{([\s\S]{0,600})\}/.exec(text);
  if (declared) {
    for (const m of declared[1].matchAll(/(?:^|[,{\s])(tx|wy|kg|kw|mg|bil|mguo)\s*:/g)) {
      const p = lxToPlatform[m[1]];
      if (p) keys.add(p);
    }
  }
  if (!keys.size) {
    for (const m of text.matchAll(/\b(source|platform)\s*===?\s*['"](tx|wy|kg|kw|mg|tencent|netease|kugou|kuwo|migu)['"]/g)) {
      const p = lxToPlatform[m[2]] || (["tencent", "netease", "kugou", "kuwo", "migu"].indexOf(m[2]) >= 0 ? (m[2] === "tencent" ? "qq" : m[2]) : null);
      if (p) keys.add(p);
    }
  }
  return Array.from(keys);
}
