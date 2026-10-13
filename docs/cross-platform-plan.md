# Primuse 跨平台方案：Windows 11 + macOS (Apple Silicon)

状态：**决策已确认，可执行** · 起草：2026-10-13 · 最后更新：2026-10-14（§18：Windows 端歌单层与云端歌单同步，v1.9.10） · 适用范围：仓库 `C:\Tools2\halo_music`（Git 根，`primuse/` 为其子目录）

> 已确认：Windows 走 **B1 薄壳 + 服务端复用**；Windows 音源范围为 **在线聚合 + 服务器型源**；分发 **先出未签名包**（Apple Silicon 侧用 ad-hoc 签名，见 §5 M4）。
> 同日追加 D4–D7（见 §7）：壳 = **复用现成 `electron/`**；后端 = **沿用已部署的 `halo-music.pages.dev`，不重新部署**，接入口从 `/rest` 改为 `/api/music`；首版音源 = **全平台（网易+QQ+酷狗+酷我）**，酷狗/酷我由客户端主进程直连 meting；QQ 搜索字段 = **维持现状**。§3、§4、§5 M0.5/M2、§6、§9 均已按此修订。
> **§12–§13 是对上面两段的实测纠正**：HALO 现网只有 `/api/music`+`/api/version`，播放类接口要登录；9 条公开聚合线路今天只有网易能出声。**M2 的主路径已改为「道理鱼（DaoLiYu）薄壳」**（见 §13），因为 iPhone 的四平台播放来自一台地址由用户自填、带账号的服务器，而不是这些公开线路。
>
> **⚠️ 2026-10-13 路线作废（用户纠正，以 §16–§17 为准）**：上面两段里的 **D1（B1 薄壳 + 服务端复用）、D4（复用现成 `electron/`）、D5（接 `halo-music.pages.dev`）三处决策是错的**，错在一个前提上 —— 我把仓库根 `halo_music/` 当成了产品本体，把 `primuse/` 当成了它的 iOS 客户端。实际相反：**`C:\Tools2\halo_music\primuse` 是一个完整独立的音乐 App（Primuse），自带全部界面和自带音乐源，不依赖 HALO 后端一行代码**。用户要的是把这个 App 多做两个版本（win / macos），不是把 HALO 网页套壳。已按 `electron/` 打出的 `HALO-Music-Setup-*.exe` 属于错交付：它加载 `halo-music.pages.dev`，所以首屏是 HALO 的登录墙，而 Primuse iPhone 版**根本没有账号体系**。§3、§4、§5 M0.5/M2、§13、§15 中与这三个决策相关的部分全部保留作为过程记录，但**不再作为执行依据**；执行依据是 §16（方案）与 §17（Windows 端 W0–W4 的实际交付与实测记录）。macOS 那一端本来就是对的（`PrimuseMac` target = 同一个 App 的桌面版），已交付。

---

## 0. 结论摘要

1. **macOS 支持在代码层面已经存在**，不需要新建 `Primuse-mac/` 目录。`project.yml` 中 `PrimuseMac` target（第 413 行起）复用 `Primuse/` 全部源码，含 `Views/Mac/` 三栏桌面 UI、菜单栏播放器、桌面歌词浮窗、mini player、iTunesLibrary 导入、SFBAudioEngine + FFmpeg 解码、WidgetKit 组件；bundle id 与 iOS 相同（`com.welape.yuanyin`，Universal Purchase）。Mac 侧缺的是**工程化**：可编译性验证（**已完成**，见 §11）、部署门槛过高（macOS 26.0，仍未降级）、以及真机上的安装/启动验证。打包分发也已完成：DMG+ZIP 由 `v*` tag 自动挂到 Release（§14）。
2. **Windows 不是移植而是新做客户端**。SwiftUI / AVFoundation / SFBAudioEngine / CloudKit / MusicKit / WidgetKit / CarPlay / App Intents / Translation / iTunesLibrary 在 Windows 无对应物。UI 层（191 个 SwiftUI 文件）必须重写；播放引擎必须替换。
   ~~**修订（D4 + §15）**：首版不重写，直接把现成的 `electron/` 壳打包成 Windows 包。~~ **该修订已作废（D4 是错的，见顶部与 §16）**：`electron/` 是 HALO 网页壳，打开是登录墙，不是 Primuse。
   **最终交付（§17）**：新建独立工程 `primuse-win/`，用 Electron **复刻 Primuse 本体**（自己的界面、自己的 9 条聚合线路、自己的道理鱼源），数据层按 §16.5/§16.6 的 HTTP 契约在 JS 里重实现，与 iPhone 版行为对齐。已在本机 Win11 出 `Primuse-Setup` + `Primuse-Portable` 两个 exe 并冒烟通过。
   **v1.9.10 追加（§18）**：Windows 端补齐了**歌单层** —— 建/改名/删歌单、搜索结果"＋歌单"、从歌单移除、手动调序，随机/顺序/单曲循环，以及与 iPhone 共用 `primuse-sync-server` 的歌单上传/下载（同步的是歌单结构，不是歌曲源）。UI 与交互逐条对着 iPhone 的 Swift 视图抄，省略项见 §18.4。
3. **真正可复用的资产是 `PrimuseKit`**：331 个文件中只有 17 个 import 了平台受限框架，模型层、GRDB 资料库、扫描/去重/CUE/流解析/元数据策略几乎全部是 Foundation 级别逻辑。
4. ~~建议按"层"而不是按"平台"组织目录，核心下沉 + 各端薄壳；Windows 目录建议 `clients/primuse-win/`。~~
   ~~**修订（D4）**：Windows 首版不新建目录，直接复用仓库根已有的 `electron/`。~~ **两处均已作废（§16）**：Windows 首版**新建了** `primuse-win/`（不是 `clients/primuse-win/`，也不复用 `electron/`）。`core/primuse-core` 下沉属于后续 B3 形态，不是首版前置。

---

## 1. 现状盘点（已核实）

### 1.1 仓库形态

| 组件 | 路径 | 性质 |
|---|---|---|
| HALO Music（Web + Cloudflare） | 仓库根：`index.html`、`major.js`、`functions/`、`admin/`、`migrations/`、`schema.sql`、`wrangler.toml` | 多源搜索/播放/歌单/歌词的网页应用，Pages Functions + D1；Electron 桌面壳在 `electron/`，`package.json` 配了 `electron-builder --win nsis/portable`（**注意：`nsis.script` 原来指着一份旧版模板抄本，会让打包 100% 失败，已修，见 §15**） |
| HALO Subsonic 服务端 | `functions/rest/[[catchall]].js` + `_subsonic.js` | 实现 ping / getLicense / getMusicFolders / getIndexes / getMusicDirectory / getArtists / getArtist / getAlbum / getSong / search2 / search3 / stream / download / getCoverArt / getLyrics(BySongID) / getPlaylists / getPlaylist / create/update/deletePlaylist / star / unstar / getStarred / getAlbumList / getScanStatus。**曾是"Windows 端最省力的接入口"，但线上实例并未部署这一面**（`/rest/*` 回落到 SPA HTML，§10 线上实例复核），因此 Windows 首版改用已在线的 `/api/music`（D5） |
| Primuse 客户端（fork） | `primuse/` | 上游 `chenqi92/primuse`，本地 `narci2018/Primuse-halo-plus`，当前版本 1.9.10 (build 72)（唯一来源 `primuse/project.yml:25-26`，发版按 +1 规则走；`primuse-win/package.json` 必须同步同一个号） |
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
- G3：三端（iOS / macOS / Windows）资料库语义与歌单行为一致。（**修订**：在 D5/D6 下，Windows 端没有本地 GRDB 资料库，"一致"落在**歌单/收藏走同一个 `/api/sync-playlists`**；本地库层面的统一要等 B3。）
- G4：一条 CI 流水线同时产出 iOS IPA、macOS 公证 DMG、Windows 安装包。

### 非目标（明确放弃，按已确认范围）
- N1：Windows 端复刻 Apple Music、CarPlay、Watch、Widget、CloudKit 同步、空间音频头部追踪、DSD/DoP。
- N2：把 Swift UI 层做跨平台移植（OpenSwiftUI 等第三方实现不完整）。
- N3：`Primuse-mac/` 目录（会与 iOS 共享源码三份漂移）。
- N4（本轮新增）：Windows 端直连本地文件夹与 SMB / NFS / SFTP / WebDAV / FTP / S3 等 NAS 协议。B1 路线下这些能力由**服务端**承担（自建 Subsonic/媒体服务器已覆盖同一需求），Windows 客户端不做协议栈。
- N5（本轮新增）：App Store 上架。未签名分发 + 明文第三方解析接口这一组合不具备过审条件，按侧载形态推进。

---

## 3. 架构方案：核心下沉 + 双端薄壳

> **已作废（见 §16）**：本节假设"Windows 客户端只是眼睛和耳朵，数据面吃 HALO 后端"，这个前提错了。Primuse 的数据面在自己的连接器层，不在 HALO。目录形态（`clients/primuse-win/`）与"核心下沉"的方向仍然有用，但不再以 `backend/halo-music` 为接入口。

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
   **修订（D5/D6）**：这条原则在 Windows 首版**不执行**。你决定不重新部署后端（现网 `/rest/*` 未上线、且后端只有网易/QQ/bilibili），所以 Windows 端接入口是已上线的 `/api/music`，酷狗/酷我由客户端主进程直连 meting 线路（与 iPhone 现有做法一致）。"下沉进后端"仍然是正确方向，但要等一次愿意重新部署的时机，详见 §5 M2。

---

## 4. Windows 三条路线对比

> **口径纠正（见 §16）**：这张表把"薄壳"定义成"壳 + HALO 在线接口"，因此 B1 的"能力上限由后端决定"是错的框架。按 §16 的实际做法，Windows 端的"薄壳"指的是 **Primuse 自己的壳**：UI 与数据面都在客户端，音源 = Primuse 内置的聚合线路 + 用户自配的服务器型源，与 iPhone 同一套契约，没有任何后端账号依赖。B2（Swift-on-Windows）的实测工作量评估也更新在 §16。

| | **B1 薄壳 + 服务端复用（✅ 已选）** | B3 C-ABI 核心复用（后续演进方向） | B2 Swift-on-Windows 原生（不采用） |
|---|---|---|---|
| 做法 | Electron/网页壳 + 播放走 Chromium 自带的解码栈，数据面吃 HALO 的在线接口（**修订：现网是 `/api/music` 而非 `/rest`，见 §5 M2**；原写法"Tauri + FFmpeg→WASAPI + Subsonic"已随 D4/D5 作废） | `PrimuseKit` 编 DLL，Windows UI 调核心逻辑，UI/音频原生 | Swift 6 Windows 工具链 + WinUI3/自绘，尽量复用现有代码 |
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

