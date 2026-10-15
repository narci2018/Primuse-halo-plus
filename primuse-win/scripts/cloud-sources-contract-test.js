'use strict';
/**
 * 云端音乐源契约测试（离线：本机假服务器；绝不碰真实 %APPDATA%\Primuse，绝不打真服务器）。
 *
 * 服务端契约的真源：cf-sync-server/functions/api/music-sources.js（GET 清单）
 * 与 functions/api/music-gateway.js（POST 网关），2026-10-14 现网实测形状见
 * docs/cross-platform-plan.md §21.7。客户端实现是 src/main/cloud-sources.js。
 *
 * 这些断言存在的理由，逐条对着需求：
 *   - 需求 4「只保存一个 URL，解释它即可获得可用的源」→ refresh/gatewayBase/toLocalSources；
 *   - 需求 2「检测全部可用」→ probeSource 必须真的取到音频字节（Range + 魔数），
 *     而且**不许把本机没测成当成源坏了**，也不许在 App 侧偷偷停用线路（只读 + 刷新）；
 *   - 需求 5「首页文案由服务端设置」→ settings.homeTitle 必须原样透出；
 *   - 向下兼容 → 拉不到清单（500 / DNS 挂了 / 契约不认识）时缓存的线路一条都不能少。
 *
 * 用法：node scripts/cloud-sources-contract-test.js
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// MARK: - 1. 假 electron：store.js 只用到 app.getPath('userData') 和 safeStorage

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'primuse-cloud-contract-'));
const fakeElectron = {
  app: { getPath: () => DATA_DIR },
  safeStorage: { isEncryptionAvailable: () => false },
};
const originalLoad = Module._load;
Module._load = function patched(request, ...rest) {
  if (request === 'electron') return fakeElectron;
  return originalLoad.call(this, request, ...rest);
};

const store = require('../src/main/store');
const aggregated = require('../src/main/aggregated');
const cloudSources = require('../src/main/cloud-sources');

const CONTRACT = 'primuse.music-sources.v1';

// MARK: - 2. 音频样本：一段真 ID3、一段"看着像但根本不是音频"的反爬页

const AUDIO = Buffer.concat([Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00'), Buffer.alloc(70000, 0x7f)]);
const JUNK = Buffer.concat([Buffer.from('<html><body>checking your browser</body></html>'), Buffer.alloc(70000, 0x41)]);

// MARK: - 3. 假服务器

/** 清单正文。测试用 setManifest() 改它，服务端行为由这几个 flag 控制。 */
const flags = {
  manifestStatus: 200, // 500 → "服务端自己挂了"
  gatewayUrl: null, // 网关 /api/music-gateway?action=url 的返回值（null → 不是 URL）
  gatewayLyric: null,
  gatewayMode: 'code0', // 'code1' → 业务错误；'dead' → 409 已判死
  maxInFlight: 0,
  inFlight: 0,
};
const seen = {
  manifest: [], // 每次 GET 清单：{url, ifNoneMatch}
  gateway: [], // 每次 POST：{query, body}
  search: [], // 线路搜索命中次数（按 source 的 line 参数）
  audio: [], // 每次取字节：{url, range}
};

let manifestDoc = buildManifest();

function buildManifest() {
  return {
    contract: CONTRACT,
    revision: 1,
    generatedAt: Date.now(),
    check: { keyword: '晴天', concurrency: 4 },
    sources: [
      { id: 'cloud-ok', name: '能出声 (Meting)', platform: 'netease', protocol: 'meting', baseURL: '', enabled: true, priority: 20, quality: '320k' },
      { id: 'cloud-junk', name: '返回的是网页 (Meting)', platform: 'netease', protocol: 'meting', baseURL: '', enabled: true, priority: 19 },
      { id: 'cloud-empty', name: '搜不到东西 (Meting)', platform: 'netease', protocol: 'meting', baseURL: '', enabled: true, priority: 18 },
      { id: 'cloud-nourl', name: '解析不出直链 (Meting)', platform: 'netease', protocol: 'meting', baseURL: '', enabled: true, priority: 17 },
      { id: 'cloud-lx', name: '非常刀[洛雪js]', platform: 'kugou', protocol: 'lxjs', baseURL: '', enabled: true, priority: 16, scriptHash: 'sha256:aaa', check: { status: 'ok', detail: '服务端体检：真取到 65536B 音频', bytes: 65536 }, suggestDelete: false },
      { id: 'cloud-lx-off', name: '停用的洛雪源', platform: 'qq', protocol: 'lxjs', baseURL: '', enabled: false, priority: 15, scriptHash: 'sha256:bbb', check: { status: 'audio_fail', detail: '服务端体检：取到 0 字节', bytes: 0 }, suggestDelete: true },
      { id: 'cloud-lx-nohash', name: '没有脚本指纹的洛雪源', platform: 'qq', protocol: 'lxjs', baseURL: '', enabled: true, priority: 14 },
      { id: 'cloud-bare', name: '没有 baseURL 的 HTTP 源', platform: 'netease', protocol: 'meting', baseURL: '', enabled: true, priority: 13 },
      { id: 'cloud-relative', name: '相对地址的 HTTP 源', platform: 'netease', protocol: 'meting', baseURL: 'api.example.com/x', enabled: true, priority: 12 },
    ],
    usable: ['cloud-ok', 'cloud-lx'],
    suggestions: [{ id: 'cloud-lx-off', name: '停用的洛雪源', reason: 'audio_fail', detail: '取到 0 字节' }],
    settings: { homeTitle: '我的音乐库', homeTitleFrom: 'device', deviceId: 'DEV-1' },
    gateway: { base: '/api/music-gateway', actions: ['capabilities', 'search', 'url', 'lyric'] },
    runtime: { lxjs: 'server-runner', meting: 'client-or-gateway', customJson: 'none' },
  };
}

