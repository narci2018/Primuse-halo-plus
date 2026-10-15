#if os(macOS)
import AppKit
import SwiftUI
import PrimuseKit

/// 开关的 UserDefaults key。单独放一个不带 actor 隔离的 enum：设置页那行要在
/// `@AppStorage(...)` 的属性默认值里引用它，而属性默认值的求值上下文不保证是主 actor。
enum MacMiniaturizedLyricsSettings {
    static let key = "macMiniaturizedLyricsEnabled"
}

/// 最小化后的单行歌词条 —— Windows 那条「任务栏歌词条」（需求 8，
/// `primuse-win/src/main/taskbar-lyric.js` + `taskbar-lyric.html/css`）在 macOS 上的对应物。
///
/// 用户 2026-10-15 的原话是"app最小化，歌词显示模式跟win版一样策略"，所以这里对齐的是
/// **Windows 的五个条件与那条窗口的物理属性**，不是 iPhone 的实时活动，也不是本页上方
/// 那个可以自己拖的桌面歌词面板（`DesktopLyricsWindowController`：多行、带工具栏、
/// 常驻、由用户手动开关）。两者并存：桌面歌词是"我一直想看着词"，这一条是
/// "我把 app 收起来了，别占地方，只在本有一句的时候露一条"。
///
/// 与 Windows 同构的五个条件（`shouldShow()`，少一个就不画 —— 空壳浮在 Dock 上方比没有更烦人）：
///   1. 设置里开着（`MacMiniaturizedLyricsController.settingsKey`，默认开，同 Windows `store.settings().taskbarLyric !== false`）；
///   2. 主窗口真的看不见（最小化 / 关掉 / 找不到了；Windows 是 `isMinimized() || !isVisible()`）；
///   3. 这一首没被用户点 ✕ 收走（Windows 是 `dismissed` 标志 + 换歌时清零；这里直接记"被收走的那首的 key"，
///      效果一样但不用在每条 payload 上判断"key 变了没"）；
///   4. 真的在播（`payload.playing`，暂停 = 收走：定在原地的歌词比没有更碍事）；
///   5. 当前这一句有字（`payload.text` 去掉空白非空 —— 前奏/间奏/纯音乐时不露）。
///
/// 歌曲身份与 Windows 就地算的口径一致：`"标题|歌手"`，不要求渲染侧多传一个字段。
///
/// 那条窗口本身的属性也照 Windows 抄：`skipTaskbar`（NSPanel 天生不进窗口菜单）、
/// 不抢焦点（`.nonactivatingPanel`，一条歌词不许抢走用户正在打的字，但照样收得到点击）、
/// 贴在可视区下沿（visibleFrame 已经避开 Dock，等于"不覆盖任务栏本身"）、
/// 浮在普通窗口之上但不压全屏（`.floating` + 不给 `.fullScreenAuxiliary`）、
/// 每个 Space 都在（`.canJoinAllSpaces`）、固定尺寸不可拖拽（`isMovable = false`）。
@MainActor
final class MacMiniaturizedLyricsController {
    /// 设置页那一行绑的就是 `MacMiniaturizedLyricsSettings.key`（`MacSTLyricsView`）。
    /// 默认开：用户要的就是这个功能（同 Windows `store.settings().taskbarLyric !== false`）。
    static let settingsKey = MacMiniaturizedLyricsSettings.key

    // 与 Windows 同一组数字：560×44，离 Dock 6pt。
    private static let stripWidth: CGFloat = 560
    private static let stripHeight: CGFloat = 44
    private static let bottomGap: CGFloat = 6

    private struct Payload {
        var text = ""
        var title = ""
        var artist = ""
        var playing = false
        var hasLyrics = false

        /// 与 Windows `taskbar-lyric.js` 里 `${title}|${artist}` 逐字符同形。
        var songKey: String { "\(title)|\(artist)" }
    }

    private var panel: NSPanel?
    private var payload = Payload()
    /// 用户点 ✕ 的那一首（`title|artist`）。换歌自然失效。
    private var dismissedSongKey: String?
    private var lastKnownEnabled = true

    /// 同 `DesktopLyricsWindowController`：block-based observer 必须自己持有 token 并在
    /// deinit 注销。nonisolated(unsafe)：仅 init(MainActor) 写、deinit 读，无并发竞争。
    nonisolated(unsafe) private var observers: [NSObjectProtocol] = []

