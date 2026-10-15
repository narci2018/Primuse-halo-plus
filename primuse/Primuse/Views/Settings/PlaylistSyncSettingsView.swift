import SwiftUI
import PrimuseKit
#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

/// 歌单同步与云端备份设置页
struct PlaylistSyncSettingsView: View {
    @Environment(MusicLibrary.self) private var library
    @AppStorage(PlaylistSyncService.serverURLStorageKey)
    private var serverURL: String = PlaylistSyncService.defaultServerURL

    @State private var showingEditURLDialog = false
    @State private var tempURLText = ""
    @State private var isProcessing = false
    @State private var feedbackAlertTitle = ""
    @State private var feedbackAlertMessage = ""
    @State private var showingFeedbackAlert = false
    @State private var copiedDeviceID = false
    @State private var cloudDevices: [PlaylistSyncService.CloudDeviceSummary] = []
    @State private var devicesLoaded = false
    @State private var isLoadingDevices = false
    @State private var deviceListError: String?
    /// 正在导入的那台设备的机器码；用来只把那一行的按钮转圈，而不是整页禁用。
    @State private var importingDeviceID: String?

    private var lastBackupTimestamp: Double {
        UserDefaults.standard.double(forKey: PlaylistSyncService.lastBackupTimestampKey)
    }

    private var lastBackupDateString: String {
        guard lastBackupTimestamp > 0 else { return "从未备份" }
        let date = Date(timeIntervalSince1970: lastBackupTimestamp)
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }

    var body: some View {
        Form {
            // MARK: - 服务器配置
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text("服务器端点 (API URL)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(serverURL.isEmpty ? "未配置服务器" : serverURL)
                        .font(.system(.footnote, design: .monospaced))
                        .foregroundStyle(serverURL.isEmpty ? .red : .primary)
                        .lineLimit(2)
                }
                .padding(.vertical, 2)

                Button {
                    tempURLText = serverURL.isEmpty ? PlaylistSyncService.defaultServerURL : serverURL
                    showingEditURLDialog = true
                } label: {
                    Label(serverURL.isEmpty ? "设置同步服务器" : "修改服务器地址", systemImage: "pencil")
                }
            } header: {
                Text("同步服务器")
            } footer: {
                Text("用于持久化保存机器码与歌单数据的 Cloudflare Pages 接口地址。")
            }

            // MARK: - 设备信息
            Section {
                HStack {
                    Text("设备名称")
                    Spacer()
                    Text(DeviceIdentity.currentDeviceName)
                        .foregroundStyle(.secondary)
                }

                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("本机唯一标识 (机器码)")
                        Text(DeviceIdentity.currentDeviceID)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Spacer()
                    Button {
                        #if os(iOS)
                        UIPasteboard.general.string = DeviceIdentity.currentDeviceID
                        #elseif os(macOS)
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(DeviceIdentity.currentDeviceID, forType: .string)
                        #endif
                        copiedDeviceID = true
                        Task {
                            try? await Task.sleep(for: .seconds(2))
                            copiedDeviceID = false
                        }
                    } label: {
                        Image(systemName: copiedDeviceID ? "checkmark.circle.fill" : "doc.on.doc")
                            .foregroundStyle(copiedDeviceID ? .green : .accentColor)
                    }
                    .buttonStyle(.plain)
                }
            } header: {
                Text("设备识别")
            }

