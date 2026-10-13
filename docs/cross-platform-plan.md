# Primuse 跨平台方案：Windows 11 + macOS (Apple Silicon)

状态：**决策已确认，可执行** · 起草：2026-10-13 · 适用范围：仓库 `C:\Tools2\halo_music`（Git 根，`primuse/` 为其子目录）

> 已确认：Windows 走 **B1 薄壳 + 服务端复用**；Windows 音源范围为 **在线聚合 + 服务器型源**；分发 **先出未签名包**（Apple Silicon 侧用 ad-hoc 签名，见 §5 M4）。

---

## 0. 结论摘要

1. **macOS 支持在代码层面已经存在**，不需要新建 `Primuse-mac/` 目录。`project.yml` 中 `PrimuseMac` target（第 413 行起）复用 `Primuse/` 全部源码，含 `Views/Mac/` 三栏桌面 UI、菜单栏播放器、桌面歌词浮窗、mini player、iTunesLibrary 导入、SFBAudioEngine + FFmpeg 解码、WidgetKit 组件；bundle id 与 iOS 相同（`com.welape.yuanyin`，Universal Purchase）。Mac 侧缺的是**工程化**：可编译性验证（**已完成**，CI 已出 `Primuse-macos-arm64-1.9.6-b68` 的 DMG+ZIP，见 §11）、部署门槛过高（macOS 26.0，仍未降级）、以及真机上的安装/启动验证。
2. **Windows 不是移植而是新做客户端**。SwiftUI / AVFoundation / SFBAudioEngine / CloudKit / MusicKit / WidgetKit / CarPlay / App Intents / Translation / iTunesLibrary 在 Windows 无对应物。UI 层（191 个 SwiftUI 文件）必须重写；播放引擎必须替换。
3. **真正可复用的资产是 `PrimuseKit`**：331 个文件中只有 17 个 import 了平台受限框架，模型层、GRDB 资料库、扫描/去重/CUE/流解析/元数据策略几乎全部是 Foundation 级别逻辑。
4. 建议按"层"而不是按"平台"组织目录，核心下沉 + 各端薄壳；Windows 目录建议 `clients/primuse-win/`。

---

## 1. 现状盘点（已核实）

### 1.1 仓库形态

| 组件 | 路径 | 性质 |
|---|---|---|
| HALO Music（Web + Cloudflare） | 仓库根：`index.html`、`major.js`、`functions/`、`admin/`、`migrations/`、`schema.sql`、`wrangler.toml` | 多源搜索/播放/歌单/歌词的网页应用，Pages Functions + D1；Electron 桌面壳在 `electron/`，`package.json` 已配 `electron-builder --win nsis/portable` |
| HALO Subsonic 服务端 | `functions/rest/[[catchall]].js` + `_subsonic.js` | 实现 ping / getLicense / getMusicFolders / getIndexes / getMusicDirectory / getArtists / getArtist / getAlbum / getSong / search2 / search3 / stream / download / getCoverArt / getLyrics(BySongID) / getPlaylists / getPlaylist / create/update/deletePlaylist / star / unstar / getStarred / getAlbumList / getScanStatus。**这是 Windows 端最省力的接入口** |
| Primuse 客户端（fork） | `primuse/` | 上游 `chenqi92/primuse`，本地 `narci2018/Primuse-halo-plus`，版本 1.9.6 (build 68)（tag `v1.9.6` 已存在），约 20 条本地提交 |
| 聚合音源接入层 | `primuse/Primuse/Services/AggregatedMusic/` | 本地新增：meting / hyw / nxinxz / openApi 四类协议，默认 9 条硬编码线路，平台 QQ/网易/酷狗/酷我/bilibili |
| lx 音源脚本 | `音源文件/`（23 个 .js，约 4.8 万行） | **无任何 Swift 代码引用**，当前为死资源；唯一 JS 引擎属于刮削器（`ConfigurableScraper.swift`），与 lx 音源格式不兼容 |

### 1.2 代码规模

| Target | Swift 文件 | 行数 |
|---|---|---|
| `Primuse`（iOS/iPadOS/macOS 共用） | 322 | 256,947 |
| `PrimuseKit` | 331 | 94,536 |
| `PrimuseTV` | 40 | 26,562 |
| `PrimuseWatch` | 4 | 799 |
| `PrimuseWidgetExtension` | 7 | 2,624 |
| 测试（PrimuseTests 25 + PrimuseKitTests 179） | 204 | 13,681+ |

### 1.3 依赖耦合普查（决定可移植性的关键数据）

`PrimuseKit/Sources` 全部 import 统计：Foundation 145、CryptoKit 20、GRDB 10、Network 9、Darwin 4、CoreFoundation 3、Security 2、Observation 2、ImageIO 2，另有 os / UniformTypeIdentifiers / OSLog / NaturalLanguage / FoundationXML / CoreGraphics / ActivityKit 各 1。

需要平台适配的 Kit 文件（17 个）：

