import CloudKit
import Foundation

/// Safely constructs the shared CloudKit container for every app platform.
///
/// `CKContainer(identifier:)` raises an exception or traps when the running
/// binary does not carry the requested iCloud entitlement (e.g. ad-hoc / sideloaded
/// builds signed with personal free Apple IDs).
enum CloudKitRuntime {
    static let containerID = "iCloud.com.welape.yuanyin"

    static var canCreateContainer: Bool {
        #if targetEnvironment(simulator)
        false
        #else
        SafeSiriBridge.hasCloudKitContainerEntitlement(containerID)
        #endif
    }

    static func makeContainer() -> CKContainer? {
        guard canCreateContainer else { return nil }
        return CKContainer(identifier: containerID)
    }
}
