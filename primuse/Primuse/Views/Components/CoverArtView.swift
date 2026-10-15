import SwiftUI

struct CoverArtView: View {
    let data: Data?
    var size: CGFloat = 48
    var cornerRadius: CGFloat = 8
    /// 无图时占位封面的取色身份。默认值刻意与 `CachedArtworkView` 的兜底身份同名，
    /// 这样没传身份的调用点也只是"固定那一档色"，不会退回灰色材质底。
    var identity: String = "placeholder:music.note"

    var body: some View {
        Group {
            if let data, let image = PlatformImage(data: data) {
                Image(platformImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
            } else {
                #if os(macOS)
                MacDefaultArtwork()
                #else
                CoverPlaceholder(
                    identity: identity,
                    size: size,
                    cornerRadius: cornerRadius,
                    glyphScale: 0.4
                )
                #endif
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
    }
}

#Preview {
    HStack(spacing: 16) {
        CoverArtView(data: nil, size: 40)
        CoverArtView(data: nil, size: 60)
        CoverArtView(data: nil, size: 100)
    }
    .padding()
}

#if os(macOS)
struct MacDefaultArtwork: View {
    var isLoading = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Image("AppIconPreview")
            .renderingMode(.original)
            .resizable()
            .interpolation(.high)
            .aspectRatio(contentMode: .fill)
            .overlay(alignment: .bottom) {
                GeometryReader { geometry in
                    let side = min(geometry.size.width, geometry.size.height)
                    if isLoading, side >= 120 {
                        VStack {
                            Spacer()
                            HStack(spacing: 6) {
                                Text("app_name")
                                    .font(.system(size: min(max(side * 0.055, 10), 20), weight: .medium))
                                if !reduceMotion {
                                    ProgressView()
                                        .controlSize(.mini)
                                }
                            }
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity)
                            .padding(.bottom, side * 0.07)
                        }
                    }
                }
            }
            .accessibilityHidden(true)
    }
}
#endif