```
ArtworkAnimation.swift                  LyricsTranslationGroupingPolicy.swift
InsecureHTTPHostPolicy.swift            Models/MusicSource.swift
LyricsActivityAttributes.swift          Models/RecentAlbumsStore.swift
                                        SharedConstants.swift
                                        Sharing/ServerMediaSharing.swift
                                        SourceConnectionPreflight.swift
                                        SourceNetworkFailurePolicy.swift
                                        SSDPNetworkInterfaces.swift
                                        Streaming/FnMusicAPIProtocol.swift
                                        Streaming/StreamResolver.swift
                                        Streaming/StreamResolverRegistry.swift
                                        Streaming/UgreenStreamResolver.swift
                                        Transfer/WiFiTransferDevice.swift
                                        Transfer/WiFiTransferServer.swift
```

`Services/{Sources,Library,Metadata,Audio}` 共 115 个 Swift 文件，其中 **32 个** import UIKit/AVFoundation/SFBAudioEngine/AMSMB2/NFSKit/Citadel/FilesProvider/Network。

主 App import 频次（越高越不可移植）：SwiftUI 145 文件、AppKit 55、UIKit 51、AVFoundation 11、MusicKit 8、CloudKit 7、AppIntents 7、WidgetKit 5、SFBAudioEngine 5、MediaPlayer 4、BackgroundTasks 3、iTunesLibrary 2、Translation 2、CarPlay/MusicUnderstanding 各 1。

### 1.4 第三方库在 Windows 的可用性

| 库 | 用途 | Windows |
|---|---|---|
| FFmpeg 8.1（仓库内 xcframework） | DTS/AC-3/稀有格式解码 | ✅ 需换 Windows 构建产物（现有 xcframework 是 Apple 平台切片） |
| GRDB 7.8 | SQLite 资料库 | ⚠️ 理论可行，需 SPM on Windows 实测 |
| swift-crypto / swift-nio | 加密 / 异步网络 | crypto ✅；**NIO 官方不支持 Windows** → SMB/SFTP 连接器受影响 |
| SFBAudioEngine | 高保真解码（ObjC++） | ❌ 依赖 Objective-C runtime |
| AMSMB2 / FilesProvider / Citadel / NFSKit | SMB / WebDAV-FTP / SFTP / NFS | ❌ 或 ⚠️ 均为 Apple/Linux 生态，NFSKit 直接依赖 Network.framework |

---

## 2. 目标与非目标

### 目标
- G1：Apple Silicon Mac 上"下载即用"，不需要 TestFlight / App Store。
- G2：Windows 11 上可用的 Primuse 客户端，覆盖在线聚合音源与服务器型音源。
- G3：三端（iOS / macOS / Windows）资料库语义与歌单行为一致。
- G4：一条 CI 流水线同时产出 iOS IPA、macOS 公证 DMG、Windows 安装包。

### 非目标（明确放弃，按已确认范围）
- N1：Windows 端复刻 Apple Music、CarPlay、Watch、Widget、CloudKit 同步、空间音频头部追踪、DSD/DoP。
- N2：把 Swift UI 层做跨平台移植（OpenSwiftUI 等第三方实现不完整）。
- N3：`Primuse-mac/` 目录（会与 iOS 共享源码三份漂移）。
- N4（本轮新增）：Windows 端直连本地文件夹与 SMB / NFS / SFTP / WebDAV / FTP / S3 等 NAS 协议。B1 路线下这些能力由**服务端**承担（自建 Subsonic/媒体服务器已覆盖同一需求），Windows 客户端不做协议栈。
- N5（本轮新增）：App Store 上架。未签名分发 + 明文第三方解析接口这一组合不具备过审条件，按侧载形态推进。

---

## 3. 架构方案：核心下沉 + 双端薄壳

```
halo_music/
├── core/
│   └── primuse-core/                 # 由现有 PrimuseKit 演进；平台中立
│       ├── Sources/CoreModels        # Song/Album/Playlist/MusicSource/AudioFormat
│       ├── Sources/CoreLibrary       # GRDB schema + 迁移 + FTS 拼音/歌词索引
│       ├── Sources/CoreScan          # 增量扫描、检查点、去重
│       ├── Sources/CoreStream        # CUE 分段、Range、解析器注册表
│       ├── Sources/CoreConnectors    # 协议逻辑（与平台 IO 分离）
│       ├── Sources/CoreCompat        # ★ 平台适配 shim：Crypto/Image/Network/时间
│       └── FFI/                      # C-ABI 导出，供 Rust/C# 宿主调用
├── backend/halo-music/               # 现有 Cloudflare 应用 + Subsonic API（聚合音源的家）
├── primuse/                          # 不动：iOS / iPadOS / tvOS / watchOS / macOS
├── clients/
│   └── primuse-win/                  # ★ 新建 Windows 客户端
│       ├── src-tauri/  (Rust 宿主 + FFmpeg→WASAPI 播放 + FFI 调 core)
│       ├── web/        (UI)
│       └── installer/  (MSIX / portable)
└── 音源文件/                          # 建议移除或真正接入
```

