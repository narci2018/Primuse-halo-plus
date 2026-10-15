import Foundation
import PrimuseKit

/// 歌单同步与云端备份服务
@MainActor
final class PlaylistSyncService {
    static let shared = PlaylistSyncService()

    static let defaultServerURL = "https://primuse-sync-server.pages.dev/api/sync-playlists"
    static let serverURLStorageKey = "primuse_playlist_sync_server_url"
    static let lastBackupTimestampKey = "primuse_playlist_sync_last_time"

    struct SyncSongEntry: Codable, Sendable {
        let id: String
        let title: String
        let artist: String?
        let album: String?
        let duration: Double?
        let filePath: String?
        let sourceId: String?
    }

    struct SyncPlaylistEntry: Codable, Sendable {
        let id: String
        let name: String
        let createdAt: Double
        let updatedAt: Double
        let songs: [SyncSongEntry]
    }

    struct BackupRequestPayload: Codable, Sendable {
        let deviceId: String
        let deviceName: String
        let platform: String
        let playlists: [SyncPlaylistEntry]
    }

    struct SyncResponseEnvelope<T: Codable & Sendable>: Codable, Sendable {
        let code: Int
        let message: String?
        let error: String?
        let data: T?
    }

    struct BackupResponseData: Codable, Sendable {
        let deviceId: String
        let playlistCount: Int
        let songCount: Int
        let updatedAt: Double
    }

    struct RestoreResponseData: Codable, Sendable {
        let deviceId: String
        let deviceName: String?
        let platform: String?
        let playlistCount: Int
        let songCount: Int
        let createdAt: Double?
        let updatedAt: Double?
        let playlists: [SyncPlaylistEntry]
    }

    /// `restore()` 的实际战果 —— 服务端的 `playlistCount` / `songCount` 只说明
    /// "云上有多少"，不说明"本机落下了多少"。上一版设置页把前者当成后者播报
    /// （"已同步 6 个歌单（共 237 首）"），而屏幕上是 0 首，用户自然认为
    /// "拉取失败"。所以这里把两个数分开带回去，反馈文案必须说本机这几个数。
    struct RestoreResult: Sendable {
        let deviceId: String
        let deviceName: String?
        /// 云端那一侧的原始计数（用来对账："云上 237，本机落下 237"）。
        let serverPlaylistCount: Int
        let serverSongCount: Int
        /// 本机真正有内容的歌单数（拉完非空的那些）。
        let filledPlaylists: Int
        /// 本轮真正进单的歌数（已有歌单里新加的那些；重复拉取会是 0）。
        let addedSongs: Int
        /// 其中：本机资料库已经有、按 id 或 曲名+歌手 对上号的。
        let matchedSongs: Int
        /// 其中：本机没有、这一轮才落成自包含在线曲目的。
        let materializedSongs: Int
        /// 认不出形状、又缺 id / 标题，连元数据都留不下的（应当极少）。
        let skippedSongs: Int
        /// 这次是从哪台设备拉的（跨设备导入时不是本机）。
        let sourceDeviceID: String
        /// 拉的是不是本机自己那一份备份。
        let isOwnBackup: Bool
    }

    /// 云端设备概览 —— `GET` 不带 `deviceId` 时服务端返回的那张表
    /// （`cf-sync-server/functions/api/sync-playlists.js:157-168`，`LIMIT 50`，按 `updated_at` 倒序）。
    ///
    /// 字段是 **snake_case**，和单设备那份 `RestoreResponseData` 的 camelCase 不一样，
    /// 所以这里显式写 CodingKeys，不能指望 `keyDecodingStrategy`。
    /// 服务端把 `device_name` / `platform` 允许为 NULL，计数也可能是 0，全部做成可选，
    /// 少一个字段就整个列表解码失败是没道理的。
    struct CloudDeviceSummary: Codable, Identifiable, Sendable {
        let deviceId: String
        let deviceName: String?
        let platform: String?
        let playlistCount: Int?
        let songCount: Int?
        let updatedAt: Double?
        let createdAt: Double?

        var id: String { deviceId }

        /// 界面上显示的名字（和 Windows 一样：没名字就退回机器码）。
        var displayName: String {
            let name = (deviceName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return name.isEmpty ? deviceId : name
        }

        private enum CodingKeys: String, CodingKey {
            case deviceId = "device_id"
            case deviceName = "device_name"
            case platform
            case playlistCount = "playlist_count"
            case songCount = "song_count"
            case updatedAt = "updated_at"
            case createdAt = "created_at"
        }
    }

