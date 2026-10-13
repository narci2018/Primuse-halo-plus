'use strict';
/**
 * 主进程 HTTP 客户端。
 *
 * 为什么所有网络请求都在主进程做：聚合线路里有明文 http 裸 IP
 * （`http://103.79.184.97/api/music/url`），渲染进程是 `file://` 页面，
 * 直连第三方域名既受 CSP 约束也拿不到对方没有的 CORS 头。iPhone 版靠
 * URLSession 直连（`AggregatedMusicService.swift:124-181`），这里等价物就
 * 是 Node 的 http/https，行为（超时、UA、重定向判定）按 Swift 逐条对齐。
 */

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');

/** Swift 侧搜索请求用的 UA（AggregatedMusicService.swift:126/151/164）。 */
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)';
/** 取音频流时用的 UA：这里是 Chromium 自己发请求的替身，带浏览器 UA 兼容性最好。 */
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0 Safari/537.36';

function pickAgent(parsed) {
  return parsed.protocol === 'https:' ? https : http;
}

function decodeBody(buffer, contentEncoding) {
  const enc = (contentEncoding || '').toLowerCase();
  try {
    if (enc === 'gzip') return zlib.gunzipSync(buffer);
    if (enc === 'deflate') return zlib.inflateSync(buffer);
    if (enc === 'br') return zlib.brotliDecompressSync(buffer);
  } catch {
    /* 有些 PHP 线路乱标 Content-Encoding，解不开就按原文 */
  }
  return buffer;
}

/**
 * @param {string} urlString
 * @param {{method?:string, headers?:Object, body?:string, timeoutMs?:number,
 *          maxRedirects?:number, insecureTLS?:boolean}} [options]
 * @returns {Promise<{statusCode:number, headers:Object, body:Buffer, text:string,
 *                    json:*, finalUrl:string, redirected:boolean}>}
 */
async function request(urlString, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body = null,
    timeoutMs = 8000,
    maxRedirects = 5,
    insecureTLS = false,
  } = options;

  let current = urlString;
  let redirected = false;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const parsed = new URL(current);
    const lib = pickAgent(parsed);

    const result = await new Promise((resolve, reject) => {
      const req = lib.request(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path: `${parsed.pathname}${parsed.search}`,
          method,
          headers: {
            'Accept-Encoding': 'gzip, deflate, br',
            ...headers,
          },
          ...(insecureTLS ? { rejectUnauthorized: false } : {}),
          timeout: timeoutMs,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode || 0,
              headers: res.headers || {},
              location: res.headers && res.headers.location,
              rawBody: Buffer.concat(chunks),
            });
          });
          res.on('error', reject);
        }
      );

      req.on('timeout', () => req.destroy(new Error(`timeout ${timeoutMs}ms: ${current}`)));
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });

    const isRedirect = [301, 302, 303, 307, 308].includes(result.statusCode) && result.location;

    if (isRedirect) {
      // 与 Swift 的判断一致：302 后的 URL 本身就是答案（例如 nxinxz 线路直接 302 到 mp3）。
      redirected = true;
      current = new URL(result.location, current).toString();
      continue;
    }

    const decoded = decodeBody(result.rawBody, result.headers['content-encoding']);
    const text = decoded.toString('utf8');
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return {
      statusCode: result.statusCode,
      headers: result.headers,
      body: decoded,
      text,
      json,
      finalUrl: current,
      redirected,
    };
  }

  throw new Error(`too many redirects: ${urlString}`);
}

/**
 * 把远端音频按 Range 透传到本地代理。返回 Node 可读流 + 上游响应信息。
 * 之所以要透传 Range：`<audio>` 拖进度就是靠 Range，而道理鱼的 `/download`
 * 必须带 `Authorization: Bearer`（`DaoLiYuSource.swift:259-262` 明确不给裸 URL）。
 */
function openStream(urlString, { headers = {}, insecureTLS = false, range = null } = {}) {
  const parsed = new URL(urlString);
  const lib = pickAgent(parsed);

  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        headers: {
          'User-Agent': DESKTOP_UA,
          ...(range ? { Range: range } : {}),
          ...headers,
        },
        ...(insecureTLS ? { rejectUnauthorized: false } : {}),
        timeout: 20000,
      },
      (res) => {
        // 跟随 3xx：音频 CDN 常常先 302 到真正的 mp3 主机
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          resolve(
            openStream(new URL(res.headers.location, urlString).toString(), {
              headers,
              insecureTLS,
              range,
            })
          );
          return;
        }
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers,
          stream: res,
          finalUrl: urlString,
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`stream timeout: ${urlString}`)));
    req.on('error', reject);
    req.end();
  });
}

function withUA(extra = {}) {
  return { 'User-Agent': IPHONE_UA, ...extra };
}

module.exports = { request, openStream, withUA, IPHONE_UA, DESKTOP_UA };
