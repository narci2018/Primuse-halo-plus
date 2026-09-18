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

    /// 从云端恢复/拉取歌单（更新至本地）
    func restore(serverURL: String, library: MusicLibrary) async throws -> RestoreResponseData {
        let cleanURLString = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var components = URLComponents(string: cleanURLString) else {
            throw NSError(domain: "PlaylistSync", code: 400, userInfo: [NSLocalizedDescriptionKey: "服务器 URL 格式无效"])
        }

        var queryItems = components.queryItems ?? []
        queryItems.append(URLQueryItem(name: "deviceId", value: DeviceIdentity.currentDeviceID))
        components.queryItems = queryItems

        guard let url = components.url else {
            throw NSError(domain: "PlaylistSync", code: 400, userInfo: [NSLocalizedDescriptionKey: "URL 参数生成错误"])
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 20

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpRes = response as? HTTPURLResponse else {
            throw NSError(domain: "PlaylistSync", code: 500, userInfo: [NSLocalizedDescriptionKey: "网络通信错误"])
        }

        let decoded = try JSONDecoder().decode(SyncResponseEnvelope<RestoreResponseData>.self, from: data)
        guard httpRes.statusCode == 200, decoded.code == 0, let resData = decoded.data else {
            throw NSError(domain: "PlaylistSync", code: decoded.code, userInfo: [
                NSLocalizedDescriptionKey: decoded.error ?? decoded.message ?? "拉取歌单失败: \(httpRes.statusCode)"
            ])
        }

        // 匹配与恢复歌单
        let allSongs = library.allSongs
        let songMapByID = Dictionary(allSongs.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })

        for remotePl in resData.playlists {
            // 查找本地是否已存在同名或同 ID 歌单
            var targetPlaylist: Playlist? = library.playlists.first(where: {
                $0.id == remotePl.id || $0.name == remotePl.name
            })

            if targetPlaylist == nil {
                targetPlaylist = library.createPlaylist(name: remotePl.name)
            }

            guard let pl = targetPlaylist else { continue }

            // 匹配歌曲：按 ID 匹配，找不到则按 title + artist 匹配
            var matchedSongIDs: [String] = []
            for rs in remotePl.songs {
                if let local = songMapByID[rs.id] {
                    matchedSongIDs.append(local.id)
                } else if let fuzzy = allSongs.first(where: {
                    $0.title == rs.title && ($0.artistName ?? "") == (rs.artist ?? "")
                }) {
                    matchedSongIDs.append(fuzzy.id)
                }
            }

            if !matchedSongIDs.isEmpty {
                library.add(songIDs: matchedSongIDs, toPlaylist: pl.id)
            }
        }

        return resData
    }
}
