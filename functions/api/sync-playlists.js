// Cloudflare Pages Functions: /api/sync-playlists
// 用于接收并持久化客户端（Primuse）上报的设备唯一标识（机器码）与歌单数据

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
      const songKey = (s) => (s.id ? `id:${s.id}` : `m:${s.title || ""}__${s.artist || ""}`);
      const seen = new Set(existingSongs.map(songKey));

      for (const song of sourceSongs) {
        const key = songKey(song);
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

    // 3. 删除设备记录 (Delete)
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

    // 4. 普通歌单上传备份 (Backup)
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
