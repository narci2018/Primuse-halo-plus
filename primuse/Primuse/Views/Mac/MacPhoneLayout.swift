#if os(macOS)
import CoreGraphics

/// iPhone 那一竖屏的物理尺寸 —— 用户 2026-10-16 拍板："macos 版 app 界面最好设置跟 iPhone 一样，
/// 在 macos 打开也像手机版的界面一样，这样操作更方便。"
///
/// 上一轮（§30/§31）定的口径是"macOS 向 Windows 看齐"，这一轮把**形态**改回手机：
/// 窗口固定 393×852（iPhone 15/16 的逻辑分辨率），不可拉大。对齐 Windows 的那部分是
/// **功能与判据**（来源页两组恒在、搜索错误态、最小化歌词条的五项条件……），那些一条不动；
/// 变的只是外壳的形状。`criteria-parity-check.js` 继续按判据比，不比窗口宽度。
///
/// 为什么是"固定"而不是"默认"：`.windowResizability(.contentSize)` + 根视图定 frame，
/// 窗口的 min == max，系统就不给拉伸；`PMWindowChromeConfigurator` 那边继续强推
/// `.resizable` 也不影响（那个 styleMask 位是全屏按钮和红绿灯存活的前提，去掉会被它每轮加回来）。
enum MacPhoneLayout {
    /// 内容区宽度（不含标题栏的左右 padding）。
    static let width: CGFloat = 393
    /// 内容区高度（标题栏是 `fullSizeContentView`，所以整窗高度就按这个走）。
    static let height: CGFloat = 852

    /// 各页按这一个开关决定「竖屏排布」还是原来那套「宽窗口两栏」。
    ///
    /// 判据写在常量上、不写在运行时量出来的宽度上：窗口尺寸是钉死的，
    /// 而运行时宽度在动画中途、面板刚挂上去时会读到 0 或过渡值，
    /// 拿它当开关会让界面在两套布局之间闪。
    static let isPhoneForm: Bool = width <= 460
}
#endif