### M0.5 · 后端就绪（B1 的前置，1 周，可与 M0 并行）—— **状态：按 D5 解除阻塞，Subsonic 部分转为待办**
B1 的本质是"Windows 客户端只是眼睛和耳朵"，能力上限等于后端提供的东西。这一步不做，M2 无从谈起。
**修订**：你确认后端已部署且不重新部署，而 M2 需要的东西现网已经具备（`/api/music` 的网易/QQ 搜索与解析、歌词、`/api/sync-playlists` 的歌单同步）。所以 M0.5 **不再是 M2 的阻塞项**；下面的 Subsonic 面全部降级为"日后愿意重新部署时再做的增强"，做完能让 Windows 端也吃到 `search3`/`stream`/Range 与断点续播，但不做也能出首版。
- 部署 HALO Music 到一个稳定域名（Cloudflare Pages + D1，`wrangler pages deploy`，迁移 `migrations/0001–0003`）。当前仓库里 D1 `database_id` 已写死，需确认是否为你自己的实例。**已核实：现网即 `halo-music.pages.dev` + D1 `halo-music-db`，见 §7 派生项。**
- Subsonic 面补强：**已实测，Range 与 OpenSubsonic 两块都不缺**（§10：`Range: bytes=1000000-1000999` → 206 + `Content-Range`；`getLyricsBySongId` 返回 `structuredLyrics.synced` 逐行毫秒时间戳）。真正剩下的只有 `getSimilarSongs`/`getRandomSongs` 这类推荐型接口，以及 QQ 的专辑/封面/时长字段（§10 缺陷 3，属源优先级取舍，不是 Subsonic 协议缺口）。
- **聚合平台缺口**：HALO 目前只有网易云 + QQ（QQ 失效时从 bilibili 补位），而 Primuse 侧的聚合模块已支持酷狗/酷我。**要么把 `AggregatedSourceStore` 的线路下沉进后端，要么 Windows 端一开始就只有网易+QQ。** —— **已由 D6 解开：两个都不选，改走第三条路：酷狗/酷我在 Windows 客户端主进程里直连 meting 线路，与 iPhone 现有做法相同，后端一行不动、也不重新部署。** 代价是这些线路的可用性只能靠发版补救。
- 鉴权对齐：**已实测可用**（token 分支 `u`+`t`/`s`，`t = md5(secret+salt)`，与 `Primuse/Services/Sources/SubsonicSource.swift` 的调用习惯一致；`p`/`enc:` 分支同样在同一个函数里）。前提是先补上 `migrations/0004_add_subsonic_tables.sql` —— 在此之前 `subsonic_auth` 表只存在于 `schema.sql`，用 migrations 建的库上 `/rest/*` 一律 `code 40`（§10 缺陷 1）。
- 把解析类接口从客户端迁到服务端后，Apple 端可去掉 `NSAllowsArbitraryLoads = YES`，改为按域名的 ATS 例外。
- 交付物：~~可访问的 `https://<domain>/rest/...?u=&t=&s=&v=&apiVersion=`~~ → **改为**：M2 直接以 `https://halo-music.pages.dev/api/music` 为接入口（已实测在线）。Subsonic 面的交付物保持不变，但推迟到下一次真正部署本仓库代码时。

### M1 · Apple 端健康度（1–2 周，与主线并行，非阻塞）
B1 不需要在 Windows 上编译 Swift，所以原先的"核心可移植化"从关键路径移除，但下面这几项无论选哪条路都该做：
- 补 `AggregatedMusic` 的半成品与测试：`.customJson` 目前返回空数组；`.hyw` / `.nxinxz` 搜索分支忽略用户配置的 `baseURL` 仍打硬编码地址；`.nxinxz` 解析不校验；该模块 0 测试（Kit 侧现有 179 个测试未覆盖它）。
- 决定 `音源文件/`（23 个 lx 脚本、4.8 万行，无任何代码引用）的去留：接入需实现 lx 的 `createApi` 沙箱语义，或直接删除。
- 统一版本与工具链口径（2026-10-13 复核后的准确清单）：`primuse/README.md:185` 要求 Xcode 26.0+，`primuse/project.yml:9` 却写 `xcodeVersion: "16.0"`；两个 CI workflow 都跑 `macos-26` 并按"有 iOS/macOS platform 的最高 Xcode"自动选版本，因此实际用的是 Xcode 26，`xcodeVersion` 只是生成工程时写入的兼容性标记，不参与选版；`primuse/CHANGELOG.md` / `CHANGELOG.en.md` 停在 **1.7.3 (build 24)**，而 `project.yml` 与 tag 已是 **1.9.6 (build 68)** —— 跨 40 多个 build 的更新日志缺口，需要单独一次回填，不适合顺手改。另外 `primuse/.github/workflows/build-ipa.yml` 是被 GitHub 忽略的死配置（GitHub 只读仓库根 `.github/`），内容严格陈旧于根目录那份（`macos-15` + 硬锁 Xcode_16.0/16.1、缺 `-sdk iphoneos` 与 c++20 实验库标志、`working-directory` 错误），已删除以止住"改错文件"的坑。

### M2 · Windows 客户端最小闭环（**修订版**，2026-10-13，依据 D4/D5/D6）

> **进度（同日）**：M2 剩下的只是"数据层接道理鱼服务器"（§13）。打包与分发这一块已经打通并本地验证：nsis + portable 两个 exe 都能出、已进 CI、会挂到版本 Release（§15）。下面第 3、4 条"缺口 2/3"里以公开聚合线路为依据的判断，凡涉及"全平台能不能做到"，一律以 §13 为准。

> 本节替换 0010 版计划。原来的四条前提被实测和你的决策改写了：`/rest/*` 在现网**没有部署**（§10 线上实例复核），后端**不重新部署**（D5），壳**用现成 `electron/`**（D4），音源**要全平台**（D6）。所以接入口从 Subsonic 改为 `/api/music`，酷狗/酷我从"下沉进后端"改为"客户端直连"。

先回答你问的"下沉后端是什么意思"：**同一条第三方线路，可以让服务器去访问（下沉后端），也可以让用户自己的电脑直接访问（客户端直连）**。现在网页版 `major.js` 就是前者 —— 它只打同源的 `/api/music?action=netease_search`，由 Cloudflare 函数去访问网易/QQ，浏览器永远不碰第三方域名，所以既没有跨域（CORS）问题，也没有混合内容问题。好处是线路失效改服务器就行、客户端不用发版；代价是必须动后端，而你说不动后端。于是酷狗/酷我这两条只能选后者：**由 Windows 客户端自己直接去请求第三方 meting 接口**，iPhone 版现在就是这么干的（`AggregatedSourceStore.swift` 里 `api.qijieya.cn/meting?...server=kugou`、`music-api.gdstudio.xyz/api.php?...source=kuwo` 都是客户端直连）。这条路的固有代价：第三方线路挂了只能靠发版补救，而且这些线路多数是明文 `http`，在浏览器里会被混合内容拦截 —— 但在 Electron 里把请求放到**主进程**就绕开了，见下面的"缺口 2"。

0. **M2 不是"从零写壳"，而是"给现成的壳补三样东西"** —— 读代码得到的事实：
   - `electron/main.cjs` 已经能跑：1440×920 窗口、`sandbox + contextIsolation + 无 nodeIntegration` 的安全默认值都在，默认 `loadURL("https://halo-music.pages.dev")`，可用 `--url=` 或环境变量 `HALO_MUSIC_URL` 覆盖，为空时回落 `loadFile(../index.html)`。
   - `package.json` 的 `build.files` 已经把整套网页应用（`index.html`、`major.js`、`styles.css`、`admin/`）打进包体，`win.target` 已是 `["nsis","portable"]`，`forceCodeSigning` 已置 `false`。
   - **`major.js`（3464 行）本身就是一个完整播放器**：`<audio>` 元素 + `currentTime` 拖进度 + 时长/进度更新、走 `/api/music` 的同源代理、LRC 歌词解析与"歌词炫酷效果"切换、封面 CDN 模板。
1. **播放引擎整段取消**。原计划里"Windows 构建 FFmpeg（libavformat/libavcodec/libswresample）→ PCM → WASAPI 共享模式"是围绕 Tauri 写的。Electron = Chromium，`<audio>` 直接解 mp3/m4a/flac/opus，D4 因此砍掉了 M2 里技术风险最高、也最难验收的一块。同理，`SFBAudioEngine 不可移植` 这条风险在 Windows 路线上不再存在。
2. **缺口 1 · QQ 能搜不能播，而且不是纯前端问题**：网页端只调了 `netease_search`/`netease_audio`/`netease_lyric`/`qq_search`（`grep` 结果），后端还有 `qq_audio`/`qq_lyric`/`qq_detail`/`bili_audio` 没接上。但**后端对播放类接口强制登录**：`functions/api/music.js:1171-1175` 对这六个 action 一律先 `authenticatedUsername()`，取不到就 401 `{"error":"请先登录后播放"}`，而会话令牌来自 cookie + `music_sessions` 表（`functions/api/_auth.js:77-89`）。线上实测印证：`?action=netease_audio&id=17899` → 401。搜索类不需要登录，所以 QQ 搜索一直是通的。
   ⇒ Windows 端要么把网页 SPA 的登录流程一起带上（`electron/` 加载的就是这套 SPA，登录本来就在同一域名下完成，成本很低），要么 QQ 就只能搜不能播。**这一条推翻了"参考 iPhone 直接访问就行"的直觉** —— iPhone 端根本不接 HALO 后端做播放（见 §12 事实 2）。
3. **缺口 2 · 全平台（D6）今天做不到，差在酷狗/酷我**：酷狗/酷我走 meting 线路直连，这些地址多为 `http` 且不带 CORS 头，**渲染进程里直连必然失败**（https 页面的混合内容 + 跨域）。方案不变：在**主进程**转发 —— `protocol.handle()` 注册自定义 scheme 让渲染进程仍打"同源"URL，或 `ipcMain.handle("halo:fetch")`，业务代码只改一处 fetch 封装。但**先决条件是线路本身能取到流**，而 §12 的体检结论是：网易两条线路可用，酷狗只有搜索、取流 401/超时，酷我与 QQ 的客户端线路今天全灭。所以 D6 要落地，必须二选一：**(a) 再找能用的酷狗/酷我线路**（体检脚本可直接拿来验），或 **(b) 部署 `cf-sync-server`/重新部署主站，把音源收敛到服务端**。
4. **缺口 3 · 歌单同步：目前没有任何在线端点可复用**。`halo-music.pages.dev/api/sync-playlists` 回落 SPA HTML（未部署），而 iPhone 实际指向的 `https://primuse-sync-server.pages.dev` **完全不可达**（curl http 000）—— 详见 §12 事实 3。好消息是它的源码就在仓库里：`cf-sync-server/`（`name = "primuse-sync-server"`，绑定**同一个 D1** `halo-music-db`），部署它是独立的小动作、不动主站，而且端点自带 `CREATE TABLE IF NOT EXISTS device_playlists`（`functions/api/sync-playlists.js:80`），**不需要任何迁移**。在此之前，Windows 首版的歌单/收藏只能存本地（`app.getPath("userData")` 下的 JSON），三端一致等这个端点上线。
5. **缺口 4 · 自动更新指向了错误的仓库**（必须修，否则打包版每次启动都在报错）：`build.publish` 写的是 `owner: "zhoujungis", repo: "halo_music"`，那是上游仓库、也是 `/api/version` 指向的 Android APK 发布地（§10），而本仓库是 `narci2018/Primuse-halo-plus`。改成实际发布仓库，或在首版把 `checkForUpdates()` 关掉。
6. **UI 范围**（都是 Electron 的常规桌面活儿，一天量级）：四平台搜索标签 / 正在播放 / 歌词 / 歌单 / 设置（后端地址、设备名、线路开关与优先级）；关闭窗口最小化到托盘、`globalShortcut` 媒体键、任务栏 `thumbarButtons`、`MediaSession` 已有的元数据回填。
7. **验收即"完成"**：Win11 双击 NSIS 安装 → 网易必定能搜能播能看词（已实测线路可用）；QQ 在登录后能播；酷狗/酷我按 §12 结论单列，**能播才算完成，只有搜索结果不算** → 点击能出声、能拖进度 → 歌词跟唱 → 新建歌单在同步端点上线后能在 iPhone 版看到同一份 → 重启记住上次队列与音量 → SmartScreen"未知发布者"放行步骤写进 README 并实测一次。
8. **明确不做**：本地文件扫描、SMB/NAS/SFTP/WebDAV、CUE、scrobble、无损直连（meting 给的通常是 128/320 kbps mp3，别承诺 Hi-Res）、以及任何需要重新部署后端才能成立的事。
9. **工作量口径修正**：原估 2–3 人·月是按 Tauri + FFmpeg + WASAPI + 自绘 UI 算的；在 Chromium 播放 + 现网 `/api/music` + 3464 行现成播放器这三个前提下，M2 实际是 **2–3 周**。

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
| SFBAudioEngine 不可移植 | Windows 高保真路径缺失 | **修订（D4）**：Windows 端走 Chromium 自带解码栈（Electron），不再是自编 FFmpeg；代价是高解析度输出与独占设备能力受限，需要时无损路径另议 |
| 第三方 meting 线路多为明文 `http` | 渲染进程直连会被混合内容拦截，且对方无 CORS 头 | **全部网络请求放 Electron 主进程**（自定义 scheme 或 `ipcMain` 转发），线路清单与 iPhone 端保持一致 |
| `build.publish` 指向上游仓库 `zhoujungis/halo_music` | 打包版的 `autoUpdater` 会去别人的仓库找 latest，行为不可预期 | M2 开工第一件事：改成本仓库 `narci2018/Primuse-halo-plus`，或首版直接关闭自动更新 |
| 文档与工程口径漂移 | `primuse/README.md` 要求 Xcode 26.0+，`project.yml` 写 `xcodeVersion: "16.0"`（该键不决定 CI 用哪个 Xcode，仅影响生成工程的兼容性标记）；CHANGELOG 停在 1.7.3/24 而版本已是 1.9.6/68；`primuse/.github/` 下还有一份被 GitHub 忽略的旧 iOS workflow | 死配置已删（2026-10-13）；版本回填见 §5 M1 清单，需要单独一次提交 |
| 死资源 | `音源文件/` 4.8 万行 lx 脚本无引用 | 接入（需实现 lx 沙箱 API）或删除，二选一，不要长期挂着 |
| 聚合模块半成品 | `.customJson` 返回空；`.hyw`/`.nxinxz` 搜索忽略用户配置的 `baseURL`；`.nxinxz` 解析不校验；零测试 | M1 顺带补齐并加测试 |