    init() {
        // 让 `UserDefaults.standard.bool(forKey:)` 在没写过的时候返回 true，
        // 与设置页里 `@AppStorage(...) = true` 的默认值同一口径。
        UserDefaults.standard.register(defaults: [Self.settingsKey: true])
        installObservers()
    }

    deinit {
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        observers.removeAll()
    }

    // MARK: - 五个条件

    private var isEnabled: Bool { UserDefaults.standard.bool(forKey: Self.settingsKey) }

    /// 主窗口是不是真的看不见。找不到主窗口也算"看不见"（用户拿红灯把窗口关了，
    /// 播放还在继续 —— Windows 那边是最小化到托盘，同一种处境）。
    private func mainWindowIsOutOfSight() -> Bool {
        guard let window = MacLyricStripMainWindow.find() else { return true }
        return window.isMiniaturized || !window.isVisible
    }

    private var isDismissedForCurrentTrack: Bool {
        guard let dismissedSongKey else { return false }
        return dismissedSongKey == payload.songKey
    }

    private var hasCurrentLine: Bool {
        !payload.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func shouldShow() -> Bool {
        isEnabled
            && mainWindowIsOutOfSight()
            && !isDismissedForCurrentTrack
            && payload.playing
            && hasCurrentLine
    }

    // MARK: - 唯一的出口

    /// 任何状态变化（新词 / 暂停 / 最小化 / 恢复 / 开关 / 换分辨率）都只走这一次判定。
    private func apply() {
        guard shouldShow() else {
            // Windows 那边是 `if (win && !win.isDestroyed() && win.isVisible()) win.hide()` ——
            // 只在真的露着的时候收，并且不收的时候不重复动，免得每推一句词就刷一次窗口。
            if let panel, panel.isVisible {
                panel.orderOut(nil)
                plog("🪟 MiniLyric: 收走（enabled=\(isEnabled) hidden=\(mainWindowIsOutOfSight()) dismissed=\(isDismissedForCurrentTrack) playing=\(payload.playing) hasLine=\(hasCurrentLine)）")
            }
            return
        }
        let panel = ensurePanel()
        panel.setFrame(stripFrame(), display: true)
        if !panel.isVisible {
            panel.orderFrontRegardless()
            plog("🪟 MiniLyric: 露出 \(payload.title) · \(payload.artist)")
        }
    }

    private func hide() {
        guard let panel, panel.isVisible else { return }
        panel.orderOut(nil)
    }

    /// 退出 / 换清单时用（对应 Windows 的 `dispose()` / `hide()`）。
    func dispose() {
        hide()
        panel?.close()
        panel = nil
    }

    // MARK: - 渲染侧推来的"现在这一句"

    /// 对应 Windows 的 `ipcMain.on('taskbar-lyric:set')`：视图只交数据，显示与否一律这里判。
    fileprivate func receive(text: String, title: String, artist: String, playing: Bool, hasLyrics: Bool) {
        payload = Payload(
            text: String(text.prefix(240)),
            title: String(title.prefix(120)),
            artist: String(artist.prefix(120)),
            playing: playing,
            hasLyrics: hasLyrics
        )
        apply()
    }

    /// ✕：这一首之内不再露出（对应 `taskbar-lyric:dismiss`）。
    fileprivate func dismissCurrentTrack() {
        dismissedSongKey = payload.songKey
        apply()
    }

    /// 点整条 = 唤回主窗口（对应 `taskbar-lyric:restore`）。
    fileprivate func restoreMainWindow() {
        NSApp.activate(ignoringOtherApps: true)
        if let window = MacLyricStripMainWindow.find() {
            if window.isMiniaturized { window.deminiaturize(nil) }
            window.makeKeyAndOrderFront(nil)
            hide()
            return
        }
        // 主窗口已被关掉：走 SwiftUI 的 openWindow(id:) 让 WindowGroup 重建一份。
        MainWindowOpener.openMainWindow()
        hide()
    }

    // MARK: - 那条窗口

    private func stripFrame() -> NSRect {
        let screen = NSScreen.main ?? NSScreen.screens.first
        let area = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let width = min(Self.stripWidth, max(280, area.width - 80))
        return NSRect(
            x: (area.midX - width / 2).rounded(),
            // macOS 的原点在左下角：`visibleFrame.minY` 已经是 Dock 上沿。
            y: (area.minY + Self.bottomGap).rounded(),
            width: width,
            height: Self.stripHeight
        )
    }

    private func ensurePanel() -> NSPanel {
        if let panel { return panel }
        let panel = NSPanel(
            contentRect: stripFrame(),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .floating
        panel.isFloatingPanel = true
        panel.isMovable = false
        panel.ignoresMouseEvents = false
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        panel.hidesOnDeactivate = false
        // 不给 autosave name：位置每次按当前屏幕重算（换分辨率 / 插外接屏后重新贴一次），
        // 也不让这条面板混进"找主窗口"的候选集。
        let host = NSHostingController(
            rootView: MacMiniaturizedLyricsView(
                onPush: { [weak self] text, title, artist, playing, hasLyrics in
                    self?.receive(text: text, title: title, artist: artist, playing: playing, hasLyrics: hasLyrics)
                },
                onDismiss: { [weak self] in self?.dismissCurrentTrack() },
                onRestore: { [weak self] in self?.restoreMainWindow() }
            ).applyPrimuseEnvironments()
        )
        host.view.frame = panel.contentView?.bounds ?? .zero
        host.view.autoresizingMask = [.width, .height]
        panel.contentView = host.view
        self.panel = panel
        return panel
    }

    // MARK: - 事件来源

    private func installObservers() {
        let center = NotificationCenter.default
        // 主窗口最小化 / 还原 / 关掉：Windows 那边是 minimize/restore/show/hide 四个事件都喊一声 sync。
        for name in [
            NSWindow.didMiniaturizeNotification,
            NSWindow.didDeminiaturizeNotification,
            NSWindow.didCloseNotification,
            NSWindow.didOcclusionStateNotification
        ] {
            observers.append(center.addObserver(
                forName: name,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor in self?.apply() }
            })
        }
        // 屏幕布局变了（换分辨率 / 插外接屏）：重新贴一次。
        observers.append(center.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.apply() }
        })
        // 退出前收走。
        observers.append(center.addObserver(
            forName: NSApplication.willTerminateNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.dispose() }
        })
        // 设置里的开关：这条是全局 didChange（app 内任何 UserDefaults 写入都会来），
        // 所以只在开关真的变了才动 —— 与 `DesktopLyricsWindowController` 处理 lock 的写法一致。
        // 开关从关到开 = 用户改主意了，上一首点的 ✕ 不该继续生效（Windows 的 `taskbar-lyric:reset`）。
        observers.append(center.addObserver(
            forName: UserDefaults.didChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                guard self.isEnabled != self.lastKnownEnabled else { return }
                self.lastKnownEnabled = self.isEnabled
                if self.isEnabled { self.dismissedSongKey = nil }
                self.apply()
            }
        })
    }
}