    struct DeviceListResponseData: Codable, Sendable {
        let devices: [CloudDeviceSummary]
    }

    /// 执行本地歌单备份（上传至 CF 服务器）
    func backup(serverURL: String, library: MusicLibrary) async throws -> BackupResponseData {
        let cleanURLString = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: cleanURLString), url.scheme?.hasPrefix("http") == true else {
            throw NSError(domain: "PlaylistSync", code: 400, userInfo: [NSLocalizedDescriptionKey: "服务器 URL 格式无效"])
        }

        // 收集本地歌单与歌曲
        let localPlaylists = library.playlists.filter { !$0.isDeleted }
        var entries: [SyncPlaylistEntry] = []

        for pl in localPlaylists {
            let songs = library.songs(forPlaylist: pl.id)
            let songEntries = songs.map { song in
                SyncSongEntry(
                    id: song.id,
                    title: song.title,
                    artist: song.artistName,
                    album: song.albumTitle,
                    duration: song.duration > 0 ? song.duration : nil,
                    filePath: song.filePath,
                    sourceId: song.sourceID
                )
            }
            entries.append(SyncPlaylistEntry(
                id: pl.id,
                name: pl.name,
                createdAt: pl.createdAt.timeIntervalSince1970 * 1000,
                updatedAt: pl.updatedAt.timeIntervalSince1970 * 1000,
                songs: songEntries
            ))
        }

        let payload = BackupRequestPayload(
            deviceId: DeviceIdentity.currentDeviceID,
            deviceName: DeviceIdentity.currentDeviceName,
            platform: DeviceIdentity.platformName,
            playlists: entries
        )

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(DeviceIdentity.currentDeviceID, forHTTPHeaderField: "X-Device-ID")
        request.timeoutInterval = 20
        request.httpBody = try JSONEncoder().encode(payload)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpRes = response as? HTTPURLResponse else {
            throw NSError(domain: "PlaylistSync", code: 500, userInfo: [NSLocalizedDescriptionKey: "网络通信错误"])
        }