---

## 7. 决策记录（已确认）

| 编号 | 决策 | 选定 | 直接后果 |
|---|---|---|---|
| D1 | Windows 技术路线 | ~~B1 薄壳 + 服务端复用~~ → **作废，改为 §16：Primuse 自有壳（UI 重写 + 数据层按 Swift 契约移植），不接 HALO 后端** | ~~Windows 端不写 Swift、不编 `PrimuseKit`；能力上限由 HALO 后端决定~~ → 能力上限由 Primuse 自己的连接器层决定，与 iPhone 一致 |
| D2 | Windows 音源范围 | **在线 + 服务器型源** | 本地文件夹与 SMB/NFS/SFTP/WebDAV/S3 明确不在本轮范围（见 N4） |
| D3 | 签名与分发 | **先出未签名包** | macOS 必须 ad-hoc 签名（Apple Silicon 硬要求）+ Gatekeeper 放行说明；Windows 接受 SmartScreen 警告，且现有 `forceCodeSigning: true` 需改为条件签名 |
| D4 | Windows 壳 | ~~复用现成 `electron/`~~ → **作废：`electron/` 是 HALO 网页的壳，不是 Primuse 的壳。改为新建 `primuse-win/`（独立 Electron 工程，产品名/图标/界面都是 Primuse）** | ~~M2 在 `electron/` 里加 Windows 播放器界面~~ → 仍用 Electron（沿用已验证的 `--win nsis/portable` 出包链路和 Chromium 音频栈），但渲染层是照 `Views/Mac/` + `Views/NowPlaying/` 重写的 Primuse 界面，**默认不加载任何远程页面** |
| D5 | 后端地址 | ~~沿用 `halo-music.pages.dev`，不重新部署~~ → **"不重新部署"仍然成立且更重要：Windows 版根本不接 HALO 后端** | Primuse 的数据面全在自己身上：聚合线路由客户端直连（`AggregatedMusicService.swift` 已是这个做法），服务器型源由用户在 App 内自填地址。HALO 现网的 `/api/music`、登录墙、`/rest` 是否部署，与 Windows 版无关 |
| D6 | Windows 首版音源 | **全平台：网易 + QQ + 酷狗 + 酷我** | 后端只有网易/QQ/补位的 bilibili。酷狗/酷我改为**客户端直连 meting 线路**（与 iPhone 现有做法完全相同：`api.qijieya.cn/meting?...&server=kugou`、`music-api.gdstudio.xyz/api.php?...source=kuwo`），因此不需要后端改动，也不需要重新部署。日后若要把线路收敛到服务端，再单独做一次后端改造 + 部署 |
| D7 | QQ 搜索字段 | **暂时维持现状** | 依据线上实测，`/api/music` 的 QQ 结果其实已带 `album`/`cover`/`albumMid`/`duration`，所以这条从"缺陷"降级为"配置口径要一致"；真正要修的只剩 `_subsonic.js` 里 `Number(duration) || 210` 那个假默认值 |

已回答的派生项：
- **聚合平台取舍** → 见 D6，全平台，客户端直连，不动后端。
- **后端域名与实例** → 见 D5，`https://halo-music.pages.dev`（Pages 项目名与仓库根 `wrangler.toml` 的 `name = "halo-music"` 一致，D1 为 `halo-music-db`）。
- **壳选型** → 见 D4，Electron。
- **QQ 搜索源优先级** → 见 D7，维持现状。

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
- ~~Tauri + WASAPI 的位深/采样率协商~~ **已随 D4 消解**（改用 Electron 后由 Chromium 解码，不存在自编 FFmpeg/WASAPI 协商）；仍然没验证的是：**未签名 macOS 包在各版本 Gatekeeper 下的实际放行路径**，以及 Electron 主进程转发 meting 线路时第三方接口的**真实可用性**（线路随时会挂，需在 Windows 机器上逐条实测）。
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

### 线上实例复核（同日，直接探测已部署的 `halo-music.pages.dev`）—— 上面缺陷 2/3 的结论要修正

只读探测线上实例的结果，与本机 `wrangler dev` 的结果**不一致**，而且线上才是用户实际在用的那个：

| 探测 | 线上结果 |
|---|---|
| `GET /api/music?action=qq_search&q=周杰伦&limit=3` | HTTP 200，`{"mid":"0039MnYb0qxYhV","name":"晴天","album":"叶惠美","cover":"...T002R300x300M000000MkMni19ClKG.jpg","albumMid":"000MkMni19ClKG","mediaMid":"003Qui1q2u1Zho","duration":269}` —— **专辑、封面、albumMid、真实时长全都有** |
| `GET /api/music?action=netease_search` | HTTP 200，返回 `url/pic/lrc` 指向 `api.qijieya.cn/meting/?server=netease`（网易只有 meting 格式，无 duration 字段） |
| `GET /api/music?action=kugou_search` | `{"error":"操作无效"}` —— 服务端确实没有酷狗/酷我 |
| `GET /rest/ping`、`/rest/ping.view` | HTTP 200 但 `Content-Type: text/html`、24464 字节 —— 是 SPA 首页，**`/rest/*` 在这个部署里根本不存在** |
| `GET /_routes.json` | 同样回落到 HTML，说明部署快照里的路由表与本地这份不一致 |
| `GET /api/version` | HTTP 200，`2.0.0`，`android.url` 指向 `zhoujungis/halo_music` 的 APK 发布 |

由此修正三条结论：

1. **缺陷 3 的"线上封面/时长缺失"不成立**。线上 QQ 搜索返回的是带 `albumMid`/`duration` 的完整载荷，所以我按本机 `search_cache` 空字段推断出的"代理赢了赛跑导致字段丢失"，最多只是**本地 dev 配置下的行为差异**（本地 `wrangler dev` 会读 `wrangler.toml` 的 `QQ_SOURCE_URLS`，线上 Functions 环境变量以 Pages 项目设置为准，两者不同就会选出不同的赢家）。你把这条列为"暂时维持现状"是在我这份不完全准确的证据上做的决定 —— 现在按线上实测，它不是首屏缺陷，**只剩 `_subsonic.js` 那句 `Number(track.duration) || 210` 作为真正的隐患**：一旦某个源真的没带时长，它会把 0 变成假的 210，客户端进度条就永久失真。这一句该改成"没有时长就不上报时长"。
2. **缺陷 2 的残留同样被削弱**：`getCoverArt` 的代码修改仍然正确（拿歌曲 mid 拼专辑模板确实恒 404），但"搜索结果没有 albumMid 可用"这个前提在线上 QQ 路径上不成立。
3. **B1 的前提变了**：`/rest/*` 没有部署，所以"Windows 端复用 Subsonic 面"这条路现在要求**一次重新部署**。你说"不需要重新部署"，那就换一条同样能落地、且完全不碰部署的架构：Windows 客户端直接用**已上线的 `/api/music`**（网易 + QQ + 酷狗/酷我走客户端直连，和 iPhone 现在的做法一致）。详见 §5 M2 的修订。


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

`PrimuseMac` 此前从未在任何 CI 上构建过，本机又是 Windows，所以 M0 的全部信息只能从 GitHub Actions 拿（仓库 `narci2018/Primuse-halo-plus`，匿名 REST 读取）。六轮运行的实际结果：

| 轮次 | commit | 卡在哪 | 真实原因 |
|---|---|---|---|
| 1 | `8ca9944` | 第 7 步之前，3 分半 | —— 只留下一个需要鉴权才能下载的 log artifact（匿名 GET 返回 401），当时完全读不到错误 |
| 2 | `1a790f8` | Build 步骤，exit 70 | `xcodebuild: error: Unable to find a device matching the provided destination specifier` —— `generic/platform=macOS,arch=arm64` 是非法组合，generic destination 不能带 arch |
| 3 | `0cbcb05` | Build 步骤，约 28 分钟后 exit 65 | `'libavcodec/avcodec.h' file not found` + `Did not find header 'avcodec.h' in framework 'libavcodec'` |
| 4 | `ccb0ce7` | 前置校验步骤，几秒 | 校验脚本自己写错了 umbrella 头名（断言 `<框架名>.h`，FFmpeg 实际是 `avcodec.h`/`avformat.h`/`avutil.h`/`swresample.h`）—— 由 `fcd4348` 修正 |
| 5 | `fcd4348` | 全绿，26.1 分 | 首次成功出包，见下面「M0 结果」 |
| 6 | `329e389` | 全绿，job 13 步无一失败 | 复验：FFmpeg 校验步骤（含 20 条符号链接断言）通过，DMG+ZIP 产物约 133.2 MB 再次产出 —— 说明修复不是碰运气，换一次提交仍然成立 |

第 2、3 轮的错误都是靠新加的 `::error::` 注解拿到的：**check-run annotations 和 job summary 在公开仓库上可以匿名 GET，而 artifact 与原始日志必须带 token**。这条机制本身比某一次修复更值钱，已固化在 `build-mac.yml` 里。

### 第 3 轮的根因：vendored FFmpeg 的 macOS 切片在仓库里就是坏的

`primuse/Frameworks/FFmpeg/*.xcframework/macos-arm64_x86_64/` 是**带版本的 framework**（`Versions/A/...` 结构），除 `Versions/A` 以外全是符号链接。而整个仓库的索引里 **`120000` 模式一条都没有**（`git ls-files -s | awk '$1=="120000"' | wc -l` = 0，`git log --all --raw` 也从未出现过 120000），因为这棵树是在 Windows 上导入的：`Headers`、`Modules`、`Resources`、`Versions/Current`、`libavcodec` 这 5 个链接被压成了 24/24/26/1/27 字节的**普通文本文件**，内容正是链接目标字符串（`Versions/Current/Headers`）。四个 framework 共 20 条。

- iOS 侧看不出问题：`ios-arm64` 与模拟器切片是扁平结构，不需要符号链接，所以历史上所有 CI 都是绿的。
- 光看编译错误会以为缺 `-F` 搜索路径，实际二进制与头文件都在 `Versions/A` 里，只是顶层入口是文本文件，clang 顺着 `libavcodec.framework/Headers` 找不到目录。
- 运行时同样会死：顶层 `libavcodec` 是 27 字节的文本，dyld 拿到的不是 Mach-O。

修法：不重新下载 FFmpeg，只把这 20 条索引项的模式从 `100644` 改回 `120000`（内容已经恰好是链接目标，直接复用原 blob）。Windows 本机没有符号链接权限也无所谓 —— 改的是索引，CI 在 macOS/Linux 上 checkout 时会正确生成链接。

### 为什么必须加前置校验

在 Windows 上 `git add -A` 会**再次**把这 20 条打回 `100644`（这就是当初坏掉的方式）。所以加了一个构建前的结构校验（起初内联在 `build-mac.yml`，§14 起抽成 `scripts/ci-check-ffmpeg-xcframework.sh`，preflight 与 build 两个 job 各调一次）：逐个检查 4 个 framework 的 5 个入口是不是真符号链接、`Headers/<name>.h` 能否解析、`Versions/Current/<name>` 是否为真文件，并打印索引里 `120000` 的条数（应为 20）。它把 28 分钟的失败压缩成几秒钟的明确报错。

