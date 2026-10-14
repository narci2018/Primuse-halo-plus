import Foundation
import Observation
import PrimuseKit

@MainActor
@Observable
public final class AggregatedMusicService {
    public static let shared = AggregatedMusicService()

    public nonisolated static let systemSourceID = "system-aggregated-music"

    public private(set) var searchResults: [AggregatedSongItem] = []
    public private(set) var isSearching: Bool = false
    public private(set) var lastSearchError: String?

    private var currentSearchTask: Task<Void, Never>?
    private var searchGeneration: Int = 0
    private var streamURLCache: [String: URL] = [:]
    private var lyricsCache: [String: String] = [:]

    private let store: AggregatedSourceStore

    public init(store: AggregatedSourceStore = .shared) {
        self.store = store
    }

    // MARK: - Search

    public func search(query: String) async {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            clearSearchResults()
            return
        }

        searchGeneration += 1
        let currentGen = searchGeneration

        currentSearchTask?.cancel()
        currentSearchTask = Task {
            isSearching = true
            lastSearchError = nil
            defer {
                if currentGen == searchGeneration {
                    isSearching = false
                }
            }

            // 防抖 200ms
            try? await Task.sleep(for: .milliseconds(200))
            guard !Task.isCancelled, currentGen == searchGeneration else { return }

            let sources = store.enabledSources()
            if sources.isEmpty {
                lastSearchError = "未启用任何聚合音乐源，请在设置中配置并启用音源。"
                return
            }

            var aggregatedList: [AggregatedSongItem] = []
            var seenKeys = Set<String>()

            await withTaskGroup(of: [AggregatedSongItem].self) { group in
                for source in sources {
                    group.addTask {
                        guard !Task.isCancelled else { return [] }
                        do {
                            return try await self.searchSingleSource(source: source, keyword: trimmed)
                        } catch {
                            return []
                        }
                    }
                }

                // 流式渐进上屏：只要有一个音源返回结果，立即刷新给用户展示，避免慢线路拖慢整体展示
                for await items in group {
                    guard !Task.isCancelled, currentGen == searchGeneration else { break }
                    var hasNew = false
                    for item in items {
                        let key = "\(item.platform.rawValue):\(item.rawID)"
                        if seenKeys.insert(key).inserted {
                            aggregatedList.append(item)
                            hasNew = true
                        }
                    }
                    if hasNew {
                        self.searchResults = aggregatedList
                    }
                }
            }

            guard !Task.isCancelled, currentGen == searchGeneration else { return }

            if aggregatedList.isEmpty {
                self.lastSearchError = "未搜索到匹配歌曲"
            }
        }
        await currentSearchTask?.value
    }

    public func clearSearchResults() {
        searchGeneration += 1
        currentSearchTask?.cancel()
        currentSearchTask = nil
        searchResults = []
        isSearching = false
        lastSearchError = nil
    }

    private func searchSingleSource(source: AggregatedSourceItem, keyword: String) async throws -> [AggregatedSongItem] {
        guard let encodedKeyword = keyword.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) else { return [] }

        switch source.protocolType {
        case .lxjs:
            // 洛雪 js 音源的脚本跑在服务端的 runner Worker 里（Workers 请求期不允许生成代码，
            // 本机也没有第二个 JS 引擎），所以搜索只能走音乐网关。
            // 清单里没有这条源时（本机手工加的源）就什么也给不出 —— 不假装能搜。
            guard source.cloudSourced == true else { return [] }
            return try await CloudMusicSources.shared.gatewaySearch(keyword: keyword, source: source)

        case .meting:
            let server = source.platform.metingServerName
            let base = baseURLBase(source)
            let q = sep(base)
            let urlString: String
            if base.contains("api.php") {
                urlString = "\(base)\(q)types=search&count=20&source=\(server)&pages=1&name=\(encodedKeyword)"
            } else {
                urlString = "\(base)\(q)type=search&id=\(encodedKeyword)&server=\(server)&limit=20"
            }
            guard let url = URL(string: urlString) else { return [] }

            var request = URLRequest(url: url)
            request.timeoutInterval = 6.0
            request.setValue("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", forHTTPHeaderField: "User-Agent")

            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return [] }

            return parseMetingSearchResults(data: data, platform: source.platform, sourceName: source.name)

        case .hyw:
            let searchURLString: String
            switch source.platform {
            case .qq:
                searchURLString = "https://api.qijieya.cn/meting?type=search&id=\(encodedKeyword)&server=tencent&limit=20"
            case .kugou:
                searchURLString = "https://api.qijieya.cn/meting?type=search&id=\(encodedKeyword)&server=kugou&limit=20"
            case .kuwo:
                searchURLString = "https://music-api.gdstudio.xyz/api.php?types=search&count=20&source=kuwo&name=\(encodedKeyword)"
            case .netease:
                searchURLString = "https://music-api.gdstudio.xyz/api.php?types=search&count=20&source=netease&name=\(encodedKeyword)"
            default:
                return []
            }
            guard let url = URL(string: searchURLString) else { return [] }

            var request = URLRequest(url: url)
            request.timeoutInterval = 6.0
            request.setValue("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", forHTTPHeaderField: "User-Agent")

            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return [] }

            return parseMetingSearchResults(data: data, platform: source.platform, sourceName: source.name)

        case .nxinxz:
            let searchURLString = "https://music-api.gdstudio.xyz/api.php?types=search&count=20&source=kuwo&name=\(encodedKeyword)"
            guard let url = URL(string: searchURLString) else { return [] }

            var request = URLRequest(url: url)
            request.timeoutInterval = 6.0
            request.setValue("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", forHTTPHeaderField: "User-Agent")

            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return [] }

            return parseMetingSearchResults(data: data, platform: source.platform, sourceName: source.name)

        case .openApi:
            let base = baseURLBase(source)
            let urlString = "\(base)\(sep(base))msg=\(encodedKeyword)&type=json"
            guard let url = URL(string: urlString) else { return [] }

            var request = URLRequest(url: url)
            request.timeoutInterval = 6.0

            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return [] }

            return parseOpenApiSearchResults(data: data, platform: source.platform, sourceName: source.name)

        case .customJson:
            return []
        }
    }

    // MARK: - URL 拼接（与服务端 / Windows 同一条规则）

    /// 线路 baseURL 去掉首尾斜杠与空白。
    private func baseURLBase(_ source: AggregatedSourceItem) -> String {
        source.baseURL.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    /// 拼查询串的分隔符。
    ///
    /// 清单里的 baseURL 自己就可能带查询串（`https://x/api.php?key=abc` 这类），
    /// 这时再拼一个 `?` 就得到 `...?key=abc?types=search...` —— 第二个 `?` 落进上一个参数的值里，
    /// 搜索/解析/歌词一律拿不到东西，一条好线路就被判成死的。
    /// 与 cf-sync-server `functions/lib/protocols.js` 的 `sep()`、Windows `aggregated.js` 的 `sep()` 同一条规则。
    private func sep(_ base: String) -> String {
        base.contains("?") ? "&" : "?"
    }

    // MARK: - 体检用的探针入口（「检测全部可用」要用单条线路的搜索/解析）

    /// 只过这一条线路的搜索。「检测全部可用」的第一步：先确认它还能给出结果。
    public func probeSearch(source: AggregatedSourceItem, keyword: String) async -> [AggregatedSongItem] {
        (try? await searchSingleSource(source: source, keyword: keyword)) ?? []
    }

    /// 用这一条线路解析直链；解析不出来返回 nil（不是抛错 —— 调用方要把"没直链"和"没测成"分开）。
    public func probeResolveURL(source: AggregatedSourceItem, rawID: String) async -> URL? {
        try? await resolveStreamURLFromSource(source: source, rawID: rawID)
    }

    // MARK: - Parsers

    private func parseMetingSearchResults(data: Data, platform: AggregatedPlatform, sourceName: String) -> [AggregatedSongItem] {
        guard let jsonArray = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            return []
        }

        var results: [AggregatedSongItem] = []
        for dict in jsonArray {
            var id = "\(dict["id"] ?? "")"
            if id.isEmpty || id == "<null>" || id == "nil" {
                id = "\(dict["url_id"] ?? "")"
            }
            if id.isEmpty || id == "<null>" || id == "nil" {
                id = "\(dict["songmid"] ?? "")"
            }
            if (id.isEmpty || id == "<null>" || id == "nil"),
               let urlStr = (dict["url"] as? String) ?? (dict["lrc"] as? String),
               let match = urlStr.range(of: "(?<=id=)[^&]+", options: .regularExpression) {
                id = String(urlStr[match])
            }

            let name = (dict["name"] as? String) ?? (dict["title"] as? String) ?? (dict["song_name"] as? String) ?? ""

            let artist: String
            if let str = dict["artist"] as? String {
                artist = str
            } else if let arr = dict["artist"] as? [String] {
                artist = arr.joined(separator: ", ")
            } else if let str = dict["author"] as? String {
                artist = str
            } else {
                artist = ""
            }

            let album = (dict["album"] as? String) ?? ""
            let pic = (dict["pic"] as? String) ?? (dict["cover"] as? String)
            guard !id.isEmpty, id != "<null>", !name.isEmpty else { continue }

            let songItem = AggregatedSongItem(
                id: "agg_\(platform.rawValue)_\(id)",
                rawID: id,
                title: name,
                artist: artist,
                album: album,
                duration: 210, // Meting search often omits duration; defaults to 3.5m
                coverURLString: pic,
                platform: platform,
                sourceName: sourceName
            )
            results.append(songItem)
        }
        return results
    }

    private func parseOpenApiSearchResults(data: Data, platform: AggregatedPlatform, sourceName: String) -> [AggregatedSongItem] {
        guard let jsonObj = try? JSONSerialization.jsonObject(with: data) else { return [] }

        var list: [[String: Any]] = []
        if let arr = jsonObj as? [[String: Any]] {
            list = arr
        } else if let dict = jsonObj as? [String: Any] {
            if let arr = dict["data"] as? [[String: Any]] {
                list = arr
            } else if let arr = dict["list"] as? [[String: Any]] {
                list = arr
            }
        }

        var results: [AggregatedSongItem] = []
        for dict in list {
            let mid = (dict["song_mid"] as? String) ?? (dict["mid"] as? String) ?? (dict["id"] as? String) ?? ""
            let name = (dict["song_name"] as? String) ?? (dict["song_title"] as? String) ?? (dict["name"] as? String) ?? ""
            let artist = (dict["singer_name"] as? String) ?? (dict["artist"] as? String) ?? ""
            let album = (dict["album_name"] as? String) ?? (dict["album"] as? String) ?? ""
            let pic = (dict["album_pic"] as? String) ?? (dict["pic"] as? String)
            let duration = (dict["duration"] as? Double) ?? (dict["song_play_time"] as? Double) ?? 210

            guard !mid.isEmpty, !name.isEmpty else { continue }

            let songItem = AggregatedSongItem(
                id: "agg_\(platform.rawValue)_\(mid)",
                rawID: mid,
                title: name,
                artist: artist,
                album: album,
                duration: duration,
                coverURLString: pic,
                platform: platform,
                sourceName: sourceName
            )
            results.append(songItem)
        }
        return results
    }

    // MARK: - Stream URL Resolution

    public func resolveStreamURL(platform: AggregatedPlatform, rawID: String) async throws -> URL {
        let cacheKey = "\(platform.rawValue):\(rawID)"
        if let cached = streamURLCache[cacheKey] {
            return cached
        }

        let candidates = store.enabledSources(for: platform)
        if candidates.isEmpty {
            throw NSError(domain: "AggregatedMusic", code: 404, userInfo: [NSLocalizedDescriptionKey: "未配置可用音源线路"])
        }

        for source in candidates {
            if let resolved = try? await resolveStreamURLFromSource(source: source, rawID: rawID) {
                streamURLCache[cacheKey] = resolved
                return resolved
            }
        }

        throw NSError(domain: "AggregatedMusic", code: 502, userInfo: [NSLocalizedDescriptionKey: "全部音源线路解析均失败，请在设置中更换或启用备用线路"])
    }

    private func resolveStreamURLFromSource(source: AggregatedSourceItem, rawID: String) async throws -> URL? {
        let base = baseURLBase(source)
        switch source.protocolType {
        case .lxjs:
            guard source.cloudSourced == true else { return nil }
            return try await CloudMusicSources.shared.gatewayResolveURL(source: source, rawID: rawID)

        case .meting:
            let server = source.platform.metingServerName
            let q = sep(base)
            let urlString: String
            if base.contains("api.php") {
                urlString = "\(base)\(q)types=url&source=\(server)&id=\(rawID)&br=320"
            } else {
                urlString = "\(base)\(q)server=\(server)&type=url&id=\(rawID)&br=320"
            }
            guard let endpoint = URL(string: urlString) else { return nil }

            var request = URLRequest(url: endpoint)
            request.timeoutInterval = 8.0

            let (data, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse {
                // If it redirected and response.url is audio
                if let directURL = response.url, directURL != endpoint, !directURL.absoluteString.contains("type=url") {
                    return directURL
                }
                // If JSON { "url": "..." }
                if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let audioURLString = (json["url"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
                   !audioURLString.isEmpty,
                   let direct = URL(string: audioURLString) {
                    return direct
                }
                // Plain text URL
                if let text = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
                   text.hasPrefix("http"),
                   let direct = URL(string: text) {
                    return direct
                }
            }

        case .hyw:
            let sourceKey = source.platform.hywSourceKey
            let urlString = "\(base)\(sep(base))source=\(sourceKey)&songId=\(rawID)&quality=320k"
            guard let endpoint = URL(string: urlString) else { return nil }

            var request = URLRequest(url: endpoint)
            request.timeoutInterval = 8.0
            let (data, _) = try await URLSession.shared.data(for: request)
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                if let audioURLString = json["url"] as? String, !audioURLString.isEmpty, let direct = URL(string: audioURLString) {
                    return direct
                }
                if let sub = json["data"] as? [String: Any], let audioURLString = sub["url"] as? String, !audioURLString.isEmpty, let direct = URL(string: audioURLString) {
                    return direct
                }
            }

        case .nxinxz:
            let urlString = "\(base)\(sep(base))id=\(rawID)&level=320k&type=mp3"
            if let endpoint = URL(string: urlString) {
                return endpoint
            }

        case .openApi:
            let urlString = "\(base)\(sep(base))msg=\(rawID)&type=url"
            guard let endpoint = URL(string: urlString) else { return nil }

            var request = URLRequest(url: endpoint)
            request.timeoutInterval = 8.0

            let (data, _) = try await URLSession.shared.data(for: request)
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let audioURLString = (json["url"] as? String) ?? (json["data"] as? String),
               let direct = URL(string: audioURLString) {
                return direct
            }

        case .customJson:
            break
        }

        return nil
    }

    // MARK: - Lyrics Resolution

    public func resolveLyrics(platform: AggregatedPlatform, rawID: String) async -> String? {
        let cacheKey = "\(platform.rawValue):\(rawID)"
        if let cached = lyricsCache[cacheKey] {
            return cached
        }

        let candidates = store.enabledSources(for: platform)
        for source in candidates {
            if let lrc = try? await resolveLyricsFromSource(source: source, rawID: rawID), !lrc.isEmpty {
                lyricsCache[cacheKey] = lrc
                return lrc
            }
        }
        return nil
    }

    private func resolveLyricsFromSource(source: AggregatedSourceItem, rawID: String) async throws -> String? {
        let base = baseURLBase(source)
        switch source.protocolType {
        case .lxjs:
            guard source.cloudSourced == true else { return nil }
            return try await CloudMusicSources.shared.gatewayLyric(source: source, rawID: rawID)

        case .meting:
            let server = source.platform.metingServerName
            let q = sep(base)
            let urlString: String
            if base.contains("api.php") {
                urlString = "\(base)\(q)types=lyric&source=\(server)&id=\(rawID)"
            } else {
                urlString = "\(base)\(q)server=\(server)&type=lrc&id=\(rawID)"
            }
            guard let endpoint = URL(string: urlString) else { return nil }

            var request = URLRequest(url: endpoint)
            request.timeoutInterval = 6.0
            let (data, _) = try await URLSession.shared.data(for: request)

            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let lrc = (json["lyric"] as? String) ?? (json["lrc"] as? String) {
                return lrc
            }
            if let text = String(data: data, encoding: .utf8), text.contains("[") {
                return text
            }

        case .hyw, .nxinxz:
            let server = source.platform.metingServerName
            let fallbackURL = "https://api.qijieya.cn/meting?server=\(server)&type=lrc&id=\(rawID)"
            if let endpoint = URL(string: fallbackURL) {
                var request = URLRequest(url: endpoint)
                request.timeoutInterval = 5.0
                if let (data, _) = try? await URLSession.shared.data(for: request) {
                    if let text = String(data: data, encoding: .utf8), text.contains("[") {
                        return text
                    }
                }
            }

        case .openApi:
            let urlString = "\(base)\(sep(base))msg=\(rawID)&type=lrc"
            guard let endpoint = URL(string: urlString) else { return nil }
            let (data, _) = try await URLSession.shared.data(for: URLRequest(url: endpoint))
            if let text = String(data: data, encoding: .utf8), text.contains("[") {
                return text
            }

        case .customJson:
            break
        }

        return nil
    }
}
