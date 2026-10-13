'use strict';
/**
 * 道理鱼契约测试 —— 用一个假服务器验证客户端的每一条 HTTP 行为，
 * 不需要用户给出真实地址（也不该把他的账号拿来试）。
 *
 * 断言依据（Swift 侧的既有事实，逐条对照）：
 *   1. 登录 body 同时带 email / username / password      —— DaoLiYuServiceClient.swift:528-535
 *   2. 响应取顶层 token，之后 Authorization: Bearer       —— :510 / :552
 *   3. 列表 GET /api/tracks?skip&take，take 上限 500      —— :321-331
 *   4. 401/403 触发"清 token → 重登 → 只重试一次"          —— :400-403 / :474-480 / :568-570
 *   5. 详情取 track 字段或顶层，歌词 lyricsSync 优先       —— :350-368
 *   6. 封面绝对 URL / /api/ 原样，其他走 /api/cover?path=  —— DaoLiYuAPIProtocol.swift:86-106
 *   7. /download 必须带 Bearer 且支持 Range（206）         —— DaoLiYuSource.swift:259-262 + :370-419
 *
 * 用法：node primuse-win/scripts/daoliyu-contract-test.js
 */

const http = require('http');
const assert = require('assert');
const { DaoLiYuClient } = require('../src/main/daoliyu');

const TOKEN_A = 'token-A';
const TOKEN_B = 'token-B';

const state = {
  logins: 0,
  lastLoginBody: null,
  acceptToken: TOKEN_A,
  downloadRequests: [],
  coverRequests: [],
};

