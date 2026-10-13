'use strict';
/**
 * 道理鱼（DaoLiYu）服务器型源 —— iPhone 版四个平台能播，靠的就是这一类源。
 *
 * 契约来源（逐字段对照，不许改字段名）：
 *   - 配置字段：primuse/Primuse/Services/Sources/DaoLiYuSource.swift:15-24
 *   - URL 拼装：primuse/PrimuseKit/Sources/PrimuseKit/Streaming/DaoLiYuAPIProtocol.swift:44-106
 *   - 登录/列表/详情/下载/歌词/封面 + 401 重登：同目录 DaoLiYuServiceClient.swift:321-570
 *
 * 注意两处与"随便写个 REST 客户端"不同的地方：
 *   1. 登录 body 同时带 `email` 和 `username`（值相同），响应取顶层 `token`（:528-552）。
 *   2. `/download` 必须带 `Authorization: Bearer`，Swift 侧在 iOS/macOS 上**不给裸 URL**
 *      （DaoLiYuSource.swift:259-262），因为播放器不会带自定义头。Windows 同理，
 *      所以播放一律经本地 127.0.0.1 代理透传 Range + 头（见 proxy.js）。
 */

const { request, openStream } = require('./httpx');

const PAGE_SIZE = 100; // DaoLiYuSource.swift:8

