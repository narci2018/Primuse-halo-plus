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
 * 2026-10-15 起还钉这六件（都是"两端各写一遍、写歪了没人报错"的那类）：
 *   11. 加载闸门：只有服务端确认可播的源进播放路径 —— Windows 与 Swift 必须是同一口径，
 *       且收口只有一处（Windows 是 aggregated.enabledSources()，渲染层只读 loaded 不再自己判）；
 *   12. 封面占位色：色相表 + FNV-1a 常数 + UTF-16 迭代口径两端一致，音乐源那一档的写真底图文件在位；
 *   13. 歌词：当前行金色（两套主题都有 token）、基准 20px；
 *   14. 任务栏歌词条：出场条件五项、换歌自动解除 ✕、通道名两侧都在、不抢焦点不进任务栏；
 *   15. macOS 外壳：底下那四格就是 iPhone 的 TabView 与 Windows 的 .tabbar —— 同一组
 *       tab、同一组图标、同一个云端首页名；三栏侧栏壳不得复活；侧栏原来装的目的地
 *       （分区在资料库页内、源与工具在设置页里）得有落点，返回有后手。
 *   16. macOS 的资料库 hub 向 Windows 看齐（2026-10-15 的口径变更，见 plan §30）：六行的
 *       名单/顺序/图标/配色逐行等于 Windows 的 HUB_ROWS，iPhone 那份默认取值一行没动；
 *       跨设备导入的字段的形状逐列等于 CF 那条列表 SQL 与 Windows 的 devices()。
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
const SWIFT_MAC_PAGETITLE = read('primuse/Primuse/Views/Mac/MacLibraryPageTitle.swift');
const SWIFT_APP = read('primuse/Primuse/App/PrimuseApp.swift');
const WIN_STYLES = read('primuse-win/src/renderer/styles.css');
const WIN_AGG = read('primuse-win/src/main/aggregated.js');
const WIN_STORE = read('primuse-win/src/main/store.js');
const WIN_PRELOAD = read('primuse-win/src/preload.js');
const WIN_STRIP_PRELOAD = read('primuse-win/src/preload-lyric.js');
const WIN_STRIP = read('primuse-win/src/main/taskbar-lyric.js');
const WIN_MAIN = read('primuse-win/src/main/main.js');
const WIN_SYNC = read('primuse-win/src/main/sync.js');
const CF_SYNC_API = read('cf-sync-server/functions/api/sync-playlists.js');
const SWIFT_SYNC = read('primuse/Primuse/Services/Playlist/PlaylistSyncService.swift');
const SWIFT_SYNC_VIEW = read('primuse/Primuse/Views/Settings/PlaylistSyncSettingsView.swift');
const WIN_STRIP_HTML = read('primuse-win/src/renderer/taskbar-lyric.html');
const WIN_STRIP_CSS = read('primuse-win/src/renderer/taskbar-lyric.css');
const WIN_STRIP_VIEW = read('primuse-win/src/renderer/taskbar-lyric-view.js');
const SWIFT_MAC_LYRIC = read('primuse/Primuse/Views/Mac/MacMiniaturizedLyrics.swift');
const SWIFT_MAC_SOURCES = read('primuse/Primuse/Views/Mac/MacSourcesView.swift');
const SWIFT_MAC_MENUBAR = read('primuse/Primuse/App/MacMenuBarController.swift');

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
// 冒烟里「渲染层自检」那条封面门：上游给不给封面 URL 不由我们决定（公开线路经常一条
// 都不给），所以两种过法必须都在 —— 有 URL 就验至少一张真解出尺寸，一条都不给就验
// 彩色占位（灰块数必须 0、色相至少两种）。只留前一种，数据源哪天返工成无图，这一步就
// 红在"渲染层自检"上、报的却是没坏的东西；只留后一种，真坏了也没人拦。
record('封面那条门两种过法都在（有 URL 验真能加载 / 无 URL 验彩色占位）',
  /const coverLoadsOk =[\s\S]{0,180}startsWith\('ok:'\)/.test(WIN_MAIN)
    && /const noUpstreamArt =/.test(WIN_MAIN)
    && /const placeholderOk = noUpstreamArt/.test(WIN_MAIN)
    && /ui\.grayCoverTiles === 0/.test(WIN_MAIN)
    && /\(ui\.placeholderHues \|\| 0\) >= 2/.test(WIN_MAIN)
    && /coverLoadsOk \|\| placeholderOk/.test(WIN_MAIN)
    && /grayCoverTiles:/.test(WIN_APP)
    // 色相种数必须是"量出来的"，不是一个常量：写成 `placeholderHues: 0` 这种看着仍在、
    // 实则把彩色占位那条路焊死了 —— 无图批次又会红在"渲染层自检"上。
    && /placeholderHues: phHues\.size/.test(WIN_APP)
    && /style\.getPropertyValue\('--ph-hue'\)/.test(WIN_APP),
  '少任何一半，那条门要么见不到无图批次就红，要么灰块回来了也不红');
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
// 冒烟喂这条窗口的方式也钉一条：v1.9.18~19 那一步时红时绿，根因是它注射了一份
// `playing:true` 的 payload 就走 —— 而主进程手里那份会被渲染层任何一次**按状态现算**
// 的推送（换歌 / 歌词行推进 / 暂停）打回 playing:false、text:""，最小化那一秒里
// 窗口按判据就该收着。所以喂的是 state，不是 payload。
const stripFeed = (WIN_APP.match(/async function smokeTaskbarStripPush\(\)[\s\S]{0,1600}?\n\}/) || [''])[0];
record('冒烟喂任务栏条靠改状态，不靠注射 payload（注射那份会被下一次状态推送打回）',
  stripFeed.includes('state.playing = true')
    && stripFeed.includes('pushTaskbarLyric(true)')
    && !stripFeed.includes('api.taskbarLyric.push(')
    && /async function smokePlaylistCleanup\(\)[\s\S]{0,300}?smokeStripBackup\.playing/.test(WIN_APP),
  `state.playing / pushTaskbarLyric / 无注射 / cleanup 还原 —— 取到的函数体 ${stripFeed.length} 字符`);

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

