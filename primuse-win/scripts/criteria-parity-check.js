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
 * 2026-10-15 起还钉这四件（都是"两端各写一遍、写歪了没人报错"的那类）：
 *   11. 加载闸门：只有服务端确认可播的源进播放路径 —— Windows 与 Swift 必须是同一口径，
 *       且收口只有一处（Windows 是 aggregated.enabledSources()，渲染层只读 loaded 不再自己判）；
 *   12. 封面占位色：色相表 + FNV-1a 常数 + UTF-16 迭代口径两端一致，音乐源那一档的写真底图文件在位；
 *   13. 歌词：当前行金色（两套主题都有 token）、基准 20px；
 *   14. 任务栏歌词条：出场条件五项、换歌自动解除 ✕、通道名两侧都在、不抢焦点不进任务栏；
 *   15. macOS 外壳：底下那四格就是 iPhone 的 TabView 与 Windows 的 .tabbar —— 同一组
 *       tab、同一组图标、同一个云端首页名；三栏侧栏壳不得复活；侧栏原来装的目的地
 *       （分区在资料库页内、源与工具在设置页里）得有落点，返回有后手。
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
const SWIFT_ART = read('primuse/Primuse/Views/Components/CachedArtworkView.swift');
const SWIFT_PLAYER = read('primuse/Primuse/Views/NowPlaying/NowPlayingView.swift');
const SWIFT_MAC_PLAYER = read('primuse/Primuse/Views/Mac/MacNowPlayingView.swift');
const SWIFT_COVER = read('primuse/Primuse/Views/Components/CoverArtView.swift');
const SWIFT_ARTWORK = read('primuse/Primuse/Views/NowPlaying/ArtworkView.swift');
const SWIFT_STORED_COVER = read('primuse/Primuse/Views/Components/StoredCoverArtView.swift');
const SWIFT_SEARCH = read('primuse/Primuse/Views/Search/SearchView.swift');
const SWIFT_LIBRARY = read('primuse/Primuse/Views/Library/LibraryView.swift');
const SWIFT_IPHONE_SHELL = read('primuse/Primuse/Views/ContentView.swift');
const SWIFT_IPHONE_SETTINGS = read('primuse/Primuse/Views/Settings/SettingsView.swift');
const SWIFT_MAC_SHELL = read('primuse/Primuse/Views/Mac/MacContentView.swift');
const SWIFT_MAC_TABBAR = read('primuse/Primuse/Views/Mac/MacTabBar.swift');
const SWIFT_MAC_DETAIL = read('primuse/Primuse/Views/Mac/MacDetailContainer.swift');
const SWIFT_MAC_SETTINGS = read('primuse/Primuse/Views/Mac/MacSettingsView.swift');
const SWIFT_MAC_TITLEBAR = read('primuse/Primuse/Views/Mac/PMTitleBar.swift');
const SWIFT_MAC_ROUTE = read('primuse/Primuse/Views/Mac/MacRoute.swift');
const SWIFT_MAC_THEME = read('primuse/Primuse/Views/Mac/Theme/PrimuseTheme.swift');
const SWIFT_APP = read('primuse/Primuse/App/PrimuseApp.swift');
const WIN_STYLES = read('primuse-win/src/renderer/styles.css');
const WIN_AGG = read('primuse-win/src/main/aggregated.js');
const WIN_STORE = read('primuse-win/src/main/store.js');
const WIN_PRELOAD = read('primuse-win/src/preload.js');
const WIN_STRIP_PRELOAD = read('primuse-win/src/preload-lyric.js');
const WIN_STRIP = read('primuse-win/src/main/taskbar-lyric.js');
const WIN_MAIN = read('primuse-win/src/main/main.js');

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
// 清单正文那个 `return ok(...)` 不是文件里第一个 —— 后台面板的 `?devices=1` 也回一句 ok()。
// 认正文的办法是说得出话的那一条：块里带 `contract:`。
const MANIFEST_BLOCK =
  Array.from(CF_MANIFEST.matchAll(/return ok\(/g))
    .map((m) => braceBlock(CF_MANIFEST, m.index))
    .find((block) => block.includes('contract:')) || '';
const MANIFEST_KEYS = topLevelKeys(MANIFEST_BLOCK);
const SWIFT_MANIFEST_PROPS = swiftProps(SWIFT_CLOUD, 'CloudManifestDTO');
const MANIFEST_MISSING = MANIFEST_KEYS.filter((k) => !SWIFT_MANIFEST_PROPS.includes(k));
record(`清单正文顶层 ${MANIFEST_KEYS.length} 个字段 Swift 全认得`,
  MANIFEST_KEYS.length >= 8 && MANIFEST_KEYS.includes('contract') && MANIFEST_KEYS.includes('sources') && MANIFEST_MISSING.length === 0,
  `顶层：${MANIFEST_KEYS.join(', ')}｜缺：${MANIFEST_MISSING.join(', ') || '无'}`);
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

// MARK: - 4. 加载闸门（需求 1 + 3）

group('11. 加载闸门：只有"服务端确认可播"的源进播放路径，两处客户端同一口径');
record('Windows 的"可播"就是 check.status === "ok"（不看 HTTP 码、不看延迟）',
  /function isPlayable\(s\) \{\s*return Boolean\(s && s\.check && s\.check\.status === 'ok'\)/.test(WIN_CLOUD), '');
record('Windows 的加载条件 = enabled && !suggestDelete && 可播',
  /function isLoadable\(s\) \{\s*return Boolean\(s && s\.enabled\) && !s\.suggestDelete && isPlayable\(s\)/.test(WIN_CLOUD), '');
record('Windows 落进线路表时 isEnabled 就是"在不在播放路径"，且把 loaded 一起带下去',
  /isEnabled: loaded,/.test(WIN_CLOUD) && /enabledOnServer: Boolean\(s\.enabled\)/.test(WIN_CLOUD), '');
record('Swift 同一口径（enabled && !suggestDelete && check?.status == "ok"）',
  /dto\.enabled && !\(dto\.suggestDelete \?\? false\) && check\?\.status == "ok"/.test(SWIFT_CLOUD), '');
record('Swift 也把它写进 isEnabled，并单独留一个 loaded 给界面说话',
  /isEnabled: loaded/.test(SWIFT_CLOUD) && /loaded: loaded/.test(SWIFT_CLOUD) && /public var loaded: Bool\?/.test(SWIFT_MODELS), '');
record('服务端下发的 usable 数组是同一口径（派生物，不是第二份真相）',
  /usable: pub\.filter\(\(s\) => s\.enabled && s\.check\.status === "ok"\)/.test(CF_MANIFEST), '');
record('播放路径的唯一收口是 aggregated.enabledSources()（它只认 isEnabled，而 isEnabled 就是 loaded）',
  /function enabledSources\(sources, platform = null\) \{\s*return sources\s*\.filter\(\(s\) => s\.isEnabled\)/.test(WIN_AGG)
    && (WIN_AGG.match(/enabledSources\(sources/g) || []).length >= 3,
  '搜索 / 解析直链 / 取歌词三条线都从这里出发，闸门只此一处');
record('渲染层不再自己算一遍闸门（真相只有一份，界面只读 loaded）',
  /function isLoaded\(s\) \{\s*return s && s\.loaded !== false;\s*\}/.test(WIN_APP), '渲染层自己判 status 就会和服务端结论打架');
record('界面上"未加载"这一档真的挂在行上，且和「本机加载」那一组一起渲染',
  /未加载/.test(WIN_APP) && /本机加载/.test(WIN_APP) && /云端有 · 本机不加载/.test(WIN_APP), '');
record('本机体检的闸门是"服务端还开着"，不是"本机已加载"（两处同一口径，否则没测过的永远没机会被测）',
  /function checkable\(s\) \{\s*if \(!s \|\| !s\.id\) return false;\s*return s\.cloud \? s\.enabledOnServer !== false : s\.isEnabled !== false;\s*\}/.test(WIN_CLOUD)
    && /store\.sources\.filter \{ !\$0\.id\.isEmpty && \$0\.isCheckable \}/.test(SWIFT_CLOUD)
    && /public var isCheckable: Bool \{ isCloudManaged \? enabledOnServer != false : isEnabled \}/.test(SWIFT_MODELS)
    && /enabledOnServer: dto\.enabled/.test(SWIFT_CLOUD), '');

// MARK: - 5. 缩略图不再灰（需求 4）

group('12. 封面占位色：两端同一张色相表、同一个哈希口径');
const HUES_WIN = (WIN_APP.match(/COVER_HUES = \[([\d,\s]+)\]/) || [])[1];
const HUES_SWIFT = (SWIFT_ART.match(/placeholderHueDegrees: \[Double\] = \[([\d,\s.]+)\]/) || [])[1];
const hueList = (s) => (s || '').split(',').map((x) => Number(x.trim())).filter((x) => !Number.isNaN(x));
record('Windows 与 Swift 的色相表逐项相同（8 档）',
  hueList(HUES_WIN).length === 8 && JSON.stringify(hueList(HUES_WIN)) === JSON.stringify(hueList(HUES_SWIFT)),
  `${HUES_WIN} vs ${HUES_SWIFT}`);
record('FNV-1a 的两个常数两端一致（种子 0x811c9dc5 / 素数 16777619，都是 32 位那一对）',
  /0x811c9dc5/.test(WIN_APP) && /Math\.imul\(hash, 0x01000193\) >>> 0/.test(WIN_APP)
    && /0x811c_9dc5/.test(SWIFT_ART) && /&\* 0x0100_0193/.test(SWIFT_ART) && /var hash: UInt32/.test(SWIFT_ART),
  'Swift 若用 UInt64 的 64 位 FNV，取模结果与 JS 完全不同 —— 两端同专辑不同色，没人会报这个 bug');
record('哈希走的是 UTF-16 码元（JS 的 charCodeAt 与 Swift 的 .utf16 同宽，否则中文名两端不同色）',
  /basis\.charCodeAt\(i\)/.test(WIN_APP) && /for unit in identity\.utf16/.test(SWIFT_ART), '');
record('占位渐变走 --cover-placeholder，且 CSS 里至少 8 处封面用它兜底（不是灰块）',
  /--cover-placeholder: linear-gradient\(/.test(WIN_STYLES) && (WIN_STYLES.match(/background: var\(--cover-placeholder\)/g) || []).length >= 8,
  `命中 ${(WIN_STYLES.match(/background: var\(--cover-placeholder\)/g) || []).length} 处`);
record('音乐源那一档用的是写真封面底图，且文件真的在渲染目录里（打包要能带上）',
  /\.sico\.photo \{[\s\S]{0,200}source-cover\.png/.test(WIN_STYLES)
    && fs.existsSync(path.join(ROOT, 'primuse-win/src/renderer/source-cover.png')), '');
record('结论色走那一圈内描（照片底上底色分不出三档）',
  /\.sico\.photo \{[\s\S]{0,300}box-shadow: inset 0 0 0 1\.5px var\(--ring/.test(WIN_STYLES), '');

// Apple 那侧以前只有 CachedArtworkView 用得上这套渐变，别处各自留着灰底 ——
// 结果同一张没封面的专辑，Windows 彩色、iPhone 灰色。这一组盯的是"灰底有没有回来"。
group('12b. 占位封面：Swift 侧只剩 CoverPlaceholder 这一条路，灰底不许再长出来');
record('CoverPlaceholder 确实住在 CachedArtworkView 里，并且走的还是那张色相表',
  /struct CoverPlaceholder: View \{/.test(SWIFT_ART) && /CachedArtworkView\.placeholderColors\(for: identity\)/.test(SWIFT_ART), '');
record('CachedArtworkView 自己的占位也改成调它（不留第二份渐变代码）',
  /private var symbolicPlaceholder: some View \{\s*CoverPlaceholder\(/.test(SWIFT_ART), '');
record('CoverArtView / ArtworkView 的材质灰底已换成占位封面',
  /CoverPlaceholder\(/.test(SWIFT_COVER) && !/\.fill\(\.ultraThinMaterial\)/.test(SWIFT_COVER)
    && /CoverPlaceholder\(/.test(SWIFT_ARTWORK) && !/\.fill\(\.ultraThinMaterial\)/.test(SWIFT_ARTWORK),
  '.ultraThinMaterial 在浅色墙上就是一块灰');
record('歌单占位不再是 secondary 灰梯度，且种子用歌单名（与 Windows 的 bgStyle(url, name) 同一口径）',
  /private var symbolicPlaceholder: some View \{\s*CoverPlaceholder\(/.test(SWIFT_STORED_COVER)
    && !/Color\.secondary\.opacity\(0\.18\)/.test(SWIFT_STORED_COVER)
    && /let name = currentPlaylist\.name[\s\S]{0,160}return name\.isEmpty \? "playlist:/.test(SWIFT_STORED_COVER), '');
record('资料库叠封预览的底版取色，不再是一块 secondary.opacity(0.1)',
  /CoverPlaceholder\(identity: seed/.test(SWIFT_LIBRARY) && !/\.fill\(Color\.secondary\.opacity\(0\.1\)\)/.test(SWIFT_LIBRARY), '');
record('聚合搜索结果的封面种子用「标题|歌手」，和 Windows 歌行的种子一模一样',
  /private func aggregatedMusicRow[\s\S]{0,1400}CoverPlaceholder\(\s*identity: "\\\(songItem\.title\)\|\\\(songItem\.artist\)"/.test(SWIFT_SEARCH), '');

// MARK: - 6. 歌词颜色与字号（需求 5）

group('13. 歌词：当前行金色、基准 20px，两套主题都有值');
const GOLD = {
  light: (WIN_STYLES.match(/:root[\s\S]{0,2000}?--gold: (#[0-9a-f]{6});/) || [])[1],
  lightNow: (WIN_STYLES.match(/:root[\s\S]{0,2000}?--gold-now: (#[0-9a-f]{6});/) || [])[1],
};
record('浅色两套金色 token 都在（深色块里另有一套，两处都命中）',
  Boolean(GOLD.light) && Boolean(GOLD.lightNow) && (WIN_STYLES.match(/--gold: #/g) || []).length >= 2 && (WIN_STYLES.match(/--gold-now: #/g) || []).length >= 2,
  JSON.stringify(GOLD));
record('.lyric-line 用 var(--gold)、当前行用 var(--gold-now)，都不再是灰色/primary',
  /\.lyric-line \{[\s\S]{0,400}color: var\(--gold\)/.test(WIN_STYLES) && /\.lyric-line\.now \{[\s\S]{0,200}color: var\(--gold-now\)/.test(WIN_STYLES), '');
record('基准字号收到 20px（原来抄 iPhone 的 26px），档位仍乘这个基准',
  /\.lyric-line \{[\s\S]{0,200}font-size: 20px/.test(WIN_STYLES) && /Math\.round\(20 \* scale\)/.test(WIN_APP), '');

// 需求 5 说的是"歌词"，不是"Windows 的歌词"。iPhone 那份原本就不灰（它是参考实现），
// 但它是白/蓝，字号基准还是 26 —— 这一组把四支 hex 与基准字号钉成两端同一个值。
const WIN_GOLD = (WIN_STYLES.match(/--gold(?:-now)?: #[0-9a-f]{6}/g) || []).map((s) => s.slice(-6).toLowerCase());
const WIN_GOLD_UNIQ = [...new Set(WIN_GOLD)].sort();
group('13b. 歌词金色与基准字号：Windows 与 Swift 两端同一个值');
// 深色那两支在 CSS 里写了两遍（media query + html[data-appearance=dark]），所以命中数会 >4；
// 真正要比的是"去重以后就这四支"。
record('Windows 侧四支金值齐了（浅深各一对：--gold 与 --gold-now）',
  WIN_GOLD_UNIQ.join(',') === 'b8860b,d99a2b,e6c068,ffd75e'
    && (WIN_STYLES.match(/--gold: #/g) || []).length >= 2 && (WIN_STYLES.match(/--gold-now: #/g) || []).length >= 2,
  JSON.stringify(WIN_GOLD_UNIQ));
record('iOS 播放页两支金色用的就是 Windows 那四支 hex（大小写不敏感比对）',
  ['d99a2b', 'e6c068'].every((h) => new RegExp(`lyricGold: Color[\\s\\S]{0,120}${h}`, 'i').test(SWIFT_PLAYER))
    && ['b8860b', 'ffd75e'].every((h) => new RegExp(`lyricGoldNow: Color[\\s\\S]{0,120}${h}`, 'i').test(SWIFT_PLAYER)),
  `Windows = ${JSON.stringify(WIN_GOLD)}；两端不同金 = 同一首歌两台设备两种颜色，没人会当 bug 报`);
record('macOS 播放页同样两支金色，值与 iOS 一致',
  /lyricGold: Color \{[\s\S]{0,120}D99A2B[\s\S]{0,40}E6C068/i.test(SWIFT_MAC_PLAYER)
    && /lyricGoldNow: Color \{[\s\S]{0,120}B8860B[\s\S]{0,40}FFD75E/i.test(SWIFT_MAC_PLAYER), '');
record('当前行走金色（默认色模式下不再拿 appearance.primary 当歌词色）',
  /case \.defaultColor:\s*return AnyShapeStyle\(appearance\.lyricGoldNow/.test(SWIFT_PLAYER), '');
record('非当前行也走金色阶梯；用户显式选了自定义色/渐变时不抢戏',
  /private var lyricBaseColor: Color \{\s*lyricsColorMode == \.defaultColor \? appearance\.lyricGold : appearance\.primary/.test(SWIFT_PLAYER), '');
record('两端基准字号都是 20（iOS 26→20、macOS 25→20，全屏档同比例 32→26）',
  /lyricsLayoutBaseSize: CGFloat = 20/.test(SWIFT_PLAYER)
    && /lyricsBaseSize: CGFloat = 20/.test(SWIFT_MAC_PLAYER)
    && /lyricsBaseSizeFS: CGFloat = 26/.test(SWIFT_MAC_PLAYER), '');
record('歌词字号倍率区间没动（0.7..1.8 仍由设置里的 lyricsFontScale 决定）',
  /lyricsMinScale: Double = 0\.7/.test(SWIFT_PLAYER) && /lyricsMaxScale: Double = 1\.8/.test(SWIFT_PLAYER)
    && /lyricsMinScale: Double = 0\.7/.test(SWIFT_MAC_PLAYER), '');

// MARK: - 7. 任务栏歌词条（需求 8）

group('14. 任务栏歌词条：显示与否只由主进程判一处，渲染层只喂数据');
record('出场条件五项齐全（开关 + 主窗口看不见 + 没被 ✕ 掉 + 在播 + 这句有字）',
  /deps\.isEnabled\(\) &&\s*deps\.mainWindowHidden\(\) &&\s*!dismissed &&\s*lastPayload &&\s*lastPayload\.playing &&\s*String\(lastPayload\.text \|\| ''\)\.trim\(\)/.test(WIN_STRIP), '');
record('换歌自动解除"这一首别露脸"（歌曲身份在主进程就地算，不靠渲染层多传字段）',
  /const key = `\$\{next\.title\}\|\$\{next\.artist\}`;[\s\S]{0,160}dismissed = false/.test(WIN_STRIP), '');
record('渲染层只 push，不自己开窗口（app.js 里不许出现那条窗口的创建/显隐）',
  /api\.taskbarLyric\.push\(/.test(WIN_APP) && !/new BrowserWindow/.test(WIN_APP), '');
record('开关默认开，且设置项在「播放」组里（关掉时主进程 sync 一次立刻收走）',
  /taskbarLyric: true/.test(WIN_STORE) && /data-switch-taskbar-lyric/.test(WIN_APP) && /taskbarLyric\.sync\(\)/.test(WIN_MAIN), '');
record('那条窗口自己的桥只有三件事（收词 / 唤回 / ✕），主窗口的整套能力一律不给',
  /exposeInMainWorld\('lyricStrip'/.test(WIN_STRIP_PRELOAD)
    && (WIN_STRIP_PRELOAD.match(/ipcRenderer\.(send|on)\(/g) || []).length === 3, '浮在别人桌面上的窗口，能力越少越好');
// 主窗口那侧走 set/reset/status，那条窗口自己那侧走 restore/dismiss（两个 preload，能力各给一半）。
// status 的 handle 在 main.js，其余三个 on 在 taskbar-lyric.js —— 两侧各查两个文件。
const CHANNELS = {
  'taskbar-lyric:set': [WIN_PRELOAD],
  'taskbar-lyric:reset': [WIN_PRELOAD],
  'taskbar-lyric:status': [WIN_PRELOAD],
  'taskbar-lyric:restore': [WIN_STRIP_PRELOAD],
  'taskbar-lyric:dismiss': [WIN_STRIP_PRELOAD],
};
const badChannels = Object.keys(CHANNELS).filter(
  (c) =>
    !(WIN_STRIP.includes(`'${c}'`) || WIN_MAIN.includes(`'${c}'`)) ||
    !CHANNELS[c].some((side) => side.includes(`'${c}'`))
);
record('五个通道名两侧都在（主进程 ↔ 两个 preload，对不上就是静默失灵）',
  badChannels.length === 0, badChannels.join(', ') || Object.keys(CHANNELS).join(' / '));
record('不抢焦点、不进任务栏、不跟随主窗口节流（否则最小化后它就哑了）',
  /focusable: false/.test(WIN_STRIP) && /skipTaskbar: true/.test(WIN_STRIP) && /backgroundThrottling: false/.test(WIN_STRIP), '');
record('只贴工作区下沿，不盖任务栏',
  /workArea/.test(WIN_STRIP) && /STRIP_HEIGHT - BOTTOM_GAP/.test(WIN_STRIP), '');

// MARK: - 15. macOS 外壳：底下那四格必须就是 iPhone 那四格

group('15. 三端主导航同源：首页 / 资料库 / 搜索 / 设置（macOS 的三栏侧栏壳已废）');

// Mac 的 tab 名单：enum MacTab 的 case 顺序就是屏幕上从左到右的顺序。
const macTabBlock = braceBlock(SWIFT_MAC_TABBAR, SWIFT_MAC_TABBAR.indexOf('enum MacTab'));
const macTabs = Array.from(macTabBlock.matchAll(/^\s*case\s+([a-z]+)/gm)).map((m) => m[1]);
// Windows 的 TABS：id / 中文文案 / SF Symbol 三元组，顺序同样是渲染顺序。
const winTabsAt = WIN_APP.indexOf('const TABS = [');
const winTabBlock = WIN_APP.slice(winTabsAt, WIN_APP.indexOf('];', winTabsAt) + 1);
const winTabRows = Array.from(winTabBlock.matchAll(/\['([a-z]+)',\s*'[^']*',\s*'([a-z._]+)'\]/g));
const winTabs = winTabRows.map((m) => m[1]);
const winTabIcons = winTabRows.map((m) => m[2]);
// iPhone 的 TabView：搜索那一格走 `role: .search`（系统自己画图），所以只有三个 systemImage。
const iphoneTabCount = (SWIFT_IPHONE_SHELL.match(/^\s+Tab\(/gm) || []).length;
const iphoneTabIcons = Array.from(new Set(
  Array.from(SWIFT_IPHONE_SHELL.matchAll(/systemImage:\s*"([a-z._]+)"/g)).map((m) => m[1])
));
const macIconBlock = braceBlock(SWIFT_MAC_TABBAR, SWIFT_MAC_TABBAR.indexOf('var icon: String'));
const macTabIcons = Array.from(macIconBlock.matchAll(/case \.([a-z]+):\s*return "([a-z._]+)"/g)).map((m) => m[2]);

record('四格名单与顺序：Mac = Windows = iPhone 那四个',
  macTabs.join(',') === 'home,library,search,settings'
    && winTabs.join(',') === macTabs.join(',')
    && iphoneTabCount === 4,
  `mac=${macTabs.join('/')} win=${winTabs.join('/')} iphoneTabs=${iphoneTabCount}`);
record('图标逐格同源（Windows 与 iPhone 用到的 symbol 名，Mac 一格都没换）',
  macTabIcons.length === 4
    && winTabIcons.every((i) => macTabIcons.includes(i))
    && iphoneTabIcons.every((i) => macTabIcons.includes(i)),
  `mac=${macTabIcons.join('/')} win=${winTabIcons.join('/')} iphone=${iphoneTabIcons.join('/')}`);
record('首页那一格仍念云端按 deviceId 下发的文案（三端同一个来源）',
  SWIFT_MAC_TABBAR.includes('HomeTitle.defaultsKey') && /HomeTitle\.text\(/.test(SWIFT_MAC_TABBAR)
    && /Tab\(HomeTitle\.text\(remoteHomeTitle\)/.test(SWIFT_IPHONE_SHELL)
    && /function homeTitle\(\)/.test(WIN_APP), '服务端改了名，三端一起改；只有一端跟着改就是飘');
record('三栏壳是真拆了，不是藏起来了（文件、路由、菜单三处都不许留）',
  !fs.existsSync(path.join(ROOT, 'primuse/Primuse/Views/Mac/MacSidebar.swift'))
    && !/MacSidebar\(/.test(SWIFT_MAC_SHELL)
    && !/sidebarCollapsed/.test(SWIFT_MAC_SHELL)
    && !/SidebarCommands\(\)/.test(SWIFT_APP), '留着 SidebarCommands 就是菜单里多一条点不动的「显示/隐藏侧栏」');

const macLibraryCase = (SWIFT_MAC_DETAIL.match(/case \.library:([\s\S]*?)case \.settings:/) || ['', ''])[1];
record('Mac 的「资料库」就是 iPhone 那份 LibraryView，分区在页内切换（不是又抄一遍分区列表）',
  macLibraryCase.includes('LibraryView(') && macLibraryCase.includes('onActiveSectionChange')
    && SWIFT_IPHONE_SHELL.includes('onActiveSectionChange:'),
  '两端共用一份视图，分区/歌单/电台的样式与持久化才不会各走各的');

// MacRoute 每加一条，`var tab` 的 switch 就得归到某一格，否则高亮与「返回」都算不出来。
const macRouteBlock = braceBlock(SWIFT_MAC_ROUTE, SWIFT_MAC_ROUTE.indexOf('enum MacRoute'));
const macRouteCases = Array.from(new Set(
  Array.from(macRouteBlock.matchAll(/^\s*case\s+([a-zA-Z]+)/gm)).map((m) => m[1])
));
const macTabSwitch = braceBlock(SWIFT_MAC_TABBAR, SWIFT_MAC_TABBAR.indexOf('var tab: MacTab'));
const orphanRoutes = macRouteCases.filter((name) => !new RegExp(`\\.${name}\\b`).test(macTabSwitch));
record(`MacRoute 的 ${macRouteCases.length} 条路由全部归得到某一格（漏一条就是底下四格与正文不同步）`,
  macRouteCases.length >= 10 && orphanRoutes.length === 0 && /var isTabRoot: Bool/.test(SWIFT_MAC_TABBAR),
  orphanRoutes.length ? `没归类：${orphanRoutes.join('/')}` : macRouteCases.join('/'));

// 侧栏原来装的目的地：源 / 聚合源 / 五个工具 —— 现在必须都在「设置」tab 的页脚。
const macToolBlock = braceBlock(SWIFT_MAC_ROUTE, SWIFT_MAC_ROUTE.indexOf('enum MacTool'));
const macTools = Array.from(macToolBlock.matchAll(/^\s*case\s+([a-zA-Z]+)/gm)).map((m) => m[1]);
const missingToolRows = macTools.filter((t) => !SWIFT_MAC_SETTINGS.includes(`onOpenTool(.${t})`));
const missingToolSheets = macTools.filter((t) => !SWIFT_MAC_SHELL.includes(`case .${t}:`));
record('设置页页脚把源、聚合源、五个工具全接住了（少一个就是目的地凭空消失）',
  SWIFT_MAC_SETTINGS.includes('embeddedDestinationRows')
    && /Text\("manage_sources"\)/.test(SWIFT_MAC_SETTINGS)
    && SWIFT_MAC_SETTINGS.includes('聚合音乐源设置')
    && /embeddedGroupHeader\("mac_sidebar_tools"\)/.test(SWIFT_MAC_SETTINGS)
    && missingToolRows.length === 0 && missingToolSheets.length === 0,
  `工具行缺 ${missingToolRows.join('/') || '无'}；弹框缺 ${missingToolSheets.join('/') || '无'}`);
record('源管理与聚合源两条路由真能渲染，且聚合源用的是 iPhone 同一份视图',
  /case \.sources:[\s\S]{0,80}MacSourcesView\(\)/.test(SWIFT_MAC_DETAIL)
    && /case \.aggregatedSources:[\s\S]{0,160}AggregatedSourcesSettingsView\(\)/.test(SWIFT_MAC_DETAIL)
    && SWIFT_IPHONE_SETTINGS.includes('AggregatedSourcesSettingsView()'), '');
record('没有系统返回按钮，就有外壳级的返回（标题栏箭头 + 再点本格回根页）',
  /var showsBack: Bool/.test(SWIFT_MAC_TITLEBAR) && SWIFT_MAC_TITLEBAR.includes('"chevron.left"')
    && /private var showsTitleBarBack: Bool/.test(SWIFT_MAC_SHELL)
    && /guard tab != selection\.tab[\s\S]{0,220}backToTabRoot\(\)/.test(SWIFT_MAC_SHELL),
  'windowToolbar 是隐藏的，NavigationStack 里钻进去就没了返回 —— 只有外壳能补');

const macTabH = num(SWIFT_MAC_THEME, /static let tabBar: CGFloat = (\d+)/);
const winTabH = num(WIN_STYLES, /--tab-h:\s*(\d+)px/);
record(`那一排的高度跟另外两端同量级（iPhone 系统 49 ≤ mac ${macTabH} ≤ win ${winTabH}）`,
  macTabH >= 49 && macTabH <= winTabH && winTabH === 56
    && /frame\(height: PMSize\.tabBar\)/.test(SWIFT_MAC_TABBAR),
  JSON.stringify({ iphone: 49, mac: macTabH, win: winTabH }));
// 迷你条 + tab 这一叠：两者必须在同一个底部 VStack 里，且 tab 在最下面。
// 只看文本先后是不够的 —— 把 MacTabBar 挪出 VStack 之后，它在源码里仍然排在后面。
const insetAt = SWIFT_MAC_SHELL.indexOf('.safeAreaInset(edge: .bottom');
const insetIf = braceBlock(SWIFT_MAC_SHELL, SWIFT_MAC_SHELL.indexOf('if !isFullScreenNowPlaying {', insetAt));
const bottomStack = braceBlock(insetIf, insetIf.indexOf('VStack(spacing: 0)'));
const bottomFirst = bottomStack.indexOf('MacBottomBar(');
record('迷你条在上、tab 贴窗口底边，两边同一叠放次序（同一个底部 VStack）',
  insetAt >= 0 && bottomFirst >= 0
    && bottomStack.indexOf('MacTabBar(') > bottomFirst,
  '顺序反了或 tab 掉出这一叠，就变成 tab 压在迷你条上面，跟 Windows/iPhone 都不一样');

// MARK: - 汇总

console.log(`\n结果：${passed} 项通过，${failures.length} 项失败`);
if (failures.length) {
  console.log('\n失败清单：');
  failures.forEach((f) => console.log(`  - ${f}`));
}
process.exit(failures.length ? 1 : 0);
