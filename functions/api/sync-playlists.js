// Cloudflare Pages Functions: /api/sync-playlists
// 用于接收并持久化客户端（Primuse）上报的设备唯一标识（机器码）与歌单数据

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
  // POST 请求：上传并同步/备份歌单
  // ----------------------------------------------------
  if (request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ code: 400, error: "请求格式错误，必须为合法 JSON" }, 400);
    }

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

    // 统计歌单数量和歌曲总数
    const playlistCount = playlists.length;
    let songCount = 0;
    for (const pl of playlists) {
      if (Array.isArray(pl?.songs)) {
        songCount += pl.songs.length;
      } else if (Array.isArray(pl?.tracks)) {
        songCount += pl.tracks.length;
      }
    }

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

  return jsonResponse({ code: 405, error: "不支持的请求方法" }, 405);
}