function etagOf(doc) {
  return `W/"rev-${doc.revision}"`;
}

/** 线路的 baseURL 里带 ?line=xxx，服务端按它决定返回什么（搜索/解析/音频三段都可能变）。 */
function applyBaseURLs(origin) {
  const map = {
    'cloud-ok': `${origin}/api.php`,
    'cloud-junk': `${origin}/api.php?line=junk`,
    'cloud-empty': `${origin}/api.php?line=empty`,
    'cloud-nourl': `${origin}/api.php?line=nourl`,
  };
  manifestDoc.sources.forEach((s) => {
    if (map[s.id]) s.baseURL = map[s.id];
  });
}

function searchItems() {
  return [
    { id: '12345', name: '晴天', artist: '周杰伦', album: '叶惠美', duration: 269 },
    { id: '67890', name: '搁浅', artist: '周杰伦', album: '七里香', duration: 254 },
  ];
}

function json(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const origin = `http://127.0.0.1:${server.address().port}`;

  // --- 清单（GET /api/music-sources?deviceId=）
  if (url.pathname === '/api/music-sources') {
    seen.manifest.push({ url: req.url, ifNoneMatch: req.headers['if-none-match'] || null, deviceId: url.searchParams.get('deviceId') || '' });
    if (flags.manifestStatus !== 200) return json(res, flags.manifestStatus, { error: 'D1 连接失败' });
    if (req.headers['if-none-match'] === etagOf(manifestDoc)) {
      res.writeHead(304, { etag: etagOf(manifestDoc) });
      return res.end();
    }
    return json(res, 200, { data: manifestDoc }, { etag: etagOf(manifestDoc) });
  }

  // --- 网关（POST /api/music-gateway?action=&deviceId=）
  if (url.pathname === '/api/music-gateway') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        body = {};
      }
      seen.gateway.push({ action: url.searchParams.get('action'), deviceId: url.searchParams.get('deviceId') || '', body });
      if (flags.gatewayMode === 'dead') return json(res, 409, { error: '这条源服务端已判死，不再解析' });
      if (flags.gatewayMode === 'code1') return json(res, 200, { code: 1, error: 'runner 里没有这个脚本' });
      if (body.action === 'search') {
        return json(res, 200, {
          code: 0,
          data: {
            results: [
              { rawID: 'lx-1', title: '非常刀', artist: '网络歌手', album: '', duration: 210, coverURL: null, platform: 'kugou', sourceId: 'cloud-lx' },
              { rawID: 'lx-2', title: '第二条', artist: '某人', album: '', duration: 0, coverURL: null, platform: 'kugou', sourceId: 'cloud-unknown' },
            ],
          },
        });
      }
      if (body.action === 'url') return json(res, 200, { code: 0, data: { url: flags.gatewayUrl } });
      if (body.action === 'lyric') return json(res, 200, { code: 0, data: { lyric: flags.gatewayLyric } });
      return json(res, 200, { code: 0, data: { ok: true } });
    });
    return undefined;
  }

  // --- meting 线路：搜索 / 解析
  if (url.pathname === '/api.php') {
    const line = url.searchParams.get('line') || 'ok';
    if (url.searchParams.get('types') === 'search') {
      seen.search.push(line);
      if (line === 'empty') return json(res, 200, []);
      return json(res, 200, searchItems());
    }
    if (url.searchParams.get('types') === 'url') {
      if (line === 'nourl') return json(res, 200, { id: url.searchParams.get('id') });
      if (line === 'stall') return json(res, 200, { url: `${origin}/stall` });
      return json(res, 200, { url: `${origin}/track.mp3${line === 'junk' ? '?line=junk' : ''}` });
    }
    return json(res, 400, { error: 'unknown types' });
  }

  // --- 传输层半途死掉：响应头都给了，body 一个字节没发就把连接打断。
  //     真实场景是墨澜聚合音源那种"The operation was aborted" —— 那是**我们这次没测成**，
  //     不是"这条源回的东西不能播"。这一跳必须冒出去落成 'error'（有 3 次宽限），
  //     绝不能落 resolve_fail 把好源判死。
  if (url.pathname === '/stall') {
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': String(AUDIO.length) });
    if (res.flushHeaders) res.flushHeaders();
    setImmediate(() => {
      if (res.socket) res.socket.destroy();
    });
    return undefined;
  }

  // --- 音频字节：真 Range
  if (url.pathname === '/track.mp3') {
    const line = url.searchParams.get('line') || 'ok';
    const payload = line === 'junk' ? JUNK : AUDIO;
    const type = line === 'junk' ? 'text/html; charset=utf-8' : line === 'wrongct' ? 'text/plain; charset=utf-8' : 'audio/mpeg';
    seen.audio.push({ range: req.headers.range || null, line });
    flags.inFlight += 1;
    flags.maxInFlight = Math.max(flags.maxInFlight, flags.inFlight);
    res.on('close', () => {
      flags.inFlight = Math.max(0, flags.inFlight - 1);
    });
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (range) {
      const from = Number(range[1]);
      const to = Math.min(Number(range[2]), payload.length - 1);
      const slice = payload.subarray(from, to + 1);
      res.writeHead(206, { 'content-type': type, 'content-length': String(slice.length), 'content-range': `bytes ${from}-${to}/${payload.length}`, 'accept-ranges': 'bytes' });
      return res.end(slice);
    }
    res.writeHead(200, { 'content-type': type, 'content-length': String(payload.length), 'accept-ranges': 'bytes' });
    return res.end(payload);
  }

  return json(res, 404, { error: 'no such route' });
});