**M0 结果（同日）**：第五轮 run `38381672057` 全绿，26.1 分钟，13 个步骤无一失败，产物 artifact `Primuse-macos-arm64-1.9.6-b68`（DMG + ZIP，133.2 MB）。也就是说 Mac target 的 Swift 主体、WidgetKit 宿主页、FFmpeg 链接、ad-hoc 逐个签名与 `hdiutil` 打包一次性全部通过，M0 的代码部分到此结束。

**仍未验证（必须真机）**：这个包在 M 系列 Mac 上能否双击启动、Gatekeeper 是"仍要打开"一次到位还是需要在「隐私与安全性」里点"允许"；CloudKit 同步与小组件在剥掉 entitlements 后是否只是静默不可用（脚本注释如此假设，但没有实测）。artifact 需要登录才能下载，匿名 GET 返回 401，所以本机无法自证。（**已改进，见 §14**：DMG/ZIP 现在直接挂到版本 Release 上，匿名可下载。）

**这一节的 FFmpeg 校验步骤已经抽成 `scripts/ci-check-ffmpeg-xcframework.sh`**，工作流拆成 preflight/build 两个 job，见 §14。

**下一轮构建要顺带确认的小改动**：`thin_arch` 之前是无效的（FFmpeg 的二进制在 `Versions/A/` 下，而框架顶层入口是符号链接，`find -type f` 根本走不到），现在显式点名四个框架并排在签名之前；默认仍为关闭，所以线上产物暂时还是 arm64+x86_64 通用包。

---

## 12. M2 前置事实核查：现网到底能给 Windows 什么（2026-10-13，全部只读 GET）

写 M2 的时候我按"现网 `/api/music` + 客户端直连 meting"落笔，随后逐条探测发现其中两条站不住。下面的每条都能用 `curl` 或 `node scripts/probe-aggregated-lines.mjs 晴天` 复现。

### 事实 1 · 后端的播放类接口需要登录

`functions/api/music.js:1171-1175`：`qq_detail`/`qq_audio`/`qq_lyric`/`bili_audio`/`netease_detail`/`netease_audio`/`netease_lyric` 这六个 action 一律先 `authenticatedUsername()`，取不到就返回 401。会话来自 cookie 里的令牌查 `music_sessions` 表（`functions/api/_auth.js:77-89`），**搜索类 action 不需要登录**。

线上印证（同一时刻）：

```
?action=qq_search&q=晴天      → 200，两条结果，album/cover/albumMid/duration 全有
?action=qq_audio&id=0039MnYb0qxYhV    → {"error":"请先登录后播放"}
?action=netease_audio&id=17899        → {"error":"请先登录后播放"}
```

结论：Windows 端要播网易/QQ，**必须带登录**。`electron/main.cjs` 加载的正是那套自带登录流程的 SPA，所以这不是额外工作，但它推翻了"参考 iPhone 直接访问即可，不用管账号"的直觉 —— 见事实 2。

### 事实 2 · iPhone 端根本不接 HALO 后端

`grep -rn "halo-music|pages.dev|api/music?action" primuse/Primuse primuse/PrimuseKit` 的全部命中只有一条：`PlaylistSyncService.swift:9` 的 `https://primuse-sync-server.pages.dev/api/sync-playlists`。也就是说 iPhone 的搜索/播放/歌词**全部来自客户端直连的聚合线路**，HALO 主站只在歌单同步时被碰、而且碰的还是另一个项目。

所以"跟 iPhone 一样直接访问"在工程上的真实含义是：**照抄 `AggregatedSourceStore.defaultSources` 那 9 条线路**，而不是访问 `halo-music.pages.dev`。这两件事在我的 M2 草案里被混为一谈，现在分开。

> **本段已被 §13 部分纠正**：这里证明的只是"HALO 主站不是 iPhone 的数据源"。iPhone 上还有**服务器型**来源（道理鱼，地址与账号在设置里填），"跟 iPhone 一样"首先指接你那台自建服务器，其次才是那 9 条聚合线路。别把本段读成"iPhone 只有聚合线路"。

### 事实 3 · 目前没有任何在线的歌单同步端点

- `https://primuse-sync-server.pages.dev/api/sync-playlists` → curl **http 000**（连不上，未部署或已删）
- `https://halo-music.pages.dev/api/sync-playlists` → 回落 SPA HTML（该实例没部署这个函数）
- `https://halo-music.pages.dev/api/version` → 200 `{"version":"2.0.0", android → zhoujungis/halo_music 的 APK}`，说明主站的 Functions 只上了 `/api/music`、`/api/version` 这一批，比当前工作树旧

仓库里 `cf-sync-server/` 就是那个同步服务器的源码（`wrangler.toml` 的 `name = "primuse-sync-server"`，且 `[[d1_databases]]` 绑的是**同一个 D1** `halo-music-db`）。部署它是独立的小动作、不需要动主站，端点自己会 `CREATE TABLE IF NOT EXISTS device_playlists`（`functions/api/sync-playlists.js:80`），无需迁移。**在三端共享歌单这件事上，这是性价比最高的一步，但它需要你执行部署（或授权我用 `wrangler` 部署）。**

### 事实 4 · 九条聚合线路的体检结果（`scripts/probe-aggregated-lines.mjs`）

脚本逐条复刻 Swift 的搜索/取流/歌词三种请求形状（包括 `.hyw`、`.nxinxz` 两个分支**无视配置里的 baseURL、硬编码打别的域名**这个已知毛病），取流一律用 `Range: bytes=0-4096` 证明"真的能出声音"，而不是只看接口回没回 200。

| 线路 | 平台 | 协议 | 搜索 | 取流 | 歌词 |
|---|---|---|---|---|---|
| default-netease-meting-1 | 网易 | meting(qijieya) | 20 条 | **AUDIO `audio/mpeg`** | LRC 970B |
| default-netease-gdstudio | 网易 | meting(gdstudio) | 20 条 | **URL→AUDIO `audio/mpeg`** | LRC 1063B |
| default-kugou-hyw | 酷狗 | hyw(硬编码 qijieya 搜 / 103.79 取流) | 20 条 | **401，重试超时** | 400/超时 |
| default-qq-hyw | QQ | hyw | `[]` | — | — |
| default-qq-meting-1 | QQ | meting(qijieya) | `[]` | — | — |
| default-qq-openapi-1 | QQ | openApi(s01s) | 第一轮返回 20 条但字段形状对不上解析，第二轮 `[]` | — | — |
| default-netease-meting-3e0 | 网易 | meting(3e0) | `{"error":"unknown type"}` | — | — |
| default-kuwo-nxinxz | 酷我 | nxinxz(硬编码 gdstudio) | `{"detail":"Value of source is not supported"}` 400 | — | — |
| default-kuwo-hyw | 酷我 | hyw(同上) | 同上 400 | — | — |

**小结：搜索可用 3/9，取流可用 2/9（都是网易），歌词可用 2/9。** 另外 gdstudio 在同一次会话里出现过 200 与 503 交替，脚本因此对 5xx/超时做了一次重试 —— 这些公共线路本身就是抖动的，`§6` 那条"公共解析接口不稳定"的风险不是假设，是今天的实测。

### 这对 D6 意味着什么（需要你拍板的取舍）

"全平台：网易 + QQ + 酷狗 + 酷我"这个目标，按今天的外部线路状态**做不到纯客户端直连**：

- **网易**：客户端直连即可播（两条线路都验证通过），不需要后端、不需要登录。
- **QQ**：客户端线路全灭；能播的只有后端 `/api/music` 的 `qq_audio`，而它**要登录**。
- **酷狗**：qijieya 能搜到 20 条，取流 401/超时 —— 半条线路，要么另找 meting 部署，要么放弃。
- **酷我**：两条依赖的域名都已不支持 `source=kuwo`，客户端侧今天无解。

三条出路，代价各不相同：
1. **接受首版 = 网易 + QQ(登录) + 酷狗(仅搜索)**，酷我后置。不动后端，最快出包。
2. **部署 `cf-sync-server` + 重新部署主站**，把酷狗/酷我的线路写进 `functions/api/music.js`，全平台由服务端供给。这需要你做一次部署，但线路失效不再需要客户端发版（也就是原来 D6 想避开的"下沉后端"）。
3. **我自己找并验证新的第三方线路**（用同一个脚本跑候选域名），能把酷狗/酷我补齐就走 1，且不改后端。

我倾向 **1 + 3 并行**：先按 1 把 Windows 包做出来（网易立刻能播是最小可用闭环），同时用脚本筛新线路，找到就把酷狗/酷我补上；2 留作你哪天愿意重新部署主站时的正式解法。

### 另外：假时长 210 的来源不止一处

`primuse/Primuse/Services/AggregatedMusic/AggregatedMusicService.swift:233` 在解析 meting 搜索结果时写死 `duration: 210 // Meting search often omits duration; defaults to 3.5m`。这与 `_subsonic.js` 里的 `Number(track.duration) || 210` 是同一类假值，而前者影响的是 **iPhone 端自己**。所以 D7 说"真正要修的只剩 `_subsonic.js`"不准确 —— 至少两处，且客户端侧那处同样会让进度条与播放统计失真。修法也一样：宁可回 `0`/未知，让 UI 显示"未知时长"，也不要编一个 210。

---

## 13. 我把"iPhone 用的服务器"认错了一处（同日，用户指出 iPhone 版四个平台全都能播之后）

我的 §12 线路体检打的是 `AggregatedSourceStore.defaultSources` 那 9 条**公开第三方线路**（聚合直连这条支路）。把"它们今天不行"写成"全平台做不到"，超出了证据能支撑的范围 —— 因为你手机上的播放很可能根本不走这 9 条。回代码核对，应用里另有一条完整的**服务器型源**：

### 道理鱼（DaoLiYu）：地址由用户填、带账号、服务端已把多平台解决

`Primuse/Services/Sources/DaoLiYuSource.swift` + `PrimuseKit/Sources/PrimuseKit/Streaming/DaoLiYu{APIProtocol,ServiceClient,StreamResolver}.swift`：

- 配置项是 `host` / `port` / `useSSL` / `basePath` / `username` / `password`（`DaoLiYuSource.swift:17-26`）—— **地址不写死在代码里，是用户在设置里填的**，所以我从仓库里查不到你部署的是哪一台。
- 登录 `/api/auth/login`，此后所有请求带 **Bearer token**（`DaoLiYuServiceClient.swift:524`）。
- 数据面：`/api/tracks/{id}`、`/api/tracks/{id}/download`（`:352/:386/:427`）、封面 `/cover`，歌词一次给两种形态 —— `lyricsSync`（同步）与 `lyrics`（纯文本）（`:132-133`）。协议注释写明"曲目使用不含服务器文件路径的合成引用，播放时始终回到 `/api/tracks/{id}/download` 并附带 Bearer token"。

这是一套"服务器负责音源、客户端只管拉流"的架构，和你说的"用跟 iPhone 一样的服务器、我已经部署好了"完全对得上。你说"全部没问题"，原因大概就在这里：**全平台是服务器给的，不是那 9 条公开线路给的。**

### 同时更新两条仍然成立的实测事实（它们只约束聚合直连这条支路）

- `103.79.184.97`（QQ/酷狗/酷我 三条 `.hyw` 线路的取流主机）今天返回 `{"code":401,"message":"需要卡密才能访问，请在请求中携带 key 参数"}`，而 `.hyw` 的请求构造里根本没有 `key`（`AggregatedMusicService.swift:344-346`）。**即这三条默认线路对当前客户端是死的**，无论你在哪个网络 —— 这是代码层面的结论，不是网络差异。
- `halo-music.pages.dev` 上 `/rest/*` 与 `/api/sync-playlists` 回落 SPA HTML，`primuse-sync-server.pages.dev` 连不上。它们只说明 HALO 那两个端点没上线，**不能**用来推断你没有可用服务器。

### 对 M2 的影响：换主路径

1. Windows 首版应当做成**道理鱼薄壳**：一个地址 + 一个账号覆盖全平台，线路失效由服务器侧修，不用客户端发版 —— 这才是 D6「全平台」的落地方式，而且已经在 iPhone 上验证过。
2. 协议面很小（login / tracks / download / cover / lyricsSync），Electron 主进程实现比兼容 9 条第三方线路容易得多。
3. HALO 的 `/api/music` 与聚合线路降级为"没有自建服务器时的补充来源"，不再是主路径；§5 M2 里的缺口 1（QQ 播放要登录）在道理鱼路线下自然消失（本来就是登录态的服务器）。
4. 这条路线与 `§6` 的"服务器型源"同源：道理鱼打通后，Subsonic/Navidrome/Jellyfin 这些同形态服务器可以顺势加。

