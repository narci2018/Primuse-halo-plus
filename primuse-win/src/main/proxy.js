'use strict';
/**
 * 本地 127.0.0.1 音频/图片代理。
 *
 * 为什么必须有它：
 *   1. 道理鱼的 `/download` 需要 `Authorization: Bearer`，而 `<audio>` 不会带自定义头
 *      —— Swift 侧同样因此不下发裸 URL，改走 `fetchRange`（DaoLiYuSource.swift:259-262）。
 *   2. 聚合线路含明文 http 裸 IP，渲染进程（file:// 页面）直连受 CSP/跨域限制；
 *      放在主进程请求就等价于 iPhone 的 URLSession 直连。
 *   3. 拖进度 = Range 请求，这里把 Range 透传给上游并原样回传 206/Content-Range。
 */

const http = require('http');
const { URL } = require('url');
const { openStream } = require('./httpx');

const COPY_REQUEST_HEADERS = ['range'];

function copyHeaders(upstream, res, extra = {}) {
  const out = {
    'Access-Control-Allow-Origin': '*',
    'Accept-Ranges': 'bytes',
    ...extra,
  };
  for (const name of ['content-type', 'content-length', 'content-range', 'cache-control']) {
    const value = upstream[name];
    if (value) out[name] = value;
  }
  if (!out['content-type']) out['content-type'] = 'audio/mpeg';
  return out;
}

function fail(res, code, message) {
  const body = JSON.stringify({ error: message });
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

/**
 * @param {{resolveAggregated:(platform:string, rawID:string, force:boolean)=>Promise<string>,
 *          daoliyuStream:(sourceID:string, rawID:string, range:string|null)=>Promise<any>,
 *          coverFetch:(url:string)=>Promise<any>}} handlers
 */
function startProxy(handlers) {
  const server = http.createServer((req, res) => {
    (async () => {
      const parsed = new URL(req.url, 'http://127.0.0.1');
      const parts = parsed.pathname.split('/').filter(Boolean);

      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Range, Content-Type',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        });
        res.end();
        return;
      }

      const range = req.headers.range || null;

      if (parts[0] === 'stream' && parts[1] === 'agg' && parts.length >= 4) {
        const platform = parts[2];
        const rawID = parts.slice(3).join('/');
        const force = parsed.searchParams.get('force') === '1';
        let target;
        try {
          target = await handlers.resolveAggregated(platform, rawID, force);
        } catch (error) {
          fail(res, 502, error.message || '线路解析失败');
          return;
        }
        const upstream = await openStream(target, { range });
        pipeTo(upstream, req, res);
        return;
      }

      if (parts[0] === 'stream' && parts[1] === 'dly' && parts.length >= 4) {
        const sourceID = parts[2];
        const rawID = parts.slice(3).join('/');
        let upstream;
        try {
          upstream = await handlers.daoliyuStream(sourceID, rawID, range);
        } catch (error) {
          fail(res, 502, error.message || '服务器源取流失败');
          return;
        }
        pipeTo(upstream, req, res);
        return;
      }

      if (parts[0] === 'img') {
        const target = parsed.searchParams.get('u');
        if (!target) {
          fail(res, 400, 'missing u');
          return;
        }
        const upstream = await handlers.coverFetch(target);
        pipeTo(upstream, req, res, { 'content-type': upstream.headers['content-type'] || 'image/jpeg' });
        return;
      }

      fail(res, 404, 'not found');
    })().catch((error) => {
      if (!res.headersSent) fail(res, 500, error.message || 'proxy error');
      else res.destroy();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function pipeTo(upstream, req, res, extra = {}) {
  const status = upstream.statusCode >= 400 && upstream.statusCode < 600 ? upstream.statusCode : upstream.statusCode === 206 ? 206 : upstream.statusCode || 200;
  res.writeHead(status, copyHeaders(upstream.headers, res, extra));

  if (req.method === 'HEAD') {
    upstream.stream.resume();
    upstream.stream.destroy();
    res.end();
    return;
  }

  upstream.stream.pipe(res);
  upstream.stream.on('error', () => res.destroy());
  res.on('close', () => upstream.stream.destroy());
}

module.exports = { startProxy, COPY_REQUEST_HEADERS };