设计原则：
1. 单一真源（single source of truth）在 `core/primuse-core`，三端行为差异只允许出现在最外层适配。
2. 平台能力通过 capability 接口暴露给 UI：`IAudioSink`、`IFilePicker`、`ISecureStorage`、`ISyncBackend`、`ILyricTranslator`。Apple 端用原生实现，Windows 端用 WASAPI / DPAPI / 自建 sync / （无翻译）。
3. 聚合在线音源的解析逻辑**从客户端挪到服务端**（HALO `functions/api/music.js`），客户端只消费 Subsonic/自有 REST。好处：线路失效只改服务端，不用重新发版；同时去掉 App Store 侧最敏感的部分。

---

## 4. Windows 三条路线对比

| | **B1 薄壳 + 服务端复用（✅ 已选）** | B3 C-ABI 核心复用（后续演进方向） | B2 Swift-on-Windows 原生（不采用） |
|---|---|---|---|
| 做法 | Tauri/Electron UI + 播放走 FFmpeg→WASAPI，数据面吃 HALO 的 Subsonic API | `PrimuseKit` 编 DLL，Windows UI 调核心逻辑，UI/音频原生 | Swift 6 Windows 工具链 + WinUI3/自绘，尽量复用现有代码 |
| 覆盖能力 | 聚合在线音乐、Subsonic/Navidrome/Jellyfin/Emby/Plex、歌单、歌词、scrobble | 上面 + 本地文件与 NAS 协议扫描、去重、CUE、缓存、刮削、统一资料库 | 接近全量（除 Apple 独占服务） |
| 需重写的部分 | UI 全写、播放器 | UI 全写、音频输出、网络 IO shim | UI 全写（无 SwiftUI）、NIO/AMSMB2/NFSKit/SFBAudio 全部替换 |
| 工作量（估） | 2–3 人·月 | 6–9 人·月 | 12–18 人·月 |
| 主要风险 | 本地/NAS 源缺失；依赖云端可用性 | FFI 边界与并发语义（Swift 6 Sendable）调试成本 | Swift Windows 生态缺口，可能在库移植上耗尽预算 |
| 维护成本 | 低 | 中 | 中（一套语言）但依赖面最广 |

建议：**B1 先落地拿到可用产品 → 同一条 CI/代码骨架里演进到 B3**。B2 不作为目标。

---

## 5. 分阶段执行计划（B1 路线，已确认）

### M0 · macOS 真正可交付（1 周）—— **代码部分已完成，产物已出**（见 §11）
- 新增 `.github/workflows/build-mac.yml`：实际用 **`macos-26`** runner（与本仓库既有 iOS 流水线一致，并按"带所需 platform 的最高 Xcode"自动选版本，不硬锁 Xcode），`xcodegen generate` → `xcodebuild -scheme PrimuseMac -configuration Release` → `.app` → **ad-hoc 签名**（`codesign -s -`，Apple Silicon 强制要求任何可执行代码至少 ad-hoc 签名，否则直接 "killed: 9"）→ `hdiutil` 出 DMG → 上传 artifact。待有付费开发者账号后，再把 ad-hoc 换成 Developer ID + `notarytool submit --wait` + `stapler staple`。
- 评估把 `MACOSX_DEPLOYMENT_TARGET` 由 26.0 降至 15.0：需清点 `Views/Mac/` 与 `PrimuseApp.swift` 中 macOS 26-only 的 SwiftUI API。若降级成本过高，则文档明确"需 macOS 26 Tahoe"。
- 核对 Mac 端聚合音源：`Primuse/` 源码共用 → `MusicSourceType.aggregated` 在 Mac 上自动可用，需验证明文 HTTP 线路（`http://103.79.184.97/...`）的可达性。
- 交付物：可直接下载的 DMG + 《未签名包安装说明》（Gatekeeper 放行步骤）+ Mac 功能缺失清单。
- 说明：本阶段全部在 CI 上验证，不依赖本机有 Mac。

### M0.5 · 后端就绪（B1 的前置，1 周，可与 M0 并行）
B1 的本质是"Windows 客户端只是眼睛和耳朵"，能力上限等于后端提供的东西。这一步不做，M2 无从谈起。
- 部署 HALO Music 到一个稳定域名（Cloudflare Pages + D1，`wrangler pages deploy`，迁移 `migrations/0001–0003`）。当前仓库里 D1 `database_id` 已写死，需确认是否为你自己的实例。
- Subsonic 面补强：**已实测，Range 与 OpenSubsonic 两块都不缺**（§10：`Range: bytes=1000000-1000999` → 206 + `Content-Range`；`getLyricsBySongId` 返回 `structuredLyrics.synced` 逐行毫秒时间戳）。真正剩下的只有 `getSimilarSongs`/`getRandomSongs` 这类推荐型接口，以及 QQ 的专辑/封面/时长字段（§10 缺陷 3，属源优先级取舍，不是 Subsonic 协议缺口）。
- **聚合平台缺口**：HALO 目前只有网易云 + QQ（QQ 失效时从 bilibili 补位），而 Primuse 侧的聚合模块已支持酷狗/酷我。**要么把 `AggregatedSourceStore` 的线路下沉进后端，要么 Windows 端一开始就只有网易+QQ。** 这是 B1 路线必须先接受的一条取舍。
- 鉴权对齐：**已实测可用**（token 分支 `u`+`t`/`s`，`t = md5(secret+salt)`，与 `Primuse/Services/Sources/SubsonicSource.swift` 的调用习惯一致；`p`/`enc:` 分支同样在同一个函数里）。前提是先补上 `migrations/0004_add_subsonic_tables.sql` —— 在此之前 `subsonic_auth` 表只存在于 `schema.sql`，用 migrations 建的库上 `/rest/*` 一律 `code 40`（§10 缺陷 1）。
- 把解析类接口从客户端迁到服务端后，Apple 端可去掉 `NSAllowsArbitraryLoads = YES`，改为按域名的 ATS 例外。
- 交付物：可访问的 `https://<domain>/rest/...?u=&t=&s=&v=&apiVersion=` 且能用现有 Primuse「Subsonic 源」跑通搜索→播放→歌词→加歌单。

