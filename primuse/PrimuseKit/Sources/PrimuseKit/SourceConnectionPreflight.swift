import Foundation
import Network

/// A TCP probe establishes reachability only; the connector still owns service
/// authentication. Preserve probe errors so cancellation and policy denials
/// cannot be relabelled as an unreachable network.
public enum SourceConnectionPreflight {
    public static func check(_ rawEndpoint: SourceConnectionEndpoint) async throws {
        try Task.checkCancellation()
        let endpoint = rawEndpoint.normalized
        guard endpoint.isUsable,
              let rawPort = UInt16(exactly: endpoint.port),
              let port = NWEndpoint.Port(rawValue: rawPort) else {
            throw URLError(.badURL)
        }
        let connection = NWConnection(host: NWEndpoint.Host(endpoint.host), port: port, using: .tcp)
        let race = CancellableResultRace<Void>()
        @Sendable func finish(_ result: Result<Void, Error>) {
            if race.resolve(result) {
                connection.stateUpdateHandler = nil
                connection.cancel()
            }
        }
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                race.install(continuation)
                guard !Task.isCancelled else {
                    finish(.failure(CancellationError()))
                    return
                }
                connection.stateUpdateHandler = { state in
                    switch state {
                    case .ready: finish(.success(()))
                    case .failed(let error): finish(.failure(error))
                    case .waiting(let error) where !SourceNetworkFailurePolicy.isNetworkFailure(error):
                        finish(.failure(error))
                    case .cancelled: finish(.failure(CancellationError()))
                    default: break
                    }
                }
                connection.start(queue: DispatchQueue.global(qos: .userInitiated))
                DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 1) {
                    finish(.failure(URLError(.timedOut)))
                }
            }
        } onCancel: {
            finish(.failure(CancellationError()))
        }
        try Task.checkCancellation()
    }
}
