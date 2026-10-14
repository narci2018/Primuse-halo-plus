'use strict';
/**
 * 「同一份判据的三份抄本不许飘」—— 纯静态源码断言（不联网、不起服务、不开 Electron）。
 *
 * 为什么要有这个文件：`能出声吗` 这一条判据现在写在三处 ——
 *   1. 服务端 `cf-sync-server/functions/lib/protocols.js`（sniffAudio / probeAudio），
 *   2. Windows `primuse-win/src/main/cloud-sources.js`（looksLikeAudio / isPlayableAudio），
 *   3. iPhone/macOS `primuse/Primuse/Services/AggregatedMusic/AudioSniff.swift`。
 * 三处不一致的后果不是"报错"，是同一线路在两个屏幕上结论相反 —— 用户看到"未检出/不可播"
 * 来回跳，谁都没法谈。而 Swift 那一遍是在**这台没有 Xcode/swiftc 的 Windows 机上写的**，
 * 它连编译都只能靠 CI 验，更不可能在本机跑测试。所以这里用"读源码文本"的方式把它钉住：
 * 任何一处改了阈值、加了魔数、换了正则，另一处没跟上 → 这个脚本红。
 *
 * 另外钉两件同样会"一声不吭坏掉"的事：
 *   - 清单字段名：CF 下发的 key 与 Swift DTO 的属性名必须一一对上
 *     （对不上 = Swift 解出来整份是 nil，界面上"线路凭空没了"）；
 *   - 观测盲区名单：`未检出` 不停用这条规则，服务端 / Windows 渲染层 / Swift 三份必须同源。
 *
 * 用法：node scripts/criteria-parity-check.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..'); // git 根 = halo_music
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const CF_PROTOCOLS = read('cf-sync-server/functions/lib/protocols.js');
const CF_STORE = read('cf-sync-server/functions/lib/store.js');
const CF_MANIFEST = read('cf-sync-server/functions/api/music-sources.js');
const CF_CHECK = read('cf-sync-server/functions/lib/check.js');
const WIN_CLOUD = read('primuse-win/src/main/cloud-sources.js');
const WIN_APP = read('primuse-win/src/renderer/app.js');
const SWIFT_SNIFF = read('primuse/Primuse/Services/AggregatedMusic/AudioSniff.swift');
const SWIFT_MODELS = read('primuse/Primuse/Services/AggregatedMusic/AggregatedMusicModels.swift');
const SWIFT_CLOUD = read('primuse/Primuse/Services/AggregatedMusic/CloudMusicSources.swift');
const SWIFT_STORE = read('primuse/Primuse/Services/AggregatedMusic/AggregatedSourceStore.swift');

// MARK: - 断言器（与 cloud-sources-contract-test.js 同一形状）

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

// MARK: - 源码小工具

/** 从 fromIdx 起第一个 `{` 开始做括号配对，返回花括号**内部**的文本。 */
function braceBlock(text, fromIdx) {
  const start = text.indexOf('{', fromIdx);
  if (start < 0) return '';
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start + 1, i);
    }
  }
  return text.slice(start + 1);
}

/** 只取深度 1 的 key，嵌套对象（`check: {…}`）不会被算进来。 */
function topLevelKeys(block) {
  const keys = [];
  let depth = 0;
  let ident = '';
  for (let i = 0; i < block.length; i += 1) {
    const ch = block[i];
    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    else if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
    if (/[A-Za-z_$]/.test(ch)) ident += ch;
    else {
      if (depth === 0 && ch === ':' && ident) keys.push(ident);
      if (ch !== ':' ) ident = '';
      else ident = '';
    }
  }
  return Array.from(new Set(keys));
}

function swiftProps(text, structName) {
  const at = text.indexOf(`struct ${structName}`);
  if (at < 0) return [];
  return Array.from(new Set(
    Array.from(braceBlock(text, at).matchAll(/public var `?([A-Za-z0-9_]+)`?\s*:/g)).map((m) => m[1])
  ));
}

/** `ascii(4, "ftyp")` 这种调用抽成 `偏移:字面` 集合 —— 魔数的位置比它的名字更容易写错。 */
function magicPairs(text, quote) {
  const re = new RegExp(`ascii\\(\\s*(\\d+)\\s*,\\s*${quote}([^${quote}]+)${quote}\\s*\\)`, 'g');
  return Array.from(text.matchAll(re)).map((m) => `${m[1]}:${m[2]}`).sort();
}

const num = (text, re) => {
  const m = text.match(re);
  return m ? Number(m[1]) : NaN;
};

// MARK: - 1. 字节层判据

