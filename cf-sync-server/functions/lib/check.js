// 「检测全部可用」的核心：一次体检 = 搜到一首真歌 → 解析出真直链 → 用 Range 真取回音频。
//
// 这是对旧行为的纠正：两端客户端的 ping 只发一个 `HEAD baseURL`（Windows aggregated.js:405-418 /
// iPhone AggregatedSourceStore.swift:169-201），把"站点活着"当成"线路可用"。
// 2026-10-14 实测就是反例：酷狗 HYW 搜索能出 20 条、延迟检测绿灯，取流却回 401「需要卡密」。
// 能访问 ≠ 能播放，所以这里三步全过才叫 ok。

import { search, resolveURL, probeAudio } from "./protocols.js";
import { lxMeta, gunzipText } from "./lx.js";
import { lxMusicUrl, lxSearch } from "./runner.js";
import { metaGet, metaSet, loadScript, publicSource, listSources } from "./store.js";

const SAMPLE_POOL_KEY = "probe_samples_v1";
const SAMPLE_LIMIT = 24;

/** 搜索命中后把 rawID 攒进样本池，供 lxjs 音源体检取用（洛雪协议只有 musicUrl，不会搜索）。 */
export async function rememberSamples(env, platform, items) {
  if (!platform || !Array.isArray(items) || !items.length) return;
  const pool = await getSamples(env);
  const list = pool[platform] && Array.isArray(pool[platform]) ? pool[platform] : [];
  for (const it of items.slice(0, 8)) {
    const id = String(it.rawID || "");
    if (id && list.indexOf(id) < 0) list.unshift(id);
  }
  pool[platform] = list.slice(0, SAMPLE_LIMIT);
  await metaSet(env, SAMPLE_POOL_KEY, JSON.stringify(pool));
}

export async function getSamples(env) {
  try {
    return JSON.parse((await metaGet(env, SAMPLE_POOL_KEY, "{}")) || "{}");
  } catch {
    return {};
  }
}

function rowToSource(row) {
  const pub = publicSource(row);
  return {
    id: pub.id,
    name: pub.name,
    platform: pub.platform,
    protocol: pub.protocol,
    baseURL: pub.baseURL,
    scriptHash: pub.scriptHash,
    quality: pub.quality,
  };
}

async function checkHttpSource(env, source, keyword) {
  const s = await search(source, keyword);
  const labelOf = new Map(s.items.map((i) => [i.rawID, `${i.title || ""}${i.artist ? ` / ${i.artist}` : ""}`]));
  let ids = s.items.map((i) => i.rawID).filter(Boolean);
  if (ids.length) {
    // 顺手喂样本池：洛雪音源不会搜索，靠这里攒的真实歌曲 id 才能被体检。
    await rememberSamples(env, source.platform, s.items);
  } else {
    // **搜索没结果 ≠ 这条源不能播。** 第三方解析站的 /search 路径经常单独挂掉
    // （现网实测：520 的 Cloudflare 拦截页、`{"error":"unknown type"}`、"需要卡密"），
    // 而它的 /url 那条路还是好的。判据是"能不能出声"，所以这里退回样本池里
    // （由别的线路或会搜的洛雪源喂进来的）真实歌曲 id，继续验播放。
    // 只有池子也空着才是真的无从判断 —— 那是我们的观测盲区，报 no_sample、绝不停用。
    ids = await ensureSamples(env, source.platform, keyword);
    if (!ids.length) {
      return { status: "no_sample", detail: `搜索无结果（${s.note || "未返回条目"}），样本池里也没有 ${source.platform} 的可考 id，暂无法验证`, bytes: 0 };
    }
  }
  const tried = [];
  for (const rawID of ids.slice(0, 3)) {
    const label = labelOf.get(rawID) || "";
    const url = await resolveURL(source, rawID);
    if (!url) {
      tried.push(`解析无直链 ${label || rawID}`);
      continue;
    }
    const a = await probeAudio(url);
    if (a.playable) {
      return {
        status: "ok",
        // 用样本池 id 验出来时要说清楚，否则"这条源搜索接口挂了却显示 ok"看着像假阳性。
        detail: `${label || rawID} · ${a.status} ${a.contentType.split(";")[0]} · ${a.bytes}B · ${a.finalHost}${labelOf.size ? "" : "（搜索接口当前无结果，用样本池的歌曲 id 验的播放）"}`,
        bytes: a.bytes,
        host: a.finalHost,
      };
    }
    tried.push(`直链不可播 ${a.status} ${a.contentType} ${a.bytes}B（${a.finalHost || "?"}）`);
  }
  return { status: "resolve_fail", detail: tried.join(" / ").slice(0, 400), bytes: 0 };
}

/**
 * 拿到某平台可体检的真实歌曲 id：先看样本池，池子空了就现搜一次。
 *
 * 为什么要在体检链路里现搜：样本池原本只由**会搜索的 HTTP 线路**喂（网关搜索命中后回写），
 * 而 2026-10-14 现网实测这些 HTTP 线路大批已经死了（520/525/需要卡密），于是 qq/kuwo/migu
 * 这些平台的池子全是空的 —— 17 条源只能报 no_sample。这跟源本身没关系，是我们没样本。
 * 官方洛雪协议只保证 musicUrl，但本机 22 个脚本里确实有一部分自己实现了 search
 * （非常刀：读 info.keyword）。能搜就让它自己供样本，把观测盲区变成真结论。
 *
 * 只试 3 条：每条都要过一次 runner（最坏 25s），再多就把一次体检拖成了扫库。
 */