**需要你给一件事**：iPhone 设置里那条服务器的**地址（host / 端口 / 是否 https）和类型**，以及它是否允许公网访问。有了地址我就用 `curl` 把 `login` / 列表 / `download` 的响应结构实测一遍，Windows 端数据层按实测契约写，而不是照抄 Swift 的猜测。

---

## 14. 推 tag 就能自动出可下载的安装包（同日，补齐 macOS 的发布环节）

你问"推到 github 自动发布编译版本了吗"，我去 Releases 页面核对的实际状态是：

- **iOS 是自动的** —— 打 `v1.9.7` 后 `build-ios.yml` 自动建出 Release，挂着 `Primuse-unsigned.ipa`（105 MB）。
- **macOS 不是** —— 同一条 tag 的 `build-mac.yml` 只把 DMG/ZIP 存成 **workflow artifact**，artifact 需要登录才能下载，且 14 天后过期，Release 页面上根本没有 Mac 的下载入口。也就是说"自动编译"有，"自动发布"没有。

改法（`.github/workflows/build-mac.yml` + 新增 `scripts/ci-check-ffmpeg-xcframework.sh`）：

1. **拆成两个 job**。`preflight` 每次推 main 都跑（几分钟：FFmpeg 符号链接校验 + XcodeGen 生成工程 + 断言 `PrimuseMac` scheme 存在）；`build` 只在 **tag（v\*）或手动 dispatch** 时跑。之前一次发版会跑两遍 25 分钟的构建，因为推 main 和推 tag 都命中同一个 `push` 触发器，纯浪费。
2. **校验脚本抽成文件**（`scripts/ci-check-ffmpeg-xcframework.sh`），两个 job 各调一次 —— `build` 里重复是为了它能单独跑，而这条检查只花几秒，比对一个 28 分钟才失败的构建。脚本在 Windows 本机会**正确地失败**（本机没符号链接权限，28 条 `::error::`），但在 CI 的 macOS checkout 上是绿的，所以我不能拿本机结果当发布判据，只能拿流水线结果。
3. **构建产物发布到 Release**：新增 `softprops/action-gh-release@v2` 步骤，把 DMG 与 ZIP 挂到同一个版本 tag 上，`append_body: true` 是必须的 —— iOS 与 macOS 两个 job 竞争写同一条 Release，后完成的那个不能抹掉先生成好的 changelog。顶部加了 `permissions: contents: write`（默认 token 没有写 Release 的权限）。
4. **手动 dispatch 加了 `release_tag` 输入**，可以给已有版本补出包而不新建 tag；不填就只构建、不发布（否则 `github.ref_name` 是分支名，会造出一个叫 `main` 的 tag 和 Release）。

效果：从现在起 **推 `v*` tag → Release 页面同时有 `.ipa`、`.dmg`、`.zip`**，匿名可下载，不需要登录 Actions。这次改动本身只触发 `preflight`（推的是 main 不是 tag），所以它的第一次真实验证是 preflight 变绿；macOS 的 Release 发布要等下一个 tag，或者用 dispatch 填 `release_tag=v1.9.7` 给已经发出去的 1.9.7 补上 Mac 包。**（Windows 的 `.exe` 随后由 §15 的 `build-win.yml` 一起挂到同一条 Release。）**

仍未实测的部分：`softprops/action-gh-release@v2` 与 iOS 那条 job 的发布步骤在同一 tag 上的竞态（`append_body` 只保证不互相清空正文，不保证不重复创建 Release；两个 action 都是"存在即复用"，理论上安全，但要等下一次真发版才能确认）。

---

## 15. Windows 包：本地把 nsis 修好，再进 CI 发到同一条 Release（同日）

你指出 Releases 上只有 iOS，macOS 已经有了，Windows 完全没有。确实：这个仓库的流水线里**从来没有过 Windows job**，`electron/` 那个壳也从没被打包验证过。所以我没有直接写 CI，而是先在本机（Windows）跑了一遍 `electron-builder`，因为出问题时 5 分钟就能定位，比在 CI 上盲跑快。

### 第一个包直接失败，根因不在我们的代码里

`npm ci` 同步正常，`win-unpacked` 与 `icon.svg → icon.ico` 都成功（SVG 图标会被自动转换，不是问题），失败在 NSIS 打包这一步：

```
Error in macro installApplicationFiles on macroline 91
Error in script "<stdin>" on line 201 -- aborting creation process
Usage: File [/nonfatal] [/a] (...)
```

逐层查下去：

1. 报错的那条 `File` 是 `node_modules/app-builder-lib/templates/nsis/include/installer.nsh:100`：
   `File "/oname=${UNINSTALL_FILENAME}" "${UNINSTALLER_OUT_FILE}"` —— 展开后第二个参数是**空字符串**，NSIS 因此把它当成"没给文件名"，打出 usage 并中止。
2. `UNINSTALLER_OUT_FILE` 为空是 `out/targets/nsis/NsisTarget.js:340-345` 造成的：只要配置了 `nsis.script`（自定义 installer.nsi），这个函数就 `return { script, isCustomScript: true }` **提前返回**，既不会先跑一遍 `BUILD_UNINSTALLER` 生成卸载器，也不会给 `defines.UNINSTALLER_OUT_FILE` 赋值；第 298 行再把 undefined 拷进主 defines。也就是说"自定义脚本 + 复用官方 include"这条路在 26.x 上自己就是断的。
3. `package.json` 里那个 `nsis.script: "build/custom-installer.nsi"` 值不值得为它承担这个断裂？`diff` 过了：**它和 26.15.3 自带的 `templates/nsis/installer.nsi` 逐行相同**（只差 CRLF），是从旧版 electron-builder 抄来的模板副本，没有任何定制内容。它唯一的实际效果就是触发第 2 条那个早退分支。
4. 那个自定义"快捷方式选择页"靠的是 `nsis.include: "build/installer.nsh"` 里的 `customPageAfterChangeDir` 宏，而这个宏**官方模板就会调用**（`templates/nsis/assistedInstaller.nsh:42-43`）。所以删掉 `script` 不丢功能。

改动：`package.json` 的 `build.nsis` 去掉 `script` 一行（`build/custom-installer.nsi` 文件留着不再引用，避免动上游作者的目录）。改完本机两个目标全绿：

| 产物 | 大小 |
|---|---|
| `HALO-Music-Setup-1.9.7-x64.exe`（nsis，`perMachine: true` 需要管理员授权） | 89 MB |
| `HALO-Music-Portable-1.9.7-x64.exe`（免安装单文件，不需要管理员） | 88 MB |
| `latest.yml`（应用内更新元数据，`version: 1.9.7` + sha512） | 356 B |

### 两个配置漂移顺手修掉

- **`build.publish` 指向上游**：`owner/repo` 原来是 `zhoujungis/halo_music`，而 `electron/main.cjs:45-51` 在打包版里会 `autoUpdater.checkForUpdates()` 且 `autoDownload = true`（`:46` 的 `if (!app.isPackaged) return` 只在开发模式生效）。也就是说从本仓库发出去的 exe 会去下载**别人的**构建并静默自动安装。已改成本仓库 `narci2018/Primuse-halo-plus`，并把 `latest.yml` 一起挂到 Release，更新只来自这里。仍未验证：无证书时自动更新下载到的是未签名 exe，SmartScreen 会不会把自动安装卡住 —— 真机才知道。
- **版本号来源**：`package.json` 自己的 `version` 是 HALO 上游的 2.0.0，和 Primuse 的 1.9.x 是两条血脉。CI 不改 `package.json`，而是 `--config.extraMetadata.version=<tag>`（本机验证过：产物名与 `latest.yml` 都变成 1.9.7），这样同一条 Release 上 iOS / macOS / Windows 三个包号数一致。

### CI：新增 `.github/workflows/build-win.yml`

`windows-latest` + Node 22 + `npm ci`（lock 已核对同步），只在 **tag（v\*）或手动 dispatch** 时跑，`--publish never`（不让 electron-builder 自己往 GitHub 传，发布统一交给 `softprops/action-gh-release@v2`，和 §14 的 macOS 步骤同一个形状、同样 `append_body: true`）。多了一步 `Verify artifacts`：断言两个 exe 非空且 `latest.yml` 里的 `version:` 等于本次 tag —— 防的是"job 全绿但根本没产出包"和"忘了传版本号于是又打出 2.0.0"。

同一条 tag 现在有三个写正文的人，所以把 `build-ipa.yml` 的发布步骤也补了 `append_body: true`（它原来只有 `generate_release_notes: true`，最后完成的那个会把另外两个的安装说明覆盖掉）。

从此推 `v*` tag 一条 Release 上会有：`Primuse-unsigned.ipa` + `Primuse-macos-arm64-*.dmg/.zip` + `HALO-Music-Setup-*.exe` + `HALO-Music-Portable-*.exe` + `latest.yml`，全部匿名可下载。

### 本机真机验证（这台机器就是 Windows 11 build 26200，所以 Windows 这一端不必只靠 CI）

不是"能编译"就算数，我把打出来的包真的跑了一次：

- `release\win-unpacked\HALO Music.exe` 启动后进程组存活，**窗口标题变成「Halo音乐」**。标题来自页面本身，等于证明 `loadURL("https://halo-music.pages.dev")` 真把 SPA 载进来了，不是空壳白屏。
- `Get-AuthenticodeSignature` 三个产物都是 `NotSigned`（预期，D3）；`FileVersion` / `ProductVersion` 都是发版号，说明 `--config.extraMetadata.version` 真的写进了 PE 版本资源。
- `@electron/asar` 列包体：313 条，`\electron\{main,preload}.cjs`、`\index.html`、`\major.js`、`\styles.css`、`\admin\index.html` 与 `electron-updater` 都在里面。（顺带一个方法论教训：先用"在 asar 字节里搜 `admin/index.html`"判定缺文件，得到**假阴性** —— asar 的头把目录与文件名分开存，必须用 asar 库列目录。）
- **旧配置的自动更新是活的、而且指向别人**：修复前那次启动的日志里明确写着
  `Checking for update` → `Error: Cannot find latest.yml in the latest release artifacts (https://github.com/zhoujungis/halo_music/releases/download/v2.0.0/latest.yml): 404`。
  改完 `build.publish` 重新打包后，同一句 `Checking for update` 不再报错。这条不是理论风险，是已经发生的网络行为。

CI 侧（tag `v1.9.8`）：`Build Win11 x64 (nsis + portable)` 首次运行 **133 秒全绿**，10 个步骤无一失败，Release 页上匿名可读到 3 个 asset（`HALO-Music-Setup-1.9.8-x64.exe` 88.1MB、`HALO-Music-Portable-1.9.8-x64.exe` 87.9MB、`latest.yml`）。`api.github.com` 匿名 200 验证了这一点；本机 `curl` 取 `browser_download_url` 返回 `http=000`，但同一时刻 `github.com` 与 `raw.githubusercontent.com` 也是 000 而 `api.github.com` 是 200 —— 这是这台机器的 shell 没走系统代理（装了 ProxyBridge / sing-box），不是 GitHub 的权限问题：同一台机器上的 Electron 应用走系统代理，刚才就成功查到了更新。补测：给 curl 加 `-x http://127.0.0.1:10808` 后 `api.github.com` 正常返回（限速额度也换了一个 IP），但 `github.com/.../releases/download/...` 变成 TLS 失败（curl exit 35）—— 所以本机命令行下载不通，能拿到的硬证据是 asset 的 `state: uploaded` 与正确大小；浏览器里点一次下载由你来确认。

刻意**没有**上传的东西：`HALO-Music-Setup-*.exe.blockmap`（electron-builder 本地会生成）。有它 electron-updater 才能差分下载，没有就每次更新整包下 89 MB。现阶段更新链路本身还没在真机上验过（未签名 + `autoDownload = true`），先不多挂一个文件。

### tag `v1.9.8` 的实测结果：三条流水线第一次落在同一个 Release 上

