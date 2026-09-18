import Foundation
#if os(iOS)
import UIKit
#elseif os(macOS)
import IOKit
#endif

/// 设备唯一标识与硬件信息识别器
enum DeviceIdentity {
    private static let deviceIDKey = "primuse.device.unique_machine_id"

    /// 获取设备唯一标识（机器码）
    static var currentDeviceID: String {
        #if os(iOS)
        if let vendorID = UIDevice.current.identifierForVendor?.uuidString {
            return vendorID
        }
        #elseif os(macOS)
        if let platformUUID = macHardwareUUID() {
            return platformUUID
        }
        #endif

        if let saved = UserDefaults.standard.string(forKey: deviceIDKey), !saved.isEmpty {
            return saved
        }
        let newID = UUID().uuidString
        UserDefaults.standard.set(newID, forKey: deviceIDKey)
        return newID
    }

    /// 获取设备友好名称
    static var currentDeviceName: String {
        #if os(iOS)
        return UIDevice.current.name
        #elseif os(macOS)
        return Host.current().localizedName ?? "Mac"
        #else
        return "Apple Device"
        #endif
    }

    /// 当前系统平台标识
    static var platformName: String {
        #if os(iOS)
        return "iOS"
        #elseif os(macOS)
        return "macOS"
        #elseif os(tvOS)
        return "tvOS"
        #elseif os(watchOS)
        return "watchOS"
        #else
        return "Apple"
        #endif
    }

    #if os(macOS)
    private static func macHardwareUUID() -> String? {
        let matching = IOServiceMatching("IOPlatformExpertDevice")
        let service = IOServiceGetMatchingService(kIOMainPortDefault, matching)
        guard service != 0 else { return nil }
        defer { IOObjectRelease(service) }
        guard let property = IORegistryEntryCreateCFProperty(
            service,
            kIOPlatformUUIDKey as CFString,
            kCFAllocatorDefault,
            0
        ) else { return nil }
        return (property.takeRetainedValue() as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    #endif
}
