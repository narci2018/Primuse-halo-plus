/**
 * 把一个设备云端备份里"播不出来的那条源"的歌，换成同一首歌、同一位演唱者在
 * **体检真出过声**的线路上的条目，换成功的才把原条目删掉；换不到的留在原地并写进报告。
 *
 * 为什么在服务端做而不是逐台手点：一条不可播的源在清单里早就判死了（`suggest_delete`），
 * 但设备备份里的歌还是那条源上的 id —— 客户端"重新解析"只能在打开那一首时一首一首试，
 * 246 首里有 35 首是这种，等人手点完不如一次批量。
 *
 * 三条硬规矩：
 *   1. **默认 dry-run**，必须 `--apply` 才写。CI 里没有这一步，也不许加 —— 这个脚本会动用户的歌单数据。
 *   2. 写之前把原样落盘（`.repoint-*.json`，gitignored），写完再 GET 一次回读核对。
 *   3. "可用可播"用的是服务端那一位判据（`enabled && !suggestDelete && check.status==='ok'`，
 *      与客户端 `isLoadable` / Swift `apply()` 同源），而且**还得本机再验一次真取到音频字节** ——
 *      体检结论是几分钟前的快照，同名同歌手的候选也可能恰好那条 rawID 解析不出。
 *
 * 匹配口径（宁可漏换也不换错歌）：
 *   - 标题与歌手都做规范化（去空白/标点/全半角差、转小写）；
 *   - 先要"完全相等"，一条都没有才退让到"去掉括号里的版本说明后相等"（报告里标 `relaxed`）；
 *   - 歌手要求**人名段整段相等**（`张靓颖, 卢昶宇…` 这种合作署名认，`田馥甄的小迷妹` 这种翻唱艺名不认）。
 *     判据本身在 `scripts/lib/song-match.mjs`，由 `tests/song-match.test.mjs` 钉住（26 项，含"不该认的必须不认"）。
 *   - 候选不止验一次：网关的 `action=url` 对洛雪源是"第一条同平台线路给什么就是什么"，
 *     所以这里逐条**可播线路**试到出字节为止（见 `verifyPlayable`），否则一条镜像挂了就把好歌判成换不了。
 *   - 换成的那条如果同一首歌在这个歌单里**已经有可播版本**，就直接删掉原条目，不再重复加。
 *
 * 用法：
 *   # ① 只算不改（先跑这个看报告）
 *   node scripts/repoint-dead-songs.mjs --device=<deviceId> [--from=qq] [--max-candidates=3]
 *   # ② 写云端那台设备的备份
 *   node scripts/repoint-dead-songs.mjs --device=<deviceId> --apply
 *   # ③ 把同一次的决定贴回本机 App 的歌单存档（离线，不联网；App 必须先退出）
 *   node scripts/repoint-dead-songs.mjs --local-store=%APPDATA%/Primuse/primuse.json --map=<②产出的 -map.json>
 *
 * 为什么需要第 ③ 步：`下载歌单（从云端恢复）` 走的是 `store.playlists.mergeIncoming`，
 * 它按 id 去重地**加**歌，不会删本机已有的条目。所以只在云端换源，本机那 35 条 QQ 还在，
 * 下次"上传备份"又会把它们带回云端。本机存档的形状也不同（`{kind,platform,rawID,coverURL,addedAt}`
 * 而不是线上的 `{id,filePath,sourceId}`），因此这份 map 同时记两种形状。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { sniffAudio } from '../functions/lib/protocols.js';
import { norm, artistHit, artistMatchLabel, titleTier } from './lib/song-match.mjs';

const BASE = process.env.PRIMUSE_SYNC_BASE || 'https://primuse-sync-server.pages.dev';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ts = new Date().toISOString().replace(/[:.]/g, '-');

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const DEVICE = String(flag('device', '')).trim();
const FROM = String(flag('from', 'qq')).trim().toLowerCase();
const APPLY = argv.includes('--apply');
const MAX_CANDIDATES = Math.max(1, Number(flag('max-candidates', 3)) || 3);
const ONLY = String(flag('only-playlist', '')).trim();
const LOCAL_STORE = String(flag('local-store', '')).trim();
const MAP_FILE = String(flag('map', '')).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (LOCAL_STORE) {
  // ---- ③ 本机模式：离线，只吃第 ② 步产出的 map，绝不联网、绝不碰云端 ----
  const storePath = path.resolve(LOCAL_STORE.replace(/%APPDATA%/gi, process.env.APPDATA || ''));
  if (!MAP_FILE) {
    console.error('本机模式要一起给 --map=<第②步产出的 -map.json>');
    process.exit(2);
  }
  if (!fs.existsSync(storePath)) {
    console.error(`找不到本机歌单存档：${storePath}`);
    process.exit(1);
  }
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Primuse.exe', '/NH'], { encoding: 'utf8' });
    if (/Primuse\.exe/i.test(out)) {
      console.error('Primuse.exe 正在运行。它把歌单握在内存里，下一次保存会盖掉我这轮的写入 ——\n'
        + '请先在 App 里退出（我不会替你结束这个进程），再跑一次。');
      process.exit(1);
    }
  } catch {
    console.warn('（tasklist 用不了，没能确认 App 是否开着 —— 请自己确认它已退出）');
  }
  const map = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'));
  const from = String(map.from || FROM).toLowerCase();
  const byRaw = new Map();
  (map.replacements || []).forEach((r) => byRaw.set(`${r.from.platform}:${r.from.rawID}`, r));
  const drops = new Map();
  (map.drops || []).forEach((d) => drops.set(`${d.from.platform}:${d.from.rawID}`, d));
  const before = fs.readFileSync(storePath, 'utf8');
  const j = JSON.parse(before);
  let replaced = 0;
  let dropped = 0;
  let left = 0;
  const patch = (list) => list
    .map((s) => {
      const key = `${String(s.platform || '').toLowerCase()}:${String(s.rawID || '')}`;
      if (String(s.platform || '').toLowerCase() !== from || !s.rawID) {
        left += 1;
        return s;
      }
      const r = byRaw.get(key);
      if (r) {
        replaced += 1;
        // 本机形状：同一首可播版本，只换平台与 rawID，封面/专辑/时长以候选为准（候选没给就留原值）
        return { ...s, platform: r.to.platform, rawID: r.to.rawID, album: r.to.album || s.album,
          duration: Number(r.to.duration) > 0 ? Number(r.to.duration) : s.duration,
          coverURL: r.to.coverURL !== undefined ? (r.to.coverURL || null) : (s.coverURL || null),
          unresolved: false };
      }
      if (drops.has(key)) {
        dropped += 1;
        return null;
      }
      console.log(`  本机这条不在 map 里（第②步也没换成）：${s.title} / ${s.artist} · ${key}`);
      left += 1;
      return s;
    })
    .filter(Boolean);
  (j.playlists || []).forEach((pl) => {
    pl.songs = patch(Array.isArray(pl.songs) ? pl.songs : []);
    pl.updatedAt = Date.now();
  });
  if (Array.isArray(j.favorites)) j.favorites = patch(j.favorites);
  const preImage = `${storePath}.before-repoint-${ts}`;
  fs.writeFileSync(preImage, before, 'utf8');
  fs.writeFileSync(storePath, JSON.stringify(j, null, 2), 'utf8');
  console.log(`本机存档：换成 ${replaced} 条、删掉 ${dropped} 条、不属于本轮 ${left} 条`);
  console.log(`原样在 ${preImage}（想回去把它覆盖回来即可）。现在可以开 App 了。`);
  process.exit(0);
}

if (!DEVICE) {
  console.error('缺少 --device=<deviceId>（现网 GET /api/sync-playlists 不带参数就能列出设备）');
  process.exit(2);
}

/** 规范化 / 标题两档 / 歌手切段判据 —— 纯函数都在 lib 里，CI 用 tests/song-match.test.mjs 钉住它们。 */
const jget = async (url, init = {}) => {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs || 45000) });
  const json = await r.json().catch(() => null);
  // 服务端那句原因放在最前面：验播那一层只会截一句，截到 URL 就没意义了
  if (!json || json.code !== 0) throw new Error(`${r.status} → ${JSON.stringify(json || {}).slice(0, 160)} @${url.slice(0, 60)}`);
  return json.data;
};

