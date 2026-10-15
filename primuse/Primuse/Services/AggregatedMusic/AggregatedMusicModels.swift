import Foundation
import PrimuseKit

public enum AggregatedPlatform: String, Codable, Sendable, CaseIterable {
    case qq = "qq"
    case netease = "netease"
    case kugou = "kugou"
    case kuwo = "kuwo"
    case migu = "migu"
    case bilibili = "bilibili"
    case custom = "custom"

    /// 云端清单里出现过的平台名（含 migu）：认不得的一律按 `custom` 处理，
    /// 但原始字符串要留着 —— 走音乐网关时发给服务端的必须是清单里那个词，不是本机的 rawValue。
    public static func from(_ raw: String?) -> AggregatedPlatform {
        guard let raw, let hit = AggregatedPlatform(rawValue: raw.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            return .custom
        }
        return hit
    }

    public var displayName: String {
        switch self {
        case .qq: return "QQ 音乐"
        case .netease: return "网易云音乐"
        case .kugou: return "酷狗音乐"
        case .kuwo: return "酷我音乐"
        case .migu: return "咪咕音乐"
        case .bilibili: return "哔哩哔哩"
        case .custom: return "自定义源"
        }
    }

    public var badgeLabel: String {
        switch self {
        case .qq: return "QQ"
        case .netease: return "163"
        case .kugou: return "KG"
        case .kuwo: return "KW"
        case .migu: return "MG"
        case .bilibili: return "Bili"
        case .custom: return "Custom"
        }
    }

    public var metingServerName: String {
        switch self {
        case .qq: return "tencent"
        case .netease: return "netease"
        case .kugou: return "kugou"
        case .kuwo: return "kuwo"
        case .migu: return "mguo"
        case .bilibili: return "bilibili"
        case .custom: return "netease"
        }
    }

    public var hywSourceKey: String {
        switch self {
        case .qq: return "tx"
        case .netease: return "wy"
        case .kugou: return "kg"
        case .kuwo: return "kw"
        case .migu: return "mg"
        case .bilibili: return "bili"
        case .custom: return "tx"
        }
    }
}

public enum AggregatedProtocolType: String, Codable, Sendable, CaseIterable {
    case meting = "meting"
    case hyw = "hyw"
    case nxinxz = "nxinxz"
    case openApi = "openApi"
    case customJson = "customJson"
    /// 洛雪 js 音源。脚本跑在 CF 的 runner Worker 里（Workers 请求期不允许生成代码，
    /// 本机也没有第二个 JS 引擎 —— `ConfigurableScraper` 那个 JavaScriptCore 只处理响应文本），
    /// 所以这一协议的搜索 / 取流 / 歌词全部经 `/api/music-gateway`，本机不落地脚本。
    case lxjs = "lxjs"

    /// 洛雪 js 音源只能由服务端执行脚本，本机的"添加线路"里没有它。
    public static let localAddableCases: [AggregatedProtocolType] = allCases.filter { $0 != .lxjs }

    public var badgeLabel: String {
        switch self {
        case .meting: return "Meting"
        case .hyw: return "HYW"
        case .nxinxz: return "NXINXZ"
        case .openApi: return "OpenAPI"
        case .customJson: return "JSON"
        case .lxjs: return "洛雪JS·云端"
        }
    }

    public var displayName: String {
        switch self {
        case .meting: return "Meting API"
        case .hyw: return "落雪 / HYW 聚合源"
        case .nxinxz: return "NXINXZ 线路"
        case .openApi: return "Music Open API"
        case .customJson: return "自定义 JSON"
        case .lxjs: return "洛雪 JS 音源（服务端执行）"
        }
    }
}

/// 一条线路"能不能出声"的结论。
///
/// 需求 2 的原话：能访问不等于能播放，一定要能播放的源才有存在的价值。
/// 所以这份结论只能来自"搜索 → 解析直链 → Range 真取 64KB 字节 → 字节层判定"，
/// 绝不能是 HEAD 请求的往返时间（旧的「测速」就是在这骗人：报错页也回 200）。
public struct AggregatedSourceVerdict: Codable, Sendable, Hashable {
    /// `ok` / `audio_fail` / `resolve_fail` / `script_error` / `script_uncompilable`
    /// / `no_sample` / `runner_missing` / `unsupported` / `error` / `unchecked`
    public var status: String
    public var detail: String
    public var bytes: Int
    /// 结论是谁测的：服务端体检下发的，还是本机实测的。洛雪 js 源只能是前者（脚本不在本机跑）。
    public var origin: Origin

