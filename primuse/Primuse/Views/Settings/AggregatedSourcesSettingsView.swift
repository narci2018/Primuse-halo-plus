import SwiftUI
import PrimuseKit

public struct AggregatedSourcesSettingsView: View {
    @Environment(AggregatedSourceStore.self) private var store
    @State private var showingAddSheet = false
    @State private var editingSource: AggregatedSourceItem?
    @State private var showingResetAlert = false

    public init() {}

    public var body: some View {
        Form {
            Section {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("聚合音乐在线引擎")
                            .font(.headline)
                        Text("支持全网多线路在线搜索、高音质流媒体播放与动态歌词，可随时添加或切换备用线路。")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button {
                        Task { await store.pingAll() }
                    } label: {
                        if store.isPinging {
                            ProgressView().controlSize(.small)
                        } else {
                            Label("测速", systemImage: "bolt.horizontal.circle")
                        }
                    }
                    .buttonStyle(.bordered)
                    .disabled(store.isPinging)
                }
                .padding(.vertical, 4)
            }

            Section {
                ForEach(store.sources) { source in
                    sourceRow(source)
                }
                .onDelete { indexSet in
                    for index in indexSet {
                        let id = store.sources[index].id
                        store.deleteSource(id: id)
                    }
                }
            } header: {
                HStack {
                    Text("聚合音源线路列表 (\(store.sources.count))")
                    Spacer()
                    Button {
                        showingAddSheet = true
                    } label: {
                        Image(systemName: "plus.circle.fill")
                            .imageScale(.large)
                    }
                }
            } footer: {
                Text("左右滑动可删除线路，点击可编辑 URL 或参数。优先使用响应最快的线路进行搜索与音频解析。")
                    .font(.footnote)
            }

            Section {
                Button(role: .destructive) {
                    showingResetAlert = true
                } label: {
                    HStack {
                        Spacer()
                        Text("恢复 HALO-Music 默认音源")
                        Spacer()
                    }
                }
            } footer: {
                Text("将所有线路重置为 HALO-Music 项目推荐的默认高可用线路。")
                    .font(.footnote)
            }
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
        .alert("恢复默认音源？", isPresented: $showingResetAlert) {
            Button("取消", role: .cancel) {}
            Button("确认恢复", role: .destructive) {
                store.resetToDefaults()
            }
        } message: {
            Text("将清除自定义修改并重新加载 HALO-Music 预置的 QQ 音乐与网易云默认线路。")
        }
    }

    @ViewBuilder
    private func sourceRow(_ source: AggregatedSourceItem) -> some View {
        HStack(spacing: 12) {
            Toggle("", isOn: Binding(
                get: { source.isEnabled },
                set: { _ in store.toggleSource(id: source.id) }
            ))
            .labelsHidden()

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(source.name)
                        .font(.subheadline.weight(.medium))
                    platformBadge(source.platform)
                    protocolBadge(source.protocolType)
                }
                Text(source.baseURL)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer()

            if let latency = source.latencyMs {
                latencyBadge(latency)
            }

            Button {
                editingSource = source
            } label: {
                Image(systemName: "pencil")
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
        }
        .padding(.vertical, 2)
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
        Text(protocolType.displayName)
            .font(.system(size: 9))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 4)
            .padding(.vertical, 1.5)
            .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 4))
    }

    @ViewBuilder
    private func latencyBadge(_ ms: Int) -> some View {
        if ms < 0 {
            Text("超时")
                .font(.caption2.bold())
                .foregroundStyle(.red)
        } else {
            Text("\(ms)ms")
                .font(.caption2.monospacedDigit())
                .foregroundStyle(ms < 400 ? .green : (ms < 1200 ? .orange : .red))
        }
    }

    private func platformColor(_ platform: AggregatedPlatform) -> Color {
        switch platform {
        case .qq: return .green
        case .netease: return .red
        case .bilibili: return .blue
        case .custom: return .purple
        }
    }
}

// MARK: - Edit / Create Sheet

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
                        ForEach(AggregatedProtocolType.allCases, id: \.self) { pt in
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
