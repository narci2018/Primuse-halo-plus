#if os(macOS)
import SwiftUI

/// macOS 主窗口把系统 toolbar 整条藏了 —— `MacDetailContainer` 里那句
/// `.toolbar(.hidden, for: .windowToolbar)`，为的是子视图自带的 `.toolbar` /
/// `.searchable` 不会在我们自绘的 `PMTitleBar` 底下再叠出第二条系统 bar。
/// 代价是 `LibraryView` 那句 `.navigationTitle("library_title")` 在 Mac 上
/// 没有落脚处：iPhone 上「资料库」是导航栏里的大标题，Windows 上是 navBar 的
/// 页面名，Mac 以前靠侧栏高亮告诉用户「你在哪」。四格 tab 之后侧栏没了，
/// 页名只能画在正文顶上。
///
/// 只在 `#if os(macOS)` 分支里被使用，iPhone / iPad 的渲染一行不动。
/// 桌面端惯例（macOS 版 Apple Music 的「资料库」）是页名固定不动、正文在它
/// 下面滚，所以这里配合 `safeAreaInset(edge: .top)` 用，而不是塞进 ScrollView
/// 里跟着滚 —— 后者要改动 `libraryHub` 那个 `VStack(spacing: 28)` 的行距，
/// 那是三端共享的排版参数，不该为了 Mac 一页去动。
struct MacLibraryPageTitle: View {
    let title: LocalizedStringKey

    var body: some View {
        Text(title)
            .font(.system(size: 28, weight: .bold))
            .tracking(-0.4)
            .foregroundStyle(PMColor.text)
            .lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)
            // 16 = `sectionHeader` / 分类行的水平内边距，标题要跟它们左对齐。
            .padding(.horizontal, 16)
            .padding(.top, 10)
            .padding(.bottom, 10)
            .background(PMColor.bg)
            .overlay(alignment: .bottom) {
                Rectangle().fill(PMColor.divider).frame(height: 0.5)
            }
    }
}
#endif
