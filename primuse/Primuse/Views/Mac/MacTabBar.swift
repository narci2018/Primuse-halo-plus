#if os(macOS)
import SwiftUI
import PrimuseKit

/// iPhone 那套四 tab（`ContentView.swift` 的 `TabView`）在 macOS 上的对应物。
///
/// 以前主窗口是「自绘标题栏 + 侧栏 + 详情」的三栏壳：侧栏把资料库的十个分区、
/// 全部歌单、智能歌单、音乐源、五个工具全摊在最外层导航里，跟 iPhone/Windows
/// 的「首页 / 资料库 / 搜索 / 设置」四格完全不是一套东西。现在目的地只剩四个，
/// 其余内容回到它们在各端本来的位置：分区在资料库页内切换，源与工具进设置页。
enum MacTab: String, CaseIterable, Hashable, Identifiable {
    case home
    case library
    case search
    case settings

    var id: String { rawValue }

    /// 与 iPhone `Tab(..., systemImage:)` 和 Windows `TABS` 同一组 SF Symbol。
    var icon: String {
        switch self {
        case .home: return "house.fill"
        case .library: return "books.vertical"
        case .search: return "magnifyingglass"
        case .settings: return "gearshape"
        }
    }

    var title: LocalizedStringKey {
        switch self {
        case .home: return "home_title"
        case .library: return "library_title"
        case .search: return "search_title"
        case .settings: return "settings_title"
        }
    }

    /// 这个 tab 的根路由。点 tab = 选根路由；「返回」按钮也回到这里。
    var route: MacRoute {
        switch self {
        case .home: return .home
        case .library: return .library
        case .search: return .search
        case .settings: return .settings
        }
    }
}

extension MacRoute {
    /// 当前页属于哪个 tab。tab 高亮与「返回」都按这个走，所以从首页点进专辑、
    /// 从设置点进音乐源，底下亮的仍然是它所属的那一格。
    var tab: MacTab {
        switch self {
        case .home:
            return .home
        case .search:
            return .search
        case .settings, .sources, .aggregatedSources:
            return .settings
        case .library, .stats, .section, .liked, .playlist, .smartPlaylist, .source:
            return .library
        }
    }

    /// 是不是所在 tab 的根页 —— 标题栏据此决定要不要出现「返回」。
    var isTabRoot: Bool {
        tab.route == self
    }
}

/// 主窗口底部的四格导航条。视觉上跟 Windows 渲染层的 `.tabbar` 一致：
/// 图标在上、文案在下、等宽四格、选中用品牌色、顶上一条 hairline 分隔。
struct MacTabBar: View {
    var selection: MacTab
    /// 需求 5：首页那一格的名字由云端清单按 deviceId 下发 —— iPhone 的
    /// `Tab(HomeTitle.text(remoteHomeTitle), systemImage: "house.fill")` 用的就是
    /// 这一份，Windows 的 `homeTitle()` 也是。以前 Mac 只有侧栏那一行用它，
    /// 侧栏去掉后这个入口落到 tab 标签上。
    @AppStorage(HomeTitle.defaultsKey) private var remoteHomeTitle = ""

    let onSelect: (MacTab) -> Void

    var body: some View {
        HStack(spacing: 0) {
            ForEach(MacTab.allCases) { tab in
                tabButton(tab)
            }
        }
        .frame(height: PMSize.tabBar)
        .frame(maxWidth: .infinity)
        .background(PMColor.bgElev.ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) {
            Rectangle().fill(PMColor.divider).frame(height: 0.5)
        }
    }

    private func tabButton(_ tab: MacTab) -> some View {
        let selected = tab == selection
        return Button {
            onSelect(tab)
        } label: {
            VStack(spacing: 3) {
                Image(systemName: tab.icon)
                    .font(.system(size: 17, weight: selected ? .semibold : .regular))
                label(for: tab)
                    .font(.system(size: 10.5, weight: selected ? .semibold : .medium))
                    .lineLimit(1)
                    // 云端下发的首页文案可能比「首页」长得多，缩字号而不是截断，
                    // 免得四格里有一格变成省略号。
                    .minimumScaleFactor(0.7)
            }
            .foregroundStyle(selected ? PMColor.brand : PMColor.textFaint)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("primuse.mac.tab.\(tab.rawValue)")
    }

    private func label(for tab: MacTab) -> Text {
        tab == .home ? Text(verbatim: HomeTitle.text(remoteHomeTitle)) : Text(tab.title)
    }
}
#endif