| run | 工作流 | 结果 | 用时 | 挂上 Release 的产物 |
|---|---|---|---|---|
| `38396898700` | Build HALO Music Windows (Electron) | success | 2.2 分 | `HALO-Music-Setup-1.9.8-x64.exe` 88.1MB、`HALO-Music-Portable-1.9.8-x64.exe` 87.9MB、`latest.yml` |
| `38396898666` | Build Primuse macOS DMG | success | 19.6 分 | `Primuse-macos-arm64-1.9.8-b70.dmg` 72.1MB、同名 `.zip` 63.9MB |
| `38396898742` | Build Primuse iOS IPA | success | 22.4 分 | `Primuse-unsigned.ipa` 105.0MB |

Release `v1.9.8` 现在 6 个 asset 全部 `state: uploaded`，正文里 Windows / macOS / Full Changelog 三段并存 —— 这就是 `append_body: true` 起作用的证据（§14 里标注为"待下次真发版才能确认"的那条竞态，已经确认安全）。从此发版动作只有一个：改 `primuse/project.yml` 的版本号 → 提交 → 打 `v*` tag → 三平台的包自动出现在 Release，全部匿名可下载。

仍然没有的：**iOS 那条流水线还没做"分支 push 不构建"的拆分**（`.github/workflows/build-ipa.yml` 的 `on.push.paths` 含 `primuse/**`），所以每次改 Apple 侧代码都会白跑一次 26 分钟的 IPA 构建，tag 上再跑一次。要不要照 macOS 那样拆（或者限定只在 tag 构建）由你决定，因为这会同时失去"每次 push 都有一个可侧载的 artifact"这个副作用。

### 这个包现在能播什么（重要，别当成 M2 完成了）

首版 Windows 包 = **原样的 `electron/main.cjs`**，即 `loadURL("https://halo-music.pages.dev")` 加载线上 SPA（地址可用 `--url=` 或环境变量 `HALO_MUSIC_URL` 覆盖，`main.cjs:5-13`）。它等价于"用 Chromium 打开 HALO 网页版"，所以：

- 能做的：网页版本身能做的（浏览、搜索、播放已登录态允许的音源、管理后台）。
- **还没有**：iPhone 那条道理鱼自建服务器的薄壳（§13 的 M2 主路径）、播放控件常驻、以及 `音源文件/` 那 23 个 lx 脚本 —— 这些是 M2 的工作，需要你先给服务器地址。
- 分发限制：无代码签名证书（D3），首次运行必过 SmartScreen「更多信息 → 仍要运行」。

---

## 16. 正确的目标：把 `primuse/` 这个 App 做出 Windows 版和 macOS 版（2026-10-13，用户纠正后重写）

用户原话：**"虽然我提交代码是用 C:\Tools2\halo_music 这个目录，但 C:\Tools2\halo_music\primuse 其实是一个独立的 iPhone 版本音乐 app，包含了完整的 UI 和自己设置好的音乐源……我只要你把 C:\Tools2\halo_music\primuse 做多两个版本，win 版和 macos 版本！"**

### 16.1 macOS 端：已完成，不是待办

`PrimuseMac` target 就是"macOS 版本"这件事的全部 —— 同一个 App、同一套 Swift 源码、桌面三栏 UI（`Views/Mac/` 25 个文件）。产物已进 Release 且匿名可下载：`Primuse-macos-arm64-1.9.8-b70.dmg` / `.zip`（§11 构建、§14 发布）。剩余的唯一缺口是真机验证（§5 任务 #5），这台 Windows 机器做不了。

### 16.2 Windows 端：为什么不能"直接再编译一次"（逐文件实测）

| 实测项 | 数字 | 证据 |
|---|---|---|
| 全仓 `.swift` | 745 文件 / 400,219 行 | 实际扫描 |
| App target `primuse/Primuse/` | 325 文件 / 257,485 行 | 同上 |
| SPM 包 `primuse/PrimuseKit/Sources/` | 151 文件 / 53,475 行 | 同上 |
| **不含任何平台绑定框架（可移植面）** | **196 / 476 文件，52,117 / 310,960 行 = 16.8%** | `Views` 只有 2/128、`App` 0/9、`PrimuseKit` 107/151 |
| import 命中（App / Kit） | SwiftUI **143**/0、AppKit **56**/0、UIKit **53**/0、AVFoundation 11/0、SFBAudioEngine 5/0、MusicKit 8/0、CloudKit 7/0、AppIntents 7/0、MediaPlayer 4/0、WidgetKit 4/0、CarPlay 1/0、Translation 2/0、iTunesLibrary 2/0、GRDB 2/10 | 逐文件 grep |
| 已按平台分叉的文件 | 120 个含 `#if os(iOS)`(93) / `#if os(macOS)`(61) | 说明它天生是 iOS+macOS 双端代码，但没有第三个分支的位置 |

三个硬障碍，按"能不能绕过"排序：

1. **播放链不可移植，且集中在一处**：没有统一 Player 抽象，只有解码协议 `PrimuseAudioDecoder`（`Services/Audio/AudioDecoderProtocol.swift:59`），签名里就带 `AVAudioFormat`；`AudioEngine.swift` 1,228 行是 AVAudioEngine 节点图；`AudioPlayerService.swift` **12,402 行**混了 AVPlayer + AVAudioEngine + SFBAudioEngine + MediaPlayer NowPlaying + CarPlay + Widget，`AVPlayer` 还散落在 29 个文件里。Windows 对应物是 WASAPI/MediaFoundation，等于整层重写。
2. **UI 128 个文件 110,943 行、143 处 SwiftUI**，SwiftUI 没有可用的 Windows 实现（社区移植到不了生产），AppKit/UIKit 同理。
3. **依赖面**：GRDB 7.8.0（`LibraryDatabase.swift:566` 行，DatabasePool + 14 条迁移 + FTS5）官方只覆盖 Apple/Linux；CryptoKit 38 处需换 swift-crypto；`MusicSourceConnector`（`Services/Sources/MusicSourceProtocol.swift:633`）本身可移植，但 25 个实现里牵扯 AMSMB2 / NFSKit / Network.framework / Keychain。

⇒ 把 Swift 直接搬上 Windows（原 B2）= 重写 UI 11 万行 + 重写播放 2.4 万行 + 移植网络与安全层，12–18 人·月，而且首版在这台机器上无法验证。**所以 Windows 版必须是"新做的同一个 App"，而不是"编译同一个 App"。**

### 16.3 首版走法：Electron 复刻 **Primuse**，不复刻 HALO

沿用 Electron 的三个理由（都不是"省写代码"，而是"少踩工具链"）：

1. 出包链路在本仓库已经验证过：`nsis` + `portable` 都能出、都能挂 Release（§15），换 Tauri/Flutter 得先修一整套构建。
2. Chromium 自带 mp3/m4a/flac/opus 解码，正好替代不可移植的 SFBAudioEngine + FFmpeg 那条链。
3. 全部网络请求放主进程，明文 `http` 裸 IP 线路（`http://103.79.184.97`）不会被混合内容拦。

**但不能复用现成的 `electron/`**：`electron/main.cjs:5-13` 默认 `loadURL("https://halo-music.pages.dev")`，`package.json` 的 `productName` 是 "HALO Music"、`appId` 是 `com.halomusic.desktop` —— 那是另一个产品的壳。因此新建 **`primuse-win/`**（独立 npm 工程，产品名/图标/界面都是 Primuse，**默认不加载任何远程页面，App 内没有账号体系**）。

数据层不在 Swift 侧复用、而是照契约重写的原因：**行为一致取决于契约一致，不取决于语言一致**。聚合线路与服务器型源全是 HTTP/JSON，契约已经逐字段实测固定（§16.5 / §16.6），照抄的成本远低于把 GRDB + CryptoKit + AVFoundation 搬上 Windows。

### 16.4 与 iPhone 行为对齐的硬要求（也就是验收口径）

1. **首屏不是登录墙**，App 里不存在"Primuse 账号"。iPhone 上的登录只发生在添加需要鉴权的音源时（道理鱼的 `POST /api/auth/login`），或由 HALO 那种网页版自己的会话体系引入 —— 后者与本项目无关。
2. **零配置即可搜索并播放**：`AggregatedSourceStore.swift:14-16,104-122` 在无存档时写入 9 条 `isEnabled:true` 默认线路，系统连接器 id `system-aggregated-music`（`AggregatedMusicService.swift:10`，`SourceManager.swift:2405-2411` 注册、UI 不可删）。Windows 版必须同样开箱可用。
3. **四平台**（网易 / QQ / 酷狗 / 酷我，bilibili 补位）：能同时做到四平台的现实路径是用户那条自建服务器型源（§13），而**不是**这 9 条公开线路 —— §12 事实 4 的体检结论是今天只有网易出声。这一点 iPhone 上也一样，不是我引入的回归：Windows 版接上同一个道理鱼服务器后，四平台表现就与 iPhone 一致。
4. 界面按 Mac 版的路由集合复刻：`MacRoute`（`Views/Mac/MacRoute.swift:6-19`）= `home / stats / search / sources / section / liked / playlist / smartPlaylist / source`，外加 `MacTool`（`:37-44`，歌词转换、重复、scrobble、缓存同步、设备传输）以弹框呈现，工具区不占主导航；骨架文件：`MacSidebar.swift`、`MacHomeView.swift`、`MacDetailContainer.swift`、`MacBottomBar.swift`、`MacNowPlayingView.swift`、`MacQueuePanel.swift`、`MacSourcesView.swift`、`MacSettingsView.swift`。
5. 服务器型源的地址与账号只在 App 内输入并本地加密存储（iPhone 用 Keychain，Windows 用 `safeStorage`），**不经过聊天、不经过任何远端服务**。

### 16.5 聚合线路契约（照抄 Swift，字段名不许改）

`Services/AggregatedMusic/AggregatedMusicService.swift`：**全部 GET**（不是 POST）。协议枚举 `meting/hyw/nxinxz/openApi/customJson`（`AggregatedMusicModels.swift:57-62`）；平台 `qq/netease/kugou/kuwo/bilibili/custom`（`:4-10`），meting 侧名字 `tencent/netease/kugou/kuwo/bilibili`（`:34-42`），hyw 侧 `tx/wy/kg/kw/bili`（`:45-53`）。

| 动作 | meting | hyw | nxinxz | openApi |
|---|---|---|---|---|
| 搜索（`:118/120/133-146/159/172`） | 含 `api.php`：`?types=search&count=20&source=<srv>&pages=1&name=<kw>`；否则 `?type=search&id=<kw>&server=<srv>&limit=20` | 搜索固定打 `api.qijieya.cn/meting`（qq/kugou）或 `music-api.gdstudio.xyz`（kuwo/netease） | 同左，硬编码 gdstudio | `<base>?msg=<kw>&type=json` |
| 取播放地址（`:314/316/346-358/362/368-378`） | `api.php?types=url&source&id&br=320`；否则 `?server&type=url&id&br=320` | `?source=<key>&songId=<id>&quality=320k` → 取 `url` 或 `data.url` | `?id=<id>&level=320k&type=mp3` | `?msg=<id>&type=url` → 取 `url` 或 `data` |
| 歌词（`:413/415/424/433/445`） | `types=lyric` / `type=lrc` → 取 `lyric\|lrc` | 回落 `api.qijieya.cn/meting?server&type=lrc&id` | 同左 | `?msg=<id>&type=lrc` |
| 封面 | 搜索项里的 `pic`/`cover`（`:224`），无独立端点 | 同左 | 同左 | 同左 |

响应识别三态（`:326-341`）：JSON 带 `url` / 纯文本 http 直链 / 302 跳转后的 URL。取到的地址是**平台 CDN 裸链、无自定义头**，含临时 token 有时效，所以 Swift 侧有 `streamURLCache`（`:286-305`），失败要重解析。UA 固定 `Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)`（`:126`）。

