#if os(macOS)
import SwiftUI
import PrimuseKit

/// 主内容区容器。四 tab 外壳里它就是 tab 上方那一整块正文（不再有三栏壳的左栏）。
/// 自带一个 NavigationStack，所以从资料库点进专辑 / 艺术家 / 歌单仍然能往下钻。
/// 每次外壳切换 tab（`route` 变）时整栈会被重建 —— `MacContentView` 用
/// `detailNavigationID` 做这件事。
struct MacDetailContainer: View {
    let route: MacRoute
    @Binding var searchText: String
    @Binding var songLocationRequest: SongLibraryLocationRequest?
    /// 「资料库」tab 的入口指令：首页的「全部歌曲」、搜索里的「在资料库中显示」、
    /// 首页电台区的「全部」都往这里塞一个 `LibraryDeepLink`，由 iPhone 那份
    /// `LibraryView` 自己切到对应分区。
    @Binding var libraryDeepLink: LibraryDeepLink?
    /// 反向通道：`LibraryView` 报上来它现在停在哪个分区，外壳据此决定标题栏的
    /// 「返回」出不出现在资料库 tab 上。
    @Binding var libraryActiveSection: LibrarySection?
    let onShowSongInLibrary: (Song) -> Void
    let onOpenLibrarySongs: () -> Void
    /// 「设置」tab 页脚那几行的动作，由外壳翻译成路由 / 弹框。
    let onOpenSourcesPage: () -> Void
    let onOpenAggregatedSourcesPage: () -> Void
    let onOpenTool: (MacTool) -> Void
    @Environment(MusicLibrary.self) private var library
    @Environment(SourcesStore.self) private var sourcesStore
    @State private var path = NavigationPath()

    var body: some View {
        NavigationStack(path: $path) {
            content
                .navigationBarBackButtonHidden(true)
                .transaction { transaction in
                    transaction.animation = nil
                }
                .navigationDestination(for: Album.self) { album in
                    AlbumDetailView(album: album, onMacInlineBack: popDetail)
                        .navigationBarBackButtonHidden(true)
                }
                .navigationDestination(for: Artist.self) { artist in
                    ArtistDetailView(artist: artist, onMacInlineBack: popDetail)
                        .navigationBarBackButtonHidden(true)
                }
                .navigationDestination(for: Playlist.self) { playlist in
                    PlaylistDetailView(playlist: playlist, onMacInlineBack: popDetail)
                        .navigationBarBackButtonHidden(true)
                }
                .navigationDestination(for: SmartPlaylist.self) { smart in
                    SmartPlaylistDetailView(
                        smartPlaylistID: smart.id,
                        onMacInlineBack: popDetail
                    )
                    .navigationBarBackButtonHidden(true)
                }
                // 隐藏 NavigationStack 顶部的原生 toolbar 区域 — 我们用 PMTitleBar
                // 自定义了全局 titlebar, 子视图里的 .toolbar/.searchable 不应再
                // 叠出第二条系统 bar (会出现 "搜索歌曲" + 排序按钮悬空在最顶)。
                .toolbar(.hidden, for: .windowToolbar)
        }
        .environment(\.macFolderShowInLibrary) { song in
            onShowSongInLibrary(song)
        }
        .onReceive(NotificationCenter.default.publisher(for: .primuseDetailGoBack)) { _ in
            if !path.isEmpty { path.removeLast() }
        }
        .onReceive(NotificationCenter.default.publisher(for: .primuseSelectPlaylists)) { _ in
            // 删除当前歌单后跳「歌单」总览。若这张歌单是 push 进来的 (从总览点入),
            // 详情栈里可能还压着它的空详情 — 这里主动清栈。
            guard !path.isEmpty else { return }
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                path = NavigationPath()
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .primuseDetailOpenAlbum)) { note in
            guard let album = note.object as? Album else { return }
            if case .section(.albums) = route {
                clearDetailPath()
                return
            }
            pushAlbum(album)
        }
        .onReceive(NotificationCenter.default.publisher(for: .primuseDetailOpenArtist)) { note in
            guard let artist = note.object as? Artist else { return }
            if case .section(.artists) = route {
                clearDetailPath()
                return
            }
            pushArtist(artist)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch route {
        case .home:
            MacHomeView(openLibrarySongs: onOpenLibrarySongs)
        case .library:
            // 与 iPhone 的「资料库」tab 同一份视图：快捷访问、分类条、
            // 歌单/电台/统计都在它页内切换，不再由外壳摊成侧栏路由。
            LibraryView(
                deepLink: $libraryDeepLink,
                onActiveSectionChange: { libraryActiveSection = $0 }
            )
        case .settings:
            MacSettingsView(
                navigation: MacSettingsNavigationModel.shared,
                embedded: true,
                onOpenSourcesPage: onOpenSourcesPage,
                onOpenAggregatedSourcesPage: onOpenAggregatedSourcesPage,
                onOpenTool: onOpenTool
            )
        case .aggregatedSources:
            // 与 iPhone 设置里同一页（云端清单 URL + 线路开关）。以前 macOS 没有
            // 任何入口能打开它 —— 现在挂在「设置」tab 页脚。
            AggregatedSourcesSettingsView()
        case .stats:
            ListeningStatsView()
        case .sources:
            MacSourcesView()
                .navigationTitle("sources_title")
        case .search:
            SearchView(searchText: $searchText, onShowInLibrary: onShowSongInLibrary)
                .navigationTitle("search_title")
        case .section(let section):
            switch section {
            case .favorites:
                LibraryView(rootSection: .favorites)
            case .folders:
                HomeFolderManagementView()
            case .statistics:
                ListeningStatsView()
            case .recommendations:
                AIRecommendationLibraryView()
                    .navigationTitle(section.title)
            case .songs:
                SongListView(locationRequest: $songLocationRequest)
                    .navigationTitle(section.title)
            case .albums:
                AlbumGridView()
                    .navigationTitle(section.title)
            case .artists:
                ArtistListView(artists: library.visibleArtists)
                    .navigationTitle(section.title)
            case .genres:
                GenreLibraryView()
                    .navigationTitle(section.title)
            case .playlists:
                PlaylistListView()
                    .navigationTitle(section.title)
            case .radio:
                MacRadioStationsView()
                    .navigationTitle(section.title)
            }
        case .liked:
            PlaylistDetailView(
                playlist: library.playlists.first(where: { $0.id == MusicLibrary.likedSongsPlaylistID })
                    ?? Playlist(id: MusicLibrary.likedSongsPlaylistID, name: String(localized: "playlist_liked_name"))
            )
            .navigationTitle("playlist_liked_name")
        case .playlist(let playlist):
            PlaylistDetailView(playlist: playlist)
                .navigationTitle(Text(verbatim: playlist.name))
        case .smartPlaylist(let smart):
            SmartPlaylistDetailView(smartPlaylistID: smart.id)
                .navigationTitle(Text(verbatim: smart.name))
        case .source(let id):
            // Sources don't yet have a per-source detail view — for now
            // route the click to the songs filtered by that source.
            let name = sourcesStore.sources.first(where: { $0.id == id })?.name ?? ""
            SongListView(sourceID: id)
                .navigationTitle(Text(verbatim: name))
        }
    }

    private func pushAlbum(_ album: Album) {
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            path.append(album)
        }
    }

    private func pushArtist(_ artist: Artist) {
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            path.append(artist)
        }
    }

    private func popDetail() {
        guard !path.isEmpty else { return }
        path.removeLast()
    }

    private func clearDetailPath() {
        guard !path.isEmpty else { return }
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            path = NavigationPath()
        }
    }
}
#endif
