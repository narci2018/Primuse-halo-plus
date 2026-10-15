#if os(macOS)
import Foundation
import PrimuseKit

enum MacRoute: Hashable {
    case home
    /// 「资料库」tab 的根 —— 就是 iPhone 那一个 `LibraryView`(十个分区在页内的
    /// 分类条里切换)。以前这些分区被侧栏摊成 10 条路由, 四 tab 外壳里它们是页内导航。
    case library
    case stats
    case search
    /// 「设置」tab 的根 —— 主窗口内嵌版 `MacSettingsView`。
    case settings
    /// 服务器型音乐源管理页, 挂在「设置」tab 下 (iPhone/Windows 同样把源行进设置)。
    case sources
    /// 聚合音乐源 (云端清单 URL + 线路) 设置页 —— 与 iPhone 设置里同一份视图。
    case aggregatedSources
    case section(LibrarySection)
    /// 单独的"我喜欢的"快捷入口 — 等同于 .section(.songs) + isLiked 过滤。
    case liked
    /// 直接打开指定歌单 (资料库页内点入, 或恢复上次浏览位置)。
    case playlist(Playlist)
    /// 直接打开指定智能歌单 (同上)。
    case smartPlaylist(SmartPlaylist)
    case source(String)
}

extension MacRoute {
    var stableID: String {
        switch self {
        case .home: return "home"
        case .library: return "library"
        case .stats: return "stats"
        case .search: return "search"
        case .settings: return "settings"
        case .sources: return "sources"
        case .aggregatedSources: return "aggregatedSources"
        case .section(let section): return "section-\(section)"
        case .liked: return "liked"
        case .playlist(let playlist): return "playlist-\(playlist.id)"
        case .smartPlaylist(let smart): return "smartPlaylist-\(smart.id)"
        case .source(let id): return "source-\(id)"
        }
    }
}

/// 工具入口 (原侧栏「工具」区, 现在在「设置」tab 的页脚)。点击不再切换路由
/// (不进详情栈), 而是以弹框 (`.sheet`) 形式覆盖在当前页上 —— 工具是临时操作面板,
/// 用完即关, 不该占据主导航。`Identifiable` 让 `MacContentView` 能直接 `.sheet(item:)`。
enum MacTool: String, Identifiable, Hashable {
    case lyricsConverter
    case duplicates
    case scrobble
    case cacheSync
    case deviceTransfer

    var id: String { rawValue }
}

extension Notification.Name {
    static let primuseDetailOpenAlbum = Notification.Name("primuse.detail.openAlbum")
    static let primuseDetailOpenArtist = Notification.Name("primuse.detail.openArtist")
    static let primuseSelectScrobble = Notification.Name("primuse.route.scrobble")
    /// 跳到「歌单」分区 (删除当前歌单后用)。主容器同时会清掉详情栈, 避免栈里
    /// 还压着刚删掉那张歌单的空详情。
    static let primuseSelectPlaylists = Notification.Name("primuse.route.playlists")
    /// 跳到资料库的「电台」分区。首页电台分区的「全部」用它 —— 电台在资料库里
    /// 只有一个目的地, 不该再 push 一个带返回键的重复页面。
    static let primuseSelectRadio = Notification.Name("primuse.route.radio")
}
#endif
