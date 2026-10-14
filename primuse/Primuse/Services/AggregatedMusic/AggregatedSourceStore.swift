import Foundation
import Observation

@MainActor
@Observable
public final class AggregatedSourceStore {
    public static let shared = AggregatedSourceStore()

    private static let storageKey = "primuse.aggregated_sources.v2"

    public private(set) var sources: [AggregatedSourceItem] = []

    public init() {
        loadSources()
    }

    public static var defaultSources: [AggregatedSourceItem] {
        [
            AggregatedSourceItem(
                id: "default-qq-hyw",
                name: "QQ音乐 (HYW 极速无损解析)",
                platform: .qq,
                protocolType: .hyw,
                baseURL: "http://103.79.184.97/api/music/url",
                isEnabled: true,
                priority: 20
            ),
            AggregatedSourceItem(
                id: "default-netease-gdstudio",
                name: "网易云 (GDStudio 320k)",
                platform: .netease,
                protocolType: .meting,
                baseURL: "https://music-api.gdstudio.xyz/api.php",
                isEnabled: true,
                priority: 18
            ),
            AggregatedSourceItem(
                id: "default-kuwo-nxinxz",
                name: "酷我音乐 (NXINXZ 320k)",
                platform: .kuwo,
                protocolType: .nxinxz,
                baseURL: "http://music.nxinxz.com/kw.php",
                isEnabled: true,
                priority: 16
            ),
            AggregatedSourceItem(
                id: "default-kugou-hyw",
                name: "酷狗音乐 (HYW 极速解析)",
                platform: .kugou,
                protocolType: .hyw,
                baseURL: "http://103.79.184.97/api/music/url",
                isEnabled: true,
                priority: 15
            ),
            AggregatedSourceItem(
                id: "default-netease-meting-1",
                name: "网易云 (七洁雅 Meting)",
                platform: .netease,
                protocolType: .meting,
                baseURL: "https://api.qijieya.cn/meting",
                isEnabled: true,
                priority: 14
            ),
            AggregatedSourceItem(
                id: "default-netease-meting-3e0",
                name: "网易云 (DreamMeting 3e0)",
                platform: .netease,
                protocolType: .meting,
                baseURL: "https://music.3e0.cn",
                isEnabled: true,
                priority: 12
            ),
            AggregatedSourceItem(
                id: "default-kuwo-hyw",
                name: "酷我音乐 (HYW 线路)",
                platform: .kuwo,
                protocolType: .hyw,
                baseURL: "http://103.79.184.97/api/music/url",
                isEnabled: true,
                priority: 10
            ),
            AggregatedSourceItem(
                id: "default-qq-meting-1",
                name: "QQ音乐 (七洁雅 Meting 备用)",
                platform: .qq,
                protocolType: .meting,
                baseURL: "https://api.qijieya.cn/meting",
                isEnabled: true,
                priority: 8
            ),
            AggregatedSourceItem(
                id: "default-qq-openapi-1",
                name: "QQ音乐 (Open API 线路)",
                platform: .qq,
                protocolType: .openApi,
                baseURL: "https://tang.api.s01s.cn/music_open_api.php",
                isEnabled: true,
                priority: 6
            )
        ]
    }

    public func loadSources() {
        let defaults = Self.defaultSources
        if let data = UserDefaults.standard.data(forKey: Self.storageKey),
           let decoded = try? JSONDecoder().decode([AggregatedSourceItem].self, from: data) {
            var merged = decoded
            let existingIDs = Set(decoded.map(\.id))
            // 补齐内置线路只在这台设备还没被云端接管时做。
            // 接管之后服务端就是名单的唯一真相：它把某条判死/删掉了，本机必须跟着消失，
            // 否则"能播放的源才有价值"这条口径在客户端不成立（旧线路会在每次冷启动复活）。
            let underCloudManagement = decoded.contains { $0.isCloudManaged }
            if !underCloudManagement {
                for def in defaults where !existingIDs.contains(def.id) {
                    merged.append(def)
                }
            }
            merged.sort { $0.priority > $1.priority }
            self.sources = merged
            save()
        } else {
            self.sources = defaults
            save()
        }
    }

    // MARK: - 云端清单落线

    /// 本机手工加的线路：不是云端下发的，也不在内置 `default-*` 名单里。
    /// iPhone 侧的本地添加用 UUID 当 id（Windows 才是 `user-` 前缀），所以只能这样认。
    private var locallyAddedSources: [AggregatedSourceItem] {
        let builtinIDs = Set(Self.defaultSources.map(\.id))
        return sources.filter { !$0.isCloudManaged && !builtinIDs.contains($0.id) }
    }

    /// 把清单正文落到线路表：只替换"云端来的 + 内置的那 9 条"，保留本机自己加的备用线路。
    public func applyCloudSources(_ list: [AggregatedSourceItem]) {
        let kept = locallyAddedSources
        var merged = list
        // 本机自己加的线路若与服务端重名同 id（用户手动复制过内置线路），以清单为准。
        let cloudIDs = Set(list.map(\.id))
        merged.append(contentsOf: kept.filter { !cloudIDs.contains($0.id) })
        merged.sort { $0.priority > $1.priority }
        sources = merged
        save()
    }

    /// 换清单地址 = 换了一份真相，云端线路整片撤掉（本机自己加的留着）。
    public func dropCloudSources() {
        sources = locallyAddedSources.sorted { $0.priority > $1.priority }
        if sources.isEmpty {
            sources = Self.defaultSources
        }
        save()
    }

    public func save() {
        if let data = try? JSONEncoder().encode(sources) {
            UserDefaults.standard.set(data, forKey: Self.storageKey)
        }
    }

    public func addSource(_ source: AggregatedSourceItem) {
        sources.append(source)
        save()
    }

    public func updateSource(_ source: AggregatedSourceItem) {
        if let index = sources.firstIndex(where: { $0.id == source.id }) {
            sources[index] = source
            save()
        }
    }

    public func deleteSource(id: String) {
        sources.removeAll { $0.id == id }
        save()
    }

    public func toggleSource(id: String) {
        if let index = sources.firstIndex(where: { $0.id == id }) {
            sources[index].isEnabled.toggle()
            save()
        }
    }

    public func resetToDefaults() {
        sources = Self.defaultSources
        save()
    }

    public func enabledSources(for platform: AggregatedPlatform? = nil) -> [AggregatedSourceItem] {
        sources.filter { source in
            guard source.isEnabled else { return false }
            if let platform {
                return source.platform == platform || source.platform == .custom
            }
            return true
        }.sorted { $0.priority > $1.priority }
    }

    // 「检测全部延迟」（ping / pingAll HEAD 请求）已经删掉，换成 CloudMusicSources.checkAllAvailable。
    //
    // 为什么必须删：HEAD 回 200 只说明"这个端口上有个东西在应答"，不说明它能给出能播的音频。
    // 现网实测：报错页回 200、反爬页回 200、"需要卡密"的站也回 200 —— 旧界面把这三家都
    // 标成绿色 300ms，用户照着绿色去点，什么都听不见。需求 2 要的是"能播才有价值"，
    // 所以结论只能来自字节层（见 AudioSniff）。
}