// 页名：`.navigationTitle` 在 Mac 上画不出来（`.toolbar(.hidden, for: .windowToolbar)`
// 把整条系统 bar 藏了），所以 `LibraryView` 得在正文顶上自己画一行。两处调用点
// （hub / 分区页）都必须待在 `#if os(macOS)` 里 —— 漏进 iPhone 就是在手机上多出一条
// 没人要的灰色横带；而没有这个补偿，Mac 的资料库页打开时一个字的页名都没有。
function lastBefore(hay, idx, needle) {
  let found = -1;
  for (let at = hay.indexOf(needle); at !== -1 && at < idx; at = hay.indexOf(needle, at + 1)) found = at;
  return found;
}
const macTitleCalls = (hay) => {
  const hits = [];
  for (let at = hay.indexOf('MacLibraryPageTitle('); at !== -1; at = hay.indexOf('MacLibraryPageTitle(', at + 1)) {
    hits.push({
      at,
      open: lastBefore(hay, at, '#if os(macOS)'),
      close: lastBefore(hay, at, '#endif'),
    });
  }
  return hits;
};
const macTitleHits = macTitleCalls(SWIFT_LIBRARY);
const macTitleInsideBranches = macTitleHits.length > 0
  && macTitleHits.every((h) => h.open >= 0 && h.close < h.open);
record('Mac 的资料库有页名（正文顶上补画一行），而 iPhone 一行代码都没多',
  /PMColor/.test(SWIFT_MAC_THEME)
    && /^#if os\(macOS\)/.test(SWIFT_MAC_PAGETITLE)
    && /struct MacLibraryPageTitle: View/.test(SWIFT_MAC_PAGETITLE)
    && /font\(\.system\(size: 28, weight: \.bold\)\)/.test(SWIFT_MAC_PAGETITLE)
    && /let title: LocalizedStringKey/.test(SWIFT_MAC_PAGETITLE)
    && SWIFT_MAC_DETAIL.includes('.toolbar(.hidden, for: .windowToolbar)')
    && macTitleHits.length === 2 && macTitleInsideBranches,
  `调用点 ${macTitleHits.length} 处（要 2：hub + 分区页），都在 macOS 分支里 = ${macTitleInsideBranches}`);
// 详情栈里的返回：Album/Artist/Playlist 三个 push 目的地要把 pop 传进去，
// 并且 pop 只能在 macOS 上非 nil —— iPhone 传了闭包会在详情页里多画一个返回圆钮。
const inlineBackPasses = (SWIFT_LIBRARY.match(/onMacInlineBack: /g) || []).length;
record('Mac 从资料库点进专辑/艺术家/歌单还有页内返回（三处都传了，且 iPhone 那边恒为 nil）',
  inlineBackPasses === 3
    && /private var detailPop: \(\(\) -> Void\)\?/.test(SWIFT_LIBRARY)
    && /navigationPath\.removeLast\(\)/.test(SWIFT_LIBRARY)
    && /#if os\(macOS\)[\s\S]{0,180}?return \{[\s\S]{0,160}?#else[\s\S]{0,60}?return nil/.test(SWIFT_LIBRARY),
  `传了 ${inlineBackPasses} 处（要 3）`);

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

// MARK: - 16. macOS 的资料库 hub 向 Windows 看齐 + 跨设备导入的三方契约

group('16. Mac 资料库 hub = Windows 资料库 hub；云端设备列表 = CF 那列 = Windows devices()');

