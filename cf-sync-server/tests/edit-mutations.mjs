// 变异自查（`npm run test:edit:mutate`）：故意把「编辑歌单详情」的服务端改坏，契约测试必须变红。
//
// 为什么单独有这一份：契约测试里那 18 项编辑用例断言的是**用户会踩的四件事** ——
// 只改不删也得通过、换源必须重算客户端认的身份、设备刚上传过备份就不许覆盖它、
// tracks 形状不许被写成两份。这些断言如果没做过红色验证，就不知道它们是真在管事还是只会绿。
// 每一个变异都对应一次"看着没毛病但功能其实是假的"的写法。
//
// 跑完逐字节还原（连中途失败也要还原），并在还原后再跑一遍看守确认全绿。
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const FILE = 'functions/api/sync-playlists.js';
const ORIG = fs.readFileSync(FILE);
const src = ORIG.toString('utf8');

const MUTATIONS = [
  {
    name: '「只改不删」的提交被当成没选中而拒掉（我就是先写成这样才发现的）',
    from: '          if (required && !hit.size) throw new EditValidationError(`${label}：没有选中任何歌曲`);',
    to: '          if (!hit.size) throw new EditValidationError(`${label}：没有选中任何歌曲`);',
  },
  {
    name: '换源后不重算 id（后台看着改对了，客户端拉回去还是按老平台解析）',
    from: '  song.id = `agg_${ident.platform}_${ident.rawID}`;',
    to: '  song.id = song.id || `agg_${ident.platform}_${ident.rawID}`;',
  },
  {
    name: '乐观并发检查形同虚设（设备刚上传的备份会被旧页面覆盖掉）',
    from: '          if (Number(expected) !== Number(row.updated_at)) {',
    to: '          if (false) {',
  },
  {
    name: '写回时永远新起 songs 键（tracks 形状的老数据会分成两份，GET 只读到新的）',
    from: '        const songsKey = Array.isArray(pl.songs) ? "songs" : Array.isArray(pl.tracks) ? "tracks" : null;',
    to: '        const songsKey = Array.isArray(pl.songs) || !Array.isArray(pl.tracks) ? "songs" : null;',
  },
  {
    name: '服务器源行上把旧 platform 留着（换源工具会把它读成在线线路）',
    from: '    delete song.platform;\n    song.kind = "server";',
    to: '    song.kind = "server";',
  },
];

const run = () => spawnSync(process.execPath, ['tests/cf-contract.test.mjs', '--no-net'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
let bad = 0;
try {
  for (const m of MUTATIONS) {
    if (!src.includes(m.from)) {
      console.log(`SKIP ${m.name}：锚点没找到（改编辑接口时记得同步这里）`);
      bad += 1;
      continue;
    }
    fs.writeFileSync(FILE, src.replace(m.from, m.to), 'utf8');
    const r = run();
    const red = r.status !== 0;
    const firstFail = (r.stdout || '').split('\n').find((l) => l.trim().startsWith('FAIL')) || '';
    console.log(`${red ? 'RED  ' : 'GREEN'} ${m.name}${red ? ` —— ${firstFail.trim().slice(0, 90)}` : '（改坏了却还全绿，这条断言是假的）'}`);
    if (!red) bad += 1;
  }
} finally {
  fs.writeFileSync(FILE, ORIG);
  const back = fs.readFileSync(FILE);
  console.log(`还原：${back.equals(ORIG) ? '逐字节一致' : '★ 没还原上，手工检查 ★'}`);
  const green = run();
  console.log(`还原后看守：${green.status === 0 ? '全绿' : `仍红 —— ${String(green.stdout).split('\n').find((l) => l.trim().startsWith('FAIL')) || ''}`}`);
  if (green.status !== 0) bad += 1;
}
console.log(bad ? `${bad} 个变异没被抓住` : `${MUTATIONS.length} 个变异都被抓住`);
process.exit(bad ? 1 : 0);