### M1 · Apple 端健康度（1–2 周，与主线并行，非阻塞）
B1 不需要在 Windows 上编译 Swift，所以原先的"核心可移植化"从关键路径移除，但下面这几项无论选哪条路都该做：
- 补 `AggregatedMusic` 的半成品与测试：`.customJson` 目前返回空数组；`.hyw` / `.nxinxz` 搜索分支忽略用户配置的 `baseURL` 仍打硬编码地址；`.nxinxz` 解析不校验；该模块 0 测试（Kit 侧现有 179 个测试未覆盖它）。
- 决定 `音源文件/`（23 个 lx 脚本、4.8 万行，无任何代码引用）的去留：接入需实现 lx 的 `createApi` 沙箱语义，或直接删除。
- 统一版本与工具链口径（2026-10-13 复核后的准确清单）：`primuse/README.md:185` 要求 Xcode 26.0+，`primuse/project.yml:9` 却写 `xcodeVersion: "16.0"`；两个 CI workflow 都跑 `macos-26` 并按"有 iOS/macOS platform 的最高 Xcode"自动选版本，因此实际用的是 Xcode 26，`xcodeVersion` 只是生成工程时写入的兼容性标记，不参与选版；`primuse/CHANGELOG.md` / `CHANGELOG.en.md` 停在 **1.7.3 (build 24)**，而 `project.yml` 与 tag 已是 **1.9.6 (build 68)** —— 跨 40 多个 build 的更新日志缺口，需要单独一次回填，不适合顺手改。另外 `primuse/.github/workflows/build-ipa.yml` 是被 GitHub 忽略的死配置（GitHub 只读仓库根 `.github/`），内容严格陈旧于根目录那份（`macos-15` + 硬锁 Xcode_16.0/16.1、缺 `-sdk iphoneos` 与 c++20 实验库标志、`working-directory` 错误），已删除以止住"改错文件"的坑。

### M2 · Windows 客户端最小闭环（2–3 周）
- 壳：**Tauri 2**（Rust 宿主，包体 ~8MB、内存友好）；若你更熟 Node，可复用仓库已有 `electron/` + `electron-builder --win` 配置直接开工，代价是包体 90MB+。二选一在开工第一天定。
- 播放：FFmpeg（Windows 构建，`libavformat`/`libavcodec`/`libswresample`）→ PCM → **WASAPI 共享模式**（独占模式会独占设备、跳过系统音量，先不做）。队列、播放/暂停/切歌/进度/音量/随机/循环。
- 数据：`/api/music` 或 Subsonic `search3` 拉在线结果；GRDB/SQLite 做本地资料库与播放历史（Windows 侧用 `rusqlite` + 与 Primuse 相同的 schema 定义，或走 `core/primuse-core` 的 FFI —— 那是 B3 的入口，M2 先不接）。
- UI：搜索 / 正在播放 / 歌词（LRC + 字级）/ 收藏 / 歌单 / 设置（后端地址 + 账号）。
- 交付物：Windows 11 双击可运行的安装程序，能搜在线歌、播放、看歌词、管歌单。

### M3 · Windows 能力对齐（3–6 周，可选）
- 服务器型源全量：Subsonic/Navidrome/Airsonic/Gonic、Jellyfin、Emby、Plex（M0.5 之后这些都是纯 HTTP 客户端，成本远低于协议栈）。
- 播放历史 / scrobble（Last.fm、ListenBrainz）/ 搜索历史 / 快捷键 / 托盘迷你播放器。
- 若要"本地文件"，此时再评估 `core` 的 FFI 方案（B3 演进）。