9 条默认线路（`AggregatedSourceStore.swift:18-102`，均启用，括号内为 priority）：① QQ音乐(HYW) `hyw` `http://103.79.184.97/api/music/url` p20 · ② 网易云(GDStudio) `meting` `https://music-api.gdstudio.xyz/api.php` p18 · ③ 酷我(NXINXZ) `nxinxz` `http://music.nxinxz.com/kw.php` p16 · ④ 酷狗(HYW) 同 ① 地址 p15 · ⑤ 网易云(七洁雅) `meting` `https://api.qijieya.cn/meting` p14 · ⑥ 网易云(DreamMeting) `meting` `https://music.3e0.cn` p12 · ⑦ 酷我(HYW) 同 ① 地址 p10 · ⑧ QQ(七洁雅) `meting` `api.qijieya.cn/meting` p8 · ⑨ QQ(OpenAPI) `openApi` `https://tang.api.s01s.cn/music_open_api.php` p6。线路清单存 UserDefaults 键 `primuse.aggregated_sources.v2`（`:9,106,126`）。

### 16.6 道理鱼（DaoLiYu）契约

配置字段 `host, port:Int?, useSSL:Bool, basePath:String?, username, password, alternateTLSValidationHostname`（`Services/Sources/DaoLiYuSource.swift:15-24`）；端点 = `basePath + "/api" + path`（`PrimuseKit/Sources/PrimuseKit/Streaming/DaoLiYuAPIProtocol.swift:44-59`，scheme 由 `useSSL` 决定）。

- 登录 `POST {base}/api/auth/login`，body 三键 `{"email":u,"username":u,"password":p}`（`DaoLiYuServiceClient.swift:521-539`），响应**取 `token`**（`:552`），之后 `Authorization: Bearer <token>` + `Accept: application/json`（`:509-510`），无自定义 UA/Referer。
- 曲目列表 `GET /api/tracks?skip=&take=`（`:321-331`，`take≤500`，pageSize=100，`DaoLiYuSource.swift:8`），响应键 `items[]/total/skip/take`。单曲 `GET /api/tracks/{id}`（响应 `track` 或顶层）。
- **没有搜索、没有歌单端点**：它是整库扫描型连接器，搜索靠本地资料库过滤（`MusicSourceConnector` + `SongScanningConnector`）。
- 音频：iOS/macOS 的 `streamingURL` 返回 nil（`DaoLiYuSource.swift:259-262`），走 `fetchRange`（带 `Range` + `Accept-Encoding: identity`，必须 206，`:370-419`）或 `downloadTrack` 落缓存；只有 tvOS 才用带 Bearer 头的 `/download` 裸 URL（`:453-461`）。⇒ Windows 侧同样不能把 `/download` 直接丢给 `<audio>`（浏览器不会带 Authorization 头），必须由**本地 127.0.0.1 代理**转发 Range。
- 歌词：详情 JSON 的 `lyricsSync`（逐字）与 `lyrics`（`:132-133`），`preferredLyrics` 取 `synchronizedLyrics ?? plainLyrics`（`:362-368`），值可以是字符串或字典 `content/text/lrc`（`:175-181`）。
- 封面：`coverArtUrl/coverArtPath/album.coverArtUrl/album.coverArtPath`（`:126-131`）；绝对 URL 与 `/api/...` 原样用，否则 `GET /api/cover?path=<ref>`（`DaoLiYuAPIProtocol.swift:101-106`）。
- 失效重登：`401 || 403` 判定鉴权失败（`:568-570`），清空 token 后**重试一次**，第二次仍失败才报 `.authenticationFailed`（`:400-403/474-480`）。
- 其它服务器型源同层存在（`SubsonicSource.swift:17` 查询参数 `t=md5(password+salt)&s&u`、`MediaServerSource.swift:5` 的 jellyfin/emby/plex 用 `MediaBrowser Client=...,Token=` 头、`FnMusicSource`、`SongloftSource`），首版只做道理鱼，其余排在 W5。

### 16.7 阶段划分（取代 §5 的 M2/M3）

| 阶段 | 内容 | 完成判据 |
|---|---|---|
| W0 | `primuse-win/` 骨架：Electron + 三栏壳 + `MacRoute` 等价导航 + 本地 `settings.json` | 双击启动，首屏是"发现/搜索"，**没有登录框** |
| W1 | 聚合线路数据层（§16.5 四类协议、9 条默认线路、优先级）全在主进程 | 零配置搜四平台，点击能出声、能拖进度 |
| W2 | 播放器常驻（`MacBottomBar` 等价）+ 队列 + 歌词滚动 + 封面 + 收藏/最近播放本地库（SQLite） | 与 iPhone 交互语义一致，重启记住队列与音量 |
| W3 | 道理鱼源（§16.6，含 127.0.0.1 Range 代理与 401 重登一次） | 在"来源"页填地址+账号后，能浏览自己的库并播放 |
| W4 | CI：`primuse-win` 独立流水线出 `nsis`+`portable`，挂到版本 Release（`append_body: true`） | tag 一推，Release 上出现 Windows 的 Primuse 安装包 |
| W5 | 其余服务器型源（subsonic/navidrome/jellyfin/emby/plex/fnMusic/songloft） | 逐源验收 |

**明确不做**：本地文件与 SMB/NAS/SFTP/WebDAV/S3 扫描、CUE 分段、iTunesLibrary、CloudKit 同步、Widget/实时活动、CarPlay、歌词翻译、scrobble（排在 W5 后另议）、无损独占输出（Chromium 做不到 WASAPI 独占，承诺了就是坑）。

### 16.8 已知取舍

- meting 类线路通常给 128/320 kbps mp3，**不承诺 Hi-Res**。
- 公开线路随时失效且只能靠发版补救 —— 这是 iPhone 版同样的固有代价，Windows 版把线路清单存本地可自加，至少不用等发版。
- 自动更新：新工程的 `build.publish` 必须指本仓库 `narci2018/Primuse-halo-plus`，不要继承 `electron/` 那份指向上游 `zhoujungis/halo_music` 的旧值（§15 已修过一次，新工程再犯一次就是新 bug）。
  **W4 落地时的修订**：`primuse-win/package.json` 的 `build.publish` 定为 `null`，即**首版不做应用内自动更新**。理由不是忘了配，而是未签名包装不了自己的更新 —— electron-updater 在 Windows 上会替换 exe，而新 exe 没有签名证书（D3），SmartScreen 会在"自动更新"这条用户没同意的路径上再拦一次，失败形态比手动下载更差。更新方式：来 Release 页面下新的 `Primuse-Setup-*.exe` 覆盖安装。将来买了证书再开 `publish`。

## 17. W0–W4 已交付：`primuse-win/` 是 Primuse 本体的 Windows 版（2026-10-13）

§16 的 Windows 端已经按 W0→W4 做完并在这台 Win11（build 26200）上实测过。记录的是"实际验证到什么程度"，不是"写了什么代码"。

### 17.1 工程形态

新目录 `primuse-win/`，与仓库根的 `electron/`（HALO 壳）**没有任何继承关系**：自己的 `package.json`、`package-lock.json`、`src/`、`build/icon.png`（图标取自 `primuse/Primuse/Resources/Assets.xcassets/AppIcon-Mac.appiconset/icon_512x512@2x.png`）。

| 键 | 值 | 为什么 |
|---|---|---|
| `productName` / `appId` | `Primuse` / `com.welape.primuse.desktop` | 与 HALO 壳的 `HALO Music` / `com.halomusic.desktop` 区分开，两台机器上并存不冲突 |
| `version` | 与 `primuse/project.yml` 同步（1.9.9） | 三个平台一条 Release 一个版本号 |
| `devDependencies` | `electron 37.10.3`、`electron-builder 26.15.3`、`@electron/asar 3.4.1`，**全部精确版本** | electron-builder 拒绝范围版本（`^37.2.6` 会报 "Cannot compute electron version"）；钉死才保证 CI 与本机打包的是同一条 Electron |
| `build.publish` | `null` | 见 §16.8 的修订 |
| `win.forceCodeSigning` | `false` | D3：没有证书 |
| 窗口 | `titleBarStyle: 'hiddenInset'` + 自绘标题栏 | 与 iPhone/macOS 版同一视觉，不出现系统菜单式网页壳 |

主进程 `src/main/`：`main.js`（IPC + 生命周期 + 冒烟）、`httpx.js`（唯一发网络请求的出口，手动跟随重定向、gzip/br 解压）、`aggregated.js`（§16.5 契约）、`daoliyu.js`（§16.6 契约）、`proxy.js`（`127.0.0.1:0` 随机端口，把带鉴权/跨域限制的音频与封面转成 `<audio>`/`<img>` 可用的本地 URL，并透传 `Range`）、`store.js`（`userData/primuse.json` + `credentials.json`，密码走 `safeStorage`/DPAPI）。
渲染层 `src/renderer/`：`index.html` + `app.js` + `styles.css`，通过 `preload.js` 暴露的 `window.primuse` 与主进程通信；`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，CSP 只允许 `media-src 'self' http://127.0.0.1:*`。
**所有网络 I/O 都在主进程**：第三方线路大量是明文 http，放在渲染层会被 mixed-content 与 CORS 直接拦掉。

### 17.2 与 Swift 的契约对齐（可执行、可回归的三处）

1. `scripts/daoliyu-contract-test.js` —— 起一个 localhost 假服务器（登录、分页、详情、`/download` 校验 Bearer 并返回 206、token 轮换、密码错误），断言 §16.6 的 7 条规则。**当前 7/7 PASS**（登录 3 次、下载 1 次）。这是"道理鱼移植对不对"的唯一离线证据；真机那台服务器仍未验证过（见 17.5）。
2. `scripts/verify-asar.js` —— 用 `@electron/asar` 列包内条目（按字节搜 `app.asar` 会假阴性），断言 12 个必需文件在包内，且 `/major.js`、`/admin/` 等 HALO 网页资产**没有**混进来。当前 15 条目、泄漏 0。
3. CI 里的线路契约断言 —— `DEFAULT_SOURCES` 必须是 9 条、priority 序列必须是 `20,18,16,15,14,12,10,8,6`、四个平台都要有默认线路。改错一行就会在 preflight 红掉，而不是等用户发现"搜不到歌"。

一处**有意偏离**：Swift 的 meting 搜索把 `duration` 写死 210（`AggregatedMusicService.swift` 内），JS 侧改成解析真实时长。偏离点写在代码注释里，不要当成 bug 改回去。

### 17.3 真机冒烟（`npm run smoke` / 打包后的 `Primuse.exe --primuse-smoke`）

同一份断言在 **dev、`dist/win-unpacked`、以及 NSIS 安装到 `%LOCALAPPDATA%\Programs\Primuse` 之后**三种形态下都跑过，1.9.9 全部 10 项 PASS（退出码 0）。v1.9.10 加歌单层后为 19 项（本机 dev 全绿，见 §18.6），三种形态的重跑是发版前动作：

```
PASS 默认线路数量 — 实际 9 条（Swift 侧应为 9）
PASS 聚合搜索有结果 — 共 64 条，平台分布 {"kugou":20,"netease":24,"qq":20}
PASS 至少一条线路真能出声 — 可播平台 netease；明细 ["netease:65536B","qq:失败","kugou:失败","kuwo:失败"]
PASS 本地代理 Range 透传 — 206 audio/mpeg 4096B via 127.0.0.1:58707
PASS 网易歌词 — LRC 969 字符
PASS 本地库持久化 — {"收藏":true,"历史":true,"队列":true,"播放器":true}
PASS 道理鱼凭据只进 DPAPI（safeStorage） — 源已存 true；密码可解密回读 true；主 JSON 无明文 true；凭据文件为密文 true；safeStorage 可用 true
PASS 冒烟探针已清理 — 收藏 0 服务器源 0
PASS 渲染层自检 — {"ready":true,"rows":64,"hasPlayerBar":true,"hasLoginWall":false,...}
PASS 界面截图
```

- `hasLoginWall: false` 是这一节存在的理由：上一版交付物（`HALO-Music-Setup-*.exe`）就是在这一条上不合格的。
- 持久化那两项是**写盘后重新 `readFileSync` 校验**，不是读内存缓存：收藏/历史/队列/音量真的落到了 `primuse.json`；道理鱼密码只进 `credentials.json` 的 safeStorage 密文，主 JSON 与凭据文件里都搜不到明文（冒烟用假密码 `smoke-secret-1` 做反向断言）。探针数据在同一个 smoke 里清掉，不许留在用户库里。
- 截图与报告落在 `%TEMP%/primuse-smoke/`（不能写 `dist/`：打包后 `__dirname` 在 `app.asar` 里，只读）。
- 安装器静默安装的可复现坑：Git Bash 会把 `/S` 改写成 `S:/`，于是安装器以为没有静默参数、弹出资质向导并挂住（进程还在、目录不出现）。要么在真 cmd/PowerShell 里跑 `Primuse-Setup-1.9.9-x64.exe /S`，要么在 Git Bash 里写 `//S`。