function originOf(config) {
  const scheme = config.useSSL ? 'https' : 'http';
  const host = String(config.host || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const port = config.port ? `:${config.port}` : '';
  const base = String(config.basePath || '').trim().replace(/^\/+|\/+$/g, '');
  return `${scheme}://${host}${port}${base ? `/${base}` : ''}`;
}

function apiURL(config, path, query) {
  const origin = originOf(config);
  const url = new URL(`${origin}/api${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

function nonempty(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return String(value);
  const s = String(value).trim();
  return s && s !== '<null>' && s !== 'null' ? s : null;
}

function lyricsText(value) {
  if (typeof value === 'string') return value.trim() ? value : null;
  if (value && typeof value === 'object') {
    return nonempty(value.content) || nonempty(value.text) || nonempty(value.lrc);
  }
  return null;
}

/** DaoLiYuTrack(json) —— DaoLiYuServiceClient.swift:68-133 */
function mapTrack(json, config) {
  const id = nonempty(json.id);
  if (!id) return null;

  const album = json.album && typeof json.album === 'object' ? json.album : null;
  const artist = json.artist && typeof json.artist === 'object' ? json.artist : null;
  const artists = Array.isArray(json.artists) ? json.artists : [];

  const artistName =
    nonempty(json.artistName) ||
    nonempty(json.artistLabel) ||
    nonempty(artist && artist.name) ||
    (artists.map((a) => nonempty(a && a.name)).filter(Boolean).join(', ') || null);

  const coverReference =
    nonempty(json.coverArtUrl) ||
    nonempty(json.coverArtPath) ||
    nonempty(album && album.coverArtUrl) ||
    nonempty(album && album.coverArtPath);

  const ext =
    [nonempty(json.fileFormat), nonempty(json.detectedContainer), nonempty(json.filePath)]
      .filter(Boolean)
      .map((v) => (v.includes('.') ? v.split('.').pop() : v).replace(/^\.+/, '').toLowerCase())
      .find((v) => v && !v.includes('/')) || '';

  return {
    kind: 'server',
    sourceID: config.id,
    sourceName: config.name || '道理鱼',
    id: `dly_${config.id}_${id}`,
    rawID: id,
    title: nonempty(json.title) || 'Unknown',
    artist: artistName || nonempty(json.albumArtist) || '',
    album: nonempty(json.albumTitle) || nonempty(album && album.title) || '',
    duration: Number(json.durationSeconds) || Number(json.duration) || 0,
    fileFormat: ext,
    fileSize: Number(json.fileSize) || 0,
    bitRate: Number(json.bitrate) || null,
    sampleRate: Number(json.sampleRate) || null,
    year: Number(json.year) || null,
    trackNumber: Number(json.trackNumber ?? json.track) || null,
    coverURL: coverURL(config, coverReference),
    hasSyncedLyrics: Boolean(lyricsText(json.lyricsSync)),
  };
}

/** DaoLiYuAPIProtocol.coverURL —— DaoLiYuAPIProtocol.swift:86-106 */
function coverURL(config, reference) {
  const ref = nonempty(reference);
  if (!ref) return null;
  if (/^https?:\/\//i.test(ref)) return ref;
  if (ref.startsWith('/api/')) return `${originOf(config)}${ref}`;
  return apiURL(config, '/cover', { path: ref });
}

class DaoLiYuClient {
  constructor(config) {
    this.config = config;
    this.token = null;
    this.loginPromise = null;
  }

  get insecureTLS() {
    return Boolean(this.config.insecureTLS);
  }

  /** POST /api/auth/login，body 三键（DaoLiYuServiceClient.swift:521-552） */
  async login() {
    if (this.loginPromise) return this.loginPromise;
    const url = apiURL(this.config, '/auth/login');
    const payload = JSON.stringify({
      email: this.config.username,
      username: this.config.username,
      password: this.config.password,
    });

    const task = (async () => {
      const res = await request(url, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: payload,
        timeoutMs: 10000,
        insecureTLS: this.insecureTLS,
      });
      const token = res.json && nonempty(res.json.token);
      if (!token) {
        const message = res.json && (nonempty(res.json.message) || nonempty(res.json.error));
        throw new Error(message ? `登录失败：${message}` : `登录失败：HTTP ${res.statusCode}`);
      }
      this.token = token;
      return token;
    })();

    this.loginPromise = task;
    try {
      return await task;
    } finally {
      this.loginPromise = null;
    }
  }

  authHeaders() {
    return { Accept: 'application/json', Authorization: `Bearer ${this.token}` };
  }

  /**
   * 401/403 判定与重试一次（DaoLiYuServiceClient.swift:568-570 + :400-403/474-480）
   * @param {(headers:Object)=>Promise<any>} run
   */
  async authorized(run) {
    if (!this.token) await this.login();
    let response = await run(this.authHeaders());
    if (response && (response.statusCode === 401 || response.statusCode === 403)) {
      this.token = null;
      await this.login();
      response = await run(this.authHeaders());
      if (response && (response.statusCode === 401 || response.statusCode === 403)) {
        throw new Error('服务器拒绝访问（401/403）：请检查用户名或密码');
      }
    }
    return response;
  }

  /** GET /api/tracks?skip&take（:321-346） */
  async listTracks(skip = 0, take = PAGE_SIZE) {
    const clamped = Math.max(1, Math.min(500, take));
    const url = apiURL(this.config, '/tracks', { skip, take: clamped });
    const res = await this.authorized((headers) =>
      request(url, { headers, timeoutMs: 15000, insecureTLS: this.insecureTLS })
    );
    if (res.statusCode !== 200) throw new Error(`曲目列表 HTTP ${res.statusCode}`);

    const rawItems = Array.isArray(res.json?.items)
      ? res.json.items
      : Array.isArray(res.json)
        ? res.json
        : [];
    return {
      items: rawItems.map((j) => mapTrack(j, this.config)).filter(Boolean),
      total: Number(res.json?.total) || 0,
      skip: Number(res.json?.skip ?? skip) || skip,
      take: clamped,
    };
  }

  /** GET /api/tracks/{id}，响应可能是 `{track:{...}}` 或直接是曲目对象（:350-354） */
  async trackDetail(rawID) {
    const url = apiURL(this.config, `/tracks/${encodeURIComponent(rawID)}`);
    const res = await this.authorized((headers) =>
      request(url, { headers, timeoutMs: 15000, insecureTLS: this.insecureTLS })
    );
    const json = res.json && res.json.track ? res.json.track : res.json;
    if (!json || typeof json !== 'object') return null;
    return {
      track: mapTrack(json, this.config),
      syncedLyrics: lyricsText(json.lyricsSync),
      plainLyrics: lyricsText(json.lyrics),
    };
  }

  downloadURL(rawID) {
    return apiURL(this.config, `/tracks/${encodeURIComponent(rawID)}/download`);
  }

  /** 供本地代理使用：带 Bearer + Range 打开上游音频流 */
  async openDownload(rawID, range) {
    const url = this.downloadURL(rawID);
    return this.authorized(async (headers) => {
      if (!headers.Authorization) await this.login();
      return openStream(url, {
        headers: { ...headers, 'Accept-Encoding': 'identity', ...(range ? { Range: range } : {}) },
        insecureTLS: this.insecureTLS,
      });
    });
  }

  /** 连通性自检：登录 + 拉一页，返回总数与样例 */
  async test() {
    await this.login();
    const page = await this.listTracks(0, 5);
    return { total: page.total, sample: page.items.slice(0, 5) };
  }
}

module.exports = { DaoLiYuClient, originOf, apiURL, mapTrack, coverURL, PAGE_SIZE };