/// 主窗口探测。过滤集与 `PrimuseAppDelegate.isMainAppWindow` /
/// `MacMenuBarController.existingMainWindow` 同一份名单（那两处是 private，
/// 这里第三份 copies 由 `criteria-parity-check.js` 第 17 组盯着名单不许漂移）：
/// 副窗口里 mini player / 桌面歌词 / 设置 / 刮削都是 canBecomeMain 的普通窗口，
/// 只按 canBecomeMain 认会误命中，必须联合 autosaveName 排除。
enum MacLyricStripMainWindow {
    private static let nonMainAutosaveNames: Set<String> = [
        "PrimuseMiniPlayer",
        "PrimuseDesktopLyrics_v2",
        "PrimuseSettings",
        "PrimuseScrapeOptions",
        "PrimuseLyricStrip"
    ]

    @MainActor
    static func find() -> NSWindow? {
        NSApp.windows.first { window in
            guard window.canBecomeMain,
                  !(window is NSPanel),
                  !window.styleMask.contains(.utilityWindow) else { return false }
            if let id = window.identifier?.rawValue, id.contains("Settings") { return false }
            if nonMainAutosaveNames.contains(window.frameAutosaveName) { return false }
            return true
        }
    }
}

/// 那条窗口的内容：左「歌名 · 歌手」（次要，窄屏先挤掉）/ 中「当前这一句」（主角，金色，单行省略号）/
/// 右「✕」。整条可点 = 唤回主窗口；✕ 只收这一首。文字全由控制器判定后才会上屏，
/// 这里一个字都不判断"该不该显示"。
struct MacMiniaturizedLyricsView: View {
    var onPush: (String, String, String, Bool, Bool) -> Void
    var onDismiss: () -> Void
    var onRestore: () -> Void