### 17.4 产物与 CI

- 本机 `npx electron-builder --win nsis portable --publish never --config.extraMetadata.version=1.9.9` → `Primuse-Setup-1.9.9-x64.exe`（89 MB）、`Primuse-Portable-1.9.9-x64.exe`（88 MB）；`latest.yml` 不生成（`publish: null`）。
- `.github/workflows/build-primuse-win.yml` 取代并**删除**了 `build-win.yml`（后者打的是 HALO 壳；两条 `v*` 流水线并存会让每个 Release 都多一个错包）。新流水线两个 job：`preflight`（语法检查 + §17.2 的三项离线断言 + 线路契约断言，几分钟）与 `build`（仅 tag / 手动触发，跑与本机同一条 electron-builder 命令 + 产物校验 + "不许变回 HALO 壳"的身份守卫 + 发到版本 Release，`append_body: true`）。preflight 是 build 的硬前置：契约断言红了就不出包。
- **CI 里故意不跑**需要联网的冒烟（`--primuse-smoke`、`scripts/data-check.js`）：它们依赖别人家的公开线路，几天内就会变（§12 已证），把绿转红的原因落在陌生服务器上，不如在本机跑。
- 触发条件**没有** `paths:` 过滤：tag 推送的 paths 过滤按该 commit 的改动文件算，一旦发版 commit 没碰 `primuse-win/`，Windows 包就会静默缺席。

### 17.5 现在能播什么、还差什么

- **能播**：网易云（经 gdstudio/qijieya/3e0 任一 meting 线路）。QQ/酷狗/酷我 的**公开线路当前全部取不到流** —— 与 §12 探测结论一致（HYW 线路要卡密、`music.nxinxz.com` 与 s01s openApi 已空、qijieya 的 tencent/kugou url 坏）。这不是移植缺陷：同一时刻 iPhone 版用这 9 条线路也是同样结果。
- **四平台靠道理鱼**：§13 的结论没变 —— 用户那台自建服务器才是四平台出声的来源。App 内"设置 → 音乐源 → 添加服务器源"可填地址与账号（凭据只进本机 DPAPI，不进日志、不进聊天）。**这一条只经过假服务器验证，没经过真服务器**。
- 未做（W2 后半与 W5）：SQLite 曲库（收藏/最近播放/队列现在是 `primuse.json` 持久化，够用但不是 GRDB）、歌词翻译、其余服务器型源（subsonic/navidrome/jellyfin/emby/plex/fnMusic/songloft）、本地文件与 NAS 扫描（D1 明确不做）。
- macOS 真机安装验证（任务 #5）与 Windows 安装器的 GUI 交互（拖拽进度条、托盘、媒体键）仍需人手；前者在这台机器上无法完成。

---

## 18. 歌单层：把 iPhone 的歌单与云端同步搬进 Windows（2026-10-14，v1.9.10 / build 72）

用户提了 5 条：① 歌单同步（`https://primuse-sync-server.pages.dev/api/sync-playlists` 上传/下载）② 搜索结果可"添加到歌单"③ 可创建/删除/编辑歌单 ④ 歌单内可随机/顺序/单曲循环 ⑤ 忠于原版 UI，去掉 iPhone 苹果体系特有的东西。并给了两条硬约束：**"服务器同步的是歌单，不是歌曲源"**、**"优选忠于 UI、忠于功能"**（据此我没有去全网抓更多公开第三方线路 —— 那是在扩大抓取受版权保护音频的入口，不做；扩源走 §17.5 的自建协议路线 W5）。

### 18.1 数据层：「我喜欢」是派生视图，不是第二份数据

`store.js` 新增 `playlists` 模块，但**没有**给「我喜欢」建表。iPhone 侧它就是一个 `id = primuse.system.liked` 的系统歌单（`MusicLibrary.swift:5138`，首次点心形时才懒建 `:5140`），Windows 侧的收藏早就存在 `state.favorites` 里 —— 所以 `playlists.get(LIKED_PLAYLIST_ID)` 返回的是**按引用包住 `state.favorites` 的视图**，点心形与在歌单里移除是同一份数组，天然不会漂移；`load()` 会把任何持久化进来的 `primuse.system.liked` 行丢掉（它是派生的，落盘就是第二真源的开端）。`list()` 的顺序照抄 `MusicLibrary.swift:7707`：「我喜欢」置顶 + 用户歌单按 `updatedAt` 倒序。

去重与匹配统一走 `trackKey(track)`（`kind|platform|sourceID|rawID`），所以 `add` 重复加入是 no-op，`toggle` 再点一次就是移除（对应 `AddToPlaylistSheet` 的 ✓ 行为）。

### 18.2 云端契约：字段与 iPhone 实测逐字节对齐

2026-10-14 只读 GET 现网拿到的真实行：`86A75176-7E98-48AC-9E80-32FD9875974F` / 设备名 iPhone / iOS / 4 个歌单（经典 232、我喜欢 1、神咒 2、佛经 6）。POST 备份体与 GET 恢复的包封见 `src/main/sync.js` 头注释。要点：

- 上行歌曲只有 7 个字段：`id / title / artist / album / duration / filePath / sourceId`。聚合曲目必须写成 `agg_{platform}_{rawID}` + `/aggregated/{platform}/{rawID}.mp3` + `system-aggregated-music`（`AggregatedMusicService.swift:10,228,269`），自建服务器源写成 `dly_{sourceID}_{rawID}`。
- 下行反解三层：`agg_*` → 可播聚合轨道；`dly_*` 且本机有同一台源 → 可播；`dly_*` 但本机没有那台源 → **`unresolved: true`**，UI 打「无对应源」徽标、播放时给一句可读错误，而不是假装能播。这就是"同步的是歌单不是歌曲源"在代码里的落点。
- 超时 20 s，成功判定 `HTTP 200 && code === 0`，包封 `{code,message?,error?,data?}`。

### 18.3 防覆盖：备份有硬闸，跨设备只读

`sync.config.ownedByThisDevice` 是备份的**前置条件**：机器码不是本机持有的（例如刚从云端导入过别人的设备行）时，`backup()` 直接抛错并根本不发 POST。跨设备"下载歌单"只走 GET，绝不回写；导入自己的 deviceId 被拒（避免自覆盖）。恢复走 `mergeIncoming()`：同 id 或同名合并，不复制出两份同名歌单。

### 18.4 UI 忠于原版的地方，以及**有意**不做的地方

照抄的：歌单列表过滤掉「我喜欢」（`PlaylistListView.swift:36-38`）、行副标题「N 首 · 日期」、空态「没有歌单 / 创建歌单来整理你的音乐」、详情页「N 首歌曲」+ 全部播放/随机播放/⋯ 菜单、⋯ 菜单顺序（重新排序·加入播放队列·接下来播放·重命名·导出·删除歌单）、删除**不弹二次确认**（原版就没有）、「添加到歌单」弹层里"新建歌单"是输入框式表单且 ✓ 再点取消、封面用 `playlist.id` + 排序后成员 ID 的 FNV-1a 稳定哈希（`PrimuseKit/.../Playlist.swift:169-227`，故意不取第一首）。底部播放条顺序改成 shuffle·prev·play·next·repeat（`MacBottomBar.swift:146-192`），循环图标 off→all→one 循环、非 off 时点亮。

**不做**（都在代码注释里点名了原因，别当 bug 补回来）：AI/规则智能歌单、更换封面（依赖本地封面文件）、批量选择（无多选态）、刮削缺失元数据（Windows 版没有本地歌曲表）。**重新排序是手动 ▲▼**（`PlaylistReorderSheet`，标题「调整播放顺序」）—— 原版根本没有"按标题排序"，我一开始写错了，已删掉 `sort()` 与那条菜单。

### 18.5 播放模式

`buildOrder(length, currentIndex, shuffle)`：无种子 Fisher–Yates 后把当前曲挪到最前（`AudioPlayerService.swift:10726-10737` 同规则），`indexAfter(delta)` 在 repeat=off 且走到头时返回 null（停），all 取模，one 原地。歌单内"随机播放"= `shuffleEnabled = true` + 随机起点（`PlaylistDetailView.swift:1106-1121`），不是打乱队列再从头放。

### 18.6 验证（本机全绿）

1. `scripts/playlist-sync-contract-test.js` —— 往 `require.cache` 注入假 store，让 `sync.js` 在纯 Node 下跑，起一个 D1 语义的本地假服务器，**种子就是 iPhone 那行真实备份的代表样本**（4 个歌单的 id/名称/字段逐字照抄现网，232 首的「经典」里取 3 首代表，所以假服务器上 iPhone 行的 `song_count` 是 6、`playlist_count` 是 4，断言按这个写）。11 项断言全绿：上行字段与 iPhone 实测逐字段相同、`agg_*` 往返、`filePath` 兜底反解、外来 `dly_*` 标 `unresolved`、备份用自己的机器码且**绝不改动 iPhone 那行**、`ownedByThisDevice=false` 时拒绝且不发请求、恢复合并、设备列表与跨设备导入只读、拒绝导入自己、404 转可读错误、从未备份过时 `restore()` 返回 `empty`。**CI 里跑的是这个假服务器，真网络路径不进 CI**：流水线不许往用户的云端备份写东西。
2. `npm run smoke` —— 19 项全 PASS，其中 5 项是这次新加的数据层断言（歌单 CRUD+落盘、「我喜欢」= 系统歌单、`agg_*` 映射、上报含自建歌单与我喜欢、探针清理）与 3 项渲染层断言（歌单 UI 已接线、**歌单页渲染**：列表/详情/⋯菜单/加入弹层/同步页的 DOM 实测、歌单 UI 探针已清理）。渲染层这一段会**建一个真歌单、开三个页面读 DOM、截图、再删掉**，所以它证明的是"看得见点得到"，不是"代码写了"。`smoke-ui-playlist.png` 里能看到 ⋯ 菜单六项与两行曲目的 →/✕。
3. CI `preflight` 新增一步 `node scripts/playlist-sync-contract-test.js`（与道理鱼契约、线路契约并列），红了就挡住 `build`。`verify-asar.js` 的必需文件表加了 `/src/main/sync.js`（现 13 项）。
4. `scripts/probe-live-sync.js` —— **只读**打真云端，用 App 自己的网络栈（`httpx` = Node https）拉设备列表与 iPhone 备份，再走一遍真实 `fromWireSong` 反解。2026-10-14 实测：`1 台设备 · iPhone/iOS · 4 个歌单 · 241 首（经典 232 / 我喜欢 1 / 神咒 2 / 佛经 6）`，**241 首全部可反解为聚合轨道，`unresolved` 0 首**。这是"字段没写错"之外唯一能证明"这台机器真能连上、真能读懂 iPhone 留下的备份"的证据；它绝不 POST。
5. 打包形态也回归过：本机 `npx electron-builder --win nsis portable` 出的 `dist/win-unpacked/Primuse.exe --primuse-smoke` 同样 19 项 PASS（退出码 0）。

一个**只在这台机器上出现**的网络坑，别误判成"服务端挂了"：本机 `curl` 访问 `*.pages.dev` 会以 `schannel: CRYPT_E_REVOCATION_OFFLINE`（`http=000`）失败，那是 Windows 证书吊销列表取不到，加 `--ssl-no-revoke` 就通；而 Electron/Node 用 BoringSSL、默认不做吊销检查，所以 App 本身连得上（上面第 4 条就是证据）。判断"同步服务在不在"要以 `probe-live-sync.js` 或 App 内的实际响应为准，不要拿一条 curl 的 000 下结论。

### 18.7 还没做

云端"整库同步/歌曲源同步"（按用户纠正，不做）；歌单封面真图（现在依赖远端封面 URL 能否加载，加载不到退回 ♪）；批量选择与拖拽排序；把 Windows 的歌单结构回灌给 iPhone（现网契约是同一份，理论上 iPhone 下载 Windows 备份即可，**未验证**）。