// ---------- 1. 现网清单：哪些线路"可用可播" ----------
const man = await jget(`${BASE}/api/music-sources`);
const sources = Array.isArray(man.sources) ? man.sources : [];
const loadable = sources.filter((s) => s.enabled && !(s.suggestDelete || s.suggest_delete) && s.check && s.check.status === 'ok');
const okIds = new Set(loadable.map((s) => s.id));
const okPlatforms = new Set(loadable.map((s) => s.platform));
const sourceNameOf = (id) => (sources.find((s) => s.id === id) || {}).name || '';
console.log(`清单 ${sources.length} 条 · 可播 ${loadable.length} 条（平台：${[...okPlatforms].join(',')}）`);
if (!okPlatforms.size) {
  console.error('一条可播线路都没有，换源没有意义。先去跑一轮体检。');
  process.exit(1);
}

// ---------- 2. 这个设备的备份 ----------
const device = await jget(`${BASE}/api/sync-playlists?deviceId=${encodeURIComponent(DEVICE)}`);
const playlists = Array.isArray(device.playlists) ? device.playlists : [];
const platformOf = (s) => {
  const m = /^agg_([a-z0-9]+)_/i.exec(String(s.id || ''));
  if (m) return m[1].toLowerCase();
  const m2 = /\/aggregated\/([a-z0-9]+)\//i.exec(String(s.filePath || ''));
  if (m2) return m2[1].toLowerCase();
  return String(s.platform || s.source || '').toLowerCase();
};
const songsOf = (pl) => (Array.isArray(pl.songs) ? pl.songs : Array.isArray(pl.tracks) ? pl.tracks : []);
const songsKey = (pl) => (Array.isArray(pl.songs) ? 'songs' : 'tracks');
console.log(`设备 ${device.deviceName}（${device.platform}）· ${playlists.length} 个歌单 / ${device.songCount} 首`);

