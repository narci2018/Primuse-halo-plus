// 公共层：响应信封、CORS、令牌门禁、粗限流。
//
// 为什么单独建一份而不是改 sync-playlists.js：那个端点已经在现网跑着，iPhone 和
// Windows 客户端都在按它的字段解析，**一个字节都不许动**（向下兼容是硬约束）。
// 这里的信封格式刻意与它保持一致：{ code, message?, error?, data? }，code 0 = 成功。

export function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Device-ID",
    "Access-Control-Max-Age": "86400",
  };
}

export function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      ...corsHeaders(),
      ...extraHeaders,
    },
  });
}

export function ok(data, message = "ok", extraHeaders = {}) {
  return jsonResponse({ code: 0, message, data }, 200, extraHeaders);
}

export function fail(code, error, status = 400) {
  return jsonResponse({ code, error }, status);
}

/**
 * 写接口门禁。
 *
 * 现网的 /api/sync-playlists 是 `CORS: *` + 无鉴权，任何人都能 POST —— 歌单数据被乱写
 * 已经是既有风险，但"音源清单"一旦被陌生人改掉，全站用户的播放都会被带偏，
 * 所以写接口一律要求 Bearer 令牌；**没配令牌就直接拒绝写操作（fail closed）**，
 * 绝不能因为漏配而变成"谁都能改"。
 */
export function checkAdmin(request, env) {
  const secret = env && env.SOURCES_ADMIN_TOKEN;
  if (!secret) {
    return {
      ok: false,
      response: fail(503, "服务端未配置 SOURCES_ADMIN_TOKEN，音源写接口已禁用（请在 Cloudflare Pages 后台设置该环境变量后重试）", 503),
    };
  }
  const header = String(request.headers.get("Authorization") || "");
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const raw = header.trim();
  if (!bearer || (bearer !== secret && raw !== secret)) {
    return { ok: false, response: fail(401, "管理令牌无效或缺失（写接口需要 Authorization: Bearer <SOURCES_ADMIN_TOKEN>）", 401) };
  }
  return { ok: true };
}

/**
 * 网关限流（只读接口也要限：不然这个 Worker 会被当成免费的第三方解析代理刷爆）。
 * 用 isolate 内存计数，不追求严格，够用即可；超配额返回 429。
 */
const buckets = new Map();

export function rateLimit(request, limit = 120, windowMs = 60000) {
  const ip = String(request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "local").split(",")[0].trim();
  const now = Date.now();
  const key = `${ip}|${Math.floor(now / windowMs)}`;
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (now - v.start > windowMs * 2) buckets.delete(k);
  }
  let b = buckets.get(key);
  if (!b) {
    b = { count: 0, start: now };
    buckets.set(key, b);
  }
  b.count += 1;
  if (b.count > limit) {
    return { ok: false, response: fail(429, `请求过于频繁（每 ${Math.round(windowMs / 1000)} 秒上限 ${limit} 次）`, 429) };
  }
  return { ok: true };
}

export function deviceIdOf(request, envOrBody) {
  const url = new URL(request.url);
  return String(
    url.searchParams.get("deviceId") ||
      url.searchParams.get("device_id") ||
      request.headers.get("X-Device-ID") ||
      (envOrBody && (envOrBody.deviceId || envOrBody.device_id)) ||
      ""
  ).trim();
}
