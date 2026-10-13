# 未签名 macOS 包的安装与功能边界

适用于 CI 产物 `Primuse-macos-arm64-<版本>-b<构建>.dmg`（或同名 `.zip`），来自 `.github/workflows/build-mac.yml`。

## 这个包是怎么签的

- **ad-hoc 签名**（`codesign -s -`），没有任何 Apple 开发者身份，也**没有 entitlements**。
- 由内向外逐个签名：FFmpeg 的 dylib/framework → 嵌套 framework → `PlugIns` 里的 Widget Extension → 最后才是 `.app` 本身。Apple Silicon 上任何缺失签名的 Mach-O 都会在加载时被直接 kill（`[1] killed`，无崩溃日志），所以 `--deep` 那种"一把梭"在这里既不可用也不安全。
- 没有时间戳、没有 hardened runtime、没有公证（notarization）。这三项都需要 Developer ID 身份，账号到位后 `primuse/scripts/package-mac-dmg.sh` 里预留的分支会自动启用。

## 首次启动

macOS 对"未公证"的软件默认拒绝打开。两种放行方式，任选其一：

1. **图形界面**：双击 DMG → 把 `Primuse.app` 拖进 `Applications`（DMG 里已经放了 `Applications` 快捷方式）→ 在 Finder 里**右键（或按住 Control 点击）App → 打开** → 弹窗里会出现"仍要打开"。确认一次之后，正常双击即可。
2. **命令行走不通时**（Ventura 及以后部分版本会把"仍要打开"藏起来）：**系统设置 → 隐私与安全性**，页面底部会有一行"已阻止使用 Primuse，因为来自身份不明的开发者"，点**仍要打开**。

如果启动后立刻退出并出现 `Code Signature Invalid`，先检查签名链是否完整：

```
codesign --verify --strict --verbose=2 /Applications/Primuse.app
spctl -a -vv -t exec /Applications/Primuse.app     # 未公证必然 rejected，属预期，不代表装不上
```

第一条必须通过；第二条失败是正常的（没有公证），只有第一条失败才说明包本身坏了。

## 这个形态下不工作的功能

ad-hoc 签名带不了受限 entitlements，因此以下能力**静默不可用**，不是 bug：

- **CloudKit / iCloud 同步**：需要 `iCloudContainerEnvironment` 与团队签发的描述文件。双区（private/public zone）同步在 Mac 上不会启动，资料库只在本机。
- **小组件（WidgetKit）与实时活动**：Widget Extension 与主 App 之间靠 App Group 共享容器，没有 App Group entitlement 时读不到同一份数据。
- **钥匙串共享项**（`keychain-access-groups`）：源密码之类若走该组，Mac 端行为可能与 iOS 不一致。

iOS 侧不受影响——那是另一条签名链路，也已有自己的流水线。

## 尚未证实的部分

写这份说明时，**本机是 Windows，没有任何 Apple Silicon 设备或 Xcode**。所以以下三点必须在一台真实 Mac 上确认，当前只是合理推断：

1. 这个包是否真能启动并走完首屏（`codesign --verify` 在 CI 里通过，不代表 dyld 加载期不报错）。
2. Gatekeeper 在你所在 macOS 版本上的确切文案与入口位置。
3. 播放链路（SFBAudioEngine + 内置 FFmpeg）在 macOS 上是否真的能出声——CI 只验证了链接和签名，没验证运行时。

验证通过后，下一步才是把 Developer ID + 公证接上，让用户不必手动放行。
