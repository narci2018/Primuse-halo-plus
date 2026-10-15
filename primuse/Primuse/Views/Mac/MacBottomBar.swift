#if os(macOS)
import SwiftUI
import PrimuseKit

/// 1.6 重设计的底部 Now Playing Bar — 三列布局: 左 cover+title+heart, 中
/// transport+scrubber, 右 secondary controls + volume。两套外观 (Liquid Glass
/// / Classic Material) 由 `pmAppearance` 环境驱动。
struct MacBottomBar: View {
    var isExpanded: Bool = false
    var isQueueShown: Bool = false
    var onToggleNowPlaying: () -> Void = {}
    var onToggleQueue: () -> Void = {}
    var onMiniPlayer: () -> Void = {}
    var onFullScreen: () -> Void = {}

    @Environment(AudioPlayerService.self) private var player
    @Environment(AudioEngine.self) private var engine
    @Environment(MusicLibrary.self) private var library
    @Environment(\.pmAppearance) private var mode
    @AppStorage(FullscreenPlayerEffect.storageKey)
    private var fullscreenPlayerEffectRawValue = FullscreenPlayerEffect.defaultValue.rawValue
    @AppStorage(PlayerAppearancePreferences.showsVolumeBarKey)
    private var showsPlayerVolumeBar = PlayerAppearancePreferences.showsVolumeBarByDefault

    @State private var airPlayShown = false
    @State private var castShown = false
    @State private var coverMenuShown = false
    /// 竖屏形态那一排装不下 Mac 独有的全部控件，其余的收在这一个浮层里。
    @State private var phoneMoreShown = false
    /// 输出设备面板在竖屏也得有自己的宿主（见 `phoneVolumeControl`）。
    @State private var phoneAudioOutShown = false

    var body: some View {
        barContent
            .frame(maxWidth: .infinity)
            .frame(height: PMSize.bottomBar)
            .background {
            // 设计稿玻璃底栏: 浮在窗内, 14px 顶部圆角 + 左右 10pt 间距。背景只在圆角
            // 形状内填充 —— 之前用 NSVisualEffectView 的"吸窗后模糊"会画出一个不跟
            // 圆角走的实心方块, 盖出一块半透明方形; 改用直接 fill 圆角形状的
            // ultraThinMaterial, 圆角之外 (四角 + 左右留白) 完全透明, 看得到后面内容。
            let shape = UnevenRoundedRectangle(
                topLeadingRadius: mode == .glass ? 14 : 0,
                bottomLeadingRadius: 0,
                bottomTrailingRadius: 0,
                topTrailingRadius: mode == .glass ? 14 : 0,
                style: .continuous
            )
            ZStack {
                if mode == .glass {
                    shape.fill(.ultraThinMaterial)     // 半透模糊, 只在圆角内
                    shape.fill(PMColor.barGlassFill)   // 叠一层品牌半透色拉对比 (设计 pm-glass)
                } else {
                    shape.fill(PMColor.bgElev)         // 经典模式: 实色
                }
                // 顶边高光 (Apple "玻璃感" 配方 inset 0 1px 0 rgba(255,255,255,.3))
                shape.strokeBorder(
                    LinearGradient(
                        colors: [.white.opacity(0.4), .white.opacity(0.06)],
                        startPoint: .top, endPoint: .bottom
                    ),
                    lineWidth: 0.5
                )
            }
        }
        .shadow(color: .black.opacity(mode == .glass ? 0.18 : 0), radius: 12, y: -3)
        // 设计稿: 玻璃模式左右留 10pt 浮动间距 (用户确认这个间距是要保留的)。
        .padding(.horizontal, mode == .glass ? 10 : 0)
    }

    @ViewBuilder
    private var barContent: some View {
        if MacPhoneLayout.isPhoneForm {
            phoneRow
        } else {
            wideRow
        }
    }