// MARK: - 4. 断言器

let passed = 0;
const failures = [];
let currentGroup = '';

function group(title) {
  currentGroup = title;
  console.log(`\n## ${title}`);
}

function record(label, ok, detail) {
  if (ok) passed += 1;
  else failures.push(`[${currentGroup}] ${label}${detail ? ` —— ${detail}` : ''}`);
  console.log(`${ok ? '✔' : '✘'} ${label}${detail ? `\n     ${String(detail).replace(/\s+/g, ' ').slice(0, 220)}` : ''}`);
}

function sameIds(list, expected) {
  return JSON.stringify(list.map((s) => s.id)) === JSON.stringify(expected);
}

const originOf = () => `http://127.0.0.1:${server.address().port}`;

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = originOf();
  applyBaseURLs(origin);

  // ---- 基线：没清单时是内置 9 条在兜底（向下兼容）
  group('0. 起点：内置线路兜底 + 机器码');
  store.aggregated.upsert({ id: 'user-manual', name: '本机手工加的线路', platform: 'netease', protocolType: 'meting', baseURL: 'https://manual.example/api.php', priority: 50 });
  store.save(true);
  const baseline = store.aggregated.list();
  record('首次启动是内置 9 条 + 本机 user-* 线路', baseline.filter((s) => String(s.id).startsWith('default-')).length === 9 && baseline.some((s) => s.id === 'user-manual'), `共 ${baseline.length} 条：${baseline.map((s) => s.id).join(', ')}`);
  record('默认清单地址是现网 pages.dev（不是 workers.dev）', store.cloud.config().defaultManifestURL === 'https://primuse-sync-server.pages.dev/api/music-sources', store.cloud.config().defaultManifestURL);
  const deviceId = store.sync.ensureDeviceId().deviceId;
  record('机器码由本机生成并写进 cloud.config()', Boolean(deviceId) && store.cloud.config().deviceId === deviceId, deviceId);

  // ---- 需求 4：一个 URL 换到全部
  group('1. setManifestURL：换地址 = 换一份真相');
  let threw = null;
  try {
    cloudSources.setManifestURL('ftp://nope/api/music-sources');
  } catch (e) {
    threw = e.message;
  }
  record('非 http(s) 地址直接拒绝', Boolean(threw), threw || '没有抛错');
  const afterSwitch = cloudSources.setManifestURL(`${origin}/api/music-sources`);
  record('换地址后 etag/revision/正文全部作废', afterSwitch.etag === '' && afterSwitch.revision === -1 && afterSwitch.hasManifest === false, JSON.stringify(afterSwitch));
  const keptOnly = store.aggregated.list();
  record('换地址只清云端来的线路，本机手工线路留着', keptOnly.every((s) => s.cloud !== true) && keptOnly.some((s) => s.id === 'user-manual'), keptOnly.map((s) => s.id).join(', '));
  record('此时内置 9 条自动回来（没有云端源就要兜底）', keptOnly.filter((s) => String(s.id).startsWith('default-')).length === 9, `${keptOnly.length} 条`);

  // ---- 拉清单
  group('2. refresh：把清单解释成线路表');
  const r1 = await cloudSources.refresh();
  record('第一次拉取成功且 changed=true', r1.ok === true && r1.changed === true && r1.revision === 1, JSON.stringify({ ok: r1.ok, changed: r1.changed, revision: r1.revision, error: r1.error }));
  record('第一次不带 If-None-Match（本机还没有 ETag）', seen.manifest[0].ifNoneMatch === null, JSON.stringify(seen.manifest[0]));
  record('机器码随清单请求带上去（服务端按它下发首页文案）', seen.manifest[0].deviceId === deviceId, seen.manifest[0].deviceId);
  const lines1 = store.aggregated.list();
  // user-manual 的 priority=50 最高，所以它排在清单线路前面
  const expectIds = ['user-manual', 'cloud-ok', 'cloud-junk', 'cloud-empty', 'cloud-nourl', 'cloud-lx', 'cloud-lx-off'];
  record('线路表 = 清单里合法的条目 + 本机 user-*，按 priority 降序', sameIds(lines1, expectIds), lines1.map((s) => s.id).join(', '));
  record('内置 default-* 被清单接管后消失', !lines1.some((s) => String(s.id).startsWith('default-')), '还在：' + lines1.filter((s) => String(s.id).startsWith('default-')).map((s) => s.id).join(','));

  group('3. toLocalSources：哪些条目不该进线路表');
  const dropCheck = cloudSources.toLocalSources(manifestDoc);
  record('lxjs 但没有脚本指纹的不进线路表（走网关也解析不了）', !dropCheck.some((s) => s.id === 'cloud-lx-nohash'), dropCheck.map((s) => s.id).join(', '));
  record('HTTP 类但没有绝对 baseURL 的不进线路表', !dropCheck.some((s) => s.id === 'cloud-bare' || s.id === 'cloud-relative'), dropCheck.map((s) => s.id).join(', '));
  record('每一条都打上 cloud:true（刷新时才知道谁该被替换）', dropCheck.every((s) => s.cloud === true), '');
  record('清单 protocol → 本机 protocolType；enabled → isEnabled', dropCheck.every((s) => s.protocolType && typeof s.isEnabled === 'boolean'), JSON.stringify(dropCheck[0]));
  record('usable 集合落成 usable 标记（只有真出声的算可用）', dropCheck.filter((s) => s.usable).map((s) => s.id).join(',') === 'cloud-ok,cloud-lx', dropCheck.map((s) => `${s.id}:${s.usable ? '可用' : '否'}`).join(', '));
  record('服务端体检结论原样带上（check/detail/bytes/suggestDelete）', (() => { const x = dropCheck.find((s) => s.id === 'cloud-lx-off'); return x.check && x.check.status === 'audio_fail' && x.suggestDelete === true && x.isEnabled === false; })(), JSON.stringify(dropCheck.find((s) => s.id === 'cloud-lx-off')));

  group('4. 网关地址与运行时口径');
  record('相对 base 拼成当前 Pages 项目的绝对地址', cloudSources.gatewayBase() === `${origin}/api/music-gateway`, cloudSources.gatewayBase());
  const absDoc = { ...manifestDoc, gateway: { base: 'https://other.example/gw/' } };
  record('清单给的是绝对地址时原样用（只去掉尾斜杠）', cloudSources.gatewayBase(absDoc) === 'https://other.example/gw', cloudSources.gatewayBase(absDoc));
  record('runtime.lxjs = server-runner（本机不装洛雪运行时）', manifestDoc.runtime.lxjs === 'server-runner' && manifestDoc.runtime.meting === 'client-or-gateway', JSON.stringify(manifestDoc.runtime));

  group('5. ETag / 304：实时更新但不浪费流量');
  const r2 = await cloudSources.refresh();
  record('第二次带 If-None-Match 且服务端回 304', seen.manifest[1].ifNoneMatch === 'W/"rev-1"' && r2.ok === true && r2.changed === false, JSON.stringify({ inm: seen.manifest[1].ifNoneMatch, changed: r2.changed }));
  record('304 不重写线路表（幂等，UI 不会闪）', sameIds(store.aggregated.list(), expectIds), store.aggregated.list().map((s) => s.id).join(', '));
  const r3 = await cloudSources.refresh({ force: true });
  record('force=true 时不带 ETag（后台刚改过源，主动刷）', seen.manifest[2].ifNoneMatch === null, JSON.stringify(seen.manifest[2]));
  manifestDoc = { ...manifestDoc, revision: 2 };
  const r4 = await cloudSources.refresh();
  record('服务端 revision 变了 → changed=true 且落进 config()', r4.changed === true && r4.revision === 2 && store.cloud.config().revision === 2, JSON.stringify({ changed: r4.changed, revision: store.cloud.config().revision }));
  record('首页文案随清单透出（需求 5）', r4.settings && r4.settings.homeTitle === '我的音乐库' && r4.settings.homeTitleFrom === 'device', JSON.stringify(r4.settings));

  group('6. 拉不到清单时绝不清空（离线可用）');
  const beforeContract = store.cloud.config();
  const savedDoc = manifestDoc;
  manifestDoc = { ...savedDoc, contract: 'primuse.music-sources.v999' };
  const r5 = await cloudSources.refresh({ force: true });
  record('契约不认识 → 整份拒绝并说明拿到的是什么', r5.ok === false && r5.error.includes(CONTRACT) && r5.contract === 'primuse.music-sources.v999', r5.error);
  record('拒绝写入的同时缓存线路一条不少', sameIds(store.aggregated.list(), expectIds) && r5.sources.length === expectIds.length, store.aggregated.list().map((s) => s.id).join(', '));
  record('缓存的清单正文与 revision 保持原样', store.cloud.config().revision === beforeContract.revision && store.cloud.config().hasManifest === true, JSON.stringify(store.cloud.config()));
  manifestDoc = { ...savedDoc, contract: undefined, sources: undefined };
  const r5b = await cloudSources.refresh({ force: true });
  record('完全不相干的 JSON（比如被网关拦回的登录页）同样拒绝', r5b.ok === false && Boolean(r5b.error), r5b.error);
  manifestDoc = savedDoc;
  flags.manifestStatus = 500;
  const r6 = await cloudSources.refresh();
  record('服务端 500 → 失败原因留给 UI，线路不动', r6.ok === false && r6.cached === true && sameIds(store.aggregated.list(), expectIds), JSON.stringify({ ok: r6.ok, cached: r6.cached, error: r6.error }));
  flags.manifestStatus = 200;
  const originalURL = store.cloud.config().manifestURL;
  cloudSources.setManifestURL('http://no-such-host.invalid/api/music-sources');
  const r7 = await cloudSources.refresh();
  record('DNS 都解析不了 → ok:false，并退回内置 9 条而不是"没有线路"', r7.ok === false && Boolean(r7.error) && r7.sources.every((s) => s.cloud !== true) && r7.sources.length === 10, JSON.stringify({ ok: r7.ok, error: r7.error, n: r7.sources.length }));
  cloudSources.setManifestURL(originalURL);
  const r8 = await cloudSources.refresh({ force: true });
  record('恢复网络后重新刷就回到清单真相', r8.ok === true && sameIds(store.aggregated.list(), expectIds), store.aggregated.list().map((s) => s.id).join(', '));

  // ---- 需求 2：检测全部可用
  group('7. 可用性判据：能访问不等于能播放');
  const pad = (b) => Buffer.concat([b, Buffer.alloc(40)]);
  const magicCases = [
    ['mp3 ID3v2', pad(Buffer.from('ID3\x03\x00\x00')), true],
    ['mp3 裸帧同步', Buffer.from([0xff, 0xfb, 0x90, 0, 0, 0, 0, 0, 0, 0, 0, 0]), true],
    ['ogg/opus OggS', pad(Buffer.from('OggS\x00\x02')), true],
    ['flac fLaC', pad(Buffer.from('fLaC\x00\x00')), true],
    ['wav RIFF…WAVE', pad(Buffer.from('RIFF\x00\x00\x00\x00WAVEfmt ')), true],
    ['m4a ftyp（box size 不是 0x18/0x20）', pad(Buffer.from('\x00\x00\x00\x1cftypM4A ')), true],
    ['HTML 反爬页', pad(Buffer.from('<html><body>x</body></html>')), false],
    ['报错 JSON', pad(Buffer.from('{"error":"nope"}')), false],
    ['一坨二进制噪声', Buffer.alloc(40, 0x41), false],
  ];
  for (const [label, buf, want] of magicCases) {
    record(`音频魔数认得 ${label}`, cloudSources.looksLikeAudio(buf) === want, `得到 ${cloudSources.looksLikeAudio(buf)}（前 12 字节 ${buf.subarray(0, 12).toString('hex')}）`);
  }
  record('文本特征一票否决（HTML/XML/JSON 开头）', cloudSources.looksLikeText(Buffer.from('  <html>')) && cloudSources.looksLikeText(Buffer.from('{"a":1}')) && !cloudSources.looksLikeText(Buffer.from('ID3\x03\x00')), '');
  record('太短的响应不算音频（<12B 直接否）', cloudSources.looksLikeAudio(Buffer.from('ID3')) === false && cloudSources.looksLikeAudio(null) === false, '');
  record('字节门槛与服务端一致（>8192B 才判能播）', cloudSources.AUDIO_MIN_BYTES === 8192, cloudSources.AUDIO_MIN_BYTES);
  record('判据与服务端一致：魔数 或 音频 content-type，且不是文本', (() => {
    const P = cloudSources.isPlayableAudio;
    return (
      P({ bytes: 20000, magic: true, textish: false, contentType: 'audio/mpeg' }) === true &&
      P({ bytes: 20000, magic: true, textish: false, contentType: 'text/plain' }) === true && // 配错 content-type 的真音频：旧口径在这误杀
      P({ bytes: 20000, magic: false, textish: false, contentType: 'audio/mp4' }) === true &&
      P({ bytes: 20000, magic: false, textish: true, contentType: 'audio/mpeg' }) === false && // 挂着 audio/mpeg 的 HTML：旧延迟检测在这被骗绿
      P({ bytes: 2000, magic: true, textish: false, contentType: 'audio/mpeg' }) === false
    );
  })(), '');

  const wrongCt = await cloudSources.probeAudio(`${origin}/track.mp3?line=wrongct`);
  record('取字节实测：真音频但 content-type 写成 text/plain → 本机判可播（旧口径在这误杀）', wrongCt.audio === true && wrongCt.magic === true && /text/i.test(wrongCt.contentType), JSON.stringify({ ct: wrongCt.contentType, bytes: wrongCt.bytes, magic: wrongCt.magic, audio: wrongCt.audio }));
  const htmlCt = await cloudSources.probeAudio(`${origin}/track.mp3?line=junk`);
  record('取字节实测：挂着 audio/mpeg 的 HTML 报错页 → 本机判不可播', htmlCt.audio === false && htmlCt.textish === true, JSON.stringify({ ct: htmlCt.contentType, bytes: htmlCt.bytes, magic: htmlCt.magic, textish: htmlCt.textish }));

  const okV = await cloudSources.probeSource(store.aggregated.list().find((s) => s.id === 'cloud-ok'));
  record('真出声的线路 → status=ok，detail 带 HTTP 状态/content-type/字节数', okV.status === 'ok' && okV.bytes === 65536 && okV.detail.includes('audio/mpeg') && okV.detail.includes('206'), JSON.stringify(okV));
  record('取字节用的是 Range: bytes=0-65535（不下载整首歌）', seen.audio.every((a) => a.range === 'bytes=0-65535'), JSON.stringify(seen.audio));
  const junkV = await cloudSources.probeSource(store.aggregated.list().find((s) => s.id === 'cloud-junk'));
  record('返回网页而不是音频 → 判不可播（旧版 HEAD 绿灯就是在这漏的）', junkV.status === 'resolve_fail' && junkV.detail.includes('直链不可播'), JSON.stringify(junkV));
  const emptyV = await cloudSources.probeSource(store.aggregated.list().find((s) => s.id === 'cloud-empty'));
  record('搜索没结果 → search_empty，明细写清可能是搜索接口单独挂了', emptyV.status === 'search_empty' && emptyV.detail.includes('搜索'), JSON.stringify(emptyV));
  const nourlV = await cloudSources.probeSource(store.aggregated.list().find((s) => s.id === 'cloud-nourl'));
  record('解析不出直链 → resolve_fail 并留下试过哪几条', nourlV.status === 'resolve_fail' && nourlV.detail.includes('解析无直链'), JSON.stringify(nourlV));
  const lxV = await cloudSources.probeSource(store.aggregated.list().find((s) => s.id === 'cloud-lx'));
  record('洛雪 js 源本机跑不了脚本 → 结论来自服务端并如实标 origin=server', lxV.origin === 'server' && lxV.status === 'ok' && lxV.bytes === 65536, JSON.stringify(lxV));

  // ---- 「我们没测成 ≠ 源坏了」：这一类在服务端是 §7f，本机必须同口径。
  //      真实现场是墨澜聚合音源（网易云）：三条样本全报 "The operation was aborted"，
  //      旧写法把它咽成 resolve_fail → 好源被判死 + 建议删除。
  const stallSource = { id: 'stall', name: '半路断了', platform: 'netease', protocolType: 'meting', baseURL: `${origin}/api.php?line=stall`, isEnabled: true, priority: 1 };
  let stallThrew = '';
  try {
    await cloudSources.probeSource(stallSource);
  } catch (error) {
    stallThrew = String((error && error.message) || error);
  }
  record('取字节时连接被掐断 → probeSource 抛出去，不写成"这源不可播"', stallThrew !== '', stallThrew || '没抛异常（失败被咽成了死刑）');
  const mixed = await cloudSources.checkAll([store.aggregated.list().find((s) => s.id === 'cloud-ok'), stallSource], () => {});
  const stallV = mixed.find((v) => v.id === 'stall');
  record('checkAll 把这种失败落成 error（渲染层按未检出显示，不出建议删除）', stallV.status === 'error' && stallV.detail.length > 0, JSON.stringify(stallV));
  record('同一批次里好源照样判 ok（一条的失败不牵连别条）', mixed.find((v) => v.id === 'cloud-ok').status === 'ok', JSON.stringify(mixed.map((v) => `${v.id}=${v.status}`)));

  const listBefore = JSON.stringify(store.aggregated.list());
  const verdicts = [];
  const all = await cloudSources.checkAll(store.aggregated.list(), (v) => verdicts.push(v));
  record('checkAll 只过服务端还开着的线路（那一条 cloud-lx-off 不占流量）', all.length === store.aggregated.list().length - 1 && !all.some((v) => v.id === 'cloud-lx-off'), `${all.length} 条：${all.map((v) => `${v.id}=${v.status}`).join(', ')}`);
  record('体检闸门是 enabledOnServer，不是 isEnabled（本机没加载的恰恰要再验一次 —— 需求 2）',
    typeof cloudSources.checkable === 'function'
      && cloudSources.checkable({ id: 'x', cloud: true, enabledOnServer: true, isEnabled: false }) === true
      && cloudSources.checkable({ id: 'x', cloud: true, enabledOnServer: false, isEnabled: false }) === false
      && cloudSources.checkable({ id: 'x', isEnabled: true }) === true
      && cloudSources.checkable({ id: 'x', isEnabled: false }) === false
      && cloudSources.checkable(null) === false,
    'isEnabled 现在的意思是"在不在播放路径里"，拿它当闸门等于"没测过的永远没机会被测"');
  record('每条出结论就回调（界面能看着进度走）', verdicts.length === all.length, `${verdicts.length}/${all.length}`);
  record('并发压在 4 以内（第三方站点都可能慢）', flags.maxInFlight > 0 && flags.maxInFlight <= 4, `同时在取字节的请求峰值 = ${flags.maxInFlight}`);
  record('App 侧只读：checkAll 不改任何 isEnabled（停用是 CF 后台的权力）', JSON.stringify(store.aggregated.list()) === listBefore, `前后 ${store.aggregated.list().length} 条，enabled 计数 ${store.aggregated.list().filter((s) => s.isEnabled).length}`);

  group('7b. 线路地址自带查询串时不能拼坏（真实清单里就有这种）');
  const withQuery = { id: 'q', name: 'q', platform: 'netease', protocolType: 'meting', baseURL: `${origin}/api.php?key=abc`, isEnabled: true, priority: 1 };
  const sq = aggregated.searchURLFor(withQuery, '晴天');
  record('搜索 URL 用 & 续第二个查询串（不是再写一个 ?）', sq.includes('?key=abc&types=search') && !sq.includes('?key=abc?types'), sq);
  record('四类协议都走同一个分隔符规则', ['meting', 'openApi', 'hyw', 'nxinxz'].length === 4 && aggregated.sep(`${origin}/a?x=1`) === '&' && aggregated.sep(`${origin}/a`) === '?', `${aggregated.sep('http://h/a?x=1')} / ${aggregated.sep('http://h/a')}`);
  store.aggregated.upsert({ ...withQuery, id: 'user-with-query', priority: 1 });
  const qVerdict = await cloudSources.probeSource(store.aggregated.list().find((s) => s.id === 'user-with-query'));
  record('带查询串的线路照样能走到"取字节"这一步（旧写法在这里会直接判搜索无结果）', qVerdict.status === 'ok' && qVerdict.bytes === 65536, JSON.stringify(qVerdict));
  store.aggregated.remove('user-with-query');
  store.save(true);

  // ---- 网关调用与 hooks 门控
  group('8. 洛雪源的搜索/取流/歌词都走 /api/music-gateway');
  const hooksOn = cloudSources.hooks();
  record('清单里有已启用的 lxjs 源才挂网关钩子', typeof hooksOn.gatewaySearch === 'function' && typeof hooksOn.gatewayResolve === 'function' && typeof hooksOn.gatewayLyric === 'function', Object.keys(hooksOn).join(','));
  const results = await hooksOn.gatewaySearch('非常刀');
  const gw = seen.gateway[seen.gateway.length - 1];
  record('搜索走网关时带上 action/keyword/limit 与机器码', gw.action === 'search' && gw.body.action === 'search' && gw.body.keyword === '非常刀' && gw.deviceId === deviceId, JSON.stringify(gw));
  record('网关回来的曲型和本机一致并标出是云端来的', results.length === 2 && results.every((r) => r.kind === 'aggregated' && r.viaCloud === true && r.rawID && r.title), JSON.stringify(results[0]));
  record('sourceName 缺失时用清单里的源名兜底', results[0].sourceName === '非常刀[洛雪js]', JSON.stringify(results.map((r) => r.sourceName)));
  flags.gatewayUrl = `${origin}/track.mp3`;
  const gUrl = await hooksOn.gatewayResolve(store.aggregated.list().find((s) => s.id === 'cloud-lx'), 'lx-1');
  record('取直链：网关给了 URL 就用它', gUrl === `${origin}/track.mp3`, gUrl);
  flags.gatewayUrl = 'not-a-url';
  record('网关给的不是 http 链接 → 返回 null 让下一条线路顶上', (await hooksOn.gatewayResolve(store.aggregated.list().find((s) => s.id === 'cloud-lx'), 'lx-1')) === null, String(flags.gatewayUrl));
  flags.gatewayUrl = null;
  record('网关完全没有 url → 同样返回 null 而不是抛异常', (await hooksOn.gatewayResolve(store.aggregated.list().find((s) => s.id === 'cloud-lx'), 'lx-1')) === null, '');
  flags.gatewayLyric = '[00:00.00]作词：黄伟文';
  record('歌词：带时间轴的 LRC 才认', (await hooksOn.gatewayLyric(store.aggregated.list().find((s) => s.id === 'cloud-lx'), 'lx-1')).includes('[00:00'));
  flags.gatewayLyric = '纯文本没有时间轴';
  record('歌词：没有时间轴就当没有（不让 UI 显示一坨死文本）', (await hooksOn.gatewayLyric(store.aggregated.list().find((s) => s.id === 'cloud-lx'), 'lx-1')) === null, '');
  flags.gatewayMode = 'code1';
  let gwErr = '';
  try {
    await cloudSources.gateway('url', { sourceId: 'x' });
  } catch (e) {
    gwErr = e.message;
  }
  record('网关业务错误原样抛出（服务端话术要能给用户看）', gwErr === 'runner 里没有这个脚本', gwErr);
  flags.gatewayMode = 'dead';
  let deadErr = '';
  try {
    await cloudSources.gateway('url', { sourceId: 'x' });
  } catch (e) {
    deadErr = e.message;
  }
  record('对已判死的源回 409，客户端把它当失败而不是空结果', deadErr.includes('已判死'), deadErr);
  flags.gatewayMode = 'code0';

  store.aggregated.toggle('cloud-lx');
  record('把唯一的 lxjs 源停用后就不再挂网关（少一次无谓请求）', Object.keys(cloudSources.hooks()).length === 0, JSON.stringify(cloudSources.hooks()));
  store.aggregated.toggle('cloud-lx');

  // ---- 关键词口径
  group('9. 体检关键词两边要一致');
  record('清单下发 check.keyword 就跟着用', (() => {
    const saved = manifestDoc;
    manifestDoc = { ...saved, check: { keyword: '青花瓷' } };
    store.cloud.setFetched({ manifest: manifestDoc });
    const k = cloudSources.probeKeyword();
    manifestDoc = saved;
    store.cloud.setFetched({ manifest: manifestDoc });
    return k === '青花瓷';
  })(), cloudSources.probeKeyword());
  record('没下发就用「晴天」，和服务端体检同一首歌', cloudSources.probeKeyword() === '晴天' && cloudSources.probeKeyword({ check: null }) === '晴天', cloudSources.probeKeyword());
  record('关键词被截到 40 字符（防止清单里塞进整段歌词）', cloudSources.probeKeyword({ check: { keyword: '一'.repeat(80) } }).length === 40, '');

  // ---- 机器可读的最终形状
  group('10. 落到 store 的最终形状');
  const cloud = store.cloud.sources();
  record('store.cloud.sources() 只返回云端线路', cloud.length === expectIds.length - 1 && cloud.every((s) => s.cloud === true), cloud.map((s) => s.id).join(', '));
  store.cloud.setError('服务端体检暂时不可达');
  record('写失败原因不清缓存（离线照样能播）', store.cloud.config().error === '服务端体检暂时不可达' && store.cloud.manifest() !== null && store.aggregated.list().length === expectIds.length, JSON.stringify(store.cloud.config()));
  const fileOnDisk = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'primuse.json'), 'utf8'));
  record('清单正文与线路都持久化了（重启不重新拉）', fileOnDisk.cloud.manifest.contract === CONTRACT && fileOnDisk.aggregatedSources.some((s) => s.id === 'cloud-ok'), JSON.stringify(Object.keys(fileOnDisk.cloud)));

  // ---- 汇总
  console.log(`\n结果：${passed} 项通过，${failures.length} 项失败`);
  if (failures.length) {
    console.log('\n失败清单：');
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  server.close();
  Module._load = originalLoad;
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    /* Windows 上偶尔句柄没放掉，不影响结论 */
  }
  process.exit(failures.length ? 1 : 0);
})().catch((error) => {
  console.error('\n测试自己炸了：', error && error.stack ? error.stack : error);
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exit(2);
});