### M4 · 分发（与 M2 同期落地）
- macOS：**未签名 + ad-hoc 签名 DMG**。Apple Silicon 不能跑完全未签名的二进制，ad-hoc 是下限；用户需右键打开或在"系统设置 → 隐私与安全性"放行，Gatekeeper 隔离属性可用 `xattr -dr com.apple.quarantine <App>` 清除。升级路径：购 Developer ID（$99/年）后走 `notarytool` 公证 + `stapler`，届时用户体验质变，代码无需改动。
- Windows：**portable exe + NSIS 安装器**（`electron-builder --win portable/nsis` 已配好；Tauri 用 `cargo tauri build --bundles nsis,msi`）。无代码签名证书 → SmartScreen 会弹"未知发布者"，需在 README 给明确放行说明；`forceCodeSigning: true` 这个现有配置必须改成条件签名，否则 CI 直接失败。
- iOS：沿用现有 unsigned IPA + 侧载。
- CI：一条 workflow 矩阵产出 iOS IPA / macOS DMG / Windows exe 三件 artifact。

---

## 6. 风险与注意事项

| 风险 | 说明 | 处置 |
|---|---|---|
| 本机无 Xcode | 任何 Apple 端构建/验证都无法在 Windows 完成 | 全部走 CI，每个 M0/M1 任务以"CI 绿"为验收 |
| ATS 与明文 HTTP | 聚合线路含裸 IP `http://103.79.184.97`，且三份 plist 都开了 `NSAllowsArbitraryLoads = YES`（全应用放行） | 改为按域名精确例外；把解析挪到服务端后客户端不再需要放行 |
| 公共解析接口不稳定 | 9 条默认线路随时失效，客户端发版无法救 | 线路配置服务端化 + 优先级/健康检查（现有 `isPinging` 可复用） |
| NIO/AMSMB2/NFSKit 无 Windows 支持 | 影响 SMB/SFTP/NFS 移植 | 提前选型（Rust `smbclient`/`supersapien`、`ssh2`、`webdav` crate），或 M3 只做服务器型源 |
| SFBAudioEngine 不可移植 | Windows 高保真路径缺失 | Windows 端统一走 FFmpeg 解码，AC-3/DTS 反而更稳 |
| 文档与工程口径漂移 | `primuse/README.md` 要求 Xcode 26.0+，`project.yml` 写 `xcodeVersion: "16.0"`（该键不决定 CI 用哪个 Xcode，仅影响生成工程的兼容性标记）；CHANGELOG 停在 1.7.3/24 而版本已是 1.9.6/68；`primuse/.github/` 下还有一份被 GitHub 忽略的旧 iOS workflow | 死配置已删（2026-10-13）；版本回填见 §5 M1 清单，需要单独一次提交 |
| 死资源 | `音源文件/` 4.8 万行 lx 脚本无引用 | 接入（需实现 lx 沙箱 API）或删除，二选一，不要长期挂着 |
| 聚合模块半成品 | `.customJson` 返回空；`.hyw`/`.nxinxz` 搜索忽略用户配置的 `baseURL`；`.nxinxz` 解析不校验；零测试 | M1 顺带补齐并加测试 |

---

## 7. 决策记录（已确认）

| 编号 | 决策 | 选定 | 直接后果 |
|---|---|---|---|
| D1 | Windows 技术路线 | **B1 薄壳 + 服务端复用** | Windows 端不写 Swift、不编 `PrimuseKit`；能力上限由 HALO 后端决定 |
| D2 | Windows 音源范围 | **在线 + 服务器型源** | 本地文件夹与 SMB/NFS/SFTP/WebDAV/S3 明确不在本轮范围（见 N4） |
| D3 | 签名与分发 | **先出未签名包** | macOS 必须 ad-hoc 签名（Apple Silicon 硬要求）+ Gatekeeper 放行说明；Windows 接受 SmartScreen 警告，且现有 `forceCodeSigning: true` 需改为条件签名 |

由 D1/D2 派生的必答项（开工前需确认）：
- **聚合平台取舍**：后端目前只有网易 + QQ（QQ 失效时从 bilibili 补位）。是否把酷狗/酷我线路也下沉到后端？不做则 Windows 首版没有它们。
- **后端域名与实例**：HALO 是否已部署在你控制的 Cloudflare 账号下（仓库里 D1 `database_id` 写死）？Windows 客户端要指向一个稳定地址。
- **壳选型**：Tauri（Rust，包体小）还是复用现成 `electron/`（Node，起步最快，`--win nsis/portable` 已配好）。
- **QQ 搜索的源优先级**（§10 缺陷 3）：官方源字段全但慢，第三方代理快却没有专辑/封面/时长。选 A（官方优先，接受延迟）/ B（赛跑后异步补全）/ C（继续兜默认值，不推荐）。这决定 Windows 与 macOS 端"能不能显示专辑、进度条准不准"，是首屏观感问题，不是可选打磨。

## 8. 开工后的第一周

