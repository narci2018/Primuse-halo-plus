import AVFoundation
import Foundation
import PrimuseKit

@MainActor
@Observable
final class EqualizerService {
    private let audioEngine: AudioEngine
    private let defaults: UserDefaults

    var currentPreset: EQPreset = .flat
    var isEnabled: Bool = true {
        didSet { updateBypass(); persist() }
    }
    var bands: [Float] = Array(repeating: 0, count: PrimuseConstants.eqBandCount)

    /// 用户手动拖出的曲线,持久化;预设里"自定义"项展示并可一键还原它。
    private(set) var customBands: [Float] = Array(repeating: 0, count: PrimuseConstants.eqBandCount)

    init(audioEngine: AudioEngine, defaults: UserDefaults = .standard) {
        self.audioEngine = audioEngine
        self.defaults = defaults
        load()
    }

    /// 当前自定义曲线对应的预设,供 UI 卡片展示/应用。
    var customPreset: EQPreset { .custom(bands: customBands) }

    func applyPreset(_ preset: EQPreset) {
        guard preset.bands.count == PrimuseConstants.eqBandCount else { return }
        currentPreset = preset
        bands = preset.bands
        if preset.isCustom { customBands = preset.bands }
        for (index, gain) in bands.enumerated() {
            audioEngine.eqNode?.bands[index].gain = clamp(gain)
        }
        persist()
    }

    func setBand(_ index: Int, gain: Float) {
        guard index >= 0, index < PrimuseConstants.eqBandCount else { return }
        let clampedGain = clamp(gain)
        bands[index] = clampedGain
        audioEngine.eqNode?.bands[index].gain = clampedGain
        // 手动拖动即进入"自定义",实时记录整条曲线
        currentPreset = .custom(bands: bands)
        customBands = bands
        persist()
    }

    func setEnabled(_ enabled: Bool) {
        isEnabled = enabled
    }

    func reset() {
        applyPreset(.flat)
    }

    /// AudioEngine.setUp() 会把所有频段增益清零,启动后需回填持久化的曲线与开关。
    func applySettings() {
        guard let eqNode = audioEngine.eqNode else { return }
        for (index, gain) in bands.enumerated() where index < eqNode.bands.count {
            eqNode.bands[index].gain = clamp(gain)
            eqNode.bands[index].bypass = !isEnabled
        }
    }

    private func clamp(_ gain: Float) -> Float {
        min(max(gain, PrimuseConstants.eqMinGain), PrimuseConstants.eqMaxGain)
    }

    private func updateBypass() {
        guard let eqNode = audioEngine.eqNode else { return }
        for band in eqNode.bands {
            band.bypass = !isEnabled
        }
    }

    var bandFrequencyLabels: [String] {
        PrimuseConstants.eqBandFrequencies.map { freq in
            if freq >= 1000 {
                return "\(Int(freq / 1000))K"
            }
            return "\(Int(freq))"
        }
    }

    // MARK: - Persistence

    private enum Keys {
        static let enabled = "eq.enabled"
        static let bands = "eq.bands"
        static let customBands = "eq.customBands"
        static let presetId = "eq.presetId"
    }

    private func persist() {
        defaults.set(bands.map(Double.init), forKey: Keys.bands)
        defaults.set(customBands.map(Double.init), forKey: Keys.customBands)
        defaults.set(currentPreset.id, forKey: Keys.presetId)
        defaults.set(isEnabled, forKey: Keys.enabled)
    }

    private func load() {
        let count = PrimuseConstants.eqBandCount

        if let saved = (defaults.array(forKey: Keys.customBands) as? [Double])?.map(Float.init),
           saved.count == count {
            customBands = saved
        }

        let savedBands = (defaults.array(forKey: Keys.bands) as? [Double])?.map(Float.init)
        let presetId = defaults.string(forKey: Keys.presetId)

        if presetId == EQPreset.customID, let b = savedBands, b.count == count {
            bands = b
            currentPreset = .custom(bands: b)
            customBands = b
        } else if let preset = EQPreset.builtInPresets.first(where: { $0.id == presetId }) {
            currentPreset = preset
            bands = preset.bands
        }

        if defaults.object(forKey: Keys.enabled) != nil {
            isEnabled = defaults.bool(forKey: Keys.enabled)
        }
    }
}