            // MARK: - 歌单操作
            Section {
                // 1. 备份（上传）
                Button {
                    performBackup()
                } label: {
                    HStack {
                        Label("立即备份到云端（上传歌单）", systemImage: "arrow.up.circle.fill")
                        Spacer()
                        if isProcessing {
                            ProgressView()
                                .controlSize(.small)
                        }
                    }
                }
                .disabled(isProcessing || serverURL.isEmpty)

                // 2. 恢复（拉取）
                Button {
                    performRestore()
                } label: {
                    Label("从云端恢复歌单（拉取同步）", systemImage: "arrow.down.circle.fill")
                }
                .disabled(isProcessing || serverURL.isEmpty)

                HStack {
                    Text("最近备份时间")
                    Spacer()
                    Text(lastBackupDateString)
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text("歌单数据备份与恢复")
            } footer: {
                Text("备份会将当前设备的所有自建歌单及曲目上传至云端；恢复会从云端拉取已保存的歌单并合并到本地资料库。")
            }

            // MARK: - 云端设备 / 跨设备导入
            //
            // Windows 设置页早就有这一块（`primuse-win/src/renderer/app.js:1688-1700`），
            // Apple 侧一直缺，于是"iPhone 那台早就备份好了、新机器上是空的"这种局面
            // 只能靠同一台机器码自己拉 —— 换新 Mac / 重装之后机器码可能变，就彻底够不着。
            // 这一节补上同一套能力：列设备 → 点别人那台 → 把它的歌单合并进本机。
            Section {
                Button {
                    loadCloudDevices()
                } label: {
                    HStack {
                        Label(devicesLoaded ? "刷新云端设备列表" : "查看云端设备列表", systemImage: "person.2.fill")
                        Spacer()
                        if isLoadingDevices {
                            ProgressView()
                                .controlSize(.small)
                        }
                    }
                }
                .disabled(isLoadingDevices || isProcessing || serverURL.isEmpty)

                if let deviceListError {
                    Text(deviceListError)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }

                ForEach(cloudDevices) { device in
                    cloudDeviceRow(device)
                }
            } header: {
                Text("云端设备 / 跨设备导入")
            } footer: {
                Text("列出云端有备份的设备。点「下载它的歌单」会把那台设备的歌单合并进本机：本机仍用自己的机器码，绝不回写对方那一份。同步的是歌单结构，不是歌曲源 —— 曲目到了本机之后走本机的线路解析。")
            }
        }
        .navigationTitle("歌单同步")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .onAppear {
            if serverURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                tempURLText = PlaylistSyncService.defaultServerURL
                showingEditURLDialog = true
            }
        }
        // 修改 URL 的弹窗
        .alert("设置同步服务器 URL", isPresented: $showingEditURLDialog) {
            TextField("https://...", text: $tempURLText)
            Button("取消", role: .cancel) {}
            Button("保存") {
                let trimmed = tempURLText.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty {
                    serverURL = trimmed
                }
            }
        } message: {
            Text("请输入 Cloudflare Pages 部署的歌单同步接口地址：")
        }
        // 结果反馈弹窗
        .alert(feedbackAlertTitle, isPresented: $showingFeedbackAlert) {
            Button("确定", role: .cancel) {}
        } message: {
            Text(feedbackAlertMessage)
        }
    }

    private func performBackup() {
        guard !serverURL.isEmpty else {
            tempURLText = PlaylistSyncService.defaultServerURL
            showingEditURLDialog = true
            return
        }

        isProcessing = true
        Task {
            do {
                let res = try await PlaylistSyncService.shared.backup(serverURL: serverURL, library: library)
                isProcessing = false
                feedbackAlertTitle = "备份成功"
                feedbackAlertMessage = "已成功将本地 \(res.playlistCount) 个歌单（共 \(res.songCount) 首歌曲）备份至云端服务器！"
                showingFeedbackAlert = true
            } catch {
                isProcessing = false
                feedbackAlertTitle = "备份失败"
                feedbackAlertMessage = error.localizedDescription
                showingFeedbackAlert = true
            }
        }
    }

    private func performRestore() {
        guard !serverURL.isEmpty else {
            tempURLText = PlaylistSyncService.defaultServerURL
            showingEditURLDialog = true
            return
        }

        isProcessing = true
        Task {
            do {
                let res = try await PlaylistSyncService.shared.restore(serverURL: serverURL, library: library)
                isProcessing = false
                presentRestoreResult(res)
            } catch {
                isProcessing = false
                feedbackAlertTitle = "拉取失败"
                feedbackAlertMessage = error.localizedDescription
                showingFeedbackAlert = true
            }
        }
    }

    // MARK: - 云端设备列表 / 跨设备导入

    private func cloudDeviceRow(_ device: PlaylistSyncService.CloudDeviceSummary) -> some View {
        let isSelf = device.deviceId == DeviceIdentity.currentDeviceID
        return HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(device.displayName)
                    .font(.body.weight(.medium))
                Text(rowSubtitle(for: device))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            if isSelf {
                Text("本机")
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Color.secondary.opacity(0.15), in: Capsule())
                    .foregroundStyle(.secondary)
            } else {
                Button {
                    importFromCloudDevice(device)
                } label: {
                    if importingDeviceID == device.deviceId {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("下载它的歌单")
                    }
                }
                .buttonStyle(.borderless)
                .disabled(isProcessing || isLoadingDevices || importingDeviceID != nil)
            }
        }
        .padding(.vertical, 2)
    }

    private func rowSubtitle(for device: PlaylistSyncService.CloudDeviceSummary) -> String {
        var parts: [String] = []
        if let platform = device.platform, !platform.isEmpty { parts.append(platform) }
        parts.append("\(device.playlistCount ?? 0) 个歌单")
        parts.append("\(device.songCount ?? 0) 首")
        if let relative = Self.relativeBackupString(device.updatedAt) {
            parts.append(relative)
        }
        return parts.joined(separator: " · ")
    }

    /// 服务端 `updated_at` 是 `Date.now()`，毫秒。
    private static func relativeBackupString(_ milliseconds: Double?) -> String? {
        guard let milliseconds, milliseconds > 0 else { return nil }
        let date = Date(timeIntervalSince1970: milliseconds / 1000)
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: Date())
    }

    private func loadCloudDevices() {
        guard !serverURL.isEmpty else {
            tempURLText = PlaylistSyncService.defaultServerURL
            showingEditURLDialog = true
            return
        }
        isLoadingDevices = true
        deviceListError = nil
        Task {
            do {
                cloudDevices = try await PlaylistSyncService.shared.listCloudDevices(serverURL: serverURL)
                devicesLoaded = true
                isLoadingDevices = false
                if cloudDevices.isEmpty {
                    deviceListError = "云端还没有任何设备的备份。"
                }
            } catch {
                isLoadingDevices = false
                devicesLoaded = true
                cloudDevices = []
                deviceListError = error.localizedDescription
            }
        }
    }

    private func importFromCloudDevice(_ device: PlaylistSyncService.CloudDeviceSummary) {
        guard importingDeviceID == nil else { return }
        importingDeviceID = device.deviceId
        Task {
            defer { importingDeviceID = nil }
            do {
                let res = try await PlaylistSyncService.shared.restore(
                    serverURL: serverURL,
                    library: library,
                    sourceDeviceID: device.deviceId
                )
                presentRestoreResult(res, prefix: "已从「\(device.displayName)」下载")
            } catch {
                feedbackAlertTitle = "导入失败"
                feedbackAlertMessage = error.localizedDescription
                showingFeedbackAlert = true
            }
        }
    }

    private func presentRestoreResult(_ res: PlaylistSyncService.RestoreResult, prefix: String? = nil) {
        // 报的是**本机落下多少**，不是云端有多少。以前这里直接念服务端计数，
        // 于是出现过"已同步 237 首"而屏幕上一个都没有。
        feedbackAlertTitle = res.filledPlaylists > 0 ? "拉取完成" : "云端没有可落地的歌单"
        var lines = [
            "云端：\(res.serverPlaylistCount) 个歌单 / \(res.serverSongCount) 首",
            "本机：\(res.filledPlaylists) 个歌单已有内容，本轮新入单 \(res.addedSongs) 首",
            "对账：本机原本就有 \(res.matchedSongs) 首，新落成在线曲目 \(res.materializedSongs) 首",
        ]
        if res.skippedSongs > 0 {
            lines.append("认不出形状、又没标题没身份，没能落地：\(res.skippedSongs) 首")
        }
        // 跨设备导入时必须让他看清拉的是谁 —— 拉错设备是撤不回来的事。
        let sourceName = res.deviceName.flatMap { $0.isEmpty ? nil : $0 } ?? res.sourceDeviceID
        if res.isOwnBackup {
            lines.append("来源设备：本机（\(sourceName)）")
        } else {
            lines.append("来源设备：\(sourceName)（\(res.sourceDeviceID)）")
        }
        if let prefix {
            lines.insert(prefix, at: 0)
            feedbackAlertTitle = res.filledPlaylists > 0 ? "导入完成" : "那台设备没有可落地的歌单"
        }
        feedbackAlertMessage = lines.joined(separator: "\n")
        showingFeedbackAlert = true
    }
}