1. `build-mac.yml`：macOS arm64 → `.app` → ad-hoc 签名 → DMG → artifact。先拿到"能装进 M 系列 Mac"的产物，同时暴露 `PrimuseMac` 是否真能编译（当前完全未验证）。
2. 后端连通性验证：用 `curl` 或现成 Subsonic 客户端打 `/rest/ping`、`search3`、`stream`、`getLyrics`，确认 Primuse 的 Subsonic 源能直连 HALO。**这一步失败，B1 全部计划要重排，所以必须最早做。**
3. 清理已知工程漂移：`forceCodeSigning`、版本口径（README/`project.yml`/CI/CHANGELOG 四处不一致）、`音源文件/` 的去留。
4. 若第 2 步暴露 Range / OpenSubsonic 缺口，立刻在 `functions/rest/[[catchall]].js` 补齐，而不是等 Windows UI 做完才发现播不了。

---

## 9. 本方案未验证的部分

- **`PrimuseMac` 是否真能编译** —— **已验证：能编，且已出包**（run 38381672057，26.1 分钟全绿，产物 `Primuse-macos-arm64-1.9.6-b68`，133.2 MB）。中间卡住的两次都不是 Swift 的问题：一次是 CI 的 destination 写法，一次是仓库自带的 FFmpeg macOS 切片被 Windows 导入压平了符号链接（详见 §11）。唯一仍然没有证据的，是这个 ad-hoc 包在真机上能不能装、能不能开、Gatekeeper 各版本的实际放行路径 —— 需要一个 M 系列 Mac 手工验证。
- HALO 的 Subsonic 实现是否满足 Primuse 客户端的实际调用习惯 —— **已实测，见 §10**。
- `forceCodeSigning: true` 下的 Windows 打包在无证书环境下必然失败 —— **已改为 `false`**。
- Tauri + WASAPI 的位深/采样率协商、以及未签名 macOS 包在各版本 Gatekeeper 下的实际放行路径，需出包后实测。
- lx 音源脚本与 Swift 代码的对接可行性未评估（需 `createApi` 沙箱语义对齐）。
- B1 路线下不再需要 `GRDB`/`swift-crypto` 在 Windows SPM 上编译，原 M1 的 Windows 编译门已移除；若将来演进到 B3，需重新验证。

---

## 10. 实测记录（2026-10-13）

方法：`wrangler pages dev`（4.114.0）在本机跑起当前工作树，`scripts/probe-subsonic.mjs` 做只读探测。探测用的临时 `subsonic_auth` 记录已删除，本地 dev server 已停止。

### 已确认可用

| 能力 | 结果 |
|---|---|
| 路由 | `/rest/*.view` 与 `/rest/*` 都进入 Pages Function，`_routes.json` 的 include 生效 |
| 鉴权 | 标准 Subsonic：`u` + `t`/`s`（`md5(secret+salt)`）与 `p`/`enc:` 双分支，与 `Primuse/Services/Sources/SubsonicSource.swift` 的调用习惯一致 |
| `ping` | `type: Navidrome`、`serverVersion 0.52.5`、`openSubsonic: true`，客户端会按 OpenSubsonic 路径走 |
| `getLicense` `getMusicFolders` `getIndexes` `getArtist` `getAlbum` `getStarred` | 全部 HTTP 200 + 合法 Subsonic JSON |
| `search3` | 查询"周杰伦"返回 5 条 QQ 结果，id/title/artist/duration/contentType/bitRate 齐备 |
| **`stream` + Range** | 无 Range → 200 + `Accept-Ranges: bytes` + 正确 Content-Length（5,785,073B，ftyp mp42 容器）；`Range: bytes=1000000-1000999` → **206 + `Content-Range` + 恰好 1000 字节** |
| `getLyricsBySongId` | OpenSubsonic `structuredLyrics`，`synced: true`，逐行 `start` 毫秒时间戳 |

Range 是 B1 路线成立的关键，Primuse 侧有 49 处 Range 相关调用依赖它 —— 结论：**服务端已满足**。

### 发现的缺陷

1. **P0（本次已修）**：`subsonic_auth` 只在 `schema.sql` 里定义，`migrations/0001–0003` 从未创建它；由 migrations 建立的库（包括本机这份）里 `/rest/*` 的 token 鉴权一律 `code 40 Wrong username or password`，Subsonic 面完全不可用。同时 `subsonic_request_log` 被 `functions/rest/[[catchall]].js` 每次请求写入，却在 `schema.sql` 和 migrations 里都不存在 → 日志静默丢失。
   修复：新增 `migrations/0004_add_subsonic_tables.sql`（两张表 + 两个索引，`IF NOT EXISTS` 幂等，对已存在的库是 no-op），并给 `schema.sql` 补 `subsonic_request_log`。补跑 migration 后同一套探测立刻全绿 —— 修复经过实测验证，不是推断。
2. **P1（部分已修）**：`getCoverArt` 对不在资料库里的 `qq_*` id 曾返回 302 → `y.gtimg.cn` **404**。根因是它把**歌曲 mid** 塞进了需要**专辑 mid** 的封面模板 `T002R300x300M000{albumMid}.jpg`，这个拼接值永远无效。
   已改：有 `albumMid` 时才发 302，否则返回占位图（200 image/svg+xml），不再把客户端指向必然 404 的地址 —— 已实测（`qq_001Bbywq2gicae`：修复前 302→404，修复后 200 占位图；库内曲目 `cov_netease-4878606`：仍是 302 → 跟随后 200 `image/jpg` 244KB，未被破坏）。
   残留：搜索结果里 `coverArt` 仍为 undefined、`album` 为占位值，因为 provider 载荷没有 `albumMid`（见下条根因）。要彻底解决需通过 QQ 歌曲详情接口补全。
