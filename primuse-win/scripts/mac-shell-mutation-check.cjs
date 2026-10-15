'use strict';
/**
 * 变异验证：`criteria-parity-check.js` 第 15 组（macOS 四 tab 外壳）那 11 条断言，
 * 逐条把源码改坏一次，看守必须报**对应那一条**红。跑完在 finally 里按原字节恢复，
 * 所以可以随便跑；恢复后还会再跑一遍看守确认回到全绿。
 *
 * 为什么留着这个文件：§26 的教训是"只会绿的测试不算测试"。第 15 组里就有一条自己写歪的 ——
 * 那条"迷你条在上、tab 贴窗口底边"原先只比文本先后，把 `MacTabBar` 挪出 VStack 仍然绿；
 * 是变异跑出来才发现的。以后改动这组断言，顺手再跑一遍这个。
 *
 * 用法：node primuse-win/scripts/mac-shell-mutation-check.cjs
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..'); // git 根 = halo_music
const GUARD_CWD = path.join(ROOT, 'primuse-win');
const P = (rel) => path.join(ROOT, rel);

const CASES = [
  {
    label: '四格名单与顺序',
    file: 'primuse/Primuse/Views/Mac/MacTabBar.swift',
    from: '    case library\n    case search\n',
    to: '    case search\n    case library\n',
  },
  {
    label: '图标逐格同源',
    file: 'primuse/Primuse/Views/Mac/MacTabBar.swift',
    from: 'case .settings: return "gearshape"',
    to: 'case .settings: return "gear"',
  },
  {
    label: '首页那一格仍念云端',
    file: 'primuse/Primuse/Views/Mac/MacTabBar.swift',
    from: '@AppStorage(HomeTitle.defaultsKey) private var remoteHomeTitle = ""',
    to: '@AppStorage("primuse.nothing") private var remoteHomeTitle = ""',
  },
  {
    label: '三栏壳是真拆了',
    file: 'primuse/Primuse/App/PrimuseApp.swift',
    from: '            ToolbarCommands()',
    to: '            SidebarCommands()\n            ToolbarCommands()',
  },
  {
    label: 'Mac 的「资料库」就是 iPhone 那份',
    file: 'primuse/Primuse/Views/Mac/MacDetailContainer.swift',
    from: '                onActiveSectionChange: { libraryActiveSection = $0 }',
    to: '                // 反报通道这次没接',
  },
  {
    label: '条路由全部归得到某一格',
    file: 'primuse/Primuse/Views/Mac/MacRoute.swift',
    from: '    case source(String)\n}',
    to: '    case source(String)\n    case fuzzBox\n}',
  },
  {
    label: '设置页页脚把源、聚合源、五个工具全接住',
    file: 'primuse/Primuse/Views/Mac/MacSettingsView.swift',
    from: '                onOpenTool(.scrobble)',
    to: '                onOpenTool(.duplicates)',
  },
  {
    label: '源管理与聚合源两条路由真能渲染',
    file: 'primuse/Primuse/Views/Mac/MacDetailContainer.swift',
    from: '            AggregatedSourcesSettingsView()',
    to: '            MacSourcesView()',
  },
  {
    label: '没有系统返回按钮，就有外壳级的返回',
    file: 'primuse/Primuse/Views/Mac/PMTitleBar.swift',
    from: 'icon: "chevron.left"',
    to: 'icon: "arrow.left"',
  },
  {
    label: '那一排的高度跟另外两端同量级',
    file: 'primuse/Primuse/Views/Mac/Theme/PrimuseTheme.swift',
    from: 'static let tabBar: CGFloat = 52',
    to: 'static let tabBar: CGFloat = 140',
  },
  {
    label: '迷你条在上、tab 贴窗口底边',
    file: 'primuse/Primuse/Views/Mac/MacContentView.swift',
    from: '                        MacTabBar(selection: selection.tab) { tab in\n                            selectTab(tab)\n                        }\n                    }',
    // 把 tab 挪出那个底部 VStack：文本顺序没变，但它不再跟迷你条同在一叠里。
    to: '                    }\n                    MacTabBar(selection: selection.tab) { tab in\n                        selectTab(tab)\n                    }',
  },
  {
    // 页名文件的平台围栏整条去掉：iOS target 也会编译它，而 `PMColor` 只存在于
    // `PrimuseTheme.swift` 的 `#if os(macOS)` 里 —— 本机没有 swiftc，只能靠看守钉住。
    label: 'Mac 的资料库有页名 —— 页名文件自己的平台围栏没了',
    file: 'primuse/Primuse/Views/Mac/MacLibraryPageTitle.swift',
    from: '#if os(macOS)\nimport SwiftUI',
    to: 'import SwiftUI',
  },
  {
    label: 'Mac 的资料库有页名 —— hub 那处漏进 iPhone',
    file: 'primuse/Primuse/Views/Library/LibraryView.swift',
    from: '            #if os(macOS)\n            // 主窗口的系统 toolbar 是隐藏的',
    to: '            // 主窗口的系统 toolbar 是隐藏的',
  },
  {
    label: 'Mac 的资料库有页名 —— 分区页没跟上',
    file: 'primuse/Primuse/Views/Library/LibraryView.swift',
    from: 'MacLibraryPageTitle(title: section.title)',
    to: 'EmptyView()',
  },
  {
    label: 'Mac 从资料库点进专辑',
    file: 'primuse/Primuse/Views/Library/LibraryView.swift',
    from: '        #else\n        return nil\n        #endif\n    }\n\n    @ViewBuilder\n    private var rootContent',
    to: '        #else\n        return {}\n        #endif\n    }\n\n    @ViewBuilder\n    private var rootContent',
  },
];

function runGuard() {
  try {
    return { code: 0, out: execFileSync('node', ['scripts/criteria-parity-check.js'], {
      cwd: GUARD_CWD, encoding: 'utf8',
    }) };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

const backups = new Map();
const restore = () => {
  for (const [file, text] of backups) fs.writeFileSync(P(file), text, 'utf8');
  backups.clear();
};

let ok = 0;
const bad = [];
try {
  for (const c of CASES) {
    const abs = P(c.file);
    const original = fs.readFileSync(abs, 'utf8');
    if (!original.includes(c.from)) {
      bad.push(`${c.label} —— 变异锚点在源码里找不到：${c.file}`);
      console.log(`⚠ 锚点缺失: ${c.label}`);
      continue;
    }
    backups.set(c.file, original);
    fs.writeFileSync(abs, original.replace(c.from, c.to), 'utf8');
    const res = runGuard();
    // 要红在**这一条**上：看守里以本条 label 前 8 字开头的那行必须是 ✘。
    const needle = c.label.split('——')[0].trim().slice(0, 8);
    const red = res.code !== 0
      && res.out.split('\n').some((line) => line.startsWith('✘') && line.includes(needle));
    if (red) {
      ok += 1;
      console.log(`✔ 改坏会红: ${c.label}`);
    } else {
      bad.push(`${c.label} —— 改坏后看守没报这一条红`);
      console.log(`✘ 改坏不红: ${c.label}`);
      console.log(res.out.split('\n').filter((l) => l.startsWith('✘')).join('\n'));
    }
    restore();
    const after = runGuard();
    if (after.code !== 0) {
      bad.push(`${c.label} —— 恢复后看守没回绿（文件没还原干净）`);
      console.log(after.out.split('\n').filter((l) => l.startsWith('✘')).join('\n'));
    }
  }
} finally {
  restore();
}

console.log(`\n变异结果：${ok}/${CASES.length} 条改坏会红，${bad.length} 条异常`);
bad.forEach((b) => console.log(`  - ${b}`));
process.exit(bad.length ? 1 : 0);
