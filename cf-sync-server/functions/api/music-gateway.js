// /api/music-gateway —— 服务端音源执行入口（客户端拿它播 lxjs 音源）
//
// 为什么要网关：洛雪 js 音源只能在服务端执行。 Workers 不允许在请求期把字符串变成代码
// （实测见 lib/runner.js 顶部），脚本被打包进独立的 runner Worker 执行，Pages Function 这边
// 只做转发；客户端两边都不装 lx 运行时 —— 这样"客户端只保存一个 URL"的目标才守得住。于是清单里每条形为：
//   protocol === "lxjs"  → 必须走本网关（网关再转给 runner）
//   其余                 → 客户端本地直连（默认）或走网关（统一口径）都可以
//
// 读开放，但要求 deviceId 并限流：这个端点会把请求转发给第三方解析站，
// 不限就变成免费公网代理。
//
// 另外两个 action 是给 runner 回调用的一等公民：
//   resolve → 让脚本用 meting/hyw/nxinxz/openApi 这几类 HTTP 协议解析某首歌的直链
//             （runner 没有 D1 绑定，读不到音源表，只能经这里；脚本因此能吃到全部线路，
//              而不是只有它自己硬编码的那一个站点）
//   samples → 脚本搜索到歌曲后把 rawID 回报进样本池，这样 lxjs 音源才有可考的真实 id 被体检

import { ok, fail, rateLimit, deviceIdOf, corsHeaders } from "../lib/common.js";
import { ensureSchema, seedDefaults, listSources, getSource, publicSource } from "../lib/store.js";
import { search, resolveURL, lyric } from "../lib/protocols.js";
import { rememberSamples, getSamples } from "../lib/check.js";
import { lxMusicUrl, lxSearch, lxCapabilities, lxSupportsSearch } from "../lib/runner.js";
import { loadScript } from "../lib/store.js";

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

async function readParams({ request, env }) {
  const url = new URL(request.url);
  let body = {};
  if (request.method === "POST") {
    try {
      body = await request.json();
    } catch {
      body = {};
    }
  }
  const pick = (keys) => {
    for (const k of keys) {
      const v = url.searchParams.get(k) !== null ? url.searchParams.get(k) : body[k];
      if (v !== undefined && v !== null && String(v) !== "") return String(v);
    }
    return "";
  };
  return {
    action: pick(["action"]).toLowerCase(),
    keyword: pick(["keyword", "q", "name", "query"]),
    platform: pick(["platform"]),
    rawID: pick(["rawID", "rawId", "id", "songId", "mid", "hash"]),
    sourceId: pick(["sourceId", "source"]),
    quality: pick(["quality"]) || "320k",
    deviceId: deviceIdOf(request, body),
    limit: Math.max(1, Math.min(60, Number(pick(["limit"])) || 30)),
  };
}

function candidates(rows, { sourceId, platform }) {
  const enabled = rows.filter((r) => Number(r.enabled) === 1).map(publicSource);
  if (sourceId) {
    const hit = enabled.filter((s) => s.id === sourceId);
    return hit.length ? hit : null; // 指名道姓却不可用：让调用方知道原因，不要静默换源
  }
  const list = platform ? enabled.filter((s) => s.platform === platform) : enabled;
  return list.sort((a, b) => b.priority - a.priority);
}

