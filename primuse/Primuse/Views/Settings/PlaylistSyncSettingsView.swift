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
                feedbackAlertTitle = "恢复成功"
                feedbackAlertMessage = "已从云端拉取并同步 \(res.playlistCount) 个歌单（共 \(res.songCount) 首歌曲）到本地！"
                showingFeedbackAlert = true
            } catch {
                isProcessing = false
                feedbackAlertTitle = "恢复失败"
                feedbackAlertMessage = error.localizedDescription
                showingFeedbackAlert = true
            }
        }
    }
}
