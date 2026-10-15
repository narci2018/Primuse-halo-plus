import SwiftUI
import Observation
import PrimuseKit

// 这里没有写 `@MainActor`：SwiftUI 的 `View` 协议本身就带 `@MainActor`，
// conformity 会把这份隔离传到整个 struct 上（`body` 之外的 helper 也在主 actor 上），
// 所以从 `@State` 的默认值里取 `CloudMusicSources.shared` 这个 MainActor 单例是合法的
// —— 本仓库另外十九个页面（`ScrobbleSettingsView` 的 `ScrobbleService.shared`、
// `MacContentView` 的 `MacUIPreferences.shared`）就是这么写的，CI 一直是绿的。
// 也没有用 `@Environment(CloudMusicSources.self)` —— 这个页面有好几个入口
// （iPhone 设置、iPad/Mac 侧栏的来源页、Mac 独立设置窗口），漏一处注入就是一次运行时崩溃。
public struct AggregatedSourcesSettingsView: View {
    @Environment(AggregatedSourceStore.self) private var store
    @State private var cloud = CloudMusicSources.shared
    @State private var showingAddSheet = false
    @State private var editingSource: AggregatedSourceItem?
    @State private var manifestDraft = ""
    @State private var showingManifestSheet = false

    public init() {}

    private var cloudManagedCount: Int { store.sources.filter { $0.isCloudManaged }.count }
    private var localCount: Int { store.sources.filter { !$0.isCloudManaged }.count }
    /// 真的在播放路径里的那几条（需求 1/3）：搜索、取流、歌词都只走它们。
    private var loadedCount: Int { store.sources.filter { $0.isInPlaybackPath }.count }

    public var body: some View {
        Form {
            cloudSection
            lineListSection
            localAddSection
        }
        .navigationTitle("聚合音乐源设置")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .sheet(isPresented: $showingAddSheet) {
            AggregatedSourceEditSheet(initialSource: nil) { newSource in
                store.addSource(newSource)
            }
        }
        .sheet(item: $editingSource) { source in
            AggregatedSourceEditSheet(initialSource: source) { updatedSource in
                store.updateSource(updatedSource)
            }
        }
        .sheet(isPresented: $showingManifestSheet) {
            ManifestURLSheet(current: $manifestDraft) { url in
                cloud.setManifestURL(url)
                Task { await cloud.refresh(force: true) }
            }
        }
    }

    // MARK: - 云端音乐源管理（需求 3 / 4）

