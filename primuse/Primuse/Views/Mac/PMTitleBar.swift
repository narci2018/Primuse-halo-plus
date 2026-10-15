#if os(macOS)
import SwiftUI
import AppKit
import PrimuseKit

/// 主窗口顶部 48pt 自定义 title bar — 跟设计稿里的 TitleBar 对齐:
/// 原生窗口按钮、居中搜索、右侧工具按钮。
///
/// 四 tab 外壳里它同时是「返回」的落点：底下那排 tab 相当于 iPhone 的
/// `TabView`，页内钻进去的分区/源详情没有侧栏可以退回，就退回本 tab 的根页。
struct PMTitleBar: View {
    @Binding var searchText: String
    @Binding var selection: MacRoute
    /// 当前页不是它所属 tab 的根页时置真 —— 只有这时左侧才出现返回箭头。
    var showsBack: Bool = false
    var onBack: () -> Void = {}
    var onAddSource: () -> Void = {}
    var onAudioOutput: () -> Void = {}

    @Environment(\.pmAppearance) private var mode
    @FocusState private var searchFocused: Bool
    @State private var keyboardShortcuts = MacKeyboardShortcutStore.shared
    /// titlebar 右上喇叭按钮的 popover 显示状态 — 设计稿 P-21 Output Picker。
    /// 之前 onAudioOutput 是空 callback 让点击没反应; 现在把 popover 直接挂在
    /// 按钮上, 点击就弹真 AudioOutputPickerView。
    @State private var audioOutputShown = false

    var body: some View {
        ZStack {
            if MacPhoneLayout.isPhoneForm {
                phoneRow
            } else {
                wideRow
            }
        }
        .padding(.horizontal, 14)
        .frame(height: PMSize.titlebar)
        .background(titlebarBackground.ignoresSafeArea(edges: .top))
        .overlay(alignment: .bottom) {
            Rectangle().fill(PMColor.divider).frame(height: 0.5)
        }
    }

    /// 宽窗口（不是竖屏形态）那一套：三色灯 + 品牌 + 弹性空档 + 右工具，
    /// 搜索框另外钉在整条的几何中心。
    private var wideRow: some View {
        ZStack {
            // The traffic lights and the three trailing tools have different
            // widths. Putting the search field between two flexible gaps
            // therefore centered it in the leftover space, not in the window.
            // Keep the chrome in the base layer and pin search to the title
            // bar's geometric center.
            HStack(spacing: 8) {
                PMStandardWindowButtonArea()
                if showsBack {
                    PMRoundBtn(icon: "chevron.left", iconSize: 12, style: .glass,
                               help: "back_to_options", action: onBack)
                }
                brandMark
                windowDragSpacer
                trailingControls
            }

            // 设计稿对比: 搜索框比当前版本更窄 + 更高 (高/宽比约 30/25 = 1.2x)。
            // idealWidth 收到 320, maxWidth 380, 高度提到 36 让上下 padding 更松,
            // 视觉比例接近设计图。
            searchBox
                .frame(minWidth: 240, idealWidth: 320, maxWidth: 380)
                .frame(height: 36)
                .zIndex(1)
        }
    }

    /// 竖屏形态：这一行可用宽度只剩 365pt。上面那套「品牌字 + 居中搜索(min 240) +
    /// 右两枚按钮」加起来 480 出头，搜索框会把三色灯和右侧按钮一起挤出窗口。
    /// 改成 iPhone 导航栏的做法 —— 搜索框贴着左侧吃满剩余宽度，品牌标识让给
    /// Dock 和菜单栏（竖屏这一行本来就放不下字标）。
    /// 中间那条 12pt 是拖窗口的落点：`isMovableByWindowBackground` 被窗口
    /// 修容逻辑按死为 false，窗口又不许拉大，没有这一段就没法挪动它。
    private var phoneRow: some View {
        HStack(spacing: 8) {
            PMStandardWindowButtonArea()

            if showsBack {
                PMRoundBtn(icon: "chevron.left", iconSize: 12, style: .glass,
                           help: "back_to_options", action: onBack)
            }

            searchBox
                .frame(maxWidth: .infinity)
                .frame(height: 30)

            PMWindowDragRegion()
                .frame(width: 12, height: PMSize.titlebar)

            trailingControls
        }
    }

    /// Use concrete AppKit views for the flexible title-bar gaps. Keeping the
    /// drag bridge in `.background` left it behind SwiftUI's hosting view, so
    /// clicks in those gaps could be swallowed before AppKit saw a double-click.
    private var windowDragSpacer: some View {
        PMWindowDragRegion()
            .frame(minWidth: 12, maxWidth: .infinity, maxHeight: .infinity)
    }

    /// 侧栏去掉之后，「猿音 / Primuse」这个品牌标识只剩标题栏这一个落点了
    /// （以前它画在侧栏顶部）。放在窗口按钮右边，宽度不够时自动被拖拽区挤掉。
    private var brandMark: some View {
        HStack(spacing: 8) {
            BrandMonogram(slot: .sidebar)

            Text(verbatim: PMAppDisplayName())
                .font(.system(size: 14, weight: .semibold))
                .tracking(-0.3)
                .foregroundStyle(PMColor.text)
        }
        .padding(.leading, 2)
    }

    private var trailingControls: some View {
        HStack(spacing: 8) {
            PMRoundBtn(icon: "hifispeaker.2.fill", iconSize: 12, style: .glass,
                       help: "audio_output") {
                audioOutputShown.toggle()
                onAudioOutput()
            }
            .popover(isPresented: $audioOutputShown, arrowEdge: .top) {
                // AudioOutputPickerView 自己 frame(width: 280), 系统 popover 自动
                // 配合内容尺寸。不再额外加 padding/frame, 避免跟系统 chrome 重叠。
                AudioOutputPickerView()
            }
            PMRoundBtn(icon: "plus", iconSize: 13, style: .glass,
                       help: "add_source", action: onAddSource)
        }
    }