const AUDIO = Buffer.concat([Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00'), Buffer.alloc(70000, 0x7f)]);

const TRACKS = [
  {
    id: 't1',
    title: '晴天',
    artist: { id: 'a1', name: '周杰伦' },
    album: { id: 'al1', title: '叶惠美', coverArtPath: 'covers/al1.jpg' },
    durationSeconds: 265.4,
    fileFormat: 'mp3',
    bitrate: 320,
    coverArtPath: 'covers/t1.jpg',
    lyricsSync: { content: '[00:01.00]故事的小黄花\n[00:05.00]从出生那年就飘着' },
    lyrics: '纯文本歌词',
  },
  { id: 't2', title: '稻香', artistName: '周杰伦', albumTitle: '魔杰座', duration: 223, fileFormat: 'flac', lyrics: '[00:02.00]对这个世界如果你有太多的抱怨' },
  { id: 't3', title: 'No Lyrics', album: { coverArtUrl: '/api/cover?path=direct.png' }, fileFormat: 'm4a' },
];

function authorized(req) {
  return String(req.headers.authorization || '') === `Bearer ${state.acceptToken}`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');

  const json = (code, value) => {
    const body = JSON.stringify(value);
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(body);
  };

  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      state.logins += 1;
      state.lastLoginBody = JSON.parse(raw || '{}');
      if (state.lastLoginBody.username !== 'primuse@test' || state.lastLoginBody.password !== 'secret') {
        return json(401, { message: 'bad credentials' });
      }
      // 第二次登录发新 token（用来验"401 → 重登一次"）
      state.acceptToken = state.logins >= 2 ? TOKEN_B : TOKEN_A;
      json(200, { token: state.acceptToken, user: { id: 'u1' } });
    });
    return;
  }

  if (!authorized(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'unauthorized' }));
    return;
  }

  if (url.pathname === '/api/tracks' && req.method === 'GET') {
    const skip = Number(url.searchParams.get('skip') || 0);
    const take = Number(url.searchParams.get('take') || 100);
    return json(200, { items: TRACKS.slice(skip, skip + take), total: TRACKS.length, skip, take });
  }

  const detail = /^\/api\/tracks\/([^/]+)$/.exec(url.pathname);
  if (detail) {
    const track = TRACKS.find((t) => t.id === decodeURIComponent(detail[1]));
    return track ? json(200, { track }) : json(404, { message: 'not found' });
  }

  const download = /^\/api\/tracks\/([^/]+)\/download$/.exec(url.pathname);
  if (download) {
    state.downloadRequests.push({ id: decodeURIComponent(download[1]), range: req.headers.range || null });
    const range = req.headers.range;
    const match = range && /bytes=(\d+)-(\d*)/.exec(range);
    if (match) {
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : AUDIO.length - 1;
      const slice = AUDIO.subarray(start, end + 1);
      res.writeHead(206, {
        'Content-Type': 'audio/mpeg',
        'Content-Range': `bytes ${start}-${end}/${AUDIO.length}`,
        'Content-Length': slice.length,
        'Accept-Ranges': 'bytes',
      });
      res.end(slice);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': AUDIO.length, 'Accept-Ranges': 'bytes' });
    res.end(AUDIO);
    return;
  }

  if (url.pathname === '/api/cover') {
    state.coverRequests.push(url.searchParams.get('path'));
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': '2'.length });
    res.end('ok');
    return;
  }

  json(404, { message: 'no route' });
});

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const client = new DaoLiYuClient({
    id: 'test',
    name: '假道理鱼',
    host: '127.0.0.1',
    port,
    useSSL: false,
    basePath: '',
    username: 'primuse@test',
    password: 'secret',
  });

  let failures = 0;
  const checks = [];
  const check = async (name, fn) => {
    checks.push(name);
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (error) {
      failures += 1;
      console.log(`FAIL ${name} — ${error.message}`);
    }
  };

  // 1 + 2 登录
  await check('登录 body 同时带 email/username/password，token 取顶层字段', async () => {
    const token = await client.login();
    assert.strictEqual(token, TOKEN_A);
    assert.deepStrictEqual(state.lastLoginBody, { email: 'primuse@test', username: 'primuse@test', password: 'secret' });
  });

  // 3 列表 + 字段映射
  await check('列表分页与字段映射（title/artist/album/duration/cover）', async () => {
    const page = await client.listTracks(0, 100);
    assert.strictEqual(page.total, 3);
    assert.strictEqual(page.items.length, 3);
    const first = page.items[0];
    assert.strictEqual(first.title, '晴天');
    assert.strictEqual(first.artist, '周杰伦');
    assert.strictEqual(first.album, '叶惠美');
    assert.strictEqual(first.duration, 265.4);
    assert.strictEqual(first.fileFormat, 'mp3');
    assert.ok(first.coverURL.startsWith(`http://127.0.0.1:${port}/api/cover?path=`), `封面应经 /api/cover：${first.coverURL}`);
    assert.ok(/path=covers%2Ft1\.jpg/.test(first.coverURL), `path 参数需转义：${first.coverURL}`);
    assert.strictEqual(page.items[1].artist, '周杰伦', 'artistName 顶层字段也要能取到');
    assert.ok(page.items[2].coverURL.includes('/api/cover?path=direct.png'), '/api/ 开头的引用应原样保留');
  });

  await check('take 超过 500 会被夹到 500（Swift 侧同规则）', async () => {
    const page = await client.listTracks(0, 5000);
    assert.strictEqual(page.take, 500);
  });

  // 5 详情与歌词优先级
  await check('详情取 track 字段，逐字歌词优先于纯文本', async () => {
    const detail = await client.trackDetail('t1');
    assert.strictEqual(detail.track.title, '晴天');
    assert.strictEqual(detail.syncedLyrics, '[00:01.00]故事的小黄花\n[00:05.00]从出生那年就飘着');
    assert.strictEqual(detail.plainLyrics, '纯文本歌词');
    const noLyric = await client.trackDetail('t3');
    assert.strictEqual(noLyric.syncedLyrics, null);
  });

  // 7 下载：Range + Bearer
  await check('/download 带 Bearer 且 Range 透传（206 + Content-Range）', async () => {
    const upstream = await client.openDownload('t1', 'bytes=1000-2000');
    assert.strictEqual(upstream.statusCode, 206);
    assert.strictEqual(upstream.headers['content-range'], `bytes 1000-2000/${AUDIO.length}`);
    let bytes = 0;
    await new Promise((resolve) => {
      upstream.stream.on('data', (c) => (bytes += c.length));
      upstream.stream.on('end', resolve);
    });
    assert.strictEqual(bytes, 1001);
    assert.strictEqual(state.downloadRequests.at(-1).range, 'bytes=1000-2000');
  });

  // 4 token 失效 → 重登一次并成功
  await check('token 失效时清 token、重登、只重试一次', async () => {
    const loginsBefore = state.logins;
    state.acceptToken = 'expired-soon'; // 让手里的 TOKEN_A 变成无效
    const page = await client.listTracks(0, 10);
    assert.strictEqual(page.items.length, 3);
    assert.strictEqual(state.logins, loginsBefore + 1, '应当恰好重登一次');
    assert.strictEqual(client.token, TOKEN_B);
  });

  await check('密码错误时不会无限重试（第二次仍 401 就报错）', async () => {
    const bad = new DaoLiYuClient({ id: 'bad', host: '127.0.0.1', port, useSSL: false, username: 'x', password: 'y' });
    await assert.rejects(() => bad.listTracks(0, 10), /登录失败/);
  });

  await new Promise((resolve) => server.close(resolve));
  console.log(
    `\n共 ${checks.length} 项契约断言，失败 ${failures} 项（假服务器：登录 ${state.logins} 次、下载 ${state.downloadRequests.length} 次、封面 ${state.coverRequests.length} 次）`
  );
  if (failures) throw new Error(`${failures} 项断言失败`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
