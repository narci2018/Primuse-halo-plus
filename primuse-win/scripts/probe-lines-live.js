'use strict';
/**
 * 只读线路体检：逐条实测 9 条默认聚合线路——能不能搜到歌、能不能解析出直链、
 * 直链能不能真的下发音频（Range 0-65535）。
 *
 * 与 CI 的分工：CI 故意不联网测这些第三方公共线路（它们随时可能下线，把绿灯变红灯
 * 反而误导），所以线路层在 CI 里只做离线契约对账。这个脚本给人手动跑，
 * 回答的是"今天这一刻哪几条真能用"。全程 GET，不 POST，不写任何用户数据。
 *
 *   node scripts/probe-lines-live.js [关键词]
 */

const {
  PLATFORMS,
  DEFAULT_SOURCES,
  searchURLFor,
  searchSingleSource,
  resolveFromSource,
} = require('../src/main/aggregated');
const { request, withUA } = require('../src/main/httpx');

const KEYWORD = process.argv[2] || '晴天';

function clip(s) {
  return String(s).replace(/\s+/g, ' ').slice(0, 80);
}

function hostOf(u) {
  try {
    return new URL(u).host;
  } catch (e) {
    return '?';
  }
}

async function probe(source) {
  const row = {
    name: source.name,
    platform: source.platform,
    protocol: source.protocolType,
    apiHost: hostOf(source.baseURL),
    priority: source.priority,
    search: 0,
    resolve: '-',
    audio: '-',
    streamHost: '',
    note: '',
  };

  let hits = [];
  try {
    hits = await searchSingleSource(source, KEYWORD);
  } catch (e) {
    row.note = '搜索异常: ' + clip(e.message);
    return row;
  }
  row.search = hits.length;
  if (!hits.length) {
    // App 里搜索失败会被吞成空数组；这里补一次裸请求，把"线路死了"和"没结果"分开。
    const urlString = searchURLFor(source, KEYWORD);
    if (!urlString) {
      row.note = '该协议不搜（customJson）';
      return row;
    }
    try {
      const res = await request(urlString, { headers: withUA(), timeoutMs: 8000 });
      row.note = `搜索接口 ${res.statusCode}，${(res.body || '').length}B，解析不出条目（线路死了或改格式了）`;
    } catch (e) {
      row.note = '搜索接口不通: ' + clip(e.message);
    }
    row.searchHost = hostOf(urlString);
    return row;
  }

  // 用这条线路自己搜到的第一首歌去考它，避免拿别的平台的 id 为难它。
  const target = hits[0];
  row.target = clip(`${target.title || ''} / ${target.artist || ''}`);

  let url = null;
  try {
    url = await resolveFromSource(source, target.rawID);
  } catch (e) {
    row.note = '解析异常: ' + clip(e.message);
    return row;
  }
  if (!url) {
    row.note = '解析无直链（版权/VIP 或线路拒绝）';
    return row;
  }
  row.resolve = 'ok';

  try {
    const res = await request(url, { headers: { ...withUA(), Range: 'bytes=0-65535' }, timeoutMs: 15000 });
    const bytes = res.body ? res.body.length : 0;
    const ct = String(res.headers && res.headers['content-type']);
    const audioish = /^audio|octet-stream/i.test(ct);
    row.streamHost = hostOf(res.finalUrl || url);
    if (bytes > 8000 && audioish) {
      row.audio = `ok ${bytes}B ${res.statusCode}`;
    } else {
      row.note = `直链不可播 ${res.statusCode} ${clip(ct)} ${bytes}B（空壳/HTML 占位）`;
      row.audio = `FAIL ${res.statusCode}`;
    }
  } catch (e) {
    row.note = '直链取流失败: ' + clip(e.message);
  }
  return row;
}

(async () => {
  console.log(`关键词「${KEYWORD}」——逐条实测 9 条默认线路（搜 / 解析 / 出声）\n`);
  const rows = [];
  for (const src of DEFAULT_SOURCES) {
    const row = await probe(src);
    rows.push(row);
    console.log(
      [
        `P${String(row.priority).padStart(2)}`,
        row.platform.padEnd(7),
        row.protocol.padEnd(7),
        row.apiHost.padEnd(22),
        `搜索${String(row.search).padStart(3)}`,
        `解析 ${String(row.resolve).padEnd(4)}`,
        `音频 ${String(row.audio).padEnd(11)}`,
        (row.streamHost || '').padEnd(22),
        row.name,
      ].join(' | ') + (row.note ? `\n      ↳ ${row.note} [目标: ${row.target || '-'}]` : '')
    );
  }

  const usable = rows.filter((r) => String(r.audio).startsWith('ok'));
  console.log(`\n真能出声: ${usable.length}/9`);
  usable.forEach((r) => console.log(`  ✓ ${r.name} · ${r.platform} · ${r.protocol} · 落地 ${r.streamHost}`));
  const searchable = rows.filter((r) => r.search > 0).map((r) => r.platform);
  console.log(`能搜到歌的平台: ${[...new Set(searchable)].join(', ')}`);
  process.exit(0);
})().catch((e) => {
  console.error('探针失败:', e);
  process.exit(1);
});
