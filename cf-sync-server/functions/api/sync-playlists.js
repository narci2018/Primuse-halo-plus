// Cloudflare Pages Functions: /api/sync-playlists
// 用于接收并持久化客户端（Primuse）上报的设备唯一标识（机器码）与歌单数据
//
// 向下兼容是硬约束：iPhone / Mac / Windows 客户端都在按这里的字段解析，
// backup / copy / merge / delete 四条老路径的形状一个字节都不许变。
// 新增的 action=edit（后台"编辑歌单详情"）只多不改，且和音源写接口一样吃管理令牌门禁。

import { checkAdmin } from "../lib/common.js";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Device-ID",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      ...corsHeaders(),
    },
  });
}

function countSongs(playlists) {
  if (!Array.isArray(playlists)) return 0;
  let count = 0;
  for (const pl of playlists) {
    if (Array.isArray(pl?.songs)) {
      count += pl.songs.length;
    } else if (Array.isArray(pl?.tracks)) {
      count += pl.tracks.length;
    }
  }
  return count;
}

function mergePlaylists(targetPlaylists, sourcePlaylists) {
  const result = JSON.parse(JSON.stringify(targetPlaylists || []));
  for (const sPl of (sourcePlaylists || [])) {
    const existingPl = result.find((t) => (sPl.id && t.id === sPl.id) || (sPl.name && t.name === sPl.name));
    if (!existingPl) {
      result.push(sPl);
    } else {
      const existingSongs = existingPl.songs || existingPl.tracks || [];
      const sourceSongs = sPl.songs || sPl.tracks || [];
      const seen = new Set(existingSongs.map(songIdentityKey));

      for (const song of sourceSongs) {
        const key = songIdentityKey(song);
        if (!seen.has(key)) {
          seen.add(key);
          existingSongs.push(song);
        }
      }
      existingPl.songs = existingSongs;
      existingPl.updatedAt = Date.now();
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────
// 下面是 action=edit（后台编辑歌单详情）专用的工具，老路径一个都没用到。
//
// 身份为什么要单独解析一遍：客户端上传的一首歌里**没有**"平台""歌曲 id"这类字段，
// 形状只有 { id, title, artist, album, duration, filePath, sourceId }
// （iOS 的 SyncSongEntry、Windows 的 sync.js:toWireSong 都是这一套），
// 平台与歌曲 id 藏在 `agg_平台_歌曲id` / `/aggregated/平台/歌曲id.mp3` / `dly_源id_歌曲id`
// 这三条字符串里。所以后台改"平台 / 歌曲 ID / 音源类型"必须把 id、filePath、sourceId
// 一起重算回去 —— 只改裸字段的话，Windows 的 fromWireSong 和 Swift 的 song(fromWire:)
// 拉回去照样按老身份解析，等于改了个寂寞。
// 下面的解析顺序与那两个函数逐条对齐，不许漂。
// ─────────────────────────────────────────────────────────────────────────

/** 系统聚合源的 id，与客户端常量同一个字符串（AggregatedMusicService.systemSourceID）。 */
const AGGREGATED_SOURCE_ID = "system-aggregated-music";

/** 平台词表 = 客户端 AggregatedPlatform 的 rawValue，也是服务端 PLATFORMS 的键。 */
const EDITABLE_PLATFORMS = ["qq", "netease", "kugou", "kuwo", "migu", "bilibili", "custom"];

/** 身份片段（rawID / sourceID）允许的字符：不含空白与斜杠，最长 120。 */
const ID_PART_PATTERN = /^[^\s/]{1,120}$/;

const SONG_FIELD_KINDS = {
  title: "text",
  artist: "text",
  album: "text",
  coverURL: "text",
  sourceName: "text",
  duration: "number",
  kind: "kind",
  platform: "platform",
  rawID: "idpart",
  sourceID: "idpart",
};

/** 与 mergePlaylists 的去重键同一把键：合并认的"同一首歌"和编辑认的"这一行"不许长歪。 */
function songIdentityKey(s) {
  return s && s.id ? `id:${s.id}` : `m:${(s && s.title) || ""}__${(s && s.artist) || ""}`;
}

/** 从一首歌里读出 { kind, platform | sourceID, rawID }；认不出来源就按 custom 兜住。 */
function readSongIdentity(song) {
  const id = String((song && song.id) || "");
  const path = String((song && song.filePath) || "");

  let m = id.match(/^dly_(.+?)_(.+)$/);
  if (m) return { kind: "server", sourceID: m[1], rawID: m[2] };

  m = id.match(/^agg_([A-Za-z0-9]+)_(.+)$/);
  if (m) return { kind: "aggregated", platform: m[1].toLowerCase(), rawID: m[2] };

  m = path.match(/^\/aggregated\/([A-Za-z0-9]+)\/(.+?)\.[A-Za-z0-9]+$/);
  if (m) return { kind: "aggregated", platform: m[1].toLowerCase(), rawID: m[2] };

  m = path.match(/^\/server\/([^/]+)\/(.+)$/);
  if (m) return { kind: "server", sourceID: m[1], rawID: m[2] };

  // 最后才看裸字段：换源工具写回过的备份里确实带 platform/rawID，两种形状都得认。
  const kind = String((song && song.kind) || "").toLowerCase() === "server" ? "server" : "aggregated";
  return {
    kind,
    platform: kind === "aggregated" ? String((song && song.platform) || "custom").toLowerCase() : undefined,
    sourceID: kind === "server" ? String((song && (song.sourceID || song.sourceId)) || "") : undefined,
    rawID: String((song && song.rawID) || id),
  };
}

/** 把身份写回三种客户端都认的形状（id + filePath + sourceId，裸字段同时留着给后台/工具看）。 */
function writeSongIdentity(song, ident) {
  if (ident.kind === "server") {
    // 与另一半身份互斥的裸字段必须删掉：服务器源行上留着旧的 platform，
    // 换源工具（platformOf 先读 s.platform）和后台就会把同一行读成两种意思。
    delete song.platform;
    song.kind = "server";
    song.sourceID = ident.sourceID;
    song.rawID = ident.rawID;
    song.id = `dly_${ident.sourceID}_${ident.rawID}`;
    song.filePath = `/server/${ident.sourceID}/${ident.rawID}`;
    song.sourceId = ident.sourceID;
    return;
  }
  delete song.sourceID;
  song.kind = "aggregated";
  song.platform = ident.platform;
  song.rawID = ident.rawID;
  song.id = `agg_${ident.platform}_${ident.rawID}`;
  song.filePath = `/aggregated/${ident.platform}/${ident.rawID}.mp3`;
  song.sourceId = AGGREGATED_SOURCE_ID;
}

/**
 * 一首歌 + 一组字段 → 就地改，返回真正变了的字段名数组。
 * 校验不过抛 EditValidationError（调用方转 400），绝不静默跳过：
 * 后台点了"保存"就必须知道哪一行没改成、为什么没改成。
 */
function applySongPatch(song, fields, label) {
  const ident = readSongIdentity(song);
  const next = { ...ident };
  const changed = [];

  for (const [name, rawValue] of Object.entries(fields || {})) {
    const kindOf = SONG_FIELD_KINDS[name];
    if (!kindOf) {
      throw new EditValidationError(`${label}：不支持修改的字段「${name}」（可改：${Object.keys(SONG_FIELD_KINDS).join("、")}）`);
    }

    if (kindOf === "number") {
      const blank = rawValue === null || rawValue === undefined || rawValue === "";
      const n = blank ? 0 : Number(rawValue);
      if (!blank && (!Number.isFinite(n) || n < 0 || n > 86400)) {
        throw new EditValidationError(`${label}：时长「${rawValue}」不是 0–86400 之间的秒数`);
      }
      const value = blank ? null : Math.round(n);
      if (Number(song.duration) !== Number(value)) {
        song.duration = value;
        changed.push(name);
      }
      continue;
    }

    const value = String(rawValue === null || rawValue === undefined ? "" : rawValue).trim();

    if (kindOf === "text") {
      if (name === "title" && !value) throw new EditValidationError(`${label}：曲名不能改成空`);
      if (value.length > 240) throw new EditValidationError(`${label}：「${name}」超过 240 字符`);
      const prev = song[name] === null || song[name] === undefined ? "" : String(song[name]);
      if (prev === value) continue;
      song[name] = value === "" ? null : value;
      changed.push(name);
      continue;
    }

    if (kindOf === "kind") {
      const k = value.toLowerCase();
      if (k !== "aggregated" && k !== "server") {
        throw new EditValidationError(`${label}：音源类型只能是 aggregated（在线线路）或 server（自建服务器源），收到「${value}」`);
      }
      if (next.kind !== k) {
        next.kind = k;
        changed.push("kind");
      }
      continue;
    }

    if (kindOf === "platform") {
      const p = value.toLowerCase();
      if (!EDITABLE_PLATFORMS.includes(p)) {
        throw new EditValidationError(`${label}：平台「${value}」不认识（可用：${EDITABLE_PLATFORMS.join("、")}）`);
      }
      if (next.platform !== p) {
        next.platform = p;
        changed.push("platform");
      }
      continue;
    }

    // idpart：rawID / sourceID —— 动到身份，最后统一重算 id 与 filePath。
    if (!ID_PART_PATTERN.test(value)) {
      throw new EditValidationError(`${label}：「${name}」必须是 1–120 个非空白、不含斜杠的字符，收到「${rawValue}」`);
    }
    if (next[name] !== value) {
      next[name] = value;
      changed.push(name);
    }
  }

  const identityDirty = changed.includes("kind") || changed.includes("platform") || changed.includes("rawID") || changed.includes("sourceID");
  if (identityDirty) {
    if (next.kind === "server") {
      if (!next.sourceID) throw new EditValidationError(`${label}：切成自建服务器源必须同时给出源 ID（sourceID）`);
      if (!next.rawID) throw new EditValidationError(`${label}：切成自建服务器源必须同时给出歌曲 ID（rawID）`);
    } else {
      if (!next.platform) next.platform = "custom";
      if (!next.rawID) throw new EditValidationError(`${label}：在线线路必须有歌曲 ID（rawID），否则客户端无法解析直链`);
    }
    writeSongIdentity(song, next);
  }

  return changed;
}

class EditValidationError extends Error {}

export async function onRequest({ request, env }) {
  // 处理跨域预检请求
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  if (!env?.DB) {
    return jsonResponse(
      { code: 500, error: "D1 数据库未绑定 (env.DB is undefined)。请在 Cloudflare Pages 设置中绑定 D1 数据库为 DB" },
      500
    );
  }

  // 确保数据表存在（容错自动建表）
  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS device_playlists (
        device_id TEXT PRIMARY KEY,
        device_name TEXT,
        platform TEXT,
        playlists_json TEXT NOT NULL,
        playlist_count INTEGER DEFAULT 0,
        song_count INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `).run();
  } catch (err) {
    console.warn("Auto-create table error:", err);
  }

  const url = new URL(request.url);

  // ----------------------------------------------------
  // GET 请求：拉取歌单或查询设备列表
  // ----------------------------------------------------
  if (request.method === "GET") {
    const deviceId = url.searchParams.get("deviceId") || url.searchParams.get("device_id");
    const playlistId = url.searchParams.get("playlistId") || url.searchParams.get("playlist_id");

    if (deviceId) {
      try {
        const row = await env.DB.prepare(
          "SELECT device_id, device_name, platform, playlists_json, playlist_count, song_count, created_at, updated_at FROM device_playlists WHERE device_id = ?"
        ).bind(deviceId.trim()).first();

        if (!row) {
          return jsonResponse({ code: 404, message: "未找到该设备的歌单备份数据", data: null }, 404);
        }

        let playlists = [];
        try {
          playlists = JSON.parse(row.playlists_json);
        } catch {
          playlists = [];
        }

        if (playlistId) {
          const matched = playlists.find((p) => p.id === playlistId || p.name === playlistId);
          if (!matched) {
            return jsonResponse({ code: 404, message: "未找到指定歌单", data: null }, 404);
          }
          return jsonResponse({
            code: 0,
            message: "获取歌单详情成功",
            data: {
              deviceId: row.device_id,
              deviceName: row.device_name || "未知设备",
              playlist: matched,
            },
          });
        }

        return jsonResponse({
          code: 0,
          message: "获取成功",
          data: {
            deviceId: row.device_id,
            deviceName: row.device_name || "未知设备",
            platform: row.platform || "Apple",
            playlistCount: row.playlist_count,
            songCount: row.song_count,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            playlists,
          },
        });
      } catch (error) {
        return jsonResponse({ code: 500, error: error.message || "读取歌单失败" }, 500);
      }
    } else {
      // 查询所有已备份设备概览列表
      try {
        const rows = await env.DB.prepare(
          "SELECT device_id, device_name, platform, playlist_count, song_count, updated_at, created_at FROM device_playlists ORDER BY updated_at DESC LIMIT 50"
        ).all();

        return jsonResponse({
          code: 0,
          message: "获取设备列表成功",
          data: {
            devices: rows?.results || [],
          },
        });
      } catch (error) {
        return jsonResponse({ code: 500, error: error.message || "读取设备列表失败" }, 500);
      }
    }
  }

  // ----------------------------------------------------
  // POST 请求：上传备份、跨设备复制歌单、跨设备合并歌单、删除设备
  // ----------------------------------------------------
  if (request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ code: 400, error: "请求格式错误，必须为合法 JSON" }, 400);
    }

    const action = String(url.searchParams.get("action") || body.action || "backup").trim().toLowerCase();

    // 1. 跨设备复制歌单 (Copy Playlists: Source -> Target)
    if (action === "copy") {
      const sourceDeviceId = String(body.sourceDeviceId || body.source_device_id || "").trim();
      const targetDeviceId = String(body.targetDeviceId || body.target_device_id || "").trim();
      const targetDeviceName = String(body.targetDeviceName || body.target_device_name || "").trim();

      if (!sourceDeviceId || !targetDeviceId) {
        return jsonResponse({ code: 400, error: "缺少必需参数：sourceDeviceId 或 targetDeviceId" }, 400);
      }
      if (sourceDeviceId === targetDeviceId) {
        return jsonResponse({ code: 400, error: "源设备和目标设备不能相同" }, 400);
      }

      try {
        const sourceRow = await env.DB.prepare(
          "SELECT * FROM device_playlists WHERE device_id = ?"
        ).bind(sourceDeviceId).first();

        if (!sourceRow) {
          return jsonResponse({ code: 404, error: `未找到源设备 [${sourceDeviceId}] 的数据` }, 404);
        }

        const targetRow = await env.DB.prepare(
          "SELECT * FROM device_playlists WHERE device_id = ?"
        ).bind(targetDeviceId).first();

        const finalTargetName = targetDeviceName || targetRow?.device_name || `副本 - ${sourceRow.device_name || "设备"}`;
        const finalPlatform = targetRow?.platform || sourceRow.platform || "iOS/macOS";
        const now = Date.now();

        await env.DB.prepare(`
          INSERT INTO device_playlists (device_id, device_name, platform, playlists_json, playlist_count, song_count, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(device_id) DO UPDATE SET
            device_name = excluded.device_name,
            platform = excluded.platform,
            playlists_json = excluded.playlists_json,
            playlist_count = excluded.playlist_count,
            song_count = excluded.song_count,
            updated_at = excluded.updated_at
        `).bind(
          targetDeviceId,
          finalTargetName,
          finalPlatform,
          sourceRow.playlists_json,
          sourceRow.playlist_count,
          sourceRow.song_count,
          targetRow?.created_at || now,
          now
        ).run();

        return jsonResponse({
          code: 0,
          message: "跨设备复制歌单成功",
          data: {
            sourceDeviceId,
            targetDeviceId,
            targetDeviceName: finalTargetName,
            playlistCount: sourceRow.playlist_count,
            songCount: sourceRow.song_count,
            updatedAt: now,
          },
        });
      } catch (error) {
        return jsonResponse({ code: 500, error: error.message || "复制歌单失败" }, 500);
      }
    }

    // 2. 跨设备合并歌单 (Merge Playlists: Source + Target -> Target)
    if (action === "merge") {
      const sourceDeviceId = String(body.sourceDeviceId || body.source_device_id || "").trim();
      const targetDeviceId = String(body.targetDeviceId || body.target_device_id || "").trim();

      if (!sourceDeviceId || !targetDeviceId) {
        return jsonResponse({ code: 400, error: "缺少必需参数：sourceDeviceId 或 targetDeviceId" }, 400);
      }
      if (sourceDeviceId === targetDeviceId) {
        return jsonResponse({ code: 400, error: "源设备和目标设备不能相同" }, 400);
      }

      try {
        const sourceRow = await env.DB.prepare(
          "SELECT * FROM device_playlists WHERE device_id = ?"
        ).bind(sourceDeviceId).first();
        if (!sourceRow) {
          return jsonResponse({ code: 404, error: `未找到源设备 [${sourceDeviceId}] 的数据` }, 404);
        }

        const targetRow = await env.DB.prepare(
          "SELECT * FROM device_playlists WHERE device_id = ?"
        ).bind(targetDeviceId).first();
        if (!targetRow) {
          return jsonResponse({ code: 404, error: `未找到目标设备 [${targetDeviceId}] 的数据` }, 404);
        }

        let sourcePlaylists = [];
        let targetPlaylists = [];
        try { sourcePlaylists = JSON.parse(sourceRow.playlists_json); } catch { sourcePlaylists = []; }
        try { targetPlaylists = JSON.parse(targetRow.playlists_json); } catch { targetPlaylists = []; }

        const mergedPlaylists = mergePlaylists(targetPlaylists, sourcePlaylists);
        const mergedPlaylistCount = mergedPlaylists.length;
        const mergedSongCount = countSongs(mergedPlaylists);
        const now = Date.now();

        await env.DB.prepare(`
          UPDATE device_playlists SET
            playlists_json = ?,
            playlist_count = ?,
            song_count = ?,
            updated_at = ?
          WHERE device_id = ?
        `).bind(
          JSON.stringify(mergedPlaylists),
          mergedPlaylistCount,
          mergedSongCount,
          now,
          targetDeviceId
        ).run();

        return jsonResponse({
          code: 0,
          message: "跨设备合并歌单成功",
          data: {
            sourceDeviceId,
            targetDeviceId,
            playlistCount: mergedPlaylistCount,
            songCount: mergedSongCount,
            updatedAt: now,
          },
        });
      } catch (error) {
        return jsonResponse({ code: 500, error: error.message || "合并歌单失败" }, 500);
      }
    }

    // 3. 编辑单个歌单里的歌曲 (Edit: 删除选中 / 修改选中)
    if (action === "edit") {
      const gate = checkAdmin(request, env);
      if (!gate.ok) return gate.response;

      const deviceId = String(body.deviceId || body.device_id || "").trim();
      const playlistRef = String(body.playlistId || body.playlist_id || body.playlistName || "").trim();
      if (!deviceId) return jsonResponse({ code: 400, error: "缺少必需参数：deviceId" }, 400);
      if (!playlistRef) return jsonResponse({ code: 400, error: "缺少必需参数：playlistId（歌单 id 或歌单名）" }, 400);

      const edits = body.edits === undefined ? [] : body.edits;
      const deleteIndexes = body.deleteSongIndexes === undefined ? [] : body.deleteSongIndexes;
      const deleteKeys = body.deleteSongKeys === undefined ? [] : body.deleteSongKeys;
      if (!Array.isArray(edits) || !Array.isArray(deleteIndexes) || !Array.isArray(deleteKeys)) {
        return jsonResponse({ code: 400, error: "edits / deleteSongIndexes / deleteSongKeys 必须是数组" }, 400);
      }
      if (!edits.length && !deleteIndexes.length && !deleteKeys.length) {
        return jsonResponse({ code: 400, error: "没有要提交的内容：edits、deleteSongIndexes、deleteSongKeys 至少给一个" }, 400);
      }
      if (edits.length > 500 || deleteIndexes.length + deleteKeys.length > 2000) {
        return jsonResponse({ code: 400, error: "单次上限 500 条补丁、2000 行删除，请分批提交" }, 400);
      }

      try {
        const row = await env.DB.prepare(
          "SELECT device_id, device_name, platform, playlists_json, playlist_count, song_count, updated_at FROM device_playlists WHERE device_id = ?"
        ).bind(deviceId).first();

        if (!row) {
          return jsonResponse({ code: 404, error: `未找到设备 [${deviceId}] 的歌单备份数据` }, 404);
        }

        // 乐观并发：设备随时可能"上传备份"把整行覆盖掉。改在人家新备份之前 = 把他的改动吃掉，
        // 所以后台必须带着自己看到的那个 updated_at 来，对不上就让人重新打开。
        const expected = body.expectedUpdatedAt;
        if (expected !== undefined && expected !== null && expected !== "") {
          if (Number(expected) !== Number(row.updated_at)) {
            return jsonResponse({
              code: 409,
              error: "云端歌单在你打开编辑之后又变了（多半是这台设备刚上传过一次备份）。关掉编辑窗口重新打开，按最新数据再改一次。",
              data: { updatedAt: Number(row.updated_at) || 0, expectedUpdatedAt: Number(expected) || 0 },
            }, 409);
          }
        }

        let playlists = [];
        try {
          playlists = JSON.parse(row.playlists_json);
        } catch {
          playlists = [];
        }
        if (!Array.isArray(playlists)) playlists = [];

        const plIndex = playlists.findIndex(
          (p) => String((p && p.id) || "") === playlistRef || String((p && p.name) || "") === playlistRef
        );
        if (plIndex < 0) {
          return jsonResponse({ code: 404, error: `设备 [${deviceId}] 上没有歌单「${playlistRef}」` }, 404);
        }

        const pl = playlists[plIndex];
        // 曲目键与 GET/copy/merge 同一套读法（songs 优先、tracks 兜底），写回也写回同一个键，
        // 免得改完多出并存的第二份曲目数组。
        const songsKey = Array.isArray(pl.songs) ? "songs" : Array.isArray(pl.tracks) ? "tracks" : null;
        if (!songsKey) {
          return jsonResponse({ code: 400, error: `歌单「${pl.name || playlistRef}」里没有曲目数组（songs/tracks 都不是数组），不敢改写` }, 400);
        }
        const songs = pl[songsKey];

        // 命中的行下标（去重、升序）。下标一律按**打开编辑时**的顺序算，所以必须先改后删：
        // 改不改变顺序，删会 —— 顺序反了就会删错行。
        // required=false 只给"删除"那一组用：只改不删是完全合法的提交，没选中就是删 0 行；
        // 而补丁条目一条目标都没定位到，是提交方写错了，必须报错而不是静默通过。
        const resolveRows = (indexes, keys, label, required = true) => {
          const hit = new Set();
          for (const raw of indexes || []) {
            const i = Number(raw);
            if (!Number.isInteger(i) || i < 0 || i >= songs.length) {
              throw new EditValidationError(
                `${label}：下标 ${raw} 超出范围（这首歌单现在 ${songs.length} 行，合法下标 0–${Math.max(songs.length - 1, 0)}）`
              );
            }
            hit.add(i);
          }
          for (const raw of keys || []) {
            const key = String(raw);
            const found = songs.findIndex((s) => songIdentityKey(s) === key);
            if (found < 0) {
              throw new EditValidationError(`${label}：没找到曲目键「${key}」，云端数据可能已经变了，重新打开编辑再试`);
            }
            hit.add(found);
          }
          if (required && !hit.size) throw new EditValidationError(`${label}：没有选中任何歌曲`);
          return [...hit].sort((a, b) => a - b);
        };

        const patchedRows = new Set();
        for (let n = 0; n < edits.length; n += 1) {
          const edit = edits[n];
          const label = `第 ${n + 1} 条修改`;
          if (!edit || typeof edit !== "object") throw new EditValidationError(`${label}必须是对象`);
          if (!edit.fields || typeof edit.fields !== "object" || Array.isArray(edit.fields)) {
            throw new EditValidationError(`${label}：缺 fields（要改的字段对象）`);
          }
          const rows = resolveRows(edit.songIndexes, edit.songKeys, label);
          for (const i of rows) {
            const changed = applySongPatch(songs[i], edit.fields, `${label} 第 ${i + 1} 行`);
            if (changed.length) patchedRows.add(i);
          }
        }

        const removed = resolveRows(deleteIndexes, deleteKeys, "删除", false);
        const removeSet = new Set(removed);
        pl[songsKey] = songs.filter((_, i) => !removeSet.has(i));
        pl.updatedAt = Date.now();
        playlists[plIndex] = pl;

        const playlistsJson = JSON.stringify(playlists);
        const songCount = countSongs(playlists);
        const playlistCount = playlists.length;
        const now = Date.now();

        await env.DB.prepare(
          "UPDATE device_playlists SET playlists_json = ?, playlist_count = ?, song_count = ?, updated_at = ? WHERE device_id = ?"
        ).bind(playlistsJson, playlistCount, songCount, now, deviceId).run();

        return jsonResponse({
          code: 0,
          message: "歌单已更新",
          data: {
            deviceId,
            playlistId: pl.id || pl.name,
            playlistName: pl.name || playlistRef,
            removedCount: removeSet.size,
            patchedCount: patchedRows.size,
            remainingSongCount: pl[songsKey].length,
            playlistCount,
            songCount,
            updatedAt: now,
            bytes: playlistsJson.length,
          },
        });
      } catch (error) {
        if (error instanceof EditValidationError) {
          return jsonResponse({ code: 400, error: error.message }, 400);
        }
        return jsonResponse({ code: 500, error: error.message || "编辑歌单失败" }, 500);
      }
    }

    // 4. 删除设备记录 (Delete)
    if (action === "delete") {
      const deviceId = String(body.deviceId || body.device_id || "").trim();
      if (!deviceId) {
        return jsonResponse({ code: 400, error: "缺少必需参数：deviceId" }, 400);
      }
      try {
        await env.DB.prepare("DELETE FROM device_playlists WHERE device_id = ?").bind(deviceId).run();
        return jsonResponse({ code: 0, message: "删除成功", data: { deviceId } });
      } catch (error) {
        return jsonResponse({ code: 500, error: error.message || "删除失败" }, 500);
      }
    }

    // 5. 普通歌单上传备份 (Backup)
    const deviceId = String(body.deviceId || body.device_id || "").trim();
    if (!deviceId) {
      return jsonResponse({ code: 400, error: "缺少必需字段：deviceId (设备唯一标识/机器码)" }, 400);
    }

    const deviceName = String(body.deviceName || body.device_name || "").trim() || "Apple Device";
    const platform = String(body.platform || "iOS/macOS").trim();
    const playlists = body.playlists;

    if (!Array.isArray(playlists)) {
      return jsonResponse({ code: 400, error: "缺少必需字段：playlists (歌单数据数组)" }, 400);
    }

    const playlistCount = playlists.length;
    const songCount = countSongs(playlists);
    const playlistsJson = JSON.stringify(playlists);
    const now = Date.now();

    try {
      await env.DB.prepare(`
        INSERT INTO device_playlists (device_id, device_name, platform, playlists_json, playlist_count, song_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET
          device_name = excluded.device_name,
          platform = excluded.platform,
          playlists_json = excluded.playlists_json,
          playlist_count = excluded.playlist_count,
          song_count = excluded.song_count,
          updated_at = excluded.updated_at
      `).bind(deviceId, deviceName, platform, playlistsJson, playlistCount, songCount, now, now).run();

      return jsonResponse({
        code: 0,
        message: "歌单同步备份成功",
        data: {
          deviceId,
          deviceName,
          platform,
          playlistCount,
          songCount,
          updatedAt: now,
        },
      });
    } catch (error) {
      return jsonResponse({ code: 500, error: error.message || "写入数据库失败" }, 500);
    }
  }

  // DELETE 请求直接支持删除设备
  if (request.method === "DELETE") {
    const deviceId = url.searchParams.get("deviceId") || url.searchParams.get("device_id");
    if (!deviceId) {
      return jsonResponse({ code: 400, error: "缺少必需参数：deviceId" }, 400);
    }
    try {
      await env.DB.prepare("DELETE FROM device_playlists WHERE device_id = ?").bind(deviceId.trim()).run();
      return jsonResponse({ code: 0, message: "删除成功", data: { deviceId } });
    } catch (error) {
      return jsonResponse({ code: 500, error: error.message || "删除失败" }, 500);
    }
  }

  return jsonResponse({ code: 405, error: "不支持的请求方法" }, 405);
}