        let decoded = try JSONDecoder().decode(SyncResponseEnvelope<BackupResponseData>.self, from: data)
        if httpRes.statusCode == 200, decoded.code == 0, let resData = decoded.data {
            UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: Self.lastBackupTimestampKey)
            return resData
        } else {
            throw NSError(domain: "PlaylistSync", code: decoded.code, userInfo: [
                NSLocalizedDescriptionKey: decoded.error ?? decoded.message ?? "服务器返回错误: \(httpRes.statusCode)"
            ])
        }
    }

    /// 从云端拉取歌单（更新至本地）。
    ///
    /// `sourceDeviceID` 为 nil 时拉**本机**那一份；给了别人的机器码就是
    /// Windows 那套「跨设备导入」——读那台设备的备份、合并进本机，
    /// 本机的机器码不变，也绝不回写对方那一条（`primuse-win/src/main/sync.js:205-219` 同语义）。
    ///
    /// 语义与 Windows 端 `primuse-win/src/main/sync.js` 的 `restore()` 对齐 ——
    /// 那一层的注释写得很清楚，是用户明确纠正过的分层：**服务器同步的是歌单结构，
    /// 不是歌曲源**。本机的播放路径（内置聚合线路 / 本机道理鱼源）在播放那一瞬间
    /// 才把 `agg_netease_xxx` 这样的身份解析成真实音频。
    ///
    /// 旧实现只肯把云端条目匹配到"本机资料库里已经有的歌"上（按 id，再按 曲名+歌手），
    /// 匹配不上就静默丢掉。在 iPhone 上恰好看不出来（那些歌本来就是这台机器加进去的），
    /// 但在"没扫描过本地曲库、所有曲目都来自在线源"的 Mac 上，237 条全部匹配失败 →
    /// 建出 6 个空歌单 → 界面 0 首歌，而弹窗按服务端的计数报"已同步 237 首"。
    /// 现在匹配不上的条目一律落成为自包含的在线曲目；本机确实没有对应源的，
    /// 保留元数据、播放时给可读失败，而不是假装这首歌不存在。
    func restore(
        serverURL: String,
        library: MusicLibrary,
        sourceDeviceID: String? = nil
    ) async throws -> RestoreResult {
        let cleanURLString = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var components = URLComponents(string: cleanURLString) else {
            throw NSError(domain: "PlaylistSync", code: 400, userInfo: [NSLocalizedDescriptionKey: "服务器 URL 格式无效"])
        }

        let ownDeviceID = DeviceIdentity.currentDeviceID
        let targetDeviceID = (sourceDeviceID ?? ownDeviceID).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !targetDeviceID.isEmpty else {
            throw NSError(domain: "PlaylistSync", code: 400, userInfo: [NSLocalizedDescriptionKey: "缺少 deviceId（设备机器码）"])
        }

        var queryItems = components.queryItems ?? []
        queryItems.removeAll { $0.name == "deviceId" || $0.name == "device_id" }
        queryItems.append(URLQueryItem(name: "deviceId", value: targetDeviceID))
        components.queryItems = queryItems

        guard let url = components.url else {
            throw NSError(domain: "PlaylistSync", code: 400, userInfo: [NSLocalizedDescriptionKey: "URL 参数生成错误"])
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        // 头里报的是**谁在问**，query 里的才是**问的是谁的数据** —— 服务端 GET 只看 query，
        // 这个头是给日志对账用的。
        request.setValue(ownDeviceID, forHTTPHeaderField: "X-Device-ID")
        request.timeoutInterval = 20

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpRes = response as? HTTPURLResponse else {
            throw NSError(domain: "PlaylistSync", code: 500, userInfo: [NSLocalizedDescriptionKey: "网络通信错误"])
        }

        let decoded = try JSONDecoder().decode(SyncResponseEnvelope<RestoreResponseData>.self, from: data)
        if httpRes.statusCode == 404 || decoded.code == 404 {
            // 服务端对"这台设备从没备份过"给的是 404，不是空列表。
            // 跨设备导入时最容易撞上（列表里能看到、点下去 404），所以要给一句人话，
            // 而不是 "拉取歌单失败: 404"。
            throw NSError(domain: "PlaylistSync", code: 404, userInfo: [
                NSLocalizedDescriptionKey: "云端还没有这台设备的备份（\(targetDeviceID) 从未上传过）。"
                    + "先在那台设备上点「立即备份到云端」，再回来导入。"
            ])
        }
        guard httpRes.statusCode == 200, decoded.code == 0, let resData = decoded.data else {
            throw NSError(domain: "PlaylistSync", code: decoded.code, userInfo: [
                NSLocalizedDescriptionKey: decoded.error ?? decoded.message ?? "拉取歌单失败: \(httpRes.statusCode)"
            ])
        }

        // 本机现有曲目的两张索引：身份键（`agg_…` / `dly_…`）直查，曲名+歌手兜底。
        // 曲名+歌手这一路以前是对 `allSongs` 线性扫（237 条 × 整库），这里改成一次建表。
        let allSongs = library.visibleSongs
        let knownIDs = Set(allSongs.map(\.id))
        var byTitleArtist: [String: String] = [:]
        byTitleArtist.reserveCapacity(allSongs.count)
        for song in allSongs {
            let key = Self.fuzzyKey(title: song.title, artist: song.artistName)
            if byTitleArtist[key] == nil { byTitleArtist[key] = song.id }
        }

        var materialized: [String: Song] = [:]   // 本轮新落地的在线曲目（按 id 去重）
        var matchedSongs = 0
        var materializedSongs = 0
        var skippedSongs = 0

        // 第一遍：把每个云端歌单的条目解析成本机 songID（先把要新建的歌攒齐）。
        var resolved: [(playlist: SyncPlaylistEntry, songIDs: [String])] = []
        resolved.reserveCapacity(resData.playlists.count)

        for remotePl in resData.playlists {
            // 镜像歌单（Apple Music 资料库那类只读快照）不接受外部写入，
            // `MusicLibrary.add` 里也有同一道闸；这里先跳过，免得白算一遍。
            if MirrorPlaylistIdentity.isMirrorPlaylist(remotePl.id) { continue }

            var songIDs: [String] = []
            songIDs.reserveCapacity(remotePl.songs.count)
            for entry in remotePl.songs {
                let id = entry.id.trimmingCharacters(in: .whitespacesAndNewlines)
                if !id.isEmpty, knownIDs.contains(id) {
                    songIDs.append(id)
                    matchedSongs += 1
                    continue
                }
                if let fuzzy = byTitleArtist[Self.fuzzyKey(title: entry.title, artist: entry.artist)] {
                    songIDs.append(fuzzy)
                    matchedSongs += 1
                    continue
                }
                guard let song = Self.song(fromWire: entry) else {
                    skippedSongs += 1
                    continue
                }
                // 同一首歌可以同时挂在两个歌单里（`我喜欢` + `经典`）。第二个歌单再遇到它时
                // 已经在本轮新建表里了 —— 这不代表它没落地，恰恰相反，它必须照样进第二个歌单。
                // `knownIDs` 故意**不**在这里加：它代表"这一轮开始之前本机就有"，
                // 计数才分得清"原本就有"和"这轮刚落"。
                if materialized[song.id] == nil {
                    materialized[song.id] = song
                    materializedSongs += 1
                }
                songIDs.append(song.id)
            }
            resolved.append((remotePl, songIDs))
        }

        // 第二遍：先一次性把新曲目写进资料库，再动歌单。
        // 顺序是硬要求 —— `add(songIDs:toPlaylist:)` 与 `createPlaylist(name:songIDs:)`
        // 都会把 `songIndexByID` 里查不到的 id 静默过滤掉（MusicLibrary.swift:5099 / 5127），
        // 先建歌单再加歌等于把歌丢掉。
        library.registerSongsIfNeeded(Array(materialized.values))

        var filledPlaylists = 0
        var addedSongs = 0
        for item in resolved {
            let remotePl = item.playlist
            let name = remotePl.name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty else { continue }

            // 同 id 优先，其次同名 —— 和旧版一样不造重复歌单。差别在于两条都匹配不上时
            // 用云端那个稳定 id 建单：`createPlaylist` 会另发一个 UUID，下次再拉又对不上号，
            // 多端 / 重装就永远收敛不回来。
            let target = library.playlists.first(where: { $0.id == remotePl.id })
                ?? library.playlists.first(where: { $0.name == name })
            let playlistID = target?.id ?? remotePl.id
            if target == nil {
                library.ensurePlaylist(id: playlistID, name: name)
            }
            guard !item.songIDs.isEmpty else { continue }

            let before = library.songs(forPlaylist: playlistID).count
            library.add(songIDs: item.songIDs, toPlaylist: playlistID)
            let after = library.songs(forPlaylist: playlistID).count
            addedSongs += max(after - before, 0)
            if after > 0 { filledPlaylists += 1 }
        }

        return RestoreResult(
            deviceId: resData.deviceId,
            deviceName: resData.deviceName,
            serverPlaylistCount: resData.playlistCount,
            serverSongCount: resData.songCount,
            filledPlaylists: filledPlaylists,
            addedSongs: addedSongs,
            matchedSongs: matchedSongs,
            materializedSongs: materializedSongs,
            skippedSongs: skippedSongs,
            sourceDeviceID: targetDeviceID,
            isOwnBackup: targetDeviceID == ownDeviceID
        )
    }

    /// 云端设备列表（不带 `deviceId` 的 GET；服务端 `LIMIT 50`、按 `updated_at` 倒序）。
    ///
    /// 这是 Windows 设置页「查看云端设备列表 / 跨设备导入」那一块在 Apple 侧的对应物
    /// （`primuse-win/src/main/sync.js:194-203`）。有了它，"iPhone 备份了、Mac 是空机"
    /// 这种局面才能在一台新设备上自助解决，而不是只能等同名机器码那份。
    func listCloudDevices(serverURL: String) async throws -> [CloudDeviceSummary] {
        let cleanURLString = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: cleanURLString), url.scheme?.hasPrefix("http") == true else {
            throw NSError(domain: "PlaylistSync", code: 400, userInfo: [NSLocalizedDescriptionKey: "服务器 URL 格式无效"])
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(DeviceIdentity.currentDeviceID, forHTTPHeaderField: "X-Device-ID")
        request.timeoutInterval = 20

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpRes = response as? HTTPURLResponse else {
            throw NSError(domain: "PlaylistSync", code: 500, userInfo: [NSLocalizedDescriptionKey: "网络通信错误"])
        }

        // 这份表可能是空的（云端一条备份都没有）。服务端在这种情况下仍然返回 code 0 + `devices: []`，
        // 但 `data` 缺失或列表解码不出来时不该把"没有设备"报成错误。
        let decoded = try? JSONDecoder().decode(SyncResponseEnvelope<DeviceListResponseData>.self, from: data)
        guard httpRes.statusCode == 200, let envelope = decoded, envelope.code == 0 else {
            let detail = decoded?.error ?? decoded?.message ?? "读取设备列表失败: \(httpRes.statusCode)"
            throw NSError(domain: "PlaylistSync", code: decoded?.code ?? httpRes.statusCode, userInfo: [
                NSLocalizedDescriptionKey: detail
            ])
        }
        return envelope.data?.devices ?? []
    }

    /// 曲名+歌手 的匹配键。和旧实现一样是精确相等（不做归一化），只是把对整库的
    /// 线性扫换成一次建表；要不要放宽匹配是另一件事，不在这个改动里。
    private static func fuzzyKey(title: String?, artist: String?) -> String {
        "\(title ?? "")\u{1}\(artist ?? "")"
    }

    /// 正则捕获组（第 1 组起），一个都拿不到就返回 nil。
    private static func captures(in value: String, pattern: String) -> [String]? {
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let hit = regex.firstMatch(in: value, range: NSRange(value.startIndex..., in: value))
        else { return nil }
        var groups: [String] = []
        for index in 1..<hit.numberOfRanges {
            let range = hit.range(at: index)
            guard range.location != NSNotFound, let swiftRange = Range(range, in: value) else { return nil }
            groups.append(String(value[swiftRange]))
        }
        return groups.isEmpty ? nil : groups
    }

    /// 云端条目 → 本机 `Song`。认的三种身份键和 Windows 的 `fromWireSong` 一一对应：
    /// `agg_{platform}_{rawID}`、`/aggregated/{platform}/{rawID}.mp3`、`dly_{sourceID}_{rawID}`。
    /// 三种都对不上的也留一条（id / 路径 / 源原样带上），让它在界面上看得见、
    /// 播放时给一句可读失败 —— "静默消失"正是这次 0 首的成因。
    private static func song(fromWire entry: SyncSongEntry) -> Song? {
        let wireID = entry.id.trimmingCharacters(in: .whitespacesAndNewlines)
        let title = entry.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let artist = (entry.artist ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let album = (entry.album ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let path = (entry.filePath ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let source = (entry.sourceId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !wireID.isEmpty || !title.isEmpty else { return nil }

        let id = wireID.isEmpty ? "sync_\(UUID().uuidString)" : wireID
        let duration = entry.duration ?? 0
        var resolvedPath = path
        var resolvedSource = source

        if let g = captures(in: id, pattern: "^agg_([A-Za-z0-9]+)_(.+)$"),
           let platform = AggregatedPlatform(rawValue: g[0].lowercased()) {
            // 字段形状与 `AggregatedSongItem.toPrimuseSong` 保持一致：这样本机以后自己
            // 从聚合搜索加进来的同一首歌是同一个 id，拉取时按 id 直接对上，不会落两遍。
            if resolvedPath.isEmpty { resolvedPath = "/aggregated/\(platform.rawValue)/\(g[1]).mp3" }
            if resolvedSource.isEmpty { resolvedSource = AggregatedMusicService.systemSourceID }
        } else if captures(in: path, pattern: "^/aggregated/[A-Za-z0-9]+/.+\\.[A-Za-z0-9]+$") != nil {
            if resolvedSource.isEmpty { resolvedSource = AggregatedMusicService.systemSourceID }
        } else if let g = captures(in: id, pattern: "^dly_(.+?)_(.+)$") {
            // 服务器型源（道理鱼那类）：本机配没配这台服务器不影响落地，播放那一刻才知道。
            if resolvedPath.isEmpty { resolvedPath = "/server/\(g[0])/\(g[1])" }
            if resolvedSource.isEmpty { resolvedSource = g[0] }
        }
        if resolvedPath.isEmpty { resolvedPath = "/aggregated/custom/\(id).mp3" }
        if resolvedSource.isEmpty { resolvedSource = AggregatedMusicService.systemSourceID }

        return Song(
            id: id,
            title: title.isEmpty ? "未知歌曲" : title,
            albumID: album.isEmpty ? nil : "agg-album-\(album)",
            artistID: artist.isEmpty ? nil : "agg-artist-\(artist)",
            albumTitle: album.isEmpty ? "在线音源" : album,
            artistName: artist.isEmpty ? "未知歌手" : artist,
            duration: duration > 0 ? duration : 180,
            fileFormat: .mp3,
            filePath: resolvedPath,
            sourceID: resolvedSource,
            fileSize: 0
        )
    }
}
