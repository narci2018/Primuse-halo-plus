import Foundation

/// Resolves Songloft streams through a session isolated by source and connection credentials.
public actor SongloftStreamResolver: StreamResolver {
    private struct Configuration: Equatable {
        let host: String?
        let port: Int?
        let useSSL: Bool
        let basePath: String?
        let sourceUsername: String?
        let credential: SourceCredential?
    }

    private struct Entry {
        let configuration: Configuration
        let client: SongloftServiceClient
    }

    private var clients: [String: Entry] = [:]
    private let transport: SongloftRequestTransport?

    public init(transport: SongloftRequestTransport? = nil) {
        self.transport = transport
    }

    public func streamURL(
        for song: Song,
        source: MusicSource,
        credential: SourceCredential?
    ) async throws -> URL {
        try await resolve(for: song, source: source, credential: credential).url
    }

    public func resolve(
        for song: Song,
        source: MusicSource,
        credential: SourceCredential?
    ) async throws -> ResolvedStream {
        guard source.type == .songloft else {
            throw StreamResolveError.unsupportedSourceType(source.type)
        }
        let radioID = SongloftAPIProtocol.radioID(from: song.filePath)
        guard radioID != nil || SongloftAPIProtocol.trackID(from: song.filePath) != nil else {
            throw StreamResolveError.cannotBuildURL
        }
        do {
            let client = client(source: source, credential: credential)
            if let radioID {
                let url = try await client.radioURL(id: radioID)
                return ResolvedStream(url: url)
            }
            return try await client.resolvedStream(trackPath: song.filePath)
        } catch {
            throw Self.streamError(from: error)
        }
    }

    public func invalidateSession(sourceID: String) async {
        guard let entry = clients.removeValue(forKey: sourceID) else { return }
        await entry.client.invalidateSession()
    }

    private func client(
        source: MusicSource,
        credential: SourceCredential?
    ) -> SongloftServiceClient {
        let configuration = Configuration(
            host: source.host,
            port: source.port,
            useSSL: source.useSsl,
            basePath: source.basePath,
            sourceUsername: source.username,
            credential: credential
        )
        if let entry = clients[source.id], entry.configuration == configuration {
            return entry.client
        }
        if let stale = clients.removeValue(forKey: source.id) {
            Task { await stale.client.invalidateSession() }
        }
        let client = SongloftServiceClient(source: source, credential: credential, transport: transport)
        clients[source.id] = Entry(configuration: configuration, client: client)
        return client
    }

    private static func streamError(from error: Error) -> Error {
        guard let error = error as? SongloftServiceError else { return error }
        switch error {
        case .missingCredential:
            return StreamResolveError.missingCredential
        case .invalidURL, .invalidResponse:
            return StreamResolveError.cannotBuildURL
        case .authenticationFailed:
            return StreamResolveError.authFailed
        case .badServerResponse(let status):
            return StreamResolveError.badServerResponse(status)
        }
    }
}