const searchCache = new Map();
const playableCache = new Map();
const notes = [];
const replacements = [];
const drops = [];

/**
 * 按平台搜（不是全站搜一把抓）。
 * 为什么不全站搜：网关一次搜索会把 17 条启用线路的结果混在一起、截到 30 条就返回，
 * 而那 30 条里多数落在判死线路上（判死的 QQ/酷我线路照样会搜出结果）—— 于是"明明能换"
 * 的歌被算成"没有同曲同歌手的候选"。改成只在**可播的那几个平台**上各搜一遍，命中率高得多。
 * 两轮关键词：先"歌名 + 歌手"（准），一条都没有再只搜歌名（召回），歌手仍要**整段相等**才认（见 lib/song-match.mjs）。
 */
async function collectCandidates(song) {
  const title = String(song.title || '').trim();
  const artist = String(song.artist || '').trim();
  const words = [`${title} ${artist}`.trim(), title];
  const found = [];
  for (const platform of [...okPlatforms]) {
    for (const keyword of words) {
      if (!keyword) continue;
      const ck = `${platform}|${keyword}`;
      if (!searchCache.has(ck)) {
        try {
          const d = await jget(`${BASE}/api/music-gateway?action=search&limit=30&platform=${encodeURIComponent(platform)}&keyword=${encodeURIComponent(keyword)}`);
          const list = (d.results || []).filter((t) => t && t.rawID && String(t.platform || '').toLowerCase() === platform.toLowerCase());
          // 带上线路本身的可播身份，供 rank 用（搜索结果项自带 sourceId）
          searchCache.set(ck, list.map((t) => ({ ...t, __ok: okIds.has(t.sourceId) ? 2 : 1 })));
        } catch (e) {
          console.warn(`  搜索失败「${keyword}」@${platform}：${e.message}`);
          searchCache.set(ck, []);
        }
        await sleep(320); // 网关按 IP 限 120 次/分，这里刻意一格一格的
      }
      found.push(...searchCache.get(ck));
      // 第一轮回到了同曲同歌手就不再放宽关键词
      if (found.some((t) => artistHit(t.artist, artist) && titleTier(t.title, title))) break;
    }
  }
  const seen = new Set();
  return found.filter((t) => {
    const k = `${t.platform}:${t.rawID}`;
    if (seen.has(k) || String(t.platform).toLowerCase() === FROM) return false;
    seen.add(k);
    return true;
  });
}

