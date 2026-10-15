import SwiftUI

struct ArtworkView: View {
    let data: Data?
    var cornerRadius: CGFloat = 16
    /// 见 `CoverArtView.identity`：只在"没有封面"时用来取占位色。
    var identity: String = "placeholder:music.note"

    var body: some View {
        Group {
            if let data, let image = PlatformImage(data: data) {
                Image(platformImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
            } else {
                #if os(macOS)
                MacDefaultArtwork()
                #else
                // 240 × 0.25 = 60pt 音符，与改动前的固定 60pt 一致。
                CoverPlaceholder(
                    identity: identity,
                    size: 240,
                    cornerRadius: cornerRadius
                )
                #endif
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
        .shadow(radius: 10, y: 5)
        .aspectRatio(1, contentMode: .fit)
    }
}

#Preview {
    ArtworkView(data: nil)
        .padding(40)
}