// Windows 那份 hub 的七行：ref / 中文文案 / SF Symbol / 色值 / 计数表达式（app.js:832-840）。
const winHubAt = WIN_APP.indexOf('const HUB_ROWS = [');
const winHubBlock = WIN_APP.slice(winHubAt, WIN_APP.indexOf('];', winHubAt) + 1);
const winHubRows = Array.from(
  winHubBlock.matchAll(/\['([a-z]+)',\s*'([^']*)',\s*'([a-z._0-9]+)',\s*'(#[0-9a-fA-F]{6})'/g)
).map((m) => ({ ref: m[1], label: m[2], icon: m[3], color: m[4].toLowerCase() }));

// Mac 侧只搬「Apple 已有分区」的那六行，`最近播放` 有意没搬（要新增 LibrarySection 分支
// 和三处 switch + 16 份本地化，那是单独一轮）。ref → LibrarySection 的对应关系写死在这里，
// 任何一端改名就会在这里断掉，而不是在屏幕上悄悄少一行。
const MAC_HUB_REF_TO_CASE = {
  songs: 'songs', albums: 'albums', artists: 'artists',
  playlists: 'playlists', liked: 'favorites', history: 'history', stats: 'statistics',
};
const macOrderAt = SWIFT_LIBRARY.indexOf('static let macOSAlignedSectionOrder');
const macOrderArrAt = macOrderAt < 0 ? -1 : SWIFT_LIBRARY.indexOf('= [', macOrderAt);
const macHubCases = macOrderArrAt < 0
  ? []
  : (SWIFT_LIBRARY.slice(macOrderArrAt, SWIFT_LIBRARY.indexOf(']', macOrderArrAt)).match(/\.[a-z]+/g) || [])
    .map((s) => s.slice(1));
const expectedMacCases = winHubRows.filter((r) => r.ref !== 'history').map((r) => MAC_HUB_REF_TO_CASE[r.ref]);
const winHubSix = winHubRows.filter((r) => r.ref !== 'history');

record('六行的名单与顺序逐行等于 Windows 那七行去掉「最近播放」',
  winHubRows.length === 7 && macHubCases.length === 6
    && macHubCases.join(',') === expectedMacCases.join(','),
  `mac=${macHubCases.join('/')} 期望=${expectedMacCases.join('/')}`);
record('Win 的「最近播放」是有意没搬，不是顺序写漏（Win 仍是七行含 history、Mac 仍不含 history）',
  winHubRows.length === 7 && winHubRows.some((r) => r.ref === 'history')
    && !macHubCases.includes('history'),
  `win=${winHubRows.length} 行、mac 含 history=${macHubCases.includes('history')} —— 这一行要新增分区分支和三处 switch、16 份本地化，等用户拍板再做`);

// 图标与配色逐行取 Windows 的原值。抽的是 `windowsHubIcon` / `windowsHubColor` 那两个
// macOS 专用的映射，不是 LibrarySection 本来的取值 —— 后者归 iPhone，一动就改到 iPhone。
const macHubIconBlock = braceBlock(SWIFT_LIBRARY, SWIFT_LIBRARY.indexOf('private var windowsHubIcon'));
const macHubIcons = Object.fromEntries(Array.from(
  macHubIconBlock.matchAll(/case \.([a-z]+): return "([a-z._0-9]+)"/g)
).map((m) => [m[1], m[2]]));
const macHubColorBlock = braceBlock(SWIFT_LIBRARY, SWIFT_LIBRARY.indexOf('private var windowsHubColor'));
const macHubColors = Object.fromEntries(Array.from(
  macHubColorBlock.matchAll(/case \.([a-z]+): return Color\(red: (\d+) \/ 255, green: (\d+) \/ 255, blue: (\d+) \/ 255\)/g)
).map((m) => [m[1], `#${[m[2], m[3], m[4]].map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`]));

const iconDrift = winHubSix
  .filter((r) => macHubIcons[MAC_HUB_REF_TO_CASE[r.ref]] !== r.icon)
  .map((r) => `${r.ref}:${r.icon}→${macHubIcons[MAC_HUB_REF_TO_CASE[r.ref]]}`);
record('图标逐行同源（Mac 不再用 music.mic / square.stack.fill 那套 iPhone 取值）',
  Object.keys(macHubIcons).length === 6 && iconDrift.length === 0,
  iconDrift.length ? iconDrift.join(' ') : winHubSix.map((r) => r.icon).join('/'));

const colorDrift = winHubSix
  .filter((r) => macHubColors[MAC_HUB_REF_TO_CASE[r.ref]] !== r.color)
  .map((r) => `${r.ref}:${r.color}→${macHubColors[MAC_HUB_REF_TO_CASE[r.ref]]}`);
record('配色逐行同源（六行的十六进制值和 Windows 完全一样）',
  Object.keys(macHubColors).length === 6 && colorDrift.length === 0,
  colorDrift.length ? colorDrift.join(' ') : winHubSix.map((r) => r.color).join('/'));

record('iPhone 那一遍一行没动（默认取值仍是 music.mic/.pink/.red，覆盖只在 macOS 分支里）',
  /case \.artists: return "music\.mic"/.test(SWIFT_LIBRARY)
    && /case \.favorites: return \.pink/.test(SWIFT_LIBRARY)
    && /case \.playlists: return \.red/.test(SWIFT_LIBRARY)
    && (SWIFT_LIBRARY.match(/windowsHubIcon/g) || []).length === 2
    && (SWIFT_LIBRARY.match(/windowsHubColor/g) || []).length === 2
    && /#if os\(macOS\)\s*\n\s*if let windows = windowsHubIcon \{ return windows \}\s*\n\s*#endif/.test(SWIFT_LIBRARY)
    && /#if os\(macOS\)\s*\n\s*if let windows = windowsHubColor \{ return windows \}\s*\n\s*#endif/.test(SWIFT_LIBRARY),
  '这两个映射只在 #if os(macOS) 里被读一次；多一个引用点就是 iPhone 也跟着变了');

record('六行的收敛只发生在 macOS 编译分支里（iPhone 的首页落点共用同一份配置，不许被带着变）',
  (SWIFT_LIBRARY.match(/macOSAlignedSections\(/g) || []).length === 2
    && /#if os\(macOS\)[\s\S]{0,500}?return LibraryDisplayConfiguration\.macOSAlignedSections\(sections\)\s*\n\s*#else\s*\n\s*return sections\s*\n\s*#endif/.test(SWIFT_LIBRARY),
  '一处定义 + 一处调用；调用点必须在 #if os(macOS) 里、且 #else 原样返回');

// hub 里「我喜欢」那一行：Windows 是纯行、点进去是这张歌单；iPhone 是那张红色大卡 +
// 快捷收藏入口。两种语义共用一个 LibrarySection，所以跳转、标题、计数三处都得分支。
// 整行注释先剔掉再比 —— 这段的注释里本来就写着 `quickAccessSection`，不剔就会把
// 「注释里提到」当成「代码里走了这条路」，那条反向断言永远红。
const stripLineComments = (text) => text.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
const hubForEach = braceBlock(SWIFT_LIBRARY, SWIFT_LIBRARY.indexOf('ForEach(visibleLibrarySections)'));
const hubMacAt = hubForEach.indexOf('#if os(macOS)');
const hubElseAt = hubForEach.indexOf('#else', hubMacAt);
const hubMacNav = stripLineComments(hubForEach.slice(hubMacAt, hubElseAt));
const hubIphoneNav = stripLineComments(hubForEach.slice(hubElseAt));
record('Mac 上「我喜欢」点进去是那张歌单本身，iPhone 仍走快捷收藏大卡',
  hubMacAt >= 0 && hubElseAt > hubMacAt
    && /section == \.favorites/.test(hubMacNav)
    && /NavigationLink\(value: likedPlaylist\)\s*\{\s*\n\s*libraryCategoryRow\(section\)/.test(hubMacNav)
    && !/quickAccessSection/.test(hubMacNav)
    && /quickAccessSection/.test(hubIphoneNav) && !/likedPlaylist/.test(hubIphoneNav),
  `mac 分支有 likedPlaylist=${/likedPlaylist/.test(hubMacNav)}，iphone 分支有 quickAccess=${/quickAccessSection/.test(hubIphoneNav)}`);

const hubTitleBlock = braceBlock(SWIFT_LIBRARY, SWIFT_LIBRARY.indexOf('private func hubRowTitle'));
record('Mac 那一行念「我喜欢」（playlist_liked_name），iPhone 仍念区块名（library_quick_access）',
  /#if os\(macOS\)[\s\S]{0,200}?section == \.favorites[\s\S]{0,120}?Text\("playlist_liked_name"\)[\s\S]{0,200}?#else\s*\n\s*Text\(section\.title\)\s*\n\s*#endif/.test(hubTitleBlock),
  '详情页标题就是 playlist_liked_name，hub 用同一个词才不跳戏');

const cntAt = SWIFT_LIBRARY.indexOf('private func categoryCountText');
const cntFav = (SWIFT_LIBRARY.slice(cntAt).match(/case \.favorites:([\s\S]*?)case \.folders:/) || ['', ''])[1];
record('Mac 那一行的计数是本机 liked 歌单的歌数，不是「添加快捷收藏」那句话',
  /#if os\(macOS\)[\s\S]{0,300}?library\.songCount\(forPlaylist: MusicLibrary\.likedSongsPlaylistID\)[\s\S]{0,200}?#else\s*\n\s*return String\(localized: "library_quick_access"\)\s*\n\s*#endif/.test(cntFav),
  'Windows 那行是「N 首歌曲」；iPhone 那行本来就是入口卡标题，两个语义不能共用一个字符串');

// 跨设备导入：字段名以服务端那条列表 SQL 为准，Windows 与 Swift 都必须照它解码。
const cfListSql = (CF_SYNC_API.match(/SELECT (device_id[^"]*?) FROM device_playlists ORDER BY updated_at DESC LIMIT 50/) || ['', ''])[1];
const cfListCols = cfListSql ? cfListSql.split(',').map((s) => s.trim()) : [];
const keysAt = SWIFT_SYNC.indexOf('private enum CodingKeys');
const keyBlock = keysAt < 0 ? '' : SWIFT_SYNC.slice(keysAt, SWIFT_SYNC.indexOf('}', keysAt));
const swiftListKeys = Array.from(keyBlock.matchAll(/case\s+(\w+)(?:\s*=\s*"([a-z_]+)")?/g)).map((m) => m[2] || m[1]);
record('设备列表的字段名三方同源：CF 下发哪几列，Swift 就解哪几个 key，Windows 就读 data.devices',
  cfListCols.length === 7
    && cfListCols.every((c) => swiftListKeys.includes(c)) && swiftListKeys.length === 7
    && CF_SYNC_API.includes('devices: rows?.results')
    && /let devices: \[CloudDeviceSummary\]/.test(SWIFT_SYNC)
    && /return \(data && data\.devices\) \|\| \[\];/.test(WIN_SYNC),
  `cf=${cfListCols.join('/')} swift=${swiftListKeys.join('/')} —— 对不上就是界面上一台设备都不显示，而 HTTP 是 200`);

const listFn = (SWIFT_SYNC.match(/func listCloudDevices\([\s\S]*?\n    \}/) || ['', ''])[0];
const winDevicesAt = WIN_SYNC.indexOf('async function devices');
const winImportAt = WIN_SYNC.indexOf('async function importFromDevice');
const winDevicesFn = WIN_SYNC.slice(winDevicesAt, winImportAt);
const winImportFn = WIN_SYNC.slice(winImportAt, WIN_SYNC.indexOf('/**', winImportAt + 10) > 0
  ? WIN_SYNC.indexOf('/**', winImportAt + 10)
  : winImportAt + 1200);
record('列表请求两端同形：GET、不带 deviceId 参数、空表不当成错误',
  listFn.length > 200
    && /request\.httpMethod = "GET"/.test(listFn) && !/name: "deviceId"/.test(listFn)
    && listFn.includes('envelope.data?.devices ?? []')
    && /method: 'GET'/.test(winDevicesFn)
    && winDevicesFn.includes('endpoint(config.serverURL)') && !winDevicesFn.includes('{ deviceId'),
  `Swift 列表函数 ${listFn.length} 字符（自己带 deviceId query=${/name: "deviceId"/.test(listFn)}），Win 那台带参=${winDevicesFn.includes('{ deviceId')}`);

// 下载别人那一份时：query 里是对方机器码、header 里报本机，本机机器码一个字节都不变，
// 而且绝不 POST 回去 —— 这一步写歪的代价是把对方那台设备的备份覆盖掉。
// restore 的函数体后面还要用来查落库顺序，先抽一次。
const restoreBody = braceBlock(SWIFT_SYNC, SWIFT_SYNC.search(/func restore\([^)]*\)[\s\S]{0,120}\{/));
record('跨设备下载只读不写：两端都不发 POST，Swift 的 X-Device-ID 报的是本机',
  restoreBody.length > 2000
    && /request\.setValue\(ownDeviceID, forHTTPHeaderField: "X-Device-ID"\)/.test(restoreBody)
    && /queryItems\.removeAll \{ \$0\.name == "deviceId" \|\| \$0\.name == "device_id" \}/.test(restoreBody)
    && /queryItems\.append\(URLQueryItem\(name: "deviceId", value: targetDeviceID\)\)/.test(restoreBody)
    && !restoreBody.includes('httpMethod = "POST"') && !listFn.includes('httpMethod = "POST"')
    && !winImportFn.includes("method: 'POST'"),
  `restore 体 ${restoreBody.length} 字符、import ${winImportFn.length} 字符，两处 POST=${restoreBody.includes('POST') || winImportFn.includes('POST')}`);

const rowBlock = SWIFT_SYNC_VIEW.slice(
  SWIFT_SYNC_VIEW.indexOf('private func cloudDeviceRow'),
  SWIFT_SYNC_VIEW.indexOf('private func rowSubtitle')
);
const selfAt = rowBlock.indexOf('if isSelf {');
const rowElseAt = rowBlock.indexOf('} else {', selfAt);
record('自己那一份不会被「下载它的歌单」再下一遍（Mac 该行只有「本机」标记，Win 直接抛错）',
  selfAt >= 0 && rowElseAt > selfAt
    && /本机/.test(rowBlock.slice(selfAt, rowElseAt)) && !/importFromCloudDevice\(device\)/.test(rowBlock.slice(selfAt, rowElseAt))
    && /importFromCloudDevice\(device\)/.test(rowBlock.slice(rowElseAt))
    && /if \(id === config\.deviceId\) throw new Error\(/.test(WIN_SYNC),
  'Mac 靠不显示按钮、Win 靠抛错；两边都得有，点了才会没反应而不是把本机刷成别人的');

// 拉取落库的顺序：先注册曲目，再写歌单。库里没有的 id 会被 add(songIDs:) 静默过滤，
// 顺序反了就正是 v1.9.21 之前那个「弹窗说 237 首、屏幕上一个都没有」。
const registerAt = restoreBody.indexOf('library.registerSongsIfNeeded');
const firstAddAt = restoreBody.indexOf('library.add(songIDs:');
record('拉取落库：先注册曲目、后写歌单，且弹窗念的是本机落下多少而不是云端计数',
  registerAt >= 0 && firstAddAt > registerAt
    && /addedSongs \+= max\(after - before, 0\)/.test(restoreBody)
    && /if after > 0 \{ filledPlaylists \+= 1 \}/.test(restoreBody)
    && /res\.filledPlaylists/.test(SWIFT_SYNC_VIEW) && /res\.addedSongs/.test(SWIFT_SYNC_VIEW)
    && /res\.materializedSongs/.test(SWIFT_SYNC_VIEW),
  `register=${registerAt} firstAdd=${firstAddAt}（add 会静默丢掉库里没有的 id，反序就是 0 首）`);

// 云端条目的身份形状：两端都靠 agg_/dly_ 两个前缀 + `/aggregated/` 路径退路反解真实音频。
const wireShapes = (t) => ['agg', 'dly'].filter((p) => new RegExp(`\\^${p}_`).test(t));
record('两端都认 agg_ / dly_ 两种 id 和 /aggregated/ 路径这条退路（缺一头就是拉到本地也放不出声）',
  wireShapes(WIN_SYNC).join(',') === 'agg,dly' && wireShapes(SWIFT_SYNC).join(',') === 'agg,dly'
    && SWIFT_SYNC.includes('/aggregated/') && SWIFT_SYNC.includes('(platform.rawValue)')
    && WIN_SYNC.includes('/aggregated/'),
  `win=${wireShapes(WIN_SYNC).join('/')} swift=${wireShapes(SWIFT_SYNC).join('/')}`);

// dly_ 那条在两端是**逐字相同**的一段正则 —— 非贪婪的源 id 加贪婪的 rawID。
// 谁把它改成贪婪（`(.+)_(.+)`），源 id 里带下划线的道理鱼就会解析错，rawID 少一截。
const winDlyPattern = (WIN_SYNC.match(/\/(\^dly_\(\.\+\?\)_\(\.\+\)\$)\//) || [])[1] || '';
record('dly_ 的正则两端字面一致（源 id 非贪婪、rawID 贪婪）',
  winDlyPattern !== '' && SWIFT_SYNC.includes(winDlyPattern),
  `win=${JSON.stringify(winDlyPattern)} swift 含同一段=${winDlyPattern !== '' && SWIFT_SYNC.includes(winDlyPattern)}`);

// MARK: - 17. macOS 最小化歌词条 = Windows 任务栏歌词条；Mac 来源页/搜索页不许把在线那半藏起来

group('17. 最小化后的单行歌词：macOS 那份的五项条件、窗口属性、尺寸、金色、身份算法逐条照 Windows；来源页与搜索页不许装死');

const macStripFn = braceBlock(SWIFT_MAC_LYRIC, SWIFT_MAC_LYRIC.indexOf('private func shouldShow()'));
// Swift/SF 源码里同一句话常被换行拆写（`macFilterChip(\n .online,`），比形状时先把空白压平。
const oneLine = (t) => t.replace(/\s+/g, ' ');
const winStripFn = braceBlock(WIN_STRIP, WIN_STRIP.indexOf('function shouldShow()'));
const macViewBlock = braceBlock(SWIFT_MAC_LYRIC, SWIFT_MAC_LYRIC.indexOf('struct MacMiniaturizedLyricsView'));
const conjCount = (t) => (t.match(/&&/g) || []).length + 1;
// 五项条件一一对应。Windows 多出的那一项是 `lastPayload &&`（JS 里 lastPayload 可能是 null），
// Swift 那边 payload 是个有默认值的 struct，不需要这一项 —— 项数差必须正好是 1，
// 谁往一边加了条件、另一边没跟上，这条就红。
const STRIP_CONDS = [
  ['开关开着', 'deps.isEnabled()', 'isEnabled'],
  ['主窗口真的看不见', 'deps.mainWindowHidden()', 'mainWindowIsOutOfSight()'],
  ['这一首没被 ✕ 掉', '!dismissed', '!isDismissedForCurrentTrack'],
  ['真的在播', 'lastPayload.playing', 'payload.playing'],
  ['当前这句有字', "String(lastPayload.text || '').trim()", 'hasCurrentLine'],
];
const missingConds = STRIP_CONDS.filter(([, winTok, macTok]) =>
  !winStripFn.includes(winTok) || !macStripFn.includes(macTok));
record('出场条件五项逐条对应（少一项 = 一端冒在用户桌面上、另一端不冒）',
  missingConds.length === 0
    && conjCount(macStripFn) === 5
    && conjCount(winStripFn) === 6
    && conjCount(winStripFn) - conjCount(macStripFn) === 1,
  `缺=${missingConds.map((c) => c[0]).join('/') || '无'} win=${conjCount(winStripFn)} 项 mac=${conjCount(macStripFn)} 项`);

// 那条窗口的物理属性成对抄。任一边改一个属性（可否拖、是否抢焦点、跟不跟 Space），
// 另一边就得同时改 —— 不然"最小化后那条"在两台上是两种东西。
record('那条窗口的属性成对：不抢焦点 / 不进窗口列表 / 浮层级别 / 每个空间都在 / 不给全屏加成 / 不可拖动',
  /focusable: false/.test(WIN_STRIP) && /skipTaskbar: true/.test(WIN_STRIP)
    && /setAlwaysOnTop\(true, 'floating'\)/.test(WIN_STRIP)
    && /visibleOnFullScreen: false/.test(WIN_STRIP) && /movable: false/.test(WIN_STRIP)
    && SWIFT_MAC_LYRIC.includes('.nonactivatingPanel')
    && SWIFT_MAC_LYRIC.includes('panel.level = .floating')
    && SWIFT_MAC_LYRIC.includes('.canJoinAllSpaces')
    && SWIFT_MAC_LYRIC.includes('panel.isMovable = false')
    // 注释里写着"不给 .fullScreenAuxiliary"不算给了 —— 负向断言一律先看掉整行注释（第 16 组栽过一次）。
    && !stripLineComments(SWIFT_MAC_LYRIC).includes('.fullScreenAuxiliary'),
  'win: focusable/skipTaskbar/floating/visibleOnFullScreen/movable ↔ mac: nonactivatingPanel/.floating/canJoinAllSpaces/isMovable');

const macNum = (name) => num(SWIFT_MAC_LYRIC, new RegExp(`static let ${name}: CGFloat = (\\d+)`));
const winNum = (name) => num(WIN_STRIP, new RegExp(`const ${name} = (\\d+)`));
const sizePairs = [['560', winNum('STRIP_WIDTH'), macNum('stripWidth')],
                   ['44', winNum('STRIP_HEIGHT'), macNum('stripHeight')],
                   ['6', winNum('BOTTOM_GAP'), macNum('bottomGap')]];
record('那条的尺寸与缝隙逐一对齐（560×44、离 Dock/任务栏 6px），且都贴工作区/可视区下沿、不盖住 Dock',
  sizePairs.every(([, w, m]) => w > 0 && w === m)
    && /area\.y \+ area\.height - STRIP_HEIGHT - BOTTOM_GAP/.test(WIN_STRIP)
    && /workArea/.test(WIN_STRIP)
    && SWIFT_MAC_LYRIC.includes('visibleFrame')
    && SWIFT_MAC_LYRIC.includes('(area.minY + Self.bottomGap)'),
  sizePairs.map(([label, w, m]) => `${label}:win=${w}/mac=${m}`).join(' '));

// 当前句那支金：从 Windows 的 CSS 里取出来比，而不是把常量抄第二遍进这个脚本 ——
// CSS 改了色号而 Swift 没改，这条同样该红。
const winStripGold = (WIN_STRIP_CSS.match(/\.line\s*\{[^}]*color:\s*#([0-9a-fA-F]{6})/s) || [])[1] || '';
record('当前句金色与 Windows 那条同一支（且浅色档也有，不许拿白色糊过去）',
  winStripGold.toUpperCase() === 'E6C068' && SWIFT_MAC_LYRIC.includes(`Color(hex: "${winStripGold.toUpperCase()}")`),
  `win css=#${winStripGold} mac 含同一支=${SWIFT_MAC_LYRIC.includes('E6C068')}`);

// Swift 的字符串插值写进正则会撞上反斜杠，这里拆成 token 再拼回去比形状。
const macSongKey = (SWIFT_MAC_LYRIC.match(/var songKey: String \{ "\\\((\w+)\)\|\\\((\w+)\)" \}/) || []);
record('歌曲身份两侧同形：标题 + 一个竖线 + 歌手（✕ 的作用域就靠它，多一个字段就飘）',
  macSongKey[1] === 'title' && macSongKey[2] === 'artist'
    && WIN_STRIP.includes('`${next.title}|${next.artist}`'),
  `mac=${(macSongKey[1] || '?')}|${(macSongKey[2] || '?')} win=title|artist`);

const macDismissBlock = braceBlock(SWIFT_MAC_LYRIC, SWIFT_MAC_LYRIC.indexOf('func dismissCurrentTrack()'));
const winDismissBlock = (WIN_STRIP.match(/ipcMain\.on\('taskbar-lyric:dismiss'[\s\S]{0,160}/) || [''])[0];
record('✕ 只收这一首：不落盘、不唤回主窗口（写成持久化 = 点一次这轮 app 再也不出现，那种 bug 只在真机上看得见）',
  macDismissBlock.includes('dismissedSongKey = payload.songKey')
    && !/UserDefaults|AppStorage|setBool/.test(macDismissBlock)
    && !macDismissBlock.includes('restoreMainWindow')
    && !macDismissBlock.includes('makeKeyAndOrderFront')
    && winDismissBlock.includes('dismissed = true')
    && !/store\.(set|save|write)/.test(winDismissBlock),
  `mac dismiss 体=${macDismissBlock.replace(/\s+/g, ' ').slice(0, 90)}`);

const macUserDefaultsAt = SWIFT_MAC_LYRIC.indexOf('UserDefaults.didChangeNotification');
record('开关从关到开 = 用户改主意，上一首的 ✕ 一并作废（两侧都有这条 reset 语义）',
  /'taskbar-lyric:reset'[\s\S]{0,80}dismissed = false/.test(WIN_STRIP)
    && macUserDefaultsAt >= 0
    && SWIFT_MAC_LYRIC.slice(macUserDefaultsAt).includes('dismissedSongKey = nil'),
  `mac 在 didChange 观察里清 ✕=${macUserDefaultsAt >= 0}`);

const macRestoreBlock = braceBlock(SWIFT_MAC_LYRIC, SWIFT_MAC_LYRIC.indexOf('func restoreMainWindow()'));
record('点整条 = 唤回主窗口；主窗口已被关掉时走 openWindow(id:) 重建（Windows 那边是 deps.onRestore()）',
  /ipcMain\.on\('taskbar-lyric:restore'/.test(WIN_STRIP)
    && macRestoreBlock.includes('deminiaturize')
    && macRestoreBlock.includes('makeKeyAndOrderFront')
    && macRestoreBlock.includes('MainWindowOpener.openMainWindow()')
    && macViewBlock.includes('.onTapGesture { onRestore() }'), '');

const appStripInitAt = SWIFT_APP.indexOf('MacMiniaturizedLyricsController()');
record('默认开着、设置页有开关、并且真的在 AppDelegate 里建起来了（三样少一样，这功能等于没做）',
  /taskbarLyric: true/.test(WIN_STORE)
    && SWIFT_MAC_LYRIC.includes('static let key = "macMiniaturizedLyricsEnabled"')
    && SWIFT_MAC_LYRIC.includes('register(defaults: [Self.settingsKey: true])')
    && SWIFT_MAC_SETTINGS.includes('MacMiniaturizedLyricsSettings.key')
    && SWIFT_MAC_SETTINGS.includes('miniaturizedLyricsEnabled')
    && appStripInitAt >= 0,
  `app 里实例化=${appStripInitAt >= 0}，设置页绑 key=${SWIFT_MAC_SETTINGS.includes('MacMiniaturizedLyricsSettings.key')}`);

// "找主窗口"在这个 app 里有三份抄本（AppDelegate / 菜单栏 / 这一条歌词条）。名单漂一格的后果是
// 歌词条把桌面歌词面板当主窗口、或者把副窗口当主窗口，最小化判断立刻失真。
const quotedNames = (t) => (t.match(/"([^"]+)"/g) || []).map((s) => s.slice(1, -1));
const menubarListAt = SWIFT_MAC_MENUBAR.indexOf('nonMainAutosaveNames: Set<String> = [');
const menuBarNames = quotedNames(SWIFT_MAC_MENUBAR.slice(menubarListAt, SWIFT_MAC_MENUBAR.indexOf(']', menubarListAt)));
const appDelegateNames = Array.from(
  SWIFT_APP.matchAll(/window\.frameAutosaveName != "([^"]+)"/g)
).map((m) => m[1]);
const stripListAt = SWIFT_MAC_LYRIC.indexOf('nonMainAutosaveNames: Set<String> = [');
const stripNames = quotedNames(SWIFT_MAC_LYRIC.slice(stripListAt, SWIFT_MAC_LYRIC.indexOf(']', stripListAt)));
const sharedMainNames = [...new Set([...menuBarNames, ...appDelegateNames])];
const lostNames = sharedMainNames.filter((n) => !stripNames.includes(n));
const extraNames = stripNames.filter((n) => !sharedMainNames.includes(n));
record('找主窗口的排除名单三份同源（这一条只允许多把自己的面板加进去）',
  menuBarNames.length >= 4 && appDelegateNames.length >= 4 && lostNames.length === 0
    && extraNames.length === 1 && extraNames[0] === 'PrimuseLyricStrip',
  `丢了=${lostNames.join('/') || '无'} 多了=${extraNames.join('/') || '无'}`);

record('这条是独立的一条，不是把桌面歌词那块多行面板拿来复用（两者用途不同：常驻面板 vs 最小化才露）',
  macViewBlock.length > 200
    && SWIFT_MAC_LYRIC.includes('rootView: MacMiniaturizedLyricsView')
    && !SWIFT_MAC_LYRIC.includes('DesktopLyricsView'),
  `视图体量=${macViewBlock.length} 字符`);

record('判显隐只有一处：显示与隐藏一律由"主进程/控制器"决定（Windows 渲染侧不许建窗口，macOS 视图不许 orderFront/orderOut）',
  !/new BrowserWindow/.test(WIN_STRIP_VIEW) && !/shouldShow/.test(WIN_STRIP_VIEW)
    && !/orderFront|orderOut/.test(macViewBlock)
    && WIN_APP.includes('api.taskbarLyric.push('), '');

// 这一条是 v1.9.23 那条"最小化后根本没有歌词条"的根因看守。
// 旧写法：面板只在"有词可推"时才创建，而推词的 SwiftUI 视图只活在那个面板里 ——
// 面板不建 → 视图不存在 → 一句词都推不过来 → 第五个条件永远为假 → 面板永远不建。
// Windows 那边没这个死锁，因为它那条 BrowserWindow 是启动就建好、只 hide 不 close。
// 所以断言"词与播放状态是控制器自己观察来的"，并且视图里既不许取词也不许建窗口。
// 一律先 stripLineComments：这些名字在注释里也出现过，拿注释当证据的话，
// 把 `withObservationTracking` 那行删掉看守照样绿（第一版就是这么漏过去的）。
const macCtrlBlock = stripLineComments(braceBlock(SWIFT_MAC_LYRIC, SWIFT_MAC_LYRIC.indexOf('final class MacMiniaturizedLyricsController')));
const macViewCode = stripLineComments(macViewBlock);
record('macOS 的歌词条不依赖"面板先存在"：控制器自己观察播放器并自己取词（否则死锁，真机上一条都不露）',
  macCtrlBlock.includes('withObservationTracking')
    && macCtrlBlock.includes('player.currentTime')
    && macCtrlBlock.includes('LyricsLoader.load')
    && macCtrlBlock.includes('func syncPayload()')
    && !macViewCode.includes('LyricsLoader')
    && !macViewCode.includes('.task('),
  `控制器含观察=${macCtrlBlock.includes('withObservationTracking')}，视图仍自己取词=${macViewCode.includes('LyricsLoader')}`);

// 本机没有 Swift 工具链，名字拼错要等 CI 跑 15 分钟才红（v1.9.23 就这么死过一次：
// `NSWindow.didCloseNotification` / `didOcclusionStateNotification` 都不存在）。
// 白名单里每一项都是**这个仓库里已被 CI 编过**的名字，或由 AppKit 的 ObjC 常量
// `NSWindowXxxNotification` 按同一套改名规则直接推得（didMiniaturize / willEnterFullScreen
// 这些已在 `PrimuseTheme.swift:690-697` 里过了编译）—— 新名字先进白名单再进代码。
const REAL_NS_WINDOW_NOTIFICATIONS = [
  'didMiniaturizeNotification', 'didDeminiaturizeNotification', 'willCloseNotification',
  'didChangeOcclusionStateNotification', 'didUpdateNotification', 'didBecomeKeyNotification',
  'didResignKeyNotification', 'didBecomeMainNotification', 'didResignMainNotification',
  'didResizeNotification', 'didMoveNotification', 'didChangeScreenNotification',
  'didChangeBackingPropertiesNotification', 'didEndLiveResizeNotification',
  'willEnterFullScreenNotification', 'didEnterFullScreenNotification',
  'willExitFullScreenNotification', 'didExitFullScreenNotification'
];
const usedWindowNotifications = [...new Set(
  Array.from(stripLineComments(SWIFT_MAC_LYRIC).matchAll(/NSWindow\.(\w+Notification)/g)).map((m) => m[1])
)];
record('事件来源用到的 NSWindow 通知名逐个得是真的（拼错 = 白花一次 15 分钟的 macOS 构建）',
  usedWindowNotifications.length >= 3
    && usedWindowNotifications.every((n) => REAL_NS_WINDOW_NOTIFICATIONS.includes(n))
    && !stripLineComments(SWIFT_MAC_LYRIC).includes('didCloseNotification')
    && !stripLineComments(SWIFT_MAC_LYRIC).includes('didOcclusionStateNotification'),
  `用到=${usedWindowNotifications.join('/')}`);

// —— 用户 2026-10-15 那两句投诉的看守：屏幕上的"0 个音乐源""搜不到"都是 Mac 独有的显示缺口。

const macSourcesContent = braceBlock(SWIFT_MAC_SOURCES, SWIFT_MAC_SOURCES.indexOf('private var content: some View'));
const macSummaryBlock = braceBlock(SWIFT_MAC_SOURCES, SWIFT_MAC_SOURCES.indexOf('private var summaryText: String'));
const sourcesEmptyGate = braceBlock(SWIFT_MAC_SOURCES, SWIFT_MAC_SOURCES.indexOf('private var sources: [MusicSource]'));
const macOnlineCard = braceBlock(SWIFT_MAC_SOURCES, SWIFT_MAC_SOURCES.indexOf('private var onlineLinesCard: some View'));
const macEmptyHint = braceBlock(SWIFT_MAC_SOURCES, SWIFT_MAC_SOURCES.indexOf('private var emptyOnlineLinesHint: String'));
// content 里那一行只许写卡片名，前面不能挂 `if` —— 挂了就是把在线那半又藏回去了。
const onlineRowInContent = (macSourcesContent.split('\n').find((line) => line.includes('onlineLinesCard')) || '').trim();
record('Mac 来源页两组恒在（照 Windows 的 renderSources，它两组都渲染、不看对方的脸）：在线卡无条件出现、整页 ContentUnavailableView 已删、本地空态只数本地；两种"在线为空"分开给话术；页脚仍报在线那半句',
  onlineRowInContent === 'onlineLinesCard'
    && !macSourcesContent.includes('ContentUnavailableView')
    && !macSourcesContent.includes('hasOnlineLines')
    && macSourcesContent.includes('if sources.isEmpty')
    && macSourcesContent.includes('localSourcesEmptyCard')
    && oneLine(macOnlineCard).includes('Text(emptyOnlineLinesHint)')
    && macEmptyHint.includes('if hasOnlineLines')
    && macEmptyHint.includes('还没有任何在线线路')
    && macSummaryBlock.includes('loadedOnlineLines.count')
    && macSummaryBlock.includes('aggregatedStore.sources.count')
    && SWIFT_MAC_SOURCES.includes('aggregatedStore.sources.filter { $0.isInPlaybackPath }')
    && SWIFT_MAC_SOURCES.includes('AggregatedSourcesSettingsView()')
    // 被滤掉的那三类（appleMusic / aggregated / 系统源）是"这一页不讲它们"的名单，
    // 不是"它们不存在" —— 名单本身要和 Windows 那侧一致，不能顺手把在线加回空态判断。
    && sourcesEmptyGate.includes('.aggregated')
    && sourcesEmptyGate.includes('AggregatedMusicService.systemSourceID'),
  `content 里的在线行="${onlineRowInContent}"，hint 两种=${macEmptyHint.replace(/\s+/g, ' ').slice(0, 60)}…`);

const macAllResults = braceBlock(SWIFT_SEARCH, SWIFT_SEARCH.indexOf('private var macAllSearchResultsView'));
const macAggSection = braceBlock(SWIFT_SEARCH, SWIFT_SEARCH.indexOf('private var macAggregatedMusicSection'));
const hasAnyBlock = braceBlock(SWIFT_SEARCH, SWIFT_SEARCH.indexOf('private var hasAnySearchResults'));
record('Mac 搜索页不许藏在线的错误态：有错误就算"有内容"，并且那句错误必须上屏（iOS 那侧原本就在说，Mac 一条都不露）',
  hasAnyBlock.includes('aggregatedMusic.lastSearchError != nil')
    && macAllResults.includes('aggregatedMusic.lastSearchError != nil')
    && macAggSection.includes('if let error = aggregatedMusic.lastSearchError')
    // iOS 那两处一个字符都没动过：整行条件 + 兜底那句。
    && SWIFT_SEARCH.includes('if !aggregatedMusic.searchResults.isEmpty || aggregatedMusic.isSearching || (aggregatedMusic.lastSearchError != nil && searchResults.isEmpty)')
    && SWIFT_SEARCH.includes('else if let error = aggregatedMusic.lastSearchError, aggregatedMusic.searchResults.isEmpty')
    // 「在线」那一格与它的落点：Swift 爱把参数换行写，所以按归一化空白后的文本比形状。
    && oneLine(SWIFT_SEARCH).includes('case .online: macAggregatedMusicSection')
    && oneLine(SWIFT_SEARCH).includes('macFilterChip( .online, title: "在线 ·'),
  `hasAny=${hasAnyBlock.replace(/\s+/g, ' ').slice(0, 120)}`);

// MARK: - 汇总

console.log(`\n结果：${passed} 项通过，${failures.length} 项失败`);
if (failures.length) {
  console.log('\n失败清单：');
  failures.forEach((f) => console.log(`  - ${f}`));
}
process.exit(failures.length ? 1 : 0);