    // MARK: - Search box

    private var searchBox: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(PMColor.textFaint)

            TextField("", text: $searchText, prompt: Text("search_placeholder_universal"))
                .textFieldStyle(.plain)
                .font(.system(size: 12.5))
                .foregroundStyle(PMColor.text)
                .focused($searchFocused)
                .onSubmit {
                    if MacTitleBarSearchPolicy.shouldActivateSearch(
                        for: searchText,
                        isOnSearch: isOnSearch
                    ) {
                        selectSearchRoute()
                    }
                    releaseSearchFocus()
                }
                .onExitCommand(perform: releaseSearchFocus)
                .onChange(of: searchText) { _, value in
                    if MacTitleBarSearchPolicy.shouldActivateSearch(
                        for: value,
                        isOnSearch: isOnSearch
                    ) {
                        selectSearchRoute()
                    }
                }

            if !searchText.isEmpty {
                Button {
                    searchText = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 11))
                        .foregroundStyle(PMColor.textFaint)
                }
                .buttonStyle(.plain)
            } else {
                Text(verbatim: keyboardShortcuts.shortcut(for: .focusSearch)?.displayString ?? "—")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(PMColor.textFaint.opacity(0.7))
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background {
            // 设计稿 TitleBar 里搜索框是 *实白* 填充 (bg-elev), 不是玻璃覆盖 —
            // 之前用 glassBtn 半透黑叠在米色 titlebar 上呈现粉桃色, 跟设计稿不一致。
            // 圆角降到 7 (设计稿是接近矩形的圆角胶囊, 不是大圆 pill); 描边只在 focus
            // 时上 brand 高亮, 平时用极淡 divider 描一圈。
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(PMColor.bgElev)
                .shadow(color: Color.black.opacity(0.06), radius: 1, y: 0.5)
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .strokeBorder(
                    searchFocused
                        ? PMColor.brand.opacity(0.55)
                        : PMColor.divider.opacity(0.6),
                    lineWidth: 0.5
                )
        }
        .onReceive(NotificationCenter.default.publisher(for: .primuseFocusSearch)) { _ in
            searchFocused = true
            selectSearchRoute()
        }
        .onReceive(NotificationCenter.default.publisher(for: .primuseDismissSearchFocus)) { _ in
            releaseSearchFocus()
        }
        .onChange(of: selection.stableID) { _, _ in
            releaseSearchFocusIfNeeded()
        }
        .onAppear {
            releaseSearchFocusIfNeeded()
        }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification)) { _ in
            releaseSearchFocusIfNeeded()
        }
    }

    private var isOnSearch: Bool {
        if case .search = selection { return true }
        return false
    }

    @ViewBuilder
    private var titlebarBackground: some View {
        // 设计稿: TitleBar 背景 = var(--pm-bg) (浅色: #F3F4F6 冷中性灰, 深色: #161719) +
        // rgba(255,255,255,.04) 微亮覆盖, 跟整窗 bg 同色调。之前用 .headerView material
        // 会去 blend 窗外内容, 在浅色系统上偏纯白, 跟整窗中性灰 bg 不一致, 顶部看着像「贴
        // 了块白条」。直接用 PMColor.bg 实色就跟下面 detail 区无缝接上。
        if mode == .glass {
            ZStack {
                Rectangle().fill(PMColor.bg)
                Rectangle().fill(Color.white.opacity(0.04))
            }
        } else {
            Rectangle().fill(PMColor.bg)
        }
    }

    private func selectSearchRoute() {
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            selection = .search
        }
    }

    private func releaseSearchFocusIfNeeded() {
        guard MacTitleBarSearchPolicy.shouldReleaseFocus(isOnSearch: isOnSearch) else { return }
        releaseSearchFocus()
    }

    private func releaseSearchFocus() {
        searchFocused = false
        searchText = MacTitleBarSearchPolicy.queryAfterReleasingFocus(searchText)

        // SwiftUI's FocusState can say `false` while AppKit restores the field
        // editor as the real first responder after launch. Release it on the
        // next main-loop turn as well so an unmodified Space reaches the
        // playback shortcut instead of becoming invisible search whitespace.
        Task { @MainActor in
            await Task.yield()
            guard !searchFocused else { return }
            searchFocused = false
            guard let window = NSApp.keyWindow,
                  window.attachedSheet == nil,
                  window.sheetParent == nil,
                  Self.isTitleBarSearchFirstResponder(in: window) else {
                return
            }
            window.makeFirstResponder(nil)
        }
    }

    private static func isTitleBarSearchFirstResponder(in window: NSWindow) -> Bool {
        let field: NSTextField?
        if let directField = window.firstResponder as? NSTextField {
            field = directField
        } else if let fieldEditor = window.firstResponder as? NSTextView {
            field = fieldEditor.delegate as? NSTextField
        } else {
            field = nil
        }

        guard let field,
              field.window === window,
              let contentView = window.contentView else { return false }
        let frameInWindow = field.convert(field.bounds, to: nil)
        let titleBarFloor = contentView.convert(contentView.bounds, to: nil).maxY - PMSize.titlebar - 12
        return frameInWindow.midY >= titleBarFloor
    }
}

extension Notification.Name {
    static let primuseDetailGoBack    = Notification.Name("primuse.detail.goBack")
    static let primuseDetailGoForward = Notification.Name("primuse.detail.goForward")
    static let primuseFocusSearch     = Notification.Name("primuse.titlebar.focusSearch")
    static let primuseDismissSearchFocus = Notification.Name("primuse.titlebar.dismissSearchFocus")
}

#endif
