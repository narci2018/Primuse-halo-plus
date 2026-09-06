import Foundation
import PrimuseKit

public enum AggregatedPlatform: String, Codable, Sendable, CaseIterable {
    case qq = "qq"
    case netease = "netease"
    case bilibili = "bilibili"
    case custom = "custom"

    public var displayName: String {
        switch self {
        case .qq: return "QQ 音乐"
        case .netease: return "网易云音乐"
        case .bilibili: return "哔哩哔哩"
        case .custom: return "自定义源"
        }
    }

    public var badgeLabel: String {
        switch self {
        case .qq: return "QQ"
        case .netease: return "163"
        case .bilibili: return "Bili"
        case .custom: return "Custom"
        }
    }

    public var metingServerName: String {
        switch self {
        case .qq: return "tencent"
        case .netease: return "netease"
        case .bilibili: return "bilibili"
        case .custom: return "netease"
        }
    }
}

public enum AggregatedProtocolType: String, Codable, Sendable, CaseIterable {
    case meting = "meting"
    case openApi = "openApi"
    case customJson = "customJson"

    public var displayName: String {
        switch self {
        case .meting: return "Meting API"
        case .openApi: return "Music Open API"
        case .customJson: return "自定义 JSON"
        }
    }
}

public struct AggregatedSourceItem: Identifiable, Codable, Sendable, Hashable {
    public var id: String
    public var name: String
    public var platform: AggregatedPlatform
    public var protocolType: AggregatedProtocolType
    public var baseURL: String
    public var isEnabled: Bool
    public var priority: Int
    public var latencyMs: Int?

    public init(
        id: String = UUID().uuidString,
        name: String,
        platform: AggregatedPlatform,
        protocolType: AggregatedProtocolType,
        baseURL: String,
        isEnabled: Bool = true,
        priority: Int = 0,
        latencyMs: Int? = nil
    ) {
        self.id = id
        self.name = name
        self.platform = platform
        self.protocolType = protocolType
        self.baseURL = baseURL
        self.isEnabled = isEnabled
        self.priority = priority
        self.latencyMs = latencyMs
    }
}

public struct AggregatedSongItem: Identifiable, Codable, Sendable, Hashable {
    public var id: String // e.g. "agg_qq_002ReDzj13wRz0"
    public var rawID: String // e.g. "002ReDzj13wRz0"
    public var title: String
    public var artist: String
    public var album: String
    public var duration: TimeInterval
    public var coverURLString: String?
    public var platform: AggregatedPlatform
    public var sourceName: String
    public var mediaMid: String?

    public init(
        id: String,
        rawID: String,
        title: String,
        artist: String,
        album: String,
        duration: TimeInterval,
        coverURLString: String? = nil,
        platform: AggregatedPlatform,
        sourceName: String,
        mediaMid: String? = nil
    ) {
        self.id = id
        self.rawID = rawID
        self.title = title
        self.artist = artist
        self.album = album
        self.duration = duration
        self.coverURLString = coverURLString
        self.platform = platform
        self.sourceName = sourceName
        self.mediaMid = mediaMid
    }

    /// 转换为 Primuse 的原生 Song 数据结构，使用专门的聚合源系统 ID
    public func toPrimuseSong(systemSourceID: String) -> PrimuseKit.Song {
        let relativePath = "/aggregated/\(platform.rawValue)/\(rawID).mp3"
        return PrimuseKit.Song(
            id: id,
            title: title.isEmpty ? "未知歌曲" : title,
            albumID: album.isEmpty ? nil : "agg-album-\(album)",
            artistID: artist.isEmpty ? nil : "agg-artist-\(artist)",
            albumTitle: album.isEmpty ? "在线音源" : album,
            artistName: artist.isEmpty ? "未知歌手" : artist,
            duration: duration > 0 ? duration : 180,
            fileFormat: .mp3,
            filePath: relativePath,
            sourceID: systemSourceID,
            fileSize: 0,
            dateAdded: Date(),
            coverArtFileName: coverURLString
        )
    }
}
