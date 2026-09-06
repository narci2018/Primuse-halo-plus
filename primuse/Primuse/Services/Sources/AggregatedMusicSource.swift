import Foundation
import PrimuseKit

/// 聚合音乐源 Native Connector。
/// 将外部聚合音源（QQ音乐、网易云、Meting等）无缝接入 Primuse 的原生播放引擎、歌词显示与缓存系统。
actor AggregatedMusicSource: MusicSourceConnector, ServerLyricsConnector {
    let sourceID: String

    init(sourceID: String = AggregatedMusicService.systemSourceID) {
        self.sourceID = sourceID
    }

    func connect() async throws {}
    func disconnect() async {}

    func listFiles(at path: String) async throws -> [RemoteFileItem] {
        return []
    }

    func localURL(for path: String) async throws -> URL {
        guard let url = try await streamingURL(for: path) else {
            throw SourceError.fileNotFound(path)
        }
        return url
    }

    func streamData(for path: String) async throws -> AsyncThrowingStream<Data, Error> {
        guard let streamURL = try await streamingURL(for: path) else {
            throw SourceError.fileNotFound(path)
        }
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let (asyncBytes, response) = try await URLSession.shared.bytes(from: streamURL)
                    guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                        continuation.finish(throwing: SourceError.connectionFailed("Stream request failed"))
                        return
                    }
                    var buffer = Data()
                    for try await byte in asyncBytes {
                        buffer.append(byte)
                        if buffer.count >= 64 * 1024 {
                            continuation.yield(buffer)
                            buffer.removeAll(keepingCapacity: true)
                        }
                    }
                    if !buffer.isEmpty {
                        continuation.yield(buffer)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { @Sendable _ in task.cancel() }
        }
    }

    func scanAudioFiles(from path: String) async throws -> AsyncThrowingStream<RemoteFileItem, Error> {
        AsyncThrowingStream { $0.finish() }
    }

    // MARK: - Streaming URL

    func streamingURL(for path: String) async throws -> URL? {
        guard let parsed = parseAggregatedPath(path) else { return nil }
        return try await AggregatedMusicService.shared.resolveStreamURL(
            platform: parsed.platform,
            rawID: parsed.rawID
        )
    }

    // MARK: - Server Lyrics

    func fetchServerLyrics(for path: String) async -> String? {
        guard let parsed = parseAggregatedPath(path) else { return nil }
        return await AggregatedMusicService.shared.resolveLyrics(
            platform: parsed.platform,
            rawID: parsed.rawID
        )
    }

    func readServerLyrics(for path: String) async -> ServerLyricsReadResult {
        if let content = await fetchServerLyrics(for: path), !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return .content(content)
        }
        return .absent
    }

    // MARK: - Range Fetch

    func fetchRange(path: String, offset: Int64, length: Int64) async throws -> Data {
        guard let url = try await streamingURL(for: path) else {
            return Data()
        }
        var request = URLRequest(url: url)
        request.setValue("bytes=\(offset)-\(offset + length - 1)", forHTTPHeaderField: "Range")
        request.timeoutInterval = 12.0
        let (data, _) = try await URLSession.shared.data(for: request)
        return data
    }

    // MARK: - Path Parsing

    private struct ParsedPath {
        let platform: AggregatedPlatform
        let rawID: String
    }

    private func parseAggregatedPath(_ path: String) -> ParsedPath? {
        // Expected format: /aggregated/{platform}/{rawID}.mp3
        let components = path.split(separator: "/", omittingEmptySubsequences: true)
        guard components.count >= 3, components[0] == "aggregated" else {
            return nil
        }
        let platformString = String(components[1])
        let rawFile = String(components[2])
        let rawID = (rawFile as NSString).deletingPathExtension

        let platform = AggregatedPlatform(rawValue: platformString) ?? .custom
        return ParsedPath(platform: platform, rawID: rawID)
    }
}
