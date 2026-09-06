import Foundation

enum SourceError: Error, LocalizedError, Sendable {
    case pathNotFound(String)
    case fileNotFound(String)
    case connectionFailed(String)
    case credentialUnavailable(String)
    case authenticationFailed
    case timeout

    var errorDescription: String? {
        switch self {
        case .pathNotFound(let path):
            return String(format: String(localized: "error_path_not_found %@"), path)
        case .fileNotFound(let path):
            return String(format: String(localized: "error_file_not_found %@"), path)
        case .connectionFailed(let message):
            return String(format: String(localized: "error_connection_failed %@"), message)
        case .credentialUnavailable(let msg): return msg
        case .authenticationFailed:
            return String(localized: "error_authentication_failed")
        case .timeout:
            return String(localized: "error_connection_timeout")
        }
    }
}

/// A route reached the service but cannot proceed without user action (for
/// example a rejected password, account lock or required password change).
/// Adaptive routing must not repeat that login against every saved endpoint.
struct SourceConnectionTerminalError: Error, LocalizedError, Sendable {
    let message: String
    var errorDescription: String? { message }
}