3. **P1（根因已定位，修法需你拍板）**：`duration` 恒为 210、`cover`/`album` 为空。读本地 `search_cache` 得到实证：`{"mid":"001IazE54bpTz7","album":"","cover":"","albumMid":"","duration":0}`。
   进一步读代码把原因缩到一处：`searchQQ` 用 `fastestSearch`（`functions/api/music.js:379`，内部是 `Promise.any`）在 `qq-official-musicu`、`qq-official-legacy` 和 N 条 `QQ_SOURCE_URLS` 代理之间赛跑，**谁先返回非空列表谁就赢，并且整份结果直接进 `search_cache`**。官方分支的 `normalizeQQOfficial` 明明读了 `song.album.mid` 与 `song.interval`（`functions/api/music.js:277/286`），代理分支的 `normalizeQQProxy` 也已经兼容 `album_mid/albummid/song_play_time` 等别名（`:322/324`）—— 所以这不是字段映射漏了，而是**第三方代理响应更快，赢了赛跑，而它的载荷根本不带专辑/封面/时长**。
   三个候选修法（都会改变线上搜索接口的延迟特征，因此不擅自改）：
   - A. 让官方源优先：给官方分支一个短窗口（例如先等 400ms 的官方结果，超时才接受代理结果）。字段最全，代价是搜索 P95 延迟上升，且官方 fcg 被风控时整体退化。
   - B. 保持赛跑，但对赢家的前 N 条做异步补全（QQ 歌曲详情接口），补全结果二次写缓存。延迟不变，多一轮上游调用与缓存版本管理。
   - C. 只在下游兜底（现在的 `Number(track.duration) || 210`）。**不推荐**：进度条与听歌统计都会失真，且封面永远拿不到。
4. **P2**：搜索结果 `album` 为占位值（"QQ音乐"），按专辑浏览语义弱。
5. **P2**：经典 `getLyrics`（artist+title）返回空 `value`，只有 `getLyricsBySongId` 有效；Primuse 走后者，暂不阻塞。
6. **部署事实**：`https://halo-music.pages.dev` 的 `/rest/*` 回落到 SPA HTML，而 `/api/version` 正常返回 2.0.0 并指向 `zhoujungis/halo_music` 的 Android APK 发布 —— 该线上实例**不是用当前工作树部署的**。B1 落地必须先有一个由本仓库部署的 Pages 实例。

### 本次一并完成

- `.github/workflows/build-mac.yml`：仓库根（`primuse/.github/` 那份是被 GitHub 忽略的死配置）新增 macOS arm64 构建 → ad-hoc 签名 → DMG + ZIP artifact，带失败时上传构建日志。这是 `PrimuseMac` 第一次进 CI。
- `primuse/scripts/package-mac-dmg.sh`：由内向外逐个签嵌套 Mach-O（Apple Silicon 对无签名二进制直接 kill），`--deep` 已废弃故不使用；默认 ad-hoc **不带 entitlements**，因为 `Config/PrimuseMac.entitlements` 里的 iCloud/CloudKit/App Groups 是受限 entitlements，没有描述文件支撑会让 App 在出现任何 UI 之前就以 "Code Signature Invalid" 退出 —— 未签名分发形态下宁可让这些功能不激活。脚本预留 Developer ID + 公证分支。
- `package.json`：`forceCodeSigning` → `false`，无证书时 Windows 打包不再直接失败。
- `README.md`：数据库初始化段落补上 migration 0004 的适用条件与症状。
- `functions/rest/[[catchall]].js`：`getCoverArt` 不再用歌曲 mid 拼腾讯专辑封面模板（该 URL 恒 404），改为有 `albumMid` 才 302、否则回占位图；已在本地 dev 实例上前后对照实测。

### 远端新提交带来的两处变化（同日 rebase 后核实）

变基到 `origin/main`（新增 `cf-sync-server/`、播放列表云同步等 3 个提交 + `v1.9.6`）后，`schema.sql` 出现冲突，已按**并集**解决：保留远端的 `device_playlists`（含 `idx_device_playlists_updated`）与本次的 `subsonic_auth`、`subsonic_request_log`。

- **`device_playlists` 不补 migration，是有意为之**：它看起来与缺陷 1 同类（只在 `schema.sql`、不在 `migrations/`），但 `functions/api/sync-playlists.js:80` 每次请求先执行 `CREATE TABLE IF NOT EXISTS device_playlists`（作者注释"容错自动建表"），且该表只被这一个端点使用，因此 migrations 建库同样能自愈。`subsonic_auth` 之所以是 P0，正因为 `/rest/*` 路径上没有任何自动建表。**判据**：表只存在于 `schema.sql` 时，先看写它的那段代码有没有兜底建表，再决定要不要加 migration，不要机械补齐。
- **换行符回归**：本次编辑把 `README.md`、`package.json` 从仓库既有的 LF 写成了 CRLF，导致整文件假变更（README 一度显示 482 增 / 473 删）。已归一化回 LF，实际内容改动仍是 9 行。后续在 Windows 上编辑这两个文件时注意同样问题，否则 review 噪声会淹没真实 diff。
---

