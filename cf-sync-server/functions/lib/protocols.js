// 四类既有协议（meting / hyw / nxinxz / openApi）的服务端实现。
//
// 逐条抄自客户端两份等价实现，字段名与 query 参数名一律不改：
//   - Windows：primuse-win/src/main/aggregated.js（本身就是 iPhone Swift 的移植）
//   - iPhone ：primuse/Primuse/Services/AggregatedMusic/AggregatedMusicService.swift:109-457
// 目的：让"体检"的判定和客户端实际播放路径完全一致——服务端说能播，客户端就得真能播。

import { PLATFORMS } from "./store.js";

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

function trimBase(u) {
  return String(u || "").replace(/\/+$/g, "");
}

function plat(platform) {
  return PLATFORMS[platform] || PLATFORMS.custom;
}

async function fetchText(url, { timeoutMs = 8000, headers = {}, method = "GET", body = null } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      body,
      redirect: "follow",
      signal: ctl.signal,
      headers: { "User-Agent": UA, Accept: "*/*", "Accept-Encoding": "gzip, deflate, br", ...headers },
    });
    const text = await res.text();
    return { status: res.status, text, finalUrl: res.url || url, redirected: Boolean(res.redirected), headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

function jsonOf(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function firstField(dict, keys) {
  for (const k of keys) {
    const v = dict[k];
    if (v === undefined || v === null) continue;
    const s = String(v);
    if (s && s !== "null" && s !== "nil" && s !== "<null>") return s;
  }
  return "";
}

function pickDuration(dict) {
  const cands = [dict.duration, dict.song_play_time, dict.interval, dict.time, dict.second, dict.dur];
  for (const c of cands) {
    if (Array.isArray(c) && c.length) {
      const n = Number(c[0]);
      if (Number.isFinite(n) && n > 0) return n > 3000 ? Math.round(n / 1000) : n;
      continue;
    }
    if (typeof c === "string" && /^\d+:\d+/.test(c)) {
      const parts = c.split(":").map(Number);
      if (Number.isFinite(parts[0]) && Number.isFinite(parts[1])) return parts[0] * 60 + parts[1];
    }
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n > 3000 ? Math.round(n / 1000) : n;
  }
  return 0;
}

function parseMetingLike(json, source, kindKeys) {
  let list = Array.isArray(json) ? json : null;
  if (!list && json && typeof json === "object") {
    list = Array.isArray(json.data) ? json.data : Array.isArray(json.list) ? json.list : null;
  }
  if (!list) return [];
  const out = [];
  for (const dict of list) {
    if (!dict || typeof dict !== "object") continue;
    let id = firstField(dict, kindKeys.id);
    if (!id && (typeof dict.url === "string" || typeof dict.lrc === "string")) {
      const m = /(?<=id=)[^&]+/.exec(String(dict.url || dict.lrc));
      if (m) id = m[0];
    }
    const name = firstField(dict, kindKeys.title);
    let artist = "";
    if (typeof dict.artist === "string") artist = dict.artist;
    else if (Array.isArray(dict.artist)) artist = dict.artist.filter((x) => typeof x === "string").join(", ");
    else if (typeof dict.author === "string") artist = dict.author;
    else artist = firstField(dict, ["singer_name", "singer"]);
    if (!id || !name) continue;
    out.push({
      id: `agg_${source.platform}_${id}`,
      rawID: id,
      title: name,
      artist,
      album: typeof dict.album === "string" ? dict.album : firstField(dict, ["album_name", "album"]),
      duration: pickDuration(dict),
      coverURL: typeof dict.pic === "string" ? dict.pic : typeof dict.cover === "string" ? dict.cover : null,
      platform: source.platform,
      sourceId: source.id,
      sourceName: source.name,
      kind: "aggregated",
    });
  }
  return out;
}

/** Windows `searchURLFor` :194-223 —— hyw/nxinxz 的搜索地址是硬编码第三方站点，照抄。 */
export function searchURLFor(source, keyword) {
  const kw = encodeURIComponent(keyword);
  const base = trimBase(source.baseURL);
  const server = plat(source.platform).meting;
  switch (source.protocol) {
    case "meting":
      return base.includes("api.php")
        ? `${base}?types=search&count=20&source=${server}&pages=1&name=${kw}`
        : `${base}?type=search&id=${kw}&server=${server}&limit=20`;
    case "hyw": {
      const p = source.platform;
      if (p === "qq") return `https://api.qijieya.cn/meting?type=search&id=${kw}&server=tencent&limit=20`;
      if (p === "kugou") return `https://api.qijieya.cn/meting?type=search&id=${kw}&server=kugou&limit=20`;
      if (p === "kuwo") return `https://music-api.gdstudio.xyz/api.php?types=search&count=20&source=kuwo&name=${kw}`;
      if (p === "netease") return `https://music-api.gdstudio.xyz/api.php?types=search&count=20&source=netease&name=${kw}`;
      return null;
    }
    case "nxinxz":
      return `https://music-api.gdstudio.xyz/api.php?types=search&count=20&source=kuwo&name=${kw}`;
    case "openApi":
      return `${base}?msg=${kw}&type=json`;
    default:
      return null;
  }
}

export async function search(source, keyword) {
  const url = searchURLFor(source, keyword);
  if (!url) return { items: [], note: `协议 ${source.protocol} 不支持搜索` };
  const res = await fetchText(url, { timeoutMs: 9000 });
  if (res.status !== 200) return { items: [], note: `搜索接口 ${res.status}：${res.text.slice(0, 120)}` };
  const json = jsonOf(res.text);
  const isOpen = source.protocol === "openApi";
  const items = parseMetingLike(json, source, {
    id: isOpen ? ["song_mid", "mid", "id"] : ["id", "url_id", "songmid", "hash", "musicId", "songId"],
    title: isOpen ? ["song_name", "song_title", "name"] : ["name", "title", "song_name", "songname"],
  });
  if (!items.length && res.text && res.text.trim() && res.text.trim() !== "[]") {
    return { items: [], note: `返回 200 但解析不出条目：${res.text.slice(0, 140)}` };
  }
  return { items, note: "" };
}

/** 对应两端 resolveStreamURLFromSource；返回直链字符串或 null。 */
export async function resolveURL(source, rawID) {
  const base = trimBase(source.baseURL);
  const server = plat(source.platform).meting;
  const id = encodeURIComponent(rawID);
  try {
    switch (source.protocol) {
      case "meting": {
        const url = base.includes("api.php")
          ? `${base}?types=url&source=${server}&id=${id}&br=320`
          : `${base}?server=${server}&type=url&id=${id}&br=320`;
        const res = await fetchText(url, { timeoutMs: 9000 });
        if (res.redirected && res.finalUrl.indexOf("type=url") < 0 && res.finalUrl.indexOf("types=url") < 0) return res.finalUrl;
        const j = jsonOf(res.text);
        if (j && typeof j.url === "string" && j.url) return j.url;
        if (/^https?:\/\//i.test(res.text.trim())) return res.text.trim();
        return null;
      }
      case "hyw": {
        const key = plat(source.platform).hyw;
        const res = await fetchText(`${base}?source=${key}&songId=${id}&quality=320k`, { timeoutMs: 9000 });
        const j = jsonOf(res.text);
        if (j && typeof j.url === "string" && j.url) return j.url;
        if (j && j.data && typeof j.data.url === "string" && j.data.url) return j.data.url;
        return null;
      }
      case "nxinxz": {
        const key = plat(source.platform).hyw;
        return `${base}?id=${id}&level=320k&type=mp3&source=${key}`;
      }
      case "openApi": {
        const res = await fetchText(`${base}?msg=${id}&type=url`, { timeoutMs: 9000 });
        const j = jsonOf(res.text);
        if (j && typeof j.url === "string" && j.url) return j.url;
        if (j && typeof j.data === "string" && /^https?:\/\//i.test(j.data)) return j.data;
        return null;
      }
      default:
        return null;
    }
  } catch (e) {
    return null;
  }
}

export async function lyric(source, rawID) {
  const base = trimBase(source.baseURL);
  const server = plat(source.platform).meting;
  const id = encodeURIComponent(rawID);
  let url = null;
  if (source.protocol === "meting") {
    url = base.includes("api.php") ? `${base}?types=lyric&source=${server}&id=${id}` : `${base}?server=${server}&type=lrc&id=${id}`;
  } else if (source.protocol === "hyw" || source.protocol === "nxinxz") {
    url = `https://api.qijieya.cn/meting?server=${server}&type=lrc&id=${id}`;
  } else if (source.protocol === "openApi") {
    url = `${base}?msg=${id}&type=lrc`;
  }
  if (!url) return "";
  try {
    const res = await fetchText(url, { timeoutMs: 7000 });
    const j = jsonOf(res.text);
    if (j) {
      const cand = j.lyric || j.lrc || (j.data && (j.data.lyric || j.data.lrc)) || "";
      if (typeof cand === "string" && cand) return cand;
    }
    return res.text && res.text.indexOf("[") >= 0 ? res.text : "";
  } catch (e) {
    return "";
  }
}

/**
 * 字节层面的音频判据。
 * content-type 只能证明"服务器声称这是音频"，恰好是旧延迟检测被骗的那种声明：
 * 不少挂掉的解析站会拿 audio/mpeg 的头回一段 HTML 报错页或 JSON。
 *
 * 但反过来只看 content-type 也是误杀：**真音频配错 content-type 是常态**
 * （`text/plain`、`application/octet-stream`、干脆不给），旧写法里 OggS/fLaC 还各有 bug ——
 * `head` 只截了 3 个字节，四字节魔数永远比不中。所以这一版：
 *   - 字节数取够（12B，四字节魔数 + RIFF 的 WAVE 标记都在里面）；
 *   - 命中魔数 或 content-type 是音频类，两者有一个成立就算有声；
 *   - 文本特征（HTML/XML/JSON 开头）一票否决，这是真挂掉的样子。
 * 客户端 src/main/cloud-sources.js 的 looksLikeAudio/isPlayableAudio 与本函数逐条对齐。
 */
export function sniffAudio(bytes) {
  const head = bytes.slice(0, 12);
  const hex = Array.from(head).map((b) => b.toString(16).padStart(2, "0")).join("");
  const asText = new TextDecoder("utf8", { fatal: false }).decode(bytes.slice(0, 64));
  const ascii = (at, text) => text.split("").every((ch, i) => head[at + i] === ch.charCodeAt(0));
  const magic =
    ascii(0, "ID3") || // mp3 带 ID3v2 头
    ascii(0, "OggS") || // ogg / opus
    ascii(0, "fLaC") || // flac
    (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) || // MPEG / ADTS 帧同步
    (ascii(0, "RIFF") && ascii(8, "WAVE")) || // wav
    ascii(4, "ftyp"); // mp4 / m4a：前 4 字节是 box 长度，不假设它一定是 0x18/0x20
  const looksText = /^\s*(<\?xml|<!DOCTYPE|<html|<HTML|\{|\[)/.test(asText);
  return { magic, looksText, head: hex.slice(0, 24) };
}

/** 真取音频：Range 前 64KB，断言 content-type 是音频、字节层也真是音频。这是"可用"的最终判据。 */
export async function probeAudio(url, { timeoutMs = 15000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: ctl.signal,
      headers: { "User-Agent": UA, Range: "bytes=0-65535", Accept: "*/*" },
    });
    const buf = await res.arrayBuffer();
    const ct = String(res.headers.get("content-type") || "");
    const sniff = sniffAudio(new Uint8Array(buf));
    return {
      status: res.status,
      bytes: buf.byteLength,
      contentType: ct,
      magic: sniff.magic,
      looksText: sniff.looksText,
      head: sniff.head,
      finalHost: (() => {
        try {
          return new URL(res.url || url).host;
        } catch {
          return "";
        }
      })(),
      playable: buf.byteLength > 8192 && !sniff.looksText && (sniff.magic || /^(audio|application\/octet-stream|video\/mp2a)/i.test(ct)),
    };
  } finally {
    clearTimeout(timer);
  }
}
