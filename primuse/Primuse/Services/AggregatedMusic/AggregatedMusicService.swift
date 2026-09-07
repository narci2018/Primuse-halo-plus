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
            searchResults = []
            isSearching = false
            return
        }

        currentSearchTask?.cancel()
        currentSearchTask = Task {
            isSearching = true
            lastSearchError = nil

            let sources = store.enabledSources()
            if sources.isEmpty {
                isSearching = false
                lastSearchError = "未启用任何聚合音乐源，请在设置中配置并启用音源。"
                return
            }

            var aggregatedList: [AggregatedSongItem] = []
            var seenKeys = Set<String>()

            await withTaskGroup(of: [AggregatedSongItem].self) { group in
                for source in sources {
                    group.addTask {
                        do {
                            return try await self.searchSingleSource(source: source, keyword: trimmed)
                        } catch {
                            return []
                        }
                    }
                }

                for await items in group {
                    for item in items {
                        let key = "\(item.platform.rawValue):\(item.rawID)"
                        if seenKeys.insert(key).inserted {
                            aggregatedList.append(item)
                        }
                    }
                }
            }

            guard !Task.isCancelled else { return }

            self.searchResults = aggregatedList
            self.isSearching = false
            if aggregatedList.isEmpty {
                self.lastSearchError = "未搜索到匹配歌曲"
            }
        }
        await currentSearchTask?.value
    }

    public func clearSearchResults() {
        currentSearchTask?.cancel()
        searchResults = []
        isSearching = false
        lastSearchError = nil
    }

    private func searchSingleSource(source: AggregatedSourceItem, keyword: String) async throws -> [AggregatedSongItem] {
        guard let encodedKeyword = keyword.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) else { return [] }

        switch source.protocolType {
        case .meting:
            let server = source.platform.metingServerName
            let base = source.baseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            let urlString: String
            if base.contains("api.php") {
                urlString = "\(base)?types=search&count=20&source=\(server)&pages=1&name=\(encodedKeyword)"
            } else {
                urlString = "\(base)?type=search&id=\(encodedKeyword)&server=\(server)&limit=20"
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
            let urlString = "\(source.baseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/")))?msg=\(encodedKeyword)&type=json"
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
        let base = source.baseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        switch source.protocolType {
        case .meting:
            let server = source.platform.metingServerName
            let urlString: String
            if base.contains("api.php") {
                urlString = "\(base)?types=url&source=\(server)&id=\(rawID)&br=320"
            } else {
                urlString = "\(base)?server=\(server)&type=url&id=\(rawID)&br=320"
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
                   let audioURLString = json["url"] as? String,
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
            let urlString = "\(base)?source=\(sourceKey)&songId=\(rawID)&quality=320k"
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
            let urlString = "\(base)?id=\(rawID)&level=320k&type=mp3"
            if let endpoint = URL(string: urlString) {
                return endpoint
            }

        case .openApi:
            let urlString = "\(base)?msg=\(rawID)&type=url"
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
        let base = source.baseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        switch source.protocolType {
        case .meting:
            let server = source.platform.metingServerName
            let urlString: String
            if base.contains("api.php") {
                urlString = "\(base)?types=lyric&source=\(server)&id=\(rawID)"
            } else {
                urlString = "\(base)?server=\(server)&type=lrc&id=\(rawID)"
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
            let urlString = "\(base)?msg=\(rawID)&type=lrc"
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
