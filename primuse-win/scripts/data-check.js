'use strict';
/**
 * 纯 Node 的数据层体检（不需要 Electron）：验证"搜索有结果 + 真的能取到音频字节"。
 * 用法：node primuse-win/scripts/data-check.js [关键词]
 * 这是 §16.4 验收口径第 2 条的机器判据 —— 光有搜索结果不算能播。
 */

const aggregated = require('../src/main/aggregated');
const { openStream } = require('../src/main/httpx');

const keyword = process.argv[2] || '晴天';
const PLATFORMS = ['netease', 'qq', 'kugou', 'kuwo'];

async function probeTrack(sources, platform, candidate) {
  if (!candidate) return { platform, ok: false, error: '无搜索结果' };
  try {
    const url = await aggregated.resolveStreamURL(sources, platform, candidate.rawID);
    const upstream = await openStream(url, { range: 'bytes=0-65535' });
    let bytes = 0;
    await new Promise((resolve) => {
      upstream.stream.on('data', (chunk) => (bytes += chunk.length));
      upstream.stream.on('error', resolve);
      upstream.stream.on('end', resolve);
      setTimeout(() => {
        upstream.stream.destroy();
        resolve();
      }, 8000);
    });
    return {
      platform,
      ok: bytes > 2048,
      title: candidate.title,
      status: upstream.statusCode,
      contentType: upstream.headers['content-type'],
      bytes,
      host: new URL(url).host,
      upstream: url.slice(0, 110),
    };
  } catch (error) {
    return { platform, ok: false, title: candidate.title, error: error.message };
  }
}

(async () => {
  const sources = aggregated.normalizeSources([]);
  console.log(`线路：${sources.length} 条（默认清单）`);

  const items = await aggregated.searchAll(sources, keyword, (partial, progress) =>
    console.log(`  渐进 ${progress.done}/${progress.total} → ${partial.length} 条`)
  );

  const byPlatform = {};
  for (const item of items) byPlatform[item.platform] = (byPlatform[item.platform] || 0) + 1;
  console.log(`搜索「${keyword}」共 ${items.length} 条：${JSON.stringify(byPlatform)}`);

  const probes = [];
  for (const platform of PLATFORMS) {
    const candidate = items.find((i) => i.platform === platform);
    probes.push(await probeTrack(sources, platform, candidate));
  }

  for (const p of probes) {
    console.log(
      `${p.ok ? '✔' : '✘'} ${p.platform.padEnd(8)} ${p.bytes ? `${p.bytes}B ${p.status} ${p.contentType || '-'}` : ''} ${p.error || ''} ${p.title || ''}`
    );
  }

  const netease = items.find((i) => i.platform === 'netease');
  if (netease) {
    const lrc = await aggregated.resolveLyrics(sources, 'netease', netease.rawID);
    console.log(`${lrc && lrc.includes('[') ? '✔' : '✘'} 网易歌词 ${lrc ? `${lrc.length} 字符` : '无'} —— 样例：${(lrc || '').split('\n').find((l) => l.includes('[')) || ''}`);
  }

  const playable = probes.filter((p) => p.ok).map((p) => p.platform);
  console.log(`\n结论：能真正取到音频平台的 = ${playable.length ? playable.join(', ') : '无'}`);
  process.exit(playable.length ? 0 : 1);
})();
