// 「检测全部可用」的核心：一次体检 = 搜到一首真歌 → 解析出真直链 → 用 Range 真取回音频。
//
// 这是对旧行为的纠正：两端客户端的 ping 只发一个 `HEAD baseURL`（Windows aggregated.js:405-418 /
// iPhone AggregatedSourceStore.swift:169-201），把"站点活着"当成"线路可用"。
// 2026-10-14 实测就是反例：酷狗 HYW 搜索能出 20 条、延迟检测绿灯，取流却回 401「需要卡密」。
// 能访问 ≠ 能播放，所以这里三步全过才叫 ok。

import { search, resolveURL, probeAudio } from "./protocols.js";
import { lxMeta, gunzipText } from "./lx.js";
import { lxMusicUrl } from "./runner.js";
import { metaGet, metaSet, loadScript, publicSource } from "./store.js";

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
  if (!s.items.length) {
    return { status: "search_empty", detail: s.note || "搜索无结果", bytes: 0 };
  }
  // 顺手喂样本池：洛雪音源不会搜索，靠这里攒的真实歌曲 id 才能被体检。
  await rememberSamples(env, source.platform, s.items);
  const tried = [];
  for (const item of s.items.slice(0, 3)) {
    const url = await resolveURL(source, item.rawID);
    if (!url) {
      tried.push(`解析无直链 ${item.title || item.rawID}`);
      continue;
    }
    const a = await probeAudio(url);
    if (a.playable) {
      return {
        status: "ok",
        detail: `${item.title || ""} / ${item.artist || ""} · ${a.status} ${a.contentType.split(";")[0]} · ${a.bytes}B · ${a.finalHost}`,
        bytes: a.bytes,
        host: a.finalHost,
      };
    }
    tried.push(`直链不可播 ${a.status} ${a.contentType} ${a.bytes}B（${a.finalHost || "?"}）`);
  }
  return { status: "resolve_fail", detail: tried.join(" / ").slice(0, 400), bytes: 0 };
}

async function checkLxSource(env, source) {
  const rec = await loadScript(env, source.scriptHash);
  if (!rec) return { status: "script_missing", detail: "D1 里找不到该音源的脚本正文", bytes: 0 };
  let text;
  try {
    text = await gunzipText(rec.body);
  } catch (e) {
    return { status: "script_error", detail: `脚本解压缩失败：${String(e.message || e)}`, bytes: 0 };
  }
  const meta = lxMeta(text);
  const pool = await getSamples(env);
  const ids = Array.isArray(pool[source.platform]) ? pool[source.platform] : [];
  if (!ids.length) {
    // 样本池空着 ≠ 音源坏了（洛雪音源不会搜索，我们没有可考的歌曲 id）。
    // 这种情况绝不能停用、更不能建议删除——那是把服务端的观测盲区算到源头上。
    return { status: "no_sample", detail: `样本池里没有 ${source.platform} 的歌曲 id，暂无法验证（先用其它线路搜一次再体检）`, bytes: 0 };
  }
  const tried = [];
  let runnerMissing = false;
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
      tried.push(`${id}: ${msg.slice(0, 140)}`);
    }
  }
  if (runnerMissing) {
    return { status: "runner_missing", detail: `${meta.name} · runner Worker 尚未部署该脚本或不可达（后台点"部署 runner"后重试）`, bytes: 0 };
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
      result = await checkLxSource(env, source);
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