export async function ensureSamples(env, platform, keyword = "晴天") {
  const pool = await getSamples(env);
  const have = Array.isArray(pool[platform]) ? pool[platform] : [];
  if (have.length) return have;

  const rows = await listSources(env);
  const cands = rows
    .filter((r) => Number(r.enabled) === 1 && r.protocol === "lxjs" && r.platform === platform)
    .slice(0, 3);
  for (const r of cands) {
    try {
      const items = await lxSearch(env, { hash: r.script_hash, platform, keyword });
      if (items.length) {
        await rememberSamples(env, platform, items);
        const again = await getSamples(env);
        const ids = Array.isArray(again[platform]) ? again[platform] : [];
        if (ids.length) return ids;
      }
    } catch {
      /* 这条源不会搜 / 搜挂了：换下一条候选，结论由后面的取样步骤给出 */
    }
  }
  return [];
}

async function checkLxSource(env, source, keyword) {
  const rec = await loadScript(env, source.scriptHash);
  if (!rec) return { status: "script_missing", detail: "D1 里找不到该音源的脚本正文", bytes: 0 };
  let text;
  try {
    text = await gunzipText(rec.body);
  } catch (e) {
    return { status: "script_error", detail: `脚本解压缩失败：${String(e.message || e)}`, bytes: 0 };
  }
  const meta = lxMeta(text);
  const ids = await ensureSamples(env, source.platform, keyword);
  if (!ids.length) {
    // 样本池空着 ≠ 音源坏了（这条源和它的同伴都不会搜索，我们没有可考的歌曲 id）。
    // 这种情况绝不能停用、更不能建议删除——那是把服务端的观测盲区算到源头上。
    return { status: "no_sample", detail: `${meta.name} · ${source.platform} 拿不到可考的歌曲 id（样本池空，且这条源的同伴里没有一个会搜索），暂无法验证`, bytes: 0 };
  }
  const tried = [];
  let runnerMissing = false;
  let brokenScript = "";
  for (const id of ids.slice(0, 3)) {
    try {
      const r = await lxMusicUrl(env, { hash: rec.hash, platform: source.platform, rawID: id, quality: source.quality });
      const a = await probeAudio(r.url);
      if (a.playable) {
        return { status: "ok", detail: `${meta.name} · ${a.status} ${a.contentType.split(";")[0]} · ${a.bytes}B · ${a.finalHost}`, bytes: a.bytes, host: a.finalHost };
      }
      tried.push(`${id}: 直链不可播 ${a.status} ${a.contentType} ${a.bytes}B`);
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      // runner 侧的基础设施问题（未部署 / 够不到）不是音源本身的错，绝不能因此停用音源。
      if (e && (e.runnerError === "hash_not_deployed" || /runner_unavailable|hash_not_deployed|没有脚本|目标未配置/.test(msg))) runnerMissing = true;
      // 反过来：脚本在沙箱里连编译都过不去，是这条源自己永远出不了声（不是我们的部署问题），
      // 停用 + 建议删除才是符合"能播才有价值"的处理。错误文本原样带出来，好判断是谁的锅。
      if (e && e.runnerError === "script_uncompilable") brokenScript = msg;
      tried.push(`${id}: ${msg.slice(0, 140)}`);
    }
  }
  if (runnerMissing) {
    return { status: "runner_missing", detail: `${meta.name} · runner Worker 尚未部署该脚本或不可达（后台点"部署 runner"后重试）`, bytes: 0 };
  }
  if (brokenScript) {
    return { status: "script_uncompilable", detail: `${meta.name} · 脚本在本沙箱里编译不过：${brokenScript.slice(0, 240)}`, bytes: 0 };
  }
  const hardError = tried.find((t) => /未注册|SyntaxError|ReferenceError|TypeError|script_timeout|超过/.test(t)) || "";
  return {
    status: hardError ? "script_error" : "audio_fail",
    detail: `${meta.name}${meta.version ? ` ${meta.version}` : ""} · ${tried.join(" / ").slice(0, 400)}`,
    bytes: 0,
  };
}

/**
 * 体检单条线路。keyword 由调用方给（默认「晴天」），失败原因写回 D1 并决定是否停用。
 */
export async function checkSource(env, row, keyword) {
  const source = rowToSource(row);
  let result;
  try {
    if (source.protocol === "lxjs") {
      result = await checkLxSource(env, source, keyword);
    } else if (source.protocol === "customJson") {
      result = { status: "unsupported", detail: "customJson 协议两端都不做搜索（Swift :183-184），无法验证", bytes: 0 };
    } else {
      result = await checkHttpSource(env, source, keyword);
    }
  } catch (e) {
    result = { status: "error", detail: String(e && e.message ? e.message : e).slice(0, 300), bytes: 0 };
  }
  return { sourceId: source.id, platform: source.platform, protocol: source.protocol, name: source.name, ...result };
}
