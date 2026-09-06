import Foundation
import Testing
@testable import PrimuseKit

@Suite struct StreamResolverRoutingTests {
    @Test func serviceAndCancellationErrorsDoNotRetireLAN() async throws {
        let errors: [any Error] = [CancellationError(), URLError(.cancelled),
                                  StreamResolveError.authFailed, StreamResolveError.needs2FA,
                                  StreamResolveError.missingCredential,
                                  StreamResolveError.badServerResponse(503), URLError(.serverCertificateUntrusted)]
        for error in errors {
            let runtime = SourceConnectionRuntime()
            let registry = StreamResolverRegistry(runtime: runtime)
            let resolver = RoutingResolver()
            await registry.register(resolver, for: [.smb])
            let source = makeSource()
            let song = Song(id: "song", title: "T", fileFormat: .flac, filePath: "/s.flac", sourceID: source.id)
            _ = try await registry.streamURL(for: song, source: source, credential: nil)
            await resolver.failNext(error)
            do {
                _ = try await registry.streamURL(for: song, source: source, credential: nil)
                Issue.record("Expected original error")
            } catch {}
            let result = try await registry.streamURL(for: song, source: source, credential: nil)
            #expect(result.host == "lan.invalid")
            #expect(await runtime.activeKind(for: source.id) == .localAddress)
            #expect(await resolver.hosts == ["lan.invalid", "lan.invalid", "lan.invalid"])
        }
    }

    @Test func networkFailureUsesFallbackAndKeepsItsRoute() async throws {
        let runtime = SourceConnectionRuntime()
        let registry = StreamResolverRegistry(runtime: runtime, endpointProbe: { endpoint in
            if endpoint.host == "lan.invalid" { throw URLError(.cannotConnectToHost) }
        })
        let resolver = RoutingResolver()
        await registry.register(resolver, for: [.smb])
        let source = makeSource()
        let song = Song(id: "song", title: "T", fileFormat: .flac, filePath: "/s.flac", sourceID: source.id)
        await resolver.failNext(URLError(.networkConnectionLost))
        let result = try await registry.streamURL(for: song, source: source, credential: nil)
        #expect(result.host == "wan.invalid")
        #expect(await runtime.activeKind(for: source.id) == .publicAddress)
        #expect(await resolver.hosts == ["lan.invalid", "wan.invalid"])
    }

    @Test func mediaTimeoutDoesNotRetireReachableEndpoint() async throws {
        let runtime = SourceConnectionRuntime()
        let registry = StreamResolverRegistry(runtime: runtime, endpointProbe: { _ in })
        let resolver = RoutingResolver()
        await registry.register(resolver, for: [.smb])
        let source = makeSource()
        let song = Song(id: "song", title: "T", fileFormat: .flac, filePath: "/s.flac", sourceID: source.id)
        _ = try await registry.streamURL(for: song, source: source, credential: nil)
        await resolver.failNext(URLError(.timedOut))
        do {
            _ = try await registry.streamURL(for: song, source: source, credential: nil)
            Issue.record("Expected media timeout")
        } catch { #expect((error as? URLError)?.code == .timedOut) }
        #expect(await runtime.activeKind(for: source.id) == .localAddress)
        let result = try await registry.streamURL(for: song, source: source, credential: nil)
        #expect(result.host == "lan.invalid")
        #expect(await resolver.hosts == ["lan.invalid", "lan.invalid", "lan.invalid"])
    }

    private func makeSource() -> MusicSource {
        MusicSource(id: UUID().uuidString, name: "NAS", type: .smb,
                    connectionConfiguration: .init(
                        localEndpoint: .init(host: "lan.invalid", port: 445, useSsl: false),
                        publicEndpoint: .init(host: "wan.invalid", port: 445, useSsl: false)))
    }
}

private actor RoutingResolver: StreamResolver {
    var hosts: [String] = []
    private var error: (any Error)?
    func failNext(_ error: any Error) { self.error = error }
    func streamURL(for song: Song, source: MusicSource, credential: SourceCredential?) async throws -> URL {
        hosts.append(source.host ?? "")
        if let error {
            self.error = nil
            throw error
        }
        return URL(string: "https://\(source.host!)/stream")!
    }
}