    @ViewBuilder
    private var cloudSection: some View {
        Section {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("聚合音乐在线引擎")
                        .font(.headline)
                    Text("线路名单由云端统一维护：本机只保存下面这一个清单地址，通过解释它得到可用线路。增删改与停用都在服务端后台完成，本机只读 + 刷新。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }

            Button {
                showingManifestSheet = true
                manifestDraft = cloud.manifestURL
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("音乐源清单地址")
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 12)
                    Text(manifestURLShortLabel)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Image(systemName: "chevron.right")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            .buttonStyle(.plain)

            LabeledContent("清单版本") {
                HStack(spacing: 6) {
                    if cloud.revision >= 0 {
                        Text("rev \(cloud.revision)")
                            .font(.callout.monospacedDigit())
                    } else {
                        Text("尚未拉取").foregroundStyle(.secondary)
                    }
                    if let fetchedAt = cloud.fetchedAt {
                        Text("· \(fetchedAt, format: .dateTime.hour().minute())")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if cloud.isRefreshing { ProgressView().controlSize(.small) }
                }
            }

            HStack(spacing: 10) {
                Button {
                    Task {
                        cloud.clearLocalVerdicts()
                        await cloud.refresh(force: true)
                        await cloud.checkAllAvailable()
                    }
                } label: {
                    HStack(spacing: 6) {
                        if cloud.isCheckingAvailability {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "checkmark.seal")
                        }
                        Text(cloud.isCheckingAvailability ? "检测中…" : "检测全部可用")
                    }
                }
                .buttonStyle(.bordered)
                .disabled(cloud.isCheckingAvailability)

                Button {
                    Task { await cloud.refresh(force: true) }
                } label: {
                    Label("刷新清单", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
                .disabled(cloud.isRefreshing)
            }
        } footer: {
            VStack(alignment: .leading, spacing: 4) {
                if !cloud.lastError.isEmpty {
                    Label(cloud.lastError, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                }
                Text("「检测全部可用」的判据是能不能出声：搜索 → 解析直链 → 真取前 64KB 字节做字节层判定。能访问不等于能播放 —— 报错页和反爬页也回 200，过去那个「测速」就是把它们都标成绿色的。")
            }
            .font(.footnote)
        }
    }

    private var manifestURLShortLabel: String {
        guard let host = URL(string: cloud.manifestURL)?.host else { return cloud.manifestURL }
        return host
    }

    // MARK: - 线路列表

    @ViewBuilder
    private var lineListSection: some View {
        Section {
            ForEach(store.sources) { source in
                sourceRow(source)
            }
            .onDelete { indexSet in
                // 云端管下来的线路不允许在本机删（那是后台的权力）；这里只删得掉本机的。
                for index in indexSet where !store.sources[index].isCloudManaged {
                    store.deleteSource(id: store.sources[index].id)
                }
            }
        } header: {
            HStack {
                Text("音源线路（云端 \(cloudManagedCount) · 本机 \(localCount) · 已加载 \(loadedCount)）")
                Spacer()
            }
        } footer: {
            Text("按「能不能出声」上色：绿色可播，灰色是观测盲区（未检出 —— 我们没测出来，不等于它坏了），红色不可播并附删除建议。带「未加载」的只在这里给一个说法，不参与搜索、不取流 —— 云端接管后本机的左右滑动只对本机线路有效。")
                .font(.footnote)
        }
    }

    @ViewBuilder
    private var localAddSection: some View {
        Section {
            Button {
                showingAddSheet = true
            } label: {
                Label("添加本机备用线路", systemImage: "plus.circle.fill")
            }
        } footer: {
            Text("本机线路不参与云端名单，只做紧急备用；云端接管后每次刷新都会保留它们。")
                .font(.footnote)
        }
    }

    @ViewBuilder
    private func sourceRow(_ source: AggregatedSourceItem) -> some View {
        let verdict = cloud.verdict(for: source)
        HStack(alignment: .top, spacing: 12) {
            // 本机线路保留原来的启停开关（这是本机自己的权力）；云端线路的启停在 CF 后台，
            // 这里连开关都不给，免得本机改出一份和服务端不一样的名单。
            if !source.isCloudManaged {
                Toggle("", isOn: Binding(
                    get: { source.isEnabled },
                    set: { _ in store.toggleSource(id: source.id) }
                ))
                .labelsHidden()
            }

            verdictIcon(verdict)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(source.name)
                        .font(.subheadline.weight(.medium))
                    platformBadge(source.platform)
                    protocolBadge(source.protocolType)
                    if source.isCloudManaged {
                        Image(systemName: "cloud")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                Text(source.protocolType == .lxjs ? "音乐网关 /api/music-gateway（脚本在服务端执行）" : source.baseURL)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Text(verdictLine(verdict))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }

            Spacer(minLength: 4)

            VStack(alignment: .trailing, spacing: 4) {
                verdictBadge(verdict)
                // 需求 1/3：这行只是"看得见"，没在播放路径里 —— 得说清是哪一种原因，
                // 否则用户只会看到"云端 50 条，我这边搜出来 14 条"，以为丢了东西。
                if source.isCloudManaged && !source.isInPlaybackPath {
                    Text(notLoadedReason(source, verdict: verdict))
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1.5)
                        .background(Color.secondary.opacity(0.15), in: RoundedRectangle(cornerRadius: 4))
                }
                if source.suggestDelete == true || verdict.tone == .dead {
                    Text("建议删除")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(.red)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1.5)
                        .background(Color.red.opacity(0.12), in: RoundedRectangle(cornerRadius: 4))
                }
            }

            if !source.isCloudManaged {
                Button {
                    editingSource = source
                } label: {
                    Image(systemName: "pencil")
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.vertical, 2)
        .swipeActions(edge: .trailing) {
            if !source.isCloudManaged {
                Button(role: .destructive) {
                    store.deleteSource(id: source.id)
                } label: {
                    Label("删除", systemImage: "trash")
                }
            }
        }
    }

    private func verdictLine(_ verdict: AggregatedSourceVerdict) -> String {
        let who = verdict.origin == .local ? "本机实测" : "服务端结论"
        let bytes = verdict.bytes > 0 ? " · \(verdict.bytes)B" : ""
        return "\(verdict.detail)\(bytes) · \(who)".trimmingCharacters(in: .whitespaces)
    }

    /// 「未加载」后面那句原因 —— 与 Windows 侧 `loadReason()` 同一套分档：
    /// 不可播 / 未检出（我们没测成）/ 本机测出声了但服务端还没确认。
    private func notLoadedReason(_ source: AggregatedSourceItem, verdict: AggregatedSourceVerdict) -> String {
        if source.suggestDelete == true || verdict.tone == .dead { return "未加载 · 不可播" }
        if verdict.tone == .blind { return "未加载 · 未检出" }
        return "未加载 · 待服务端确认"
    }

    /// 不是 `@ViewBuilder`：`ViewBuilder` 会把函数体里的 `switch` 当成"条件视图"去 buildExpression，
    /// 而这里是给变量赋值（`()` 不是 View，CI 就这么报的）。去掉 builder 之后函数体是普通语句，
    /// 所以最后那个视图必须**显式 `return`** —— 隐式尾表达式只在 builder（和单表达式函数）里成立，
    /// 少了这一行 CI 报的是"function declares an opaque return type, but has no return statements"。
    /// 两个错是同一处的上下两半，记下免得下次改回头又踩另一半。
    private func verdictIcon(_ verdict: AggregatedSourceVerdict) -> some View {
        let symbol: String
        switch verdict.tone {
        case .playable: symbol = "play.circle.fill"
        case .blind: symbol = "questionmark.circle"
        case .dead: symbol = "exclamationmark.triangle.fill"
        }
        return Image(systemName: symbol)
            .font(.body)
            .foregroundStyle(verdictColor(verdict))
            .frame(width: 22, alignment: .center)
    }

    @ViewBuilder
    private func verdictBadge(_ verdict: AggregatedSourceVerdict) -> some View {
        Text(verdict.toneLabel)
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(.white)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(verdictColor(verdict), in: Capsule())
    }

    private func verdictColor(_ verdict: AggregatedSourceVerdict) -> Color {
        switch verdict.tone {
        case .playable: return Color(red: 0.12, green: 0.54, blue: 0.36)
        case .blind: return Color(red: 0.37, green: 0.42, blue: 0.53)
        case .dead: return Color(red: 0.75, green: 0.22, blue: 0.17)
        }
    }

    @ViewBuilder
    private func platformBadge(_ platform: AggregatedPlatform) -> some View {
        Text(platform.badgeLabel)
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(.white)
            .padding(.horizontal, 5)
            .padding(.vertical, 1.5)
            .background(platformColor(platform), in: Capsule())
    }

    @ViewBuilder
    private func protocolBadge(_ protocolType: AggregatedProtocolType) -> some View {
        Text(protocolType.badgeLabel)
            .font(.system(size: 9))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 4)
            .padding(.vertical, 1.5)
            .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 4))
    }

    private func platformColor(_ platform: AggregatedPlatform) -> Color {
        switch platform {
        case .qq: return .green
        case .netease: return .red
        case .kugou: return .blue
        case .kuwo: return .orange
        case .migu: return .teal
        case .bilibili: return .cyan
        case .custom: return .purple
        }
    }
}

// MARK: - 清单地址

private struct ManifestURLSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var current: String
    let onSave: (String) -> Void

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://…/api/music-sources", text: $current)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        #endif
                } header: {
                    Text("音乐源清单地址")
                } footer: {
                    Text("客户端只保存这一个 URL：线路名单、可用性结论、洛雪 js 音源、以及首页标题文案，都从这份清单里解释出来。换地址会清掉旧的缓存与云端线路。")
                }
            }
            .navigationTitle("清单地址")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存并刷新") {
                        onSave(current)
                        dismiss()
                    }
                    .disabled(!current.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("http"))
                }
            }
        }
    }
}