/** 候选排序：完全同名 > 去掉括号里的版本说明后同名；同级里线路本身可播的排前面（sort 稳定，两档不会串）。 */
function rank(list, song) {
  const exact = [];
  const relaxed = [];
  for (const t of list) {
    if (!artistHit(t.artist, song.artist)) continue;
    const tier = titleTier(t.title, song.title);
    if (tier === 'exact') exact.push(t);
    else if (tier === 'relaxed') relaxed.push(t);
  }
  return [...exact.map((t) => ({ t, relaxed: false })), ...relaxed.map((t) => ({ t, relaxed: true }))]
    .sort((a, b) => (b.t.__ok || 0) - (a.t.__ok || 0))
    .slice(0, MAX_CANDIDATES);
}

/**
 * 真取一次音频字节：与体检同一判据（>8192B、不是文本、命中魔数或 content-type 是音频）。
 *
 * 为什么要**逐条线路**验而不是问一次网关就算：网关的 `action=url` 对洛雪源是
 * 「第一条同平台线路解析出来就 return」（music-gateway.js:197），既不试下一条，也不管
 * 那条链接是不是 404 页 —— 于是"这条线路给不出这一首"会被看成"这首歌换不了"。
 * 现网实例：`赤伶 / 等什么君(邓寓君)` 在同名同歌手候选里出现了 3 次，三条链接全是
 * `404 <html>`，但清单里可播的 netease 线路有 12 条，没道理一条都给不出。
 * 所以这里显式地把候选自己那条线路排第一，再把同平台其余可播线路依次试过去
 * （上限 `MAX_SOURCES_PER_CANDIDATE`，一首歌不至于要为 12 条线路付款）。
 */
const MAX_SOURCES_PER_CANDIDATE = 4;
async function verifyPlayable(candidate) {
  const key = `${candidate.platform}:${candidate.rawID}`;
  if (playableCache.has(key)) return playableCache.get(key);
  const order = [];
  if (candidate.sourceId && okIds.has(candidate.sourceId)) order.push(candidate.sourceId);
  loadable.filter((s) => s.platform === candidate.platform && s.id !== candidate.sourceId).forEach((s) => order.push(s.id));
  const attempts = [];
  let verdict = { ok: false, why: '没有可播线路可试', via: null };
  for (const sid of order.slice(0, MAX_SOURCES_PER_CANDIDATE)) {
    try {
      const d = await jget(`${BASE}/api/music-gateway?action=url&sourceId=${encodeURIComponent(sid)}&platform=${encodeURIComponent(candidate.platform)}&rawID=${encodeURIComponent(candidate.rawID)}`);
      const link = d && d.url;
      if (!link) {
        attempts.push(`${sid}:没解析出直链`);
        await sleep(260);
        continue;
      }
      const r = await fetch(link, { headers: { Range: 'bytes=0-65535' }, signal: AbortSignal.timeout(30000) });
      const buf = new Uint8Array(await r.arrayBuffer());
      const sniff = sniffAudio(buf);
      const ct = String(r.headers.get('content-type') || '');
      const okBytes = buf.byteLength > 8192 && !sniff.looksText && (sniff.magic || /^(audio|application\/octet-stream|video\/mp2a)/i.test(ct));
      const label = `${r.status} ${ct || '无 content-type'} ${buf.byteLength}B ${sniff.magic ? `魔数 ${sniff.head}` : `文本特征 ${sniff.looksText} 头 ${sniff.head}`}`;
      if (okBytes) {
        verdict = { ok: true, why: label, via: sid };
        break;
      }
      attempts.push(`${sid}:${label}`);
    } catch (e) {
      attempts.push(`${sid}:异常 ${String(e.message).slice(0, 70)}`);
    }
    await sleep(260);
  }
  if (!verdict.ok) verdict.why = attempts.join(' / ') || '未试成';
  playableCache.set(key, verdict);
  return verdict;
}