    @Environment(AudioPlayerService.self) private var player
    @Environment(SourceManager.self) private var sourceManager
    @Environment(SourcesStore.self) private var sourcesStore
    @State private var lyrics: [LyricLine] = []

    /// 当前句金色 —— 与 Windows `taskbar-lyric.css` 的 `#e6c068`（App 里 `--gold`）逐位同值，
    /// 也和 Mac 播放页那行 `Color(hex: "E6C068")` 同一支金。
    private let lineColor = Color(hex: "E6C068")
    private let metaColor = Color.white.opacity(0.5)

    private var currentLine: LyricLine? {
        guard let index = LyricPlaybackPositionPolicy.activeLineIndex(in: lyrics, at: player.currentTime),
              lyrics.indices.contains(index) else { return nil }
        return lyrics[index]
    }

    private var lineText: String {
        currentLine?.text.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    /// 去重键：与 Windows `pushTaskbarLyric()` 的 `${playing}|${title}|${text}` 同构
    /// （timeupdate 一秒能来四次，同一句反复推会把那条刷出残影）。
    private var pushKey: String {
        let song = player.currentSong
        return "\(player.isPlaying)|\(song?.title ?? "")|\(song?.artistName ?? "")|\(lineText)"
    }

    var body: some View {
        HStack(spacing: 10) {
            metaText
            currentLineText
            closeButton
        }
        .padding(.horizontal, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background {
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(Color(red: 18 / 255, green: 19 / 255, blue: 23 / 255).opacity(0.86))
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
        }
        .contentShape(Rectangle())
        .onTapGesture { onRestore() }
        .help("点击回到 Primuse")
        .task(id: player.currentSong?.id) { await reloadLyrics() }
        .onChange(of: pushKey, initial: true) { _, _ in push() }
    }

    private var metaText: some View {
        let song = player.currentSong
        let meta = [song?.title, song?.artistName]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
            .joined(separator: " · ")
        return Text(meta)
            .font(.system(size: 11))
            .foregroundStyle(metaColor)
            .lineLimit(1)
            .truncationMode(.tail)
            .frame(maxWidth: 200, alignment: .leading)
            .opacity(meta.isEmpty ? 0 : 1)
    }

    /// 没有当前句时（纯音乐 / 还没到第一句）给一句人话，而不是留一条空壳。
    /// 注意：控制器的第五个条件在这种情形下会把整条收走，所以这句只在"词刚清空的那一帧"露脸 ——
    /// 与 Windows `taskbar-lyric-view.js` 那两处兜底文案完全同形。
    private var currentLineText: some View {
        let hasText = !lineText.isEmpty
        return Text(hasText ? lineText : (lyrics.isEmpty ? "这首歌没有歌词" : "（间奏）"))
            .font(.system(size: 16, weight: hasText ? .semibold : .regular))
            .foregroundStyle(hasText ? lineColor : Color.white.opacity(0.42))
            .lineLimit(1)
            .truncationMode(.tail)
            .frame(maxWidth: .infinity, alignment: .center)
    }

    private var closeButton: some View {
        Button {
            onDismiss()
        } label: {
            Image(systemName: "xmark")
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(Color.white.opacity(0.62))
                .frame(width: 22, height: 22)
                .background(Color.white.opacity(0.10), in: Circle())
        }
        .buttonStyle(.plain)
        .help("这一首不再显示歌词")
        .accessibilityLabel("这一首不再显示歌词")
    }

    private func push() {
        let song = player.currentSong
        onPush(lineText, song?.title ?? "", song?.artistName ?? "", player.isPlaying, !lyrics.isEmpty)
    }

    private func reloadLyrics() async {
        guard let song = player.currentSong else {
            if !lyrics.isEmpty { lyrics = [] }
            return
        }
        let loaded = await LyricsLoader.load(
            for: song,
            sourceManager: sourceManager,
            sourceType: sourcesStore.source(id: song.sourceID)?.type
        )
        guard !Task.isCancelled, player.currentSong?.id == song.id else { return }
        lyrics = loaded
    }
}
#endif