// MARK: - Edit / Create Sheet（只有本机线路能进这里）

struct AggregatedSourceEditSheet: View {
    @Environment(\.dismiss) private var dismiss
    let initialSource: AggregatedSourceItem?
    let onSave: (AggregatedSourceItem) -> Void

    @State private var name: String = ""
    @State private var platform: AggregatedPlatform = .qq
    @State private var protocolType: AggregatedProtocolType = .meting
    @State private var baseURL: String = ""
    @State private var priority: Int = 0

    init(initialSource: AggregatedSourceItem?, onSave: @escaping (AggregatedSourceItem) -> Void) {
        self.initialSource = initialSource
        self.onSave = onSave
        _name = State(initialValue: initialSource?.name ?? "")
        _platform = State(initialValue: initialSource?.platform ?? .qq)
        _protocolType = State(initialValue: initialSource?.protocolType ?? .meting)
        _baseURL = State(initialValue: initialSource?.baseURL ?? "https://")
        _priority = State(initialValue: initialSource?.priority ?? 0)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("基本信息") {
                    TextField("音源名称 (如: QQ音乐备用线路)", text: $name)
                    Picker("所属平台", selection: $platform) {
                        ForEach(AggregatedPlatform.allCases, id: \.self) { p in
                            Text(p.displayName).tag(p)
                        }
                    }
                    Picker("接口协议", selection: $protocolType) {
                        // 洛雪 js 音源的脚本只能在服务端跑，本机手工加不了 —— 不放进选项。
                        ForEach(AggregatedProtocolType.localAddableCases, id: \.self) { pt in
                            Text(pt.displayName).tag(pt)
                        }
                    }
                }

                Section {
                    TextField("https://...", text: $baseURL)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        #endif
                } header: {
                    Text("API 接口地址")
                } footer: {
                    Text("请填写标准的 Meting 兼容接口地址或 Music Open API 地址。")
                }

                Section {
                    Stepper("优先级评分: \(priority)", value: $priority, in: -10...100)
                } header: {
                    Text("优先级")
                } footer: {
                    Text("评分越高的线路，在搜索与音频解析时越优先被调用。")
                }
            }
            .navigationTitle(initialSource == nil ? "添加聚合音源" : "编辑音源")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        let trimmedURL = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
                        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
                        let source = AggregatedSourceItem(
                            id: initialSource?.id ?? UUID().uuidString,
                            name: trimmedName.isEmpty ? "\(platform.displayName)线路" : trimmedName,
                            platform: platform,
                            protocolType: protocolType,
                            baseURL: trimmedURL,
                            isEnabled: initialSource?.isEnabled ?? true,
                            priority: priority
                        )
                        onSave(source)
                        dismiss()
                    }
                    .disabled(baseURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}
