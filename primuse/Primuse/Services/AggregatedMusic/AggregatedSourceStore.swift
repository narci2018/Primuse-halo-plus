import Foundation
import Observation

@MainActor
@Observable
public final class AggregatedSourceStore {
    public static let shared = AggregatedSourceStore()

    private static let storageKey = "primuse.aggregated_sources.v1"

    public private(set) var sources: [AggregatedSourceItem] = []
    public private(set) var isPinging: Bool = false

    public init() {
        loadSources()
    }

    public static var defaultSources: [AggregatedSourceItem] {
        [
            AggregatedSourceItem(
                id: "default-qq-openapi-1",
                name: "QQ音乐 (Open API 线路)",
                platform: .qq,
                protocolType: .openApi,
                baseURL: "https://tang.api.s01s.cn/music_open_api.php",
                isEnabled: true,
                priority: 10
            ),
            AggregatedSourceItem(
                id: "default-qq-meting-1",
                name: "QQ音乐 (Meting 线路 1)",
                platform: .qq,
                protocolType: .meting,
                baseURL: "https://api.qijieya.cn/meting",
                isEnabled: true,
                priority: 8
            ),
            AggregatedSourceItem(
                id: "default-qq-meting-2",
                name: "QQ音乐 (Meting 线路 2)",
                platform: .qq,
                protocolType: .meting,
                baseURL: "https://api.injahow.cn/meting",
                isEnabled: true,
                priority: 6
            ),
            AggregatedSourceItem(
                id: "default-netease-meting-1",
                name: "网易云 (Meting 线路 1)",
                platform: .netease,
                protocolType: .meting,
                baseURL: "https://api.qijieya.cn/meting",
                isEnabled: true,
                priority: 10
            ),
            AggregatedSourceItem(
                id: "default-netease-meting-2",
                name: "网易云 (Meting 线路 2)",
                platform: .netease,
                protocolType: .meting,
                baseURL: "https://api.injahow.cn/meting",
                isEnabled: true,
                priority: 8
            ),
            AggregatedSourceItem(
                id: "default-netease-meting-3",
                name: "网易云 (Meting 线路 3)",
                platform: .netease,
                protocolType: .meting,
                baseURL: "https://musicapi.qijieya.cn/meting",
                isEnabled: true,
                priority: 6
            )
        ]
    }

    public func loadSources() {
        if let data = UserDefaults.standard.data(forKey: Self.storageKey),
           let decoded = try? JSONDecoder().decode([AggregatedSourceItem].self, from: data),
           !decoded.isEmpty {
            self.sources = decoded
        } else {
            self.sources = Self.defaultSources
            save()
        }
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

    public func ping(sourceID: String) async -> Int? {
        guard let index = sources.firstIndex(where: { $0.id == sourceID }) else { return nil }
        let source = sources[index]
        guard let url = URL(string: source.baseURL) else { return nil }

        let start = CFAbsoluteTimeGetCurrent()
        var request = URLRequest(url: url)
        request.httpMethod = "HEAD"
        request.timeoutInterval = 4.0

        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            let elapsed = Int((CFAbsoluteTimeGetCurrent() - start) * 1000)
            if let http = response as? HTTPURLResponse, (200...499).contains(http.statusCode) {
                sources[index].latencyMs = elapsed
                return elapsed
            }
        } catch {
            // HEAD might be rejected by some PHP APIs, try GET with small timeout
            do {
                var getReq = URLRequest(url: url)
                getReq.timeoutInterval = 4.0
                let (_, response) = try await URLSession.shared.data(for: getReq)
                let elapsed = Int((CFAbsoluteTimeGetCurrent() - start) * 1000)
                if let http = response as? HTTPURLResponse, (200...499).contains(http.statusCode) {
                    sources[index].latencyMs = elapsed
                    return elapsed
                }
            } catch {}
        }
        sources[index].latencyMs = -1
        return nil
    }

    public func pingAll() async {
        isPinging = true
        defer { isPinging = false }

        await withTaskGroup(of: Void.self) { group in
            for source in sources {
                group.addTask { @MainActor in
                    _ = await self.ping(sourceID: source.id)
                }
            }
        }
    }
}
