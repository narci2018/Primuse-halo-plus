#if os(macOS)
import SwiftUI
import AppKit
import PrimuseKit

/// macOS 根布局: 自定义 TitleBar + 正文 + BottomBar + 四 tab。
///
/// 目的地这一层跟 iPhone (`ContentView.swift` 的 `TabView`) 和 Windows
/// (`index.html` 的 `.tabbar`) 是同一套：首页 / 资料库 / 搜索 / 设置。以前的
/// 三栏壳把资料库的十个分区、全部歌单、音乐源和五个工具都摊在最外层的侧栏里,
/// 那些内容现在回到它们在另外两端本来的位置 —— 分区在资料库页内切换,
/// 源和工具在设置页里。标题栏背景透明且内容延伸至顶部,导航和搜索由
/// `PMTitleBar` 绘制,窗口控制保留 AppKit 原生实现。
struct MacContentView: View {
    @State private var selection: MacRoute = .home
    @State private var detailNavigationID = UUID()
    /// 每个 tab 上次停在哪儿（存成持久化 ID，回来时用 `route(for:)` 校验对象
    /// 还在不在，歌单被删了就退回根页）。iPhone 的 `TabView` 天然记住每条栈，
    /// 这里补上同样的行为，切走再切回不会被甩回根页。
    @State private var lastRouteIDPerTab: [MacTab: String] = [:]
    @State private var nowPlayingPresented = false
    @State private var queuePresented = false
    @State private var isWindowFullScreen = false
    @State private var hostWindow: NSWindow?
    @State private var searchText = ""
    @State private var songLocationRequest: SongLibraryLocationRequest?
    /// 发给资料库页的入口指令（「全部歌曲」/「在资料库中显示」/电台「全部」）。
    @State private var libraryDeepLink: LibraryDeepLink?
    /// 资料库页当前停在哪个分区（`LibraryView` 通过 `onActiveSectionChange` 报上来）。
    /// 非 nil = 已经从 hub 钻进去了，标题栏的「返回」因此出现 —— 外壳没有侧栏，
    /// 也没有能画在导航栏上的系统返回按钮（`windowToolbar` 是隐藏的），
    /// 所以钻多深都一键回到本 tab 的根页。
    @State private var libraryActiveSection: LibrarySection?
    @State private var didRestorePersistedRoute = false
    @State private var preferences = MacUIPreferences.shared
    @State private var showInitialOnboarding = false
    /// Keep the one-tap lyrics scrape above `MacNowPlayingView`'s lifetime.
    /// The expanded player is removed from the view tree when it is collapsed;
    /// a task/state owned by that child can therefore lose its UI completion
    /// path halfway through a request. `MacContentView` stays mounted, so the
    /// scrape continues and publishes its result even while the player is
    /// collapsed.
    @State private var lyricsScrapeTask: Task<Void, Never>?
    @State private var isScrapingCurrentSongLyrics = false
    @State private var lyricsTranscriptionEditorTargetSong: Song?
    @State private var lyricsScrapeAlertMessage: String?
    @State private var showNoScraperSourceAlert = false
    /// 当前打开的工具弹框 (nil = 没开)。「设置」tab 页脚的工具行设置它, sheet 关掉清空。
    @State private var activeTool: MacTool?

    @Environment(\.openWindow) private var openWindow
    @Environment(AudioPlayerService.self) private var player
    @Environment(MusicScraperService.self) private var scraperService
    @Environment(ScraperSettingsStore.self) private var scraperSettings
    @Environment(SourcesStore.self) private var sourcesStore
    @Environment(MusicLibrary.self) private var library
    @Environment(MusicIntelligenceService.self) private var intelligence
    @Environment(\.colorScheme) private var colorScheme
    @AppStorage("primuse.hasSeenOnboarding") private var hasSeenOnboarding = false
    @AppStorage("primuse.navigation.macRoute.v1") private var persistedRouteID = "home"