## 11. CI 实测记录：PrimuseMac 第一次进流水线（2026-10-13）

`PrimuseMac` 此前从未在任何 CI 上构建过，本机又是 Windows，所以 M0 的全部信息只能从 GitHub Actions 拿。三轮运行的实际结果：

| 轮次 | commit | 卡在哪 | 真实原因 |
|---|---|---|---|
| 1 | `8ca9944` | 第 7 步之前，3 分半 | —— 只留下一个需要鉴权才能下载的 log artifact（匿名 GET 返回 401），当时完全读不到错误 |
| 2 | `1a790f8` | Build 步骤，exit 70 | `xcodebuild: error: Unable to find a device matching the provided destination specifier` —— `generic/platform=macOS,arch=arm64` 是非法组合，generic destination 不能带 arch |
| 3 | `0cbcb05` | Build 步骤，约 28 分钟后 exit 65 | `'libavcodec/avcodec.h' file not found` + `Did not find header 'avcodec.h' in framework 'libavcodec'` |

第 2、3 轮的错误都是靠新加的 `::error::` 注解拿到的：**check-run annotations 和 job summary 在公开仓库上可以匿名 GET，而 artifact 与原始日志必须带 token**。这条机制本身比某一次修复更值钱，已固化在 `build-mac.yml` 里。

### 第 3 轮的根因：vendored FFmpeg 的 macOS 切片在仓库里就是坏的

`primuse/Frameworks/FFmpeg/*.xcframework/macos-arm64_x86_64/` 是**带版本的 framework**（`Versions/A/...` 结构），除 `Versions/A` 以外全是符号链接。而整个仓库的索引里 **`120000` 模式一条都没有**（`git ls-files -s | awk '$1=="120000"' | wc -l` = 0，`git log --all --raw` 也从未出现过 120000），因为这棵树是在 Windows 上导入的：`Headers`、`Modules`、`Resources`、`Versions/Current`、`libavcodec` 这 5 个链接被压成了 24/24/26/1/27 字节的**普通文本文件**，内容正是链接目标字符串（`Versions/Current/Headers`）。四个 framework 共 20 条。

- iOS 侧看不出问题：`ios-arm64` 与模拟器切片是扁平结构，不需要符号链接，所以历史上所有 CI 都是绿的。
- 光看编译错误会以为缺 `-F` 搜索路径，实际二进制与头文件都在 `Versions/A` 里，只是顶层入口是文本文件，clang 顺着 `libavcodec.framework/Headers` 找不到目录。
- 运行时同样会死：顶层 `libavcodec` 是 27 字节的文本，dyld 拿到的不是 Mach-O。

修法：不重新下载 FFmpeg，只把这 20 条索引项的模式从 `100644` 改回 `120000`（内容已经恰好是链接目标，直接复用原 blob）。Windows 本机没有符号链接权限也无所谓 —— 改的是索引，CI 在 macOS/Linux 上 checkout 时会正确生成链接。

### 为什么必须加前置校验

在 Windows 上 `git add -A` 会**再次**把这 20 条打回 `100644`（这就是当初坏掉的方式）。所以在 `build-mac.yml` 里加了一个构建前的结构校验步骤：逐个检查 4 个 framework 的 5 个入口是不是真符号链接、`Headers/<name>.h` 能否解析、`Versions/Current/<name>` 是否为真文件，并打印索引里 `120000` 的条数（应为 20）。它把 28 分钟的失败压缩成几秒钟的明确报错。

**M0 结果（同日）**：第五轮 run `38381672057` 全绿，26.1 分钟，13 个步骤无一失败，产物 artifact `Primuse-macos-arm64-1.9.6-b68`（DMG + ZIP，133.2 MB）。也就是说 Mac target 的 Swift 主体、WidgetKit 宿主页、FFmpeg 链接、ad-hoc 逐个签名与 `hdiutil` 打包一次性全部通过，M0 的代码部分到此结束。

**仍未验证（必须真机）**：这个包在 M 系列 Mac 上能否双击启动、Gatekeeper 是"仍要打开"一次到位还是需要在「隐私与安全性」里点"允许"；CloudKit 同步与小组件在剥掉 entitlements 后是否只是静默不可用（脚本注释如此假设，但没有实测）。artifact 需要登录才能下载，匿名 GET 返回 401，所以本机无法自证。

**下一轮构建要顺带确认的小改动**：`thin_arch` 之前是无效的（FFmpeg 的二进制在 `Versions/A/` 下，而框架顶层入口是符号链接，`find -type f` 根本走不到），现在显式点名四个框架并排在签名之前；默认仍为关闭，所以线上产物暂时还是 arm64+x86_64 通用包。