export async function handleGateway(ctx) {
  const { request, env } = ctx;
  if (!env || !env.DB) return fail(500, "D1 数据库未绑定（env.DB 为空）", 500);
  const rl = rateLimit(request, 120, 60000);
  if (!rl.ok) return rl.response;

  await ensureSchema(env);
  await seedDefaults(env);
  const p = await readParams(ctx);
  const rows = await listSources(env);

  if (p.action === "capabilities" || !p.action) {
    const usable = rows.map(publicSource).filter((s) => s.enabled);
    const pool = await getSamples(env);
    return ok({
      contract: "primuse.music-gateway.v1",
      actions: ["search", "url", "lyric", "capabilities"],
      enabledSourceCount: usable.length,
      byProtocol: usable.reduce((acc, s) => {
        acc[s.protocol] = (acc[s.protocol] || 0) + 1;
        return acc;
      }, {}),
      samplePool: Object.keys(pool).map((k) => ({ platform: k, count: Array.isArray(pool[k]) ? pool[k].length : 0 })),
    }, "网关在线");
  }

  const list = candidates(rows, p);
  if (list === null) {
    return fail(409, `指定音源 ${p.sourceId} 不存在或已被停用/体检判为不可用`, 409);
  }
  if (!list.length) {
    return fail(409, "没有任何启用的音源（全部被体检判为不可用就是这种状态）", 409);
  }

  if (p.action === "search") {
    if (!p.keyword) return fail(400, "缺少 keyword", 400);
    // 并行搜（并发数刻意压小：每个第三方站点都可能慢）。
    //
    // lxjs 要不要进来：官方洛雪协议只保证 musicUrl，搜索是各家脚本自己加的，所以这里
    // **先问 runner 的 capabilities**（脚本在 inited 负载里声明 actions），声明了 search 才发搜索。
    // 不声明的就不浪费一次 25s 超时。问不到（runner 挂了）就当不会搜，绝不为"猜"付钱。
    const wanted = p.platform ? (s) => s.platform === p.platform : () => true;
    const httpSources = list.filter((s) => s.protocol !== "lxjs" && wanted(s));
    const lxSources = list.filter((s) => s.protocol === "lxjs" && s.scriptHash && wanted(s))
      // 排序：体检真出过声的排前面，其余（含"检不出"的 kuwo/migu 那批）排在后面 ——
      // 上限 4 条只是给一次用户搜索封顶，不是把"没体检过"的源排除掉；
      // 恰恰是它们需要在搜索里被用到，才能喂样本池、从"无法验证"里出来。
      .sort((a, b) => (b.check && b.check.status === "ok" ? 1 : 0) - (a.check && a.check.status === "ok" ? 1 : 0) || b.priority - a.priority)
      .slice(0, 4);

    const seen = new Set();
    const results = [];
    const notes = [];
    const chunks = [];
    for (let i = 0; i < httpSources.length; i += 4) chunks.push(httpSources.slice(i, 4 + i));
    // 洛雪搜索先发出去，不排在 HTTP 那几批后面：一次 runner 冷启动就要好几秒。
    const lxBallot = Promise.all(lxSources.map(async (s) => {
      try {
        const caps = await lxCapabilities(env, s.scriptHash);
        if (!lxSupportsSearch(caps)) return { s, items: [], skipped: "该音源未声明 search 能力" };
        const items = await lxSearch(env, { hash: s.scriptHash, platform: s.platform, keyword: p.keyword, limit: Math.min(20, p.limit), timeoutMs: 12000 });
        return { s, items };
      } catch (e) {
        return { s, items: [], skipped: String(e && e.message ? e.message : e) };
      }
    }));
    for (const chunk of chunks) {
      const settled = await Promise.all(
        chunk.map(async (s) => {
          try {
            return { s, r: await search({ ...s, baseURL: s.baseURL }, p.keyword) };
          } catch (e) {
            return { s, r: { items: [], note: String(e && e.message ? e.message : e) } };
          }
        })
      );
      for (const { s, r } of settled) {
        if (!r.items.length) {
          notes.push({ id: s.id, name: s.name, note: r.note || "无结果" });
          continue;
        }
        await rememberSamples(env, s.platform, r.items);
        for (const item of r.items) {
          const key = `${item.platform}:${item.rawID}`;
          if (seen.has(key)) continue;
          seen.add(key);
          results.push(item);
        }
      }
    }
    for (const { s, items, skipped } of await lxBallot) {
      if (!items.length) {
        notes.push({ id: s.id, name: s.name, note: skipped || "无结果" });
        continue;
      }
      // 喂样本池：这是 kuwo / migu 这类"只有洛雪源会搜"的平台唯一能拿到可考 id 的途径。
      await rememberSamples(env, s.platform, items);
      for (const item of items) {
        const key = `${s.platform}:${item.rawID}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({ ...item, id: `agg_${s.platform}_${item.rawID}`, platform: s.platform, sourceId: s.id, sourceName: s.name, kind: "aggregated", protocol: "lxjs" });
      }
    }
    return ok({ action: "search", keyword: p.keyword, count: results.length, results: results.slice(0, p.limit), notes }, "搜索完成");
  }

  if (p.action === "url") {
    if (!p.rawID) return fail(400, "缺少 rawID", 400);
    const platform = p.platform || (p.rawID.startsWith("agg_") ? p.rawID.split("_")[1] : list[0].platform);
    const tried = [];
    for (const s of list) {
      if (s.platform !== platform && s.platform !== "custom") continue;
      try {
        if (s.protocol === "lxjs") {
          if (!s.scriptHash) {
            tried.push({ id: s.id, note: "脚本正文缺失" });
            continue;
          }
          const rec = await loadScript(env, s.scriptHash);
          if (!rec) {
            tried.push({ id: s.id, note: "脚本正文缺失" });
            continue;
          }
          // 脚本不在这里执行：Workers 不允许请求期把字符串变成代码，
          // 真正执行在 runner Worker（见 lib/runner.js 顶部实测记录），这里只是转发调用。
          const r = await lxMusicUrl(env, { hash: s.scriptHash, platform, rawID: p.rawID, quality: s.quality || p.quality });
          return ok({ action: "url", url: r.url, sourceId: s.id, sourceName: s.name, protocol: s.protocol, platform, rawID: p.rawID, tried }, "解析成功");
        }
        const url = await resolveURL({ ...s, baseURL: s.baseURL }, p.rawID);
        if (url) {
          return ok({ action: "url", url, sourceId: s.id, sourceName: s.name, protocol: s.protocol, platform, rawID: p.rawID, tried }, "解析成功");
        }
        tried.push({ id: s.id, name: s.name, note: "无直链" });
      } catch (e) {
        tried.push({ id: s.id, name: s.name, note: String(e && e.message ? e.message : e).slice(0, 200) });
      }
    }
    return fail(404, `全部启用音源均解析失败（平台 ${platform}，id ${p.rawID}）：${tried.map((t) => `${t.name || t.id}:${t.note}`).join(" / ").slice(0, 400)}`, 404);
  }

  if (p.action === "lyric") {
    if (!p.rawID) return fail(400, "缺少 rawID", 400);
    const platform = p.platform || list[0].platform;
    for (const s of list) {
      if (s.protocol === "lxjs") continue;
      const text = await lyric({ ...s, baseURL: s.baseURL }, p.rawID);
      if (text) return ok({ action: "lyric", lyric: text, sourceId: s.id, platform, rawID: p.rawID }, "歌词获取成功");
    }
    return ok({ action: "lyric", lyric: "", sourceId: null, platform, rawID: p.rawID }, "无歌词");
  }

  return fail(400, `未知 action：${p.action}（可用：search/url/lyric/capabilities）`, 400);
}

export const onRequestGet = handleGateway;
export const onRequestPost = handleGateway;