    public enum Origin: String, Codable, Sendable {
        case server
        case local
    }

    /// 观测盲区：这些状态说明"我们没看清"，不是"这条源坏了" —— 不停用，也不建议删除。
    /// 与 cf-sync-server `functions/lib/store.js` 的 blind 分支、Windows `app.js` 的
    /// `VERDICT_BLIND` 同一份名单，三处必须一致。
    public static let blindStatuses: [String] = ["no_sample", "runner_missing", "unsupported", "unchecked", "error"]

    public init(status: String, detail: String = "", bytes: Int = 0, origin: Origin = .server) {
        self.status = status
        self.detail = detail
        self.bytes = bytes
        self.origin = origin
    }

    public var isPlayable: Bool { status == "ok" }
    public var isBlind: Bool { Self.blindStatuses.contains(status) }

    public enum Tone: Hashable {
        case playable
        case blind
        case dead
    }

    public var tone: Tone {
        if isPlayable { return .playable }
        return isBlind ? .blind : .dead
    }

    /// 界面文案
    public var toneLabel: String {
        switch tone {
        case .playable: return "可播"
        case .blind: return "未检出"
        case .dead: return "不可播"
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

    // MARK: 云端清单带来的字段（全是可选 —— 老的本地存档必须还能解得开）

    /// 这条线路是云端清单管下来的：增删改、启停、删除建议都在 CF 后台，本机只读 + 刷新。
    public var cloudSourced: Bool?
    /// 清单里 `platform` 的原文。本机没有的平台（咪咕）靠它原样回传给音乐网关。
    public var cloudPlatform: String?
    public var quality: String?
    public var scriptHash: String?
    /// 可用性结论：服务端下发的那份，或本机「检测全部可用」实测的那份。
    public var verdict: AggregatedSourceVerdict?
    /// 服务端体检判死后的删除建议（需求 2 的后半句）。
    public var suggestDelete: Bool?
    /// 这条源在不在本机的播放路径里（需求 1/3）。落清单时算一次，判据与 Windows 侧
    /// `isLoadable()` 一字不差：`enabled && !suggestDelete && 体检结论 == ok`。
    /// 可选是为了让老存档还能解码 —— 没有这个字段的按"在"处理。
    public var loaded: Bool?
    /// 服务端那一侧的启用位（清单里的 `enabled`）。`isEnabled` 已经被"在不在播放路径里"占了，
    /// 「检测全部可用」需要的是另一位：**服务端还开着的才值得占流量**，
    /// 服务端开着但本机没加载的那些（未检出 / 被判不可播）恰恰是最该再验一次的（需求 2）。
    /// 可选同样是为了老存档能解码 —— 没有这个字段的按"开着"处理。
    public var enabledOnServer: Bool?

    public var isCloudManaged: Bool { cloudSourced == true }
    /// 界面与搜索/取流都只看这一个：`loaded == false` 的云端线路只负责被看见，不参与播放。
    public var isInPlaybackPath: Bool { loaded != false }
    /// 本机体检该不该过这一条（与 Windows `checkable()` 同一口径）。
    public var isCheckable: Bool { isCloudManaged ? enabledOnServer != false : isEnabled }

    public init(
        id: String = UUID().uuidString,
        name: String,
        platform: AggregatedPlatform,
        protocolType: AggregatedProtocolType,
        baseURL: String,
        isEnabled: Bool = true,
        priority: Int = 0,
        latencyMs: Int? = nil,
        cloudSourced: Bool? = nil,
        cloudPlatform: String? = nil,
        quality: String? = nil,
        scriptHash: String? = nil,
        verdict: AggregatedSourceVerdict? = nil,
        suggestDelete: Bool? = nil,
        loaded: Bool? = nil,
        enabledOnServer: Bool? = nil
    ) {
        self.id = id
        self.name = name
        self.platform = platform
        self.protocolType = protocolType
        self.baseURL = baseURL
        self.isEnabled = isEnabled
        self.priority = priority
        self.latencyMs = latencyMs
        self.cloudSourced = cloudSourced
        self.cloudPlatform = cloudPlatform
        self.quality = quality
        self.scriptHash = scriptHash
        self.verdict = verdict
        self.suggestDelete = suggestDelete
        self.loaded = loaded
        self.enabledOnServer = enabledOnServer
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