const out = playlists.map((pl) => ({ id: pl.id, name: pl.name, createdAt: pl.createdAt, updatedAt: pl.updatedAt, [songsKey(pl)]: [] }));
// 每个歌单自己的歌曲字段名（两端都写 `songs`，但 mergePlaylists 允许 `tracks`，这里别把假设写死）
const keys = playlists.map((pl) => songsKey(pl));

for (let i = 0; i < playlists.length; i += 1) {
  const pl = playlists[i];
  const target = out[i];
  const songs = songsOf(pl);
  const keep = [];
  const key = keys[i];
  if (ONLY && String(pl.name || '') !== ONLY) {
    target[key] = songs;
    continue;
  }
  const rawOf = (s) => {
    const m = /^agg_[a-z0-9]+_(.+)$/i.exec(String(s.id || ''));
    return String(s.rawID || (m ? m[1] : '') || '');
  };
  for (const song of songs) {
    if (platformOf(song) !== FROM) {
      keep.push(song);
      continue;
    }
    const label = `${song.title} / ${song.artist}`;
    const fromRef = { platform: FROM, rawID: rawOf(song) };
    // ① 这个歌单里已经有同一首歌的可播版本 —— 直接删，不重复加
    const dup = keep.find((s) => platformOf(s) !== FROM && norm(s.title) === norm(song.title) && artistHit(s.artist, song.artist));
    if (dup) {
      notes.push({ playlist: pl.name, song: label, action: 'drop-duplicate', detail: `同歌单已有 ${platformOf(dup)}:${dup.rawID || dup.id}` });
      drops.push({ playlist: pl.name, song: label, from: fromRef, reason: 'duplicate-in-playlist' });
      continue;
    }
    const list = await collectCandidates(song);
    const ranked = rank(list, song);
    if (!ranked.length) {
      keep.push(song);
      notes.push({ playlist: pl.name, song: label, action: 'kept-no-candidate', detail: `在可播平台（${[...okPlatforms].join('/')}）上搜到 ${list.length} 条，没有"同曲同歌手"的候选` });
      continue;
    }
    let picked = null;
    const tried = [];
    for (const c of ranked) {
      const v = await verifyPlayable(c.t);
      tried.push(`${c.t.platform}:${c.t.rawID} ${v.ok ? 'OK' : `× ${v.why}`}`);
      if (v.ok) { picked = { ...c, via: v.via }; break; }
    }
    if (!picked) {
      keep.push(song);
      notes.push({ playlist: pl.name, song: label, action: 'kept-all-failed', detail: tried.join(' / ') });
      continue;
    }
    const c = picked.t;
    const replacement = {
      id: `agg_${c.platform}_${c.rawID}`,
      title: song.title || c.title,
      artist: song.artist || c.artist,
      album: c.album || song.album || '在线音源',
      duration: Number(c.duration) > 0 ? Number(c.duration) : song.duration || null,
      filePath: `/aggregated/${c.platform}/${c.rawID}.mp3`,
      sourceId: 'system-aggregated-music',
    };
    keep.push(replacement);
    replacements.push({
      playlist: pl.name,
      song: label,
      from: fromRef,
      // 线上（wire）形状与本机形状都记下：本机存档用的是 {kind,platform,rawID,coverURL,...}
      wire: replacement,
      to: {
        platform: c.platform,
        rawID: c.rawID,
        title: c.title,
        artist: c.artist,
        album: c.album || null,
        duration: Number(c.duration) > 0 ? Number(c.duration) : null,
        coverURL: c.coverURL || null,
        sourceId: c.sourceId || null,
        sourceName: c.sourceName || null,
        // 真正给播出字节的那条线路（可能不是搜到它的那条）—— 复盘"为什么换成了它"要看这个
        viaSourceId: picked.via || null,
        viaSourceName: sourceNameOf(picked.via) || null,
      },
    });
    notes.push({
      playlist: pl.name,
      song: label,
      action: picked.relaxed ? 'replaced-relaxed' : 'replaced',
      detail: `${FROM} → ${c.platform}:${c.rawID}（真出过声的线路：${sourceNameOf(picked.via) || c.sourceName || c.sourceId || '未记'}）· ${c.title} / ${c.artist} · 认下的歌手段「${artistMatchLabel(c.artist, song.artist)}」 · 候选 ${ranked.length} 条`,
    });
  }
  target[key] = keep;
}