    /// 宽窗口那套三列布局（左 260 / 中弹性 / 右 260）。只在窗口不锁手机宽度时用。
    private var wideRow: some View {
        HStack(alignment: .center, spacing: 14) {
            leftColumn
                .frame(width: 260, alignment: .leading)
            transportColumn
                .frame(maxWidth: .infinity)
            rightColumn
                .frame(width: 260, alignment: .trailing)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }

    // MARK: - 竖屏形态（iPhone 那一条迷你播放条）

    /// 用户 2026-10-16 拍板 macOS 的**外壳形态**照 iPhone 做，窗口钉在 393 宽。
    /// 上面那三列在这里放不下：260 + 260 就已经超过整窗宽度，右半会被挤出窗口，
    /// 看着像"投放、音量、迷你播放器这些按钮凭空不见了"。
    /// iPhone 的迷你条本来就只留「封面 + 曲名 + 播放/下一首」，其余收进
    /// 「正在播放」页 —— 这里同理：把 Mac 独有的那一堆控件收进一个浮层，
    /// 一个都不删，只是不再摊在这一行上。进度条单独占一行，跟 iPhone 的
    /// 迷你条下方那条细进度同一位置。
    private var phoneRow: some View {
        VStack(spacing: 3) {
            HStack(spacing: 8) {
                coverThumb
                    .onTapGesture { onToggleNowPlaying() }

                titleBlock
                    .frame(maxWidth: .infinity, alignment: .leading)

                if player.currentSong != nil, !player.isLiveRadio {
                    likeButton
                }

                playPauseButton

                PMRoundBtn(icon: isQueueShown ? "list.bullet.indent" : "list.bullet",
                           iconSize: 12, style: .plain,
                           isActive: isQueueShown, help: "queue_title") {
                    onToggleQueue()
                }

                phoneMoreControls
            }

            scrubberRow
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    /// Mac 独有、但 iPhone 迷你条上没有的那一簇控件。全部保留，改挂在
    /// 一个浮层里 —— 每个都还在，只是不再是屏幕上一排点不着的小图标。
    private var phoneMoreControls: some View {
        Button { phoneMoreShown.toggle() } label: {
            PMRoundBtnIcon(icon: "slider.horizontal.3", help: "more")
        }
        .buttonStyle(.plain)
        .popover(isPresented: $phoneMoreShown, arrowEdge: .top) {
            phoneMorePopover
        }
        // 投放设备面板在宽窗口那套里挂在右列那枚电视按钮上；竖屏那一列根本不渲染，
        // 光把 `castShown` 置真没有任何宿主，面板一次都不会出现。所以这里在同一枚
        // 「更多」按钮上再挂一个 popover，用同一个状态变量。
        .popover(isPresented: $castShown, arrowEdge: .top) {
            CastDevicePickerSheet()
                .frame(minWidth: 360, minHeight: 460)
        }
        .popover(isPresented: $phoneAudioOutShown, arrowEdge: .top) {
            AudioOutputPickerView()
        }
    }

    private var phoneMorePopover: some View {
        VStack(alignment: .leading, spacing: 12) {
            if !player.isLiveRadio {
                popoverToggleRow(icon: isExpanded ? "text.bubble.fill" : "text.bubble",
                                 title: LocalizedStringKey("lyrics_word"),
                                 isOn: isExpanded) {
                    phoneMoreShown = false
                    onToggleNowPlaying()
                }
                popoverToggleRow(icon: "tv.and.hifispeaker.fill",
                                 title: LocalizedStringKey("cast_picker_title"),
                                 isOn: player.isCastingMode) {
                    phoneMoreShown = false
                    castShown = true
                }

                // 随机与循环只对歌曲有意义，直播电台那两条在宽窗口版本里也是藏起来的。
                popoverToggleRow(icon: "shuffle",
                                 title: LocalizedStringKey("shuffle"),
                                 isOn: player.shuffleEnabled) {
                    player.shuffleEnabled.toggle()
                }
                popoverToggleRow(icon: repeatIconName,
                                 title: LocalizedStringKey("repeat"),
                                 isOn: player.repeatMode != .off) {
                    cycleRepeat()
                }
            }

            Divider()

            phoneVolumeControl

            Divider()

            popoverActionRow(icon: "rectangle.inset.filled.on.rectangle",
                             title: LocalizedStringKey("mini_player")) {
                phoneMoreShown = false
                onMiniPlayer()
            }
            popoverActionRow(icon: "arrow.up.left.and.arrow.down.right",
                             title: LocalizedStringKey("full_screen_player")) {
                phoneMoreShown = false
                onFullScreen()
            }
            if ImmersiveEffectEntryPolicy.showsMacQuickAccess(
                hasCurrentSong: player.currentSong != nil,
                isLiveRadio: player.isLiveRadio
            ) {
                fullscreenEffectMenu
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            // 「加入歌单 / 刮削 / 歌曲信息 / 分享 / 睡眠定时」那一串不在这里：
            // `PlayerMoreMenu` 自己是 Button + popover，套在本 popover 里点开会把外层
            // 直接关掉。它本来就在「正在播放」页右上角（`floatingControls`）有一份，
            // 竖屏形态点封面/歌词按钮先进那一页，那枚 ⋯ 一直在。
        }
        .padding(14)
        .frame(width: 260)
    }

    private func popoverToggleRow(icon: String, title: LocalizedStringKey,
                                  isOn: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: icon)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(isOn ? PMColor.brand : PMColor.textMuted)
                    .frame(width: 18)
                Text(title)
                    .font(.system(size: 12.5))
                    .foregroundStyle(PMColor.text)
                Spacer(minLength: 6)
                if isOn {
                    Image(systemName: "checkmark")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(PMColor.brand)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func popoverActionRow(icon: String, title: LocalizedStringKey,
                                  action: @escaping () -> Void) -> some View {
        popoverToggleRow(icon: icon, title: title, isOn: false, action: action)
    }

    // MARK: - Left column

    private var leftColumn: some View {
        HStack(spacing: 10) {
            coverThumb
                .onTapGesture { onToggleNowPlaying() }

            titleBlock

            Spacer(minLength: 4)

            if player.currentSong != nil, !player.isLiveRadio {
                likeButton
            }
        }
    }

    private var titleBlock: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(player.currentSong?.title ?? String(localized: "player_empty_title"))
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(player.currentSong == nil ? PMColor.textMuted : PMColor.text)
                .lineLimit(1)
                .truncationMode(.tail)
            Text(metaLine.isEmpty ? String(localized: "player_empty_message") : metaLine)
                .font(.system(size: 11.5))
                .foregroundStyle(PMColor.textMuted)
                .lineLimit(1)
                .truncationMode(.tail)
        }
    }

    private var likeButton: some View {
        let song = player.currentSong
        let liked = song.map { library.isLiked(songID: $0.id) } ?? false
        return Button {
            if let song { library.toggleLiked(songID: song.id) }
        } label: {
            Image(systemName: liked ? "heart.fill" : "heart")
                .font(.system(size: 13))
                .foregroundStyle(liked ? PMColor.brand : PMColor.textMuted)
                .frame(width: 28, height: 28)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(Text(liked ? "a11y_unlike" : "a11y_like"))
        .animation(.easeOut(duration: 0.12), value: liked)
    }

    /// 竖屏那一行只有 393 宽，48 的封面会把曲名挤到只剩几个字；
    /// iPhone 的迷你条用的是 30，这里取 38 兼顾macOS 的鼠标点击目标。
    private var coverThumbSize: CGFloat { MacPhoneLayout.isPhoneForm ? 38 : 48 }

    private var coverThumb: some View {
        Group {
            if let station = player.currentRadioStation, player.isLiveRadio {
                RadioStationArtworkView(station: station, size: coverThumbSize, cornerRadius: 5)
            } else if let song = player.currentSong {
                CachedArtworkView(
                    coverRef: song.coverArtFileName,
                    songID: song.id,
                    size: coverThumbSize, cornerRadius: 5,
                    sourceID: song.sourceID,
                    filePath: song.filePath,
                    fileFormat: song.fileFormat
                )
            } else {
                CoverArtView(data: nil, size: coverThumbSize, cornerRadius: 5)
            }
        }
        .help(Text(isExpanded ? "close" : "now_playing"))
    }

    private var metaLine: String {
        let parts = [
            player.currentSong.flatMap { library.artistDisplayName(for: $0) },
            player.currentSong?.albumTitle,
        ]
            .compactMap { $0 }.filter { !$0.isEmpty }
        return parts.joined(separator: " · ")
    }

    // MARK: - Transport column

    private var transportColumn: some View {
        VStack(spacing: 4) {
            HStack(spacing: 6) {
                if !player.isLiveRadio {
                    transportBtn("shuffle", size: 13, active: player.shuffleEnabled, help: "shuffle") {
                        player.shuffleEnabled.toggle()
                    }
                }
                if !player.isLiveRadio || player.canSwitchRadioStation {
                    transportBtn("backward.fill", size: 13, help: player.isLiveRadio ? "radio_previous_station" : "previous_song") {
                        Task { await player.previous() }
                    }
                }
                playPauseButton

                if !player.isLiveRadio || player.canSwitchRadioStation {
                    transportBtn("forward.fill", size: 13, help: player.isLiveRadio ? "radio_next_station" : "next_song") {
                        Task { await player.next() }
                    }
                }
                if !player.isLiveRadio {
                    transportBtn(repeatIconName, size: 13, active: player.repeatMode != .off, help: "repeat") {
                        cycleRepeat()
                    }
                }
            }

            scrubberRow
        }
    }

    private var scrubberRow: some View {
        MacBottomBarProgress()
    }

    private var repeatIconName: String {
        switch player.repeatMode {
        case .off, .all: return "repeat"
        case .one:       return "repeat.1"
        }
    }

    private func cycleRepeat() {
        switch player.repeatMode {
        case .off: player.repeatMode = .all
        case .all: player.repeatMode = .one
        case .one: player.repeatMode = .off
        }
    }

    /// 中间那枚圆形播放/暂停。宽栏和竖屏迷你条共用一份，图标、状态、
    /// 加载中的转圈都跟着同一个条件走 —— 两边各抄一遍迟早会走岔。
    private var playPauseButton: some View {
        Button { player.togglePlayPause() } label: {
            ZStack {
                Circle().fill(PMColor.brand).frame(width: 36, height: 36)
                if player.isLoading && !player.isLiveRadio {
                    ProgressView().controlSize(.small).tint(.white)
                } else {
                    Image(systemName: player.isLiveRadio && (player.isPlaying || player.isLoading)
                        ? "stop.fill"
                        : (player.isPlaying ? "pause.fill" : "play.fill"))
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(.white)
                        .contentTransition(.symbolEffect(.replace))
                        .offset(x: player.isPlaying ? 0 : 1)
                }
            }
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(player.isLoading && !player.isLiveRadio)
        .help(Text(player.isLiveRadio && (player.isPlaying || player.isLoading)
            ? "radio_stop"
            : (player.isPlaying ? "pause" : "play")))
    }

    private func transportBtn(_ symbol: String, size: CGFloat,
                              active: Bool = false,
                              help: LocalizedStringKey,
                              action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: size, weight: .semibold))
                .foregroundStyle(active ? PMColor.brand : PMColor.text)
                .frame(width: 28, height: 28)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(Text(help))
    }

    // MARK: - Right column

    private var rightColumn: some View {
        HStack(spacing: 8) {
            if !player.isLiveRadio {
                PMRoundBtn(icon: isExpanded ? "text.bubble.fill" : "text.bubble",
                           iconSize: 12, style: .plain,
                           isActive: isExpanded, help: "lyrics_word",
                           action: onToggleNowPlaying)

                PMRoundBtn(icon: isQueueShown ? "list.bullet.indent" : "list.bullet",
                           iconSize: 12, style: .plain,
                           isActive: isQueueShown, help: "queue_title") {
                    onToggleQueue()
                }

                PMRoundBtn(icon: "tv.and.hifispeaker.fill", iconSize: 12, style: .plain,
                           isActive: player.isCastingMode, help: "cast_picker_title") {
                    castShown = true
                }
                .popover(isPresented: $castShown, arrowEdge: .top) {
                    CastDevicePickerSheet()
                        .frame(minWidth: 420, minHeight: 460)
                }
            }

            volumeControl

            PMRoundBtn(icon: "rectangle.inset.filled.on.rectangle", iconSize: 12, style: .plain,
                       help: "mini_player", action: onMiniPlayer)
            if ImmersiveEffectEntryPolicy.showsMacQuickAccess(
                hasCurrentSong: player.currentSong != nil,
                isLiveRadio: player.isLiveRadio
            ) {
                fullscreenEffectMenu
            }
            PMRoundBtn(icon: "arrow.up.left.and.arrow.down.right", iconSize: 12, style: .plain,
                       help: "full_screen_player", action: onFullScreen)

            if !player.isLiveRadio {
                PlayerMoreMenu {
                    PMRoundBtnIcon(icon: "ellipsis", help: "more")
                }
                .frame(width: PMSize.medBtn, height: PMSize.medBtn)
            }
        }
    }

    private var fullscreenPlayerEffect: FullscreenPlayerEffect {
        FullscreenPlayerEffect(rawValue: fullscreenPlayerEffectRawValue) ?? .defaultValue
    }

    private var fullscreenEffectMenu: some View {
        Menu {
            ForEach(FullscreenEffectCollection.allCases) { collection in
                Section {
                    ForEach(collection.effects) { candidate in
                        Button {
                            fullscreenPlayerEffectRawValue = candidate.rawValue
                            FullscreenPlayerEffectSync.shared.select(candidate)
                        } label: {
                            Label(
                                candidate.localizedTitle,
                                systemImage: candidate == fullscreenPlayerEffect
                                    ? "checkmark"
                                    : candidate.symbolName
                            )
                        }
                    }
                } header: {
                    Text(verbatim: collection.title)
                }
            }
        } label: {
            PMRoundBtnIcon(icon: "sparkles.tv", help: "fullscreen_effect_settings_title")
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .accessibilityLabel(Text("fullscreen_effect_settings_title"))
    }

    private var volumeControl: some View {
        HStack(spacing: 5) {
            volumeMuteButton { airPlayShown.toggle() }
                .popover(isPresented: $airPlayShown, arrowEdge: .top) {
                    AudioOutputPickerView()
                }

            volumeSlider
        }
    }

    /// 竖屏浮层里那一行。滑块同一个，但那枚喇叭不能用它自己的 popover：
    /// popover 套 popover，一点就把外层关掉，输出设备面板一次都出不来（`PlayerMoreMenu`
    /// 在 §33 里栽的是同一个坑）。所以这里改成先把外层关掉，再由「更多」按钮上的
    /// 第三个 popover 承载面板。
    private var phoneVolumeControl: some View {
        HStack(spacing: 5) {
            volumeMuteButton {
                phoneMoreShown = false
                phoneAudioOutShown = true
            }

            volumeSlider
        }
    }

    private func volumeMuteButton(_ openPicker: @escaping () -> Void) -> some View {
        Button(action: openPicker) {
            Image(systemName: volumeSymbol)
                .font(.system(size: 12))
                .foregroundStyle(PMColor.textMuted)
                .frame(width: 18)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(Text("audio_output"))
    }

    @ViewBuilder
    private var volumeSlider: some View {
        if showsPlayerVolumeBar {
            // AppKit slider opts out of window-background dragging, so volume
            // drags do not move the hidden-titlebar window.
            PMVolumeSlider(value: Binding(
                get: { Double(engine.volume) },
                set: { player.setPlaybackVolume(Float($0)) }
            ), isEnabled: player.isLiveRadio || player.playbackSettings.outputMode == .effects,
               accessibilityHelp: !player.isLiveRadio && player.playbackSettings.outputMode == .highFidelity
                   ? String(localized: "volume_high_fidelity_system_hint")
                   : nil)
            .frame(width: 72)
            .help(!player.isLiveRadio && player.playbackSettings.outputMode == .highFidelity
                ? Text("volume_high_fidelity_system_hint")
                : Text("volume"))
        }
    }

    private var volumeSymbol: String {
        let v = engine.volume
        if v <= 0.001 { return "speaker.slash.fill" }
        if v < 0.4 { return "speaker.wave.1.fill" }
        if v < 0.75 { return "speaker.wave.2.fill" }
        return "speaker.wave.3.fill"
    }
}

/// 把 `currentTime` 的高频观察限制在进度条内，避免每次播放器 tick 都重算
/// 整个底栏（封面、菜单、投放设备和音量控件）。
private struct MacBottomBarProgress: View {
    @Environment(AudioPlayerService.self) private var player
    @State private var dragValue: Double?

    /// 电台态的中间列。直播流没有时长也没法拖拽，硬套音乐那套
    /// 「时间 — 进度条 — 剩余」只会留下一条空槽；这里换成实时频谱 +
    /// 连接状态 + 已连时长，宽度也收窄到内容需要的尺寸。
    private var radioStatusLine: some View {
        let isBuffering = player.isLoading
        let isActive = player.isPlaying && !isBuffering
        let statusMaxWidth: CGFloat = MacPhoneLayout.isPhoneForm ? .infinity : 340

        return HStack(spacing: PMSpace.s10) {
            HStack(spacing: 5) {
                Circle()
                    .fill(isActive ? Color.red : PMColor.textFaint)
                    .frame(width: 6, height: 6)
                Text(isBuffering ? String(localized: "radio_buffering") : String(localized: "live_badge"))
                    .font(.system(size: 10, weight: .bold))
                    .tracking(0.8)
                    .foregroundStyle(isActive ? PMColor.brand : PMColor.textMuted)
            }

            if isActive {
                MacRadioLevelBars()
            }

            if let detail = streamDetail {
                Text(detail)
                    .font(.system(size: 10.5))
                    .foregroundStyle(PMColor.textFaint)
                    .lineLimit(1)
            }

            Spacer(minLength: 8)

            Text(player.currentTime.formattedDuration)
                .font(.system(size: 10.5, design: .monospaced))
                .monospacedDigit()
                .foregroundStyle(PMColor.textFaint)
                .help(Text("radio_connected_for"))
        }
        // 宽窗口时那条状态线限到 340 是为了跟中间列同宽居中；竖屏形态整行
        // 就 393，限宽反而让右边的已连时长贴不到边。
        .frame(maxWidth: statusMaxWidth)
    }

    /// 「128 kbps · MP3」。仅在左栏正显示曲目元数据时才补 —— 没有元数据时
    /// 左栏回落显示的就是 `playbackSubtitle`(同样是码率/格式)，再显示一遍就重了。
    private var streamDetail: String? {
        guard player.radioMetadataTitle?.isEmpty == false else { return nil }
        var parts: [String] = []
        if let bitRate = player.radioBitRate, bitRate > 0 {
            parts.append("\(bitRate / 1_000) kbps")
        }
        if player.radioStreamFormat != .automatic {
            parts.append(player.radioStreamFormat.displayName)
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    var body: some View {
        if player.isLiveRadio {
            radioStatusLine
        } else {
        let current = dragValue ?? player.currentTime
        let duration = max(player.duration, 0.001)
        let progressMaxWidth: CGFloat = MacPhoneLayout.isPhoneForm ? .infinity : 560

        HStack(spacing: 8) {
            Text(player.currentSong == nil ? "--:--" : current.formattedDuration)
                .font(.system(size: 10.5, design: .monospaced))
                .monospacedDigit()
                .foregroundStyle(PMColor.textFaint)
                .frame(minWidth: 36, alignment: .trailing)

            Scrubber(
                value: current,
                total: duration,
                onDrag: { dragValue = $0 },
                onCommit: { value in
                    player.seek(to: value)
                    dragValue = nil
                }
            )
            .frame(height: 14)
            .opacity(player.currentSong == nil ? 0.4 : 1)

            Text(player.currentSong == nil ? "--:--" : "-\(max(0, duration - current).formattedDuration)")
                .font(.system(size: 10.5, design: .monospaced))
                .monospacedDigit()
                .foregroundStyle(PMColor.textFaint)
                .frame(minWidth: 36, alignment: .leading)
        }
        .frame(maxWidth: progressMaxWidth)
        }
    }
}

// MARK: - Scrubber

private struct Scrubber: View {
    let value: Double
    let total: Double
    var onDrag: (Double) -> Void
    var onCommit: (Double) -> Void

    @State private var hover = false
    @State private var dragging = false

    var body: some View {
        GeometryReader { geo in
            let width = geo.size.width
            let frac = total > 0 ? CGFloat(max(0, min(1, value / total))) : 0
            let dotSize: CGFloat = (hover || dragging) ? 10 : 0
            let barHeight: CGFloat = (hover || dragging) ? 4 : 3

            ZStack(alignment: .leading) {
                Capsule()
                    .fill(PMColor.dividerStrong)
                    .frame(height: barHeight)

                Capsule()
                    .fill(PMColor.brand)
                    .frame(width: max(0, min(width, width * frac)), height: barHeight)

                if dotSize > 0 {
                    Circle()
                        .fill(.white)
                        .frame(width: dotSize, height: dotSize)
                        .shadow(color: .black.opacity(0.25), radius: 1, y: 1)
                        .overlay {
                            Circle().strokeBorder(.black.opacity(0.15), lineWidth: 0.5)
                        }
                        .offset(x: max(0, min(width - dotSize, width * frac - dotSize / 2)))
                }
            }
            .frame(height: geo.size.height, alignment: .center)
            .contentShape(Rectangle())
            .onHover { h in withAnimation(.easeInOut(duration: 0.12)) { hover = h } }
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { g in
                        guard width > 0, total > 0 else { return }
                        dragging = true
                        let frac = max(0, min(1, g.location.x / width))
                        onDrag(Double(frac) * total)
                    }
                    .onEnded { g in
                        guard width > 0, total > 0 else { dragging = false; return }
                        let frac = max(0, min(1, g.location.x / width))
                        onCommit(Double(frac) * total)
                        dragging = false
                    }
            )
        }
    }
}

// MARK: - PlayerMoreMenu label helper

/// 没有点击行为的纯展示 icon — 给 PlayerMoreMenu 当 label 用 (PlayerMoreMenu
/// 自己接管点击)。复用 PMRoundBtn 的视觉但不要 button。
/// 电台态的律动条。**装饰性动画，不是真实频谱** —— 直播流走 `AVPlayer`，
/// 拿不到 `AudioVisualizerService` 依赖的 `AVAudioEngine` tap，所以这里只
/// 用固定相位差的正弦摆动表示「正在出声」。仅在真的在播时才挂起来(调用方
/// 已用 `isActive` 判过)，不会在暂停/缓冲时空跳。
private struct MacRadioLevelBars: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var phase = false

    private let heights: [CGFloat] = [5, 11, 7, 13, 8]

    var body: some View {
        HStack(alignment: .center, spacing: 2) {
            ForEach(Array(heights.enumerated()), id: \.offset) { index, height in
                Capsule()
                    .fill(PMColor.brand.opacity(0.75))
                    .frame(width: 2, height: phase ? height : height * 0.4)
                    .animation(
                        reduceMotion
                            ? nil
                            : .easeInOut(duration: 0.42 + Double(index) * 0.07)
                                .repeatForever(autoreverses: true),
                        value: phase
                    )
            }
        }
        .frame(height: 14)
        .accessibilityHidden(true)
        .onAppear { phase = true }
    }
}

private struct PMRoundBtnIcon: View {
    var icon: String
    var help: LocalizedStringKey

    @Environment(\.pmAppearance) private var mode
    @State private var hover = false

    var body: some View {
        Image(systemName: icon)
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(PMColor.text)
            .frame(width: PMSize.medBtn, height: PMSize.medBtn)
            .background(hover ? (mode == .glass ? PMColor.glassBtnHover : PMColor.matBtnHover) : .clear, in: .circle)
            .help(Text(help))
            .onHover { hover = $0 }
            .animation(.easeOut(duration: 0.12), value: hover)
    }
}

#endif