    var body: some View {
        VStack(spacing: 0) {
            if !isFullScreenNowPlaying {
                PMTitleBar(
                    searchText: $searchText,
                    selection: navigationSelection,
                    showsBack: showsTitleBarBack,
                    onBack: backToTabRoot,
                    onAddSource: { selectRoute(.sources) },
                    onAudioOutput: { /* 由 BottomBar 右侧的喇叭按钮 popover 接管 */ }
                )
            }

            HStack(spacing: 0) {
                ZStack {
                    MacDetailContainer(
                        route: selection,
                        searchText: $searchText,
                        songLocationRequest: $songLocationRequest,
                        libraryDeepLink: $libraryDeepLink,
                        libraryActiveSection: $libraryActiveSection,
                        onShowSongInLibrary: showSongInLibrary,
                        onOpenLibrarySongs: { openLibrary(.section(.songs)) },
                        onOpenSourcesPage: { selectRoute(.sources) },
                        onOpenAggregatedSourcesPage: { selectRoute(.aggregatedSources) },
                        onOpenTool: { activeTool = $0 }
                    )
                        .id(detailNavigationID)
                        .background(PMColor.bg.ignoresSafeArea())

                    if nowPlayingPresented {
                        MacNowPlayingView(onClose: {
                            withAnimation(.easeInOut(duration: 0.25)) {
                                nowPlayingPresented = false
                            }
                        }, isScrapingCurrentSong: isScrapingCurrentSongLyrics,
                           canTranscribeAudio: canTranscribeCurrentSongAudio,
                           onScrapeCurrentSong: startCurrentSongLyricsScrape,
                           onTranscribeAudio: openCurrentSongAudioTranscriptionEditor,
                           onToggleQueue: {
                               withAnimation(.easeInOut(duration: 0.25)) {
                                   queuePresented.toggle()
                               }
                           })
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                        .zIndex(1)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)

                if queuePresented {
                    MacQueuePanel(onClose: {
                        withAnimation(.easeInOut(duration: 0.25)) {
                            queuePresented = false
                        }
                    })
                    .frame(width: 380)
                    .transition(.move(edge: .trailing))
                }
            }
            // 迷你播放条 + 四 tab 一起挂在内容 HStack 底部, 而不是当 VStack 的
            // 第三行 —— 后者会让底栏自带一条等高的窗口底色 (PMColor.bg) 横条, 浮动
            // 卡片的圆角和左右留白处透出的就是这条底色, 看着像卡片背后压了一个方块。
            // 改成 safeAreaInset 后正文的 ignoresSafeArea 背景会一直延伸到窗口底部、
            // 铺到卡片背后, 圆角处透出的是它自己的背景色, 卡片真正"浮"在内容上。
            // 顺序跟 Windows 渲染层一致: 迷你条在上, tab 贴着窗口底边。
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if !isFullScreenNowPlaying {
                    VStack(spacing: 0) {
                        MacBottomBar(
                            isExpanded: nowPlayingPresented,
                            isQueueShown: queuePresented,
                            onToggleNowPlaying: {
                                withAnimation(.easeInOut(duration: 0.25)) {
                                    nowPlayingPresented.toggle()
                                }
                            },
                            onToggleQueue: {
                                withAnimation(.easeInOut(duration: 0.25)) {
                                    queuePresented.toggle()
                                }
                            },
                            onMiniPlayer: {
                                PrimuseAppDelegate.shared?.toggleMiniPlayer()
                            },
                            onFullScreen: {
                                PrimuseAppDelegate.shared?.toggleFullScreenPlayer()
                            }
                        )

                        MacTabBar(selection: selection.tab) { tab in
                            selectTab(tab)
                        }
                    }
                }
            }
        }
        .songBatchRemovalFeedback()
        .environment(\.pmAppearance, preferences.appearance)
        .background(PMColor.bg.ignoresSafeArea())
        .background(PMWindowChromeConfigurator())
        .ignoresSafeArea(.container, edges: .top)
        .sheet(isPresented: $showInitialOnboarding) {
            OnboardingView()
                .frame(minWidth: 720, minHeight: 560)
        }
        .sheet(item: $activeTool) { tool in
            toolSheet(tool)
        }
        .sheet(item: $lyricsTranscriptionEditorTargetSong) { song in
            LyricsEditorSheet(song: song, autoStartsAudioTranscription: true) { updated in
                guard player.currentSong?.id == updated.id else { return }
                NotificationCenter.default.post(
                    name: .primuseLyricsDidChange,
                    object: updated.id
                )
            }
        }
        // 新建歌单 / 智能歌单 / AI 歌单的入口在资料库的「歌单」分区里
        // (`PlaylistListView` 自己的 + 菜单, 与 iPhone 同一处), 外壳不再各留一份。
        .alert(
            String(localized: "server_favorite_update_failed_title"),
            isPresented: Binding(
                get: { library.serverFavoriteErrorMessage != nil },
                set: { if !$0 { library.dismissServerFavoriteError() } }
            )
        ) {
            Button("done", role: .cancel) {}
        } message: {
            Text(library.serverFavoriteErrorMessage ?? "")
        }
        .alert(String(localized: "scrape_song"),
               isPresented: Binding(
                   get: { lyricsScrapeAlertMessage != nil },
                   set: { if !$0 { lyricsScrapeAlertMessage = nil } }
               )) {
            Button("done", role: .cancel) {}
        } message: {
            Text(lyricsScrapeAlertMessage ?? "")
        }
        .scraperSourceRequiredAlert(isPresented: $showNoScraperSourceAlert)
        .task {
            restorePersistedRouteIfNeeded()
            MainWindowOpener.register(openWindow)
            if !hasSeenOnboarding && sourcesStore.sources.isEmpty {
                hasSeenOnboarding = true
                showInitialOnboarding = true
            }
        }
        .onChange(of: colorScheme, initial: true) { _, _ in
            // `.system` 下 AppKit 不会重新调用偏好 setter；由根视图监听实际
            // effective appearance，重绘带明暗资源变体的 Dock 图标。
            preferences.applyAppIcon()
        }
        .onChange(of: selection) { _, route in
            persistedRouteID = persistenceID(for: route)
        }
        .onReceive(NotificationCenter.default.publisher(for: .primuseRequestExpandNowPlaying)) { note in
            let animated = note.userInfo?[PrimuseNowPlayingExpansion.animatedKey] as? Bool ?? true
            if animated {
                withAnimation(.easeInOut(duration: 0.25)) {
                    nowPlayingPresented = true
                    queuePresented = false
                }
            } else {
                var transaction = Transaction(animation: nil)
                transaction.disablesAnimations = true
                withTransaction(transaction) {
                    nowPlayingPresented = true
                    queuePresented = false
                }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .primuseSelectScrobble)) { _ in
            activeTool = .scrobble
        }
        .onReceive(NotificationCenter.default.publisher(for: .primuseSelectPlaylists)) { _ in
            // 删除当前歌单之后回到资料库的「歌单」分区 —— 外壳没有侧栏了，
            // 回首页等于把用户放到了一个跟刚才无关的页面。
            openLibrary(.section(.playlists))
        }
        .onReceive(NotificationCenter.default.publisher(for: .primuseSelectRadio)) { _ in
            openLibrary(.section(.radio))
        }
        .onReceive(NotificationCenter.default.publisher(for: .primuseDetailOpenAlbum)) { note in
            guard note.object is Album else { return }
            nowPlayingPresented = false
        }
        .onReceive(NotificationCenter.default.publisher(for: .primuseDetailOpenArtist)) { note in
            guard note.object is Artist else { return }
            nowPlayingPresented = false
        }
        .background {
            PMWindowResolver { window in
                hostWindow = window
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didEnterFullScreenNotification)) { note in
            guard let window = note.object as? NSWindow, window === hostWindow else { return }
            isWindowFullScreen = true
        }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didExitFullScreenNotification)) { note in
            guard let window = note.object as? NSWindow, window === hostWindow else { return }
            isWindowFullScreen = false
        }
    }

    /// 工具弹框内容 —— 每个工具的 macBody 已经是自带 header/footer 的
    /// 整面板, 这里只负责按当前 `MacTool` 选一个塞进 sheet。
    @ViewBuilder
    private func toolSheet(_ tool: MacTool) -> some View {
        switch tool {
        case .lyricsConverter:
            LyricsFormatConverterView()
        case .duplicates:
            DuplicateSongsView()
        case .scrobble:
            ScrobbleSettingsView()
        case .cacheSync:
            MacAudioCacheSyncView()
        case .deviceTransfer:
            WiFiTransferView()
        }
    }

    private var isFullScreenNowPlaying: Bool {
        isWindowFullScreen && nowPlayingPresented
    }

    private func startCurrentSongLyricsScrape() {
        guard lyricsScrapeTask == nil,
              let displayedSong = player.currentSong else { return }

        scraperSettings.performSingleSongScrapeAction(
            from: .macNowPlayingAutomaticLyrics,
            onProceed: { startCurrentSongLyricsScrapeWithEnabledSource(displayedSong) },
            onRequireSource: { showNoScraperSourceAlert = true }
        )
    }

    private func startCurrentSongLyricsScrapeWithEnabledSource(_ displayedSong: Song) {
        isScrapingCurrentSongLyrics = true
        lyricsScrapeTask = Task { @MainActor in
            defer {
                isScrapingCurrentSongLyrics = false
                lyricsScrapeTask = nil
            }

            do {
                let song: Song
                if displayedSong.sourceID == AppleMusicLibraryIdentity.sourceID {
                    song = AppServices.shared.appleMusicLibrary.canonicalLibrarySong(for: displayedSong)
                    if song.id != displayedSong.id {
                        _ = await MetadataAssetStore.shared.preserveLyricsAlias(
                            fromSongID: displayedSong.id,
                            toSongID: song.id
                        )
                        player.adoptCanonicalAppleMusicSong(song, replacing: displayedSong.id)
                    }
                } else {
                    song = displayedSong
                }

                let updatedSong: Song
                let scrapedLyrics: [LyricLine]?
                if song.sourceID == AppleMusicLibraryIdentity.sourceID {
                    let result = try await scraperService.scrapeOnlineLyricsOnly(song: song, in: library)
                    updatedSong = result.song
                    scrapedLyrics = result.lyrics
                } else {
                    let result = try await scraperService.scrapeSingle(song: song, in: library)
                    updatedSong = result.0
                    scrapedLyrics = result.2
                }

                CachedArtworkView.invalidateCache(for: updatedSong.id)
                if let oldRef = song.coverArtFileName {
                    CachedArtworkView.invalidateCache(for: oldRef)
                }
                player.syncSongMetadata(updatedSong)
                player.forceRefreshNowPlayingArtwork()

                // This notification is the view-independent completion path:
                // an expanded player reloads immediately; a collapsed player
                // reads the same song-ID cache on its next appearance.
                NotificationCenter.default.post(
                    name: .primuseLyricsDidChange,
                    object: updatedSong.id,
                    userInfo: lyricsChangeUserInfo(scrapedLyrics)
                )
                lyricsScrapeAlertMessage = String(localized: scrapedLyrics?.isEmpty == false
                    ? "scrape_song_success"
                    : "scrape_lyrics_not_found")
            } catch {
                lyricsScrapeAlertMessage = String(localized: "scrape_song_failed")
            }
        }
    }

    private func lyricsChangeUserInfo(
        _ lyrics: [LyricLine]?
    ) -> [AnyHashable: Any]? {
        guard let lyrics, !lyrics.isEmpty else { return nil }
        return ["lyrics": lyrics]
    }

    private var canTranscribeCurrentSongAudio: Bool {
        guard let song = player.currentSong else { return false }
        return intelligence.isAudioTranscriptionConfigured
            && AIAudioTranscriptionPolicy.supportsInput(format: song.fileFormat)
            && song.sourceID != AppleMusicLibraryIdentity.sourceID
            && song.cueSheetPath == nil
            && (song.duration <= 0
                || song.duration <= AIAudioTranscriptionPolicy.maximumDuration)
    }

    private func openCurrentSongAudioTranscriptionEditor() {
        guard canTranscribeCurrentSongAudio,
              lyricsScrapeTask == nil,
              let song = player.currentSong else { return }
        lyricsTranscriptionEditorTargetSong = song
    }

    private var navigationSelection: Binding<MacRoute> {
        Binding(get: { selection }, set: { selectRoute($0) })
    }

    /// 标题栏要不要出返回键。两条来源：路由本身不是本 tab 的根页（例如从设置
    /// 进了音乐源管理），或者资料库 tab 已经从 hub 钻进了某个分区。
    private var showsTitleBarBack: Bool {
        if !selection.isTabRoot { return true }
        return selection == .library && libraryActiveSection != nil
    }

    private func backToTabRoot() {
        if selection == .library {
            openLibrary(.root)
        } else {
            selectRoute(selection.tab.route)
        }
    }

    private func selectRoute(_ route: MacRoute) {
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            nowPlayingPresented = false
            if route.tab != selection.tab {
                // 离开一个 tab 时记住它停在哪儿，回来时用 `route(for:)` 还原
                // （那个函数顺带校验歌单/来源还在不在，被删了就退回根页）。
                lastRouteIDPerTab[selection.tab] = persistenceID(for: selection)
            }
            selection = route
            libraryActiveSection = route.tab == .library ? libraryActiveSection : nil
            // 直接目标 NavigationLink 的展示状态不在 path 内，换页需重建整栈。
            detailNavigationID = UUID()
        }
    }

    /// 底下四格之一的点击。跟 iPhone 的 `TabView` 一样：切走的 tab 停在它上次
    /// 那一页；**已经在这格上再点一次 = 回到本 tab 的根页** —— macOS 的系统
    /// 导航栏是隐藏的（`toolbar(.hidden, for: .windowToolbar)`），`LibraryView`
    /// 恢复上次浏览位置时也不会回报分区，所以这一记永远是把栈清干净的后手。
    private func selectTab(_ tab: MacTab) {
        guard tab != selection.tab else {
            if !selection.isTabRoot || selection == .library {
                backToTabRoot()
            }
            return
        }
        selectRoute(lastRouteIDPerTab[tab].flatMap { route(for: $0) } ?? tab.route)
    }

    /// 把「跳到资料库的某一处」交给 iPhone 那份 `LibraryView` 自己做，
    /// 外壳只负责切到资料库 tab。
    private func openLibrary(_ link: LibraryDeepLink) {
        if selection == .library {
            libraryDeepLink = link
            if link == .root { libraryActiveSection = nil }
            return
        }
        libraryDeepLink = link
        selectRoute(.library)
    }

    private func showSongInLibrary(_ song: Song) {
        songLocationRequest = SongLibraryLocationRequest(songID: song.id)
        openLibrary(.song(song.id))
    }

    private func restorePersistedRouteIfNeeded() {
        guard !didRestorePersistedRoute else { return }
        didRestorePersistedRoute = true
        selectRoute(route(for: persistedRouteID) ?? .home)
    }

    private func persistenceID(for route: MacRoute) -> String {
        switch route {
        case .home: return "home"
        case .library: return "library"
        case .stats: return "stats"
        case .search: return "search"
        case .settings: return "settings"
        case .sources: return "sources"
        case .aggregatedSources: return "aggregated-sources"
        case .section(let section): return "section:\(section.rawValue)"
        case .liked: return "liked"
        case .playlist(let playlist): return "playlist:\(playlist.id)"
        case .smartPlaylist(let smartPlaylist): return "smart:\(smartPlaylist.id)"
        case .source(let sourceID): return "source:\(sourceID)"
        }
    }

    private func route(for persistedID: String) -> MacRoute? {
        switch persistedID {
        case "home": return .home
        case "library": return .library
        case "stats": return .stats
        case "search": return .search
        case "settings": return .settings
        case "sources": return .sources
        case "aggregated-sources": return .aggregatedSources
        case "liked": return .liked
        default: break
        }

        if let rawValue = identifier(in: persistedID, after: "section:"),
           let section = LibrarySection(rawValue: rawValue) {
            return .section(section)
        }
        if let playlistID = identifier(in: persistedID, after: "playlist:") {
            guard let playlist = library.playlists.first(where: { $0.id == playlistID }) else {
                return .section(.playlists)
            }
            return .playlist(playlist)
        }
        if let smartPlaylistID = identifier(in: persistedID, after: "smart:") {
            guard let smartPlaylist = library.smartPlaylists.first(where: { $0.id == smartPlaylistID }) else {
                return .section(.playlists)
            }
            return .smartPlaylist(smartPlaylist)
        }
        if let sourceID = identifier(in: persistedID, after: "source:") {
            return sourcesStore.sources.contains(where: { $0.id == sourceID })
                ? .source(sourceID)
                : .sources
        }
        return nil
    }

    private func identifier(in value: String, after prefix: String) -> String? {
        guard value.hasPrefix(prefix) else { return nil }
        return String(value.dropFirst(prefix.count))
    }
}

#endif