// ---------- 3. 报告 ----------
const tally = (arr) => {
  const c = {};
  arr.forEach((s) => (c[platformOf(s)] = (c[platformOf(s)] || 0) + 1));
  return c;
};
console.log('\n逐歌单：');
playlists.forEach((pl, i) => {
  const before = tally(songsOf(pl));
  const after = tally(out[i][keys[i]] || []);
  console.log(`  - ${pl.name}: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
});
const actions = {};
notes.forEach((n) => (actions[n.action] = (actions[n.action] || 0) + 1));
console.log('\n处置统计：', JSON.stringify(actions));
notes.filter((n) => n.action.startsWith('kept')).forEach((n) => console.log(`  留下没换：[${n.playlist}] ${n.song} —— ${n.detail}`));

const reportFile = path.join(HERE, '..', `.repoint-${DEVICE.slice(0, 8)}-${ts}.json`);
fs.writeFileSync(reportFile, JSON.stringify({ deviceId: DEVICE, from: FROM, apply: APPLY, at: new Date().toISOString(), actions, notes }, null, 2), 'utf8');
// map 单独一份：dry-run 也写，方便先只读看决定；第③步（本机存档）吃的就是它
const mapFile = path.join(HERE, '..', `.repoint-${DEVICE.slice(0, 8)}-${ts}-map.json`);
fs.writeFileSync(mapFile, JSON.stringify({
  deviceId: DEVICE, deviceName: device.deviceName, from: FROM, at: new Date().toISOString(),
  apply: APPLY, okPlatforms: [...okPlatforms], replacements, drops,
}, null, 2), 'utf8');
console.log(`决定清单：${mapFile}（换 ${replacements.length} 条 / 只删不补 ${drops.length} 条 / 留下 ${Object.keys(actions).filter((a) => a.startsWith('kept')).reduce((n, k) => n + actions[k], 0)} 条）`);

if (!APPLY) {
  console.log(`\n[dry-run] 没写任何东西。报告：${reportFile}\n确认无误后加 --apply 再跑一次。`);
  process.exit(0);
}

// ---------- 4. 写：先存原样，再 POST 备份，再回读核对 ----------
const preImage = path.join(HERE, '..', `.repoint-${DEVICE.slice(0, 8)}-${ts}-preimage.json`);
fs.writeFileSync(preImage, JSON.stringify({ deviceName: device.deviceName, platform: device.platform, playlists }, null, 2), 'utf8');
const res = await fetch(`${BASE}/api/sync-playlists`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ deviceId: DEVICE, deviceName: device.deviceName, platform: device.platform, playlists: out }),
  signal: AbortSignal.timeout(60000),
});
const back = await res.json().catch(() => null);
console.log(`\n写入：HTTP ${res.status} ${JSON.stringify(back).slice(0, 260)}`);
if (!back || back.code !== 0) {
  console.error(`写入失败。原样还在 ${preImage}，可以贴回去（同样用 POST backup）。`);
  process.exit(1);
}
const after = await jget(`${BASE}/api/sync-playlists?deviceId=${encodeURIComponent(DEVICE)}`);
const allAfter = [];
(after.playlists || []).forEach((pl) => songsOf(pl).forEach((s) => allAfter.push(s)));
console.log(`回读：${after.playlistCount} 个歌单 / ${after.songCount} 首 · 按平台 ${JSON.stringify(tally(allAfter))}`);
const left = allAfter.filter((s) => platformOf(s) === FROM).length;
console.log(`还剩 ${FROM} 条目 ${left} 首（这些是"没找到可播的同曲同歌手"或"验播全失败"的，故意留在原地）`);
console.log(`原样备份：${preImage}\n处置报告：${reportFile}`);
