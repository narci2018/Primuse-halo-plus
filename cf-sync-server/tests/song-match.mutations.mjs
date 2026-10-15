// 变异自查（`npm run test:match:mutate`）：故意把判据改坏，看守必须变红。跑完逐字节还原（连失败也要还原）。
//
// 为什么这个文件值得入库：`tests/song-match.test.mjs` 那 26 项如果没人做过红色验证，
// 就不知道它们是真在管事还是"只会绿"。这里把三种改坏方式固定下来，改判据时先跑它。
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const FILE = 'scripts/lib/song-match.mjs';
const ORIG = fs.readFileSync(FILE);
const src = ORIG.toString('utf8');

const MUTATIONS = [
  {
    name: '演唱者判据退回"整串互相包含"',
    from: '  return A.some((x) => B.includes(x));',
    to: '  return A.some((x) => B.some((y) => x.includes(y) || y.includes(x)));',
  },
  {
    name: '括号里的本名不摊平',
    from: "    .replace(/[\\(（【\\[]/g, ',')",
    to: "    .replace(/[\\(（【\\[]/g, '')",
  },
  {
    name: '标题不再退让 relaxed 档',
    from: "  if (norm(candidateTitle) !== norm(wantedTitle) && baseTitle(candidateTitle) === baseTitle(wantedTitle)) return 'relaxed';",
    to: '  // 退让档被删掉',
  },
];

const run = () => spawnSync(process.execPath, ['tests/song-match.test.mjs'], { encoding: 'utf8' });
let bad = 0;
try {
  for (const m of MUTATIONS) {
    if (!src.includes(m.from)) {
      console.log(`SKIP ${m.name}：锚点没找到（改判据时记得同步这里）`);
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
  console.log(`还原后看守：${green.status === 0 ? '全绿' : `仍红 —— ${green.stdout}`}`);
  if (green.status !== 0) bad += 1;
}
console.log(bad ? `${bad} 个变异没被抓住` : `${MUTATIONS.length} 个变异都被抓住`);
process.exit(bad ? 1 : 0);