group('1. 判据本体：bytes>下限 && 不像文本 && (魔数 || content-type 是音频)');
const MIN = { cf: num(CF_PROTOCOLS, /buf\.byteLength > (\d+)/), win: num(WIN_CLOUD, /AUDIO_MIN_BYTES = (\d+)/), swift: num(SWIFT_SNIFF, /audioMinBytes = (\d+)/) };
const WINDOW = { cf: num(CF_PROTOCOLS, /bytes=0-(\d+)"/), win: num(WIN_CLOUD, /PROBE_BYTES = (\d+)/), swift: num(SWIFT_SNIFF, /probeBytes = (\d+)/) };
record('下限三处一致（8192）', MIN.cf === 8192 && MIN.win === MIN.cf && MIN.swift === MIN.cf, JSON.stringify(MIN));
record('取字节窗口三处一致（65536；服务端是 Range 末位 65535）', WINDOW.cf + 1 === WINDOW.win && WINDOW.swift === WINDOW.win, JSON.stringify(WINDOW));
record('Swift 的判据公式与服务端同式（不看 HTTP 状态码）',
  /bytes > audioMinBytes && !textish && \(magic \|\| isAudioContentType\(contentType\)\)/.test(SWIFT_SNIFF), '');
record('Windows 的判据公式与服务端同式',
  /bytes > AUDIO_MIN_BYTES && !textish && \(magic \|\| audioContentType\(contentType\)\)/.test(WIN_CLOUD), '');
record('魔数比对至少要 12 字节（四字节魔数 + RIFF 的 WAVE 标记都在里面）',
  /bytes\.count >= 12/.test(SWIFT_SNIFF) && /head = bytes\.slice\(0, 12\)/.test(CF_PROTOCOLS) && /buffer\.length < 12/.test(WIN_CLOUD), '');

group('2. 音频魔数表：偏移 + 字面 三处一字不差');
const MAGIC = {
  cf: magicPairs(CF_PROTOCOLS, '"'),
  win: magicPairs(WIN_CLOUD, "'"),
  swift: magicPairs(SWIFT_SNIFF, '"'),
};
const EXPECT_MAGIC = ['0:ID3', '0:OggS', '0:RIFF', '0:fLaC', '4:ftyp', '8:WAVE'].sort();
record('服务端含全部六个魔数位', JSON.stringify(MAGIC.cf) === JSON.stringify(EXPECT_MAGIC), MAGIC.cf.join(', '));
record('Windows 与服务端同表', JSON.stringify(MAGIC.win) === JSON.stringify(MAGIC.cf), MAGIC.win.join(', '));
record('Swift 与服务端同表', JSON.stringify(MAGIC.swift) === JSON.stringify(MAGIC.cf), MAGIC.swift.join(', '));
record('`ftyp` 比的是偏移 4 而不是 0（mp4 前四字节是 box 长度）',
  MAGIC.swift.includes('4:ftyp') && MAGIC.win.includes('4:ftyp') && MAGIC.cf.includes('4:ftyp'), '');
const ADTS = (t) => /0[xX][fF][fF]/.test(t) && /0[xX][eE]0\)/.test(t) && /&\s*0[xX][eE]0/.test(t);
record('MPEG/ADTS 帧同步（0xFF + &0xE0）三处都在', ADTS(CF_PROTOCOLS) && ADTS(WIN_CLOUD) && ADTS(SWIFT_SNIFF), '');

group('3. 「看着像文本」与「声称是音频」两条正则，三处同源');
const TEXTRE = {
  cf: (CF_PROTOCOLS.match(/\/(\^\\s\*\(.+?\))\/\.test/) || [])[1],
  win: (WIN_CLOUD.match(/\/(\^\\s\*\(.+?\))\/\.test/) || [])[1],
  swift: (SWIFT_SNIFF.match(/"(\^\\s\*\(.+?\))"/) || [])[1],
};
record('文本特征正则三处逐字相同', TEXTRE.cf === TEXTRE.win && TEXTRE.cf === TEXTRE.swift, JSON.stringify(TEXTRE));
const CTRE = {
  cf: (CF_PROTOCOLS.match(/\/(\^\(audio.+?\))\/i\.test/) || [])[1],
  win: (WIN_CLOUD.match(/\/(\^\(audio.+?\))\/i\.test/) || [])[1],
  swift: (SWIFT_SNIFF.match(/"\(\?i\)(\^\(audio.+?\))"/) || [])[1],
};
record('content-type 白名单正则三处逐字相同', CTRE.cf === CTRE.win && CTRE.cf === CTRE.swift, JSON.stringify(CTRE));
record('Swift 走的是"文本层解码后判定"，与 JS 的 fatal:false 同口径',
  /String\(decoding: head, as: UTF8\.self\)/.test(SWIFT_SNIFF) && !/String\(data: head, encoding/.test(SWIFT_SNIFF),
  '用 String(decoding:) —— String(data:encoding:.utf8) 在二进制上直接回 nil，一票否决项会恒为 false');

group('4. UA：客户端取音频用的那串要和服务端一样');
const CF_UA = (CF_PROTOCOLS.match(/const UA = "([^"]+)"/) || [])[1];
const SWIFT_UA = (SWIFT_SNIFF.match(/userAgent = "([^"]+)"/) || [])[1];
record('Swift AudioSniff 的 UA 与服务端逐字相同', Boolean(CF_UA) && SWIFT_UA === CF_UA, `${SWIFT_UA} vs ${CF_UA}`);
record('清单请求也带这串 UA（服务端按 UA 放不同编码，给错就回 m3u8/反爬页）',
  /setValue\(AudioSniff\.userAgent, forHTTPHeaderField: "User-Agent"\)/.test(SWIFT_CLOUD), '');
// Windows 故意用桌面 UA 取流（Chromium 自己发请求的替身），这条不是漂移，是既成事实 —— 记下来免得下次"顺手统一"。
record('Windows 取流用桌面 UA 是刻意的（httpx.DESKTOP_UA），本脚本不把它算作飘',
  /DESKTOP_UA = 'Mozilla\/5\.0 \(Windows NT/.test(read('primuse-win/src/main/httpx.js')), '');

// MARK: - 2. 清单字段名

group('5. 清单字段名：CF 下发的 key 与 Swift DTO 的属性名一一对上');
const CF_SOURCE_KEYS = topLevelKeys(braceBlock(CF_STORE, CF_STORE.indexOf('return', CF_STORE.indexOf('export function publicSource'))));
const SWIFT_SOURCE_PROPS = swiftProps(SWIFT_CLOUD, 'CloudSourceDTO');
const SOURCE_MISSING = CF_SOURCE_KEYS.filter((k) => !SWIFT_SOURCE_PROPS.includes(k) && !['createdAt', 'updatedAt'].includes(k));
record(`服务端 publicSource 的 ${CF_SOURCE_KEYS.length} 个字段，Swift DTO 全认得`,
  CF_SOURCE_KEYS.length >= 14 && SOURCE_MISSING.length === 0,
  `缺：${SOURCE_MISSING.join(', ') || '无'}（createdAt/updatedAt 本机不用，JSONDecoder 会忽略）`);
record('`protocol` 是 Swift 关键字 —— 属性名必须还能对上 JSON 里那个 key',
  /public var `protocol`: String/.test(SWIFT_CLOUD), '写成 protocolType 而忘了反引号，整份清单会解成 nil');
const CF_CHECK_KEYS = topLevelKeys(braceBlock(CF_STORE, CF_STORE.indexOf('check: {')));
const SWIFT_CHECK_PROPS = swiftProps(SWIFT_CLOUD, 'CloudSourceCheckDTO');
record(`check 对象的 ${CF_CHECK_KEYS.length} 个字段 Swift 全认得`,
  CF_CHECK_KEYS.every((k) => SWIFT_CHECK_PROPS.includes(k)), `${CF_CHECK_KEYS.join(', ')} vs ${SWIFT_CHECK_PROPS.join(', ')}`);
const MANIFEST_BLOCK = braceBlock(CF_MANIFEST, CF_MANIFEST.indexOf('return ok('));
const MANIFEST_KEYS = topLevelKeys(MANIFEST_BLOCK);
const SWIFT_MANIFEST_PROPS = swiftProps(SWIFT_CLOUD, 'CloudManifestDTO');
const MANIFEST_MISSING = MANIFEST_KEYS.filter((k) => !SWIFT_MANIFEST_PROPS.includes(k));
record(`清单正文顶层 ${MANIFEST_KEYS.length} 个字段 Swift 全认得`,
  MANIFEST_KEYS.includes('contract') && MANIFEST_KEYS.includes('sources') && MANIFEST_MISSING.length === 0,
  `缺：${MANIFEST_MISSING.join(', ') || '无'}`);
record('settings.homeTitle / homeTitleFrom / deviceId 三个都在 DTO 里',
  ['homeTitle', 'homeTitleFrom', 'deviceId'].every((k) => swiftProps(SWIFT_CLOUD, 'CloudDeviceSettingsDTO').includes(k)), '');
record('gateway.base / actions / note 三个都在 DTO 里',
  ['base', 'actions', 'note'].every((k) => swiftProps(SWIFT_CLOUD, 'CloudGatewayDTO').includes(k)), '');

group('6. 契约号与默认清单地址：三端同一个');
record('契约号 primuse.music-sources.v1 三处都在',
  CF_MANIFEST.includes('"primuse.music-sources.v1"')
    && WIN_CLOUD.includes("'primuse.music-sources.v1'")
    && SWIFT_CLOUD.includes('"primuse.music-sources.v1"'), '');
const DEFAULT_URL = 'https://primuse-sync-server.pages.dev/api/music-sources';
record('Swift 与 Windows 的默认清单地址相同（都是 Pages，不是 workers.dev）',
  SWIFT_CLOUD.includes(`= "${DEFAULT_URL}"`) && read('primuse-win/src/main/store.js').includes(`'${DEFAULT_URL}'`), DEFAULT_URL);

// MARK: - 3. 盲区名单与停用权力

group('7. 观测盲区：未检出 ≠ 源坏了，三处同源');
const SWIFT_BLIND = (SWIFT_MODELS.match(/blindStatuses: \[String\] = \[([^\]]+)\]/) || [])[1];
const WIN_BLIND = (WIN_APP.match(/VERDICT_BLIND = \[([^\]]+)\]/) || [])[1];
const norm = (s) => (s || '').replace(/["']/g, '').split(',').map((x) => x.trim()).filter(Boolean).sort();
const SB = norm(SWIFT_BLIND);
const WB = norm(WIN_BLIND);
record('Swift 与 Windows 的盲区名单完全相同', SB.length === 5 && JSON.stringify(SB) === JSON.stringify(WB), `${SB.join('|')} vs ${WB.join('|')}`);
const CF_BLIND = norm((CF_STORE.match(/blindStatus = \[([^\]]+)\]/) || [])[1]);
record('服务端那份是子集，且不含 error（error 走 ERROR_GRACE=3 的宽限，见 store.js）',
  CF_BLIND.every((s) => SB.includes(s)) && !CF_BLIND.includes('error'), CF_BLIND.join('|'));
record('服务端 ERROR_GRACE 仍是 3', num(CF_STORE, /export const ERROR_GRACE = (\d+)/) === 3, '');
record('Swift 盲区名单里有 unchecked/error/no_sample/runner_missing/unsupported',
  ['no_sample', 'runner_missing', 'unsupported', 'unchecked', 'error'].every((s) => SB.includes(s)), SB.join('|'));

group('8. App 侧只读 + 刷新：本机结论不许动 isEnabled');
record('Swift 的体检里没有停用调用（toggleSource/enable 都不许出现在 checkAllAvailable 里）',
  !/checkAllAvailable[\s\S]{0,2000}?(toggleSource|isEnabled =)/.test(SWIFT_CLOUD), '停线与删除建议是 CF 后台的权力（决策③）');
record('内置线路的补齐有闸门：云端接管后不再每次冷启动回填（后台删掉的源不该原地复活）',
  /underCloudManagement/.test(SWIFT_STORE), '');
record('传输层失败一律 throw，不咽成"0 字节不可播"',
  /async throws -> ProbeResult/.test(SWIFT_SNIFF) && /try await probeSession\.bytes\(for: request\)/.test(SWIFT_SNIFF), '');
record('探测结论落成 error 而不是 audio_fail/resolve_fail（"我们没测成"≠"这条源死了"）',
  /status: "error",[\s\S]{0,160}origin: \.local/.test(SWIFT_CLOUD), '');

group('9. 体检关键词与样本口径：两边检同一首歌');
record('默认关键词三处都是「晴天」',
  /keyword = "晴天"/.test(CF_CHECK) && /=== '晴天'|'晴天'/.test(WIN_CLOUD) && /probeKeyword: String \{ "晴天" \}/.test(SWIFT_CLOUD), '');
record('Swift 有本机样本池，且键名带版本号',
  /primuse\.aggregated\.sample_ids\.v1/.test(SWIFT_CLOUD), '搜索接口单独挂掉时用它继续验播放（服务端 ensureSamples 的本机对应物）');
record('搜索无结果 + 池子也空 → no_sample（不停用、不建议删除）',
  /status: "no_sample"/.test(SWIFT_CLOUD), '');

group('10. 需求 5：首页文案的三态来源');
record('服务端确实回 device / global / default 三态',
  /"device"/.test(CF_MANIFEST) && /"global"/.test(CF_MANIFEST) && /"default"/.test(CF_MANIFEST), '');
record('Swift 把 default 当"没设置"，回落到本地 home_title',
  /settings\.homeTitleFrom != "default"/.test(SWIFT_CLOUD),
  '现网没人设置过时照样回 {homeTitle:"首页",homeTitleFrom:"default"}，照单全收会把 de/es/fr/hi/ar 的本地化压成中文');
record('Swift 回落的是本地化键而不是硬编码"首页"',
  /String\(localized: "home_title"\)/.test(SWIFT_CLOUD), '');

// MARK: - 汇总

console.log(`\n结果：${passed} 项通过，${failures.length} 项失败`);
if (failures.length) {
  console.log('\n失败清单：');
  failures.forEach((f) => console.log(`  - ${f}`));
}
process.exit(failures.length ? 1 : 0);
