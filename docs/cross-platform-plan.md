# Primuse 跨平台方案：Windows 11 + macOS (Apple Silicon)

状态：**决策已确认，可执行** · 起草：2026-10-13 · 适用范围：仓库 `C:\Tools2\halo_music`（Git 根，`primuse/` 为其子目录）

> 已确认：Windows 走 **B1 薄壳 + 服务端复用**；Windows 音源范围为 **在线聚合 + 服务器型源**；分发 **先出未签名包**（Apple Silicon 侧用 ad-hoc 签名，见 §5 M4）。
> 同日追加 D4–D7（见 §7）：壳 = **复用现成 `electron/`**；后端 = **沿用已部署的 `halo-music.pages.dev`，不重新部署**，接入口从 `/rest` 改为 `/api/music`；首版音源 = **全平台（网易+QQ+酷狗+酷我）**，酷狗/酷我由客户端主进程直连 meting；QQ 搜索字段 = **维持现状**。§3、§4、§5 M0.5/M2、§6、§9 均已按此修订。
> **§12–§13 是对上面两段的实测纠正**：HALO 现网只有 `/api/music`+`/api/version`，播放类接口要登录；9 条公开聚合线路今天只有网易能出声。**M2 的主路径已改为「道理鱼（DaoLiYu）薄壳」**（见 §13），因为 iPhone 的四平台播放来自一台地址由用户自填、带账号的服务器，而不是这些公开线路。

---

## 0. 结论摘要

1. **macOS 支持在代码层面已经存在**，不需要新建 `Primuse-mac/` 目录。`project.yml` 中 `PrimuseMac` target（第 413 行起）复用 `Primuse/` 全部源码，含 `Views/Mac/` 三栏桌面 UI、菜单栏播放器、桌面歌词浮窗、mini player、iTunesLibrary 导入、SFBAudioEngine + FFmpeg 解码、WidgetKit 组件；bundle id 与 iOS 相同（`com.welape.yuanyin`，Universal Purchase）。Mac 侧缺的是**工程化**：可编译性验证（**已完成**，CI 已出 `Primuse-macos-arm64-1.9.6-b68` 的 DMG+ZIP，见 §11）、部署门槛过高（macOS 26.0，仍未降级）、以及真机上的安装/启动验证。
2. **Windows 不是移植而是新做客户端**。SwiftUI / AVFoundation / SFBAudioEngine / CloudKit / MusicKit / WidgetKit / CarPlay / App Intents / Translation / iTunesLibrary 在 Windows 无对应物。UI 层（191 个 SwiftUI 文件）必须重写；播放引擎必须替换。
3. **真正可复用的资产是 `PrimuseKit`**：331 个文件中只有 17 个 import 了平台受限框架，模型层、GRDB 资料库、扫描/去重/CUE/流解析/元数据策略几乎全部是 Foundation 级别逻辑。
4. 建议按"层"而不是按"平台"组织目录，核心下沉 + 各端薄壳；Windows 目录建议 `clients/primuse-win/`。
   **修订（D4）**：Windows 首版不新建目录，直接复用仓库根已有的 `electron/` + `package.json` 里的 `electron-builder --win` 配置；`clients/primuse-win/` 与 `core/primuse-core` 都属于 B3 阶段的形态，不是 B1 首版的前置。

---

## 1. 现状盘点（已核实）

### 1.1 仓库形态

| 组件 | 路径 | 性质 |
|---|---|---|
| HALO Music（Web + Cloudflare） | 仓库根：`index.html`、`major.js`、`functions/`、`admin/`、`migrations/`、`schema.sql`、`wrangler.toml` | 多源搜索/播放/歌单/歌词的网页应用，Pages Functions + D1；Electron 桌面壳在 `electron/`，`package.json` 已配 `electron-builder --win nsis/portable` |
| HALO Subsonic 服务端 | `functions/rest/[[catchall]].js` + `_subsonic.js` | 实现 ping / getLicense / getMusicFolders / getIndexes / getMusicDirectory / getArtists / getArtist / getAlbum / getSong / search2 / search3 / stream / download / getCoverArt / getLyrics(BySongID) / getPlaylists / getPlaylist / create/update/deletePlaylist / star / unstar / getStarred / getAlbumList / getScanStatus。**曾是"Windows 端最省力的接入口"，但线上实例并未部署这一面**（`/rest/*` 回落到 SPA HTML，§10 线上实例复核），因此 Windows 首版改用已在线的 `/api/music`（D5） |
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
| D1 | Windows 技术路线 | **B1 薄壳 + 服务端复用** | Windows 端不写 Swift、不编 `PrimuseKit`；能力上限由 HALO 后端决定 |
| D2 | Windows 音源范围 | **在线 + 服务器型源** | 本地文件夹与 SMB/NFS/SFTP/WebDAV/S3 明确不在本轮范围（见 N4） |
| D3 | 签名与分发 | **先出未签名包** | macOS 必须 ad-hoc 签名（Apple Silicon 硬要求）+ Gatekeeper 放行说明；Windows 接受 SmartScreen 警告，且现有 `forceCodeSigning: true` 需改为条件签名 |
| D4 | Windows 壳 | **复用现成 `electron/`** | M2 在 `electron/` 里加 Windows 播放器界面，不引入 Rust/Tauri 工具链；包体 90MB+ 换取"Chromium 自带音频栈 + 已有 `--win nsis/portable` 配置"，首版最快。网络请求全部放主进程，避开 https 页面直连 http 线路的混合内容限制 |
| D5 | 后端地址 | **沿用已部署的 `halo-music.pages.dev`，不重新部署** | 该实例的 `/api/*` 在线（QQ 搜索字段完整），但 `/rest/*` 不在线。所以 B1 的接入口从 Subsonic 改为 `/api/music`；Subsonic 面等到你愿意重新部署时再启用（Primuse iPhone 端本来就自带聚合音源，不依赖 `/rest`） |
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

在 Windows 上 `git add -A` 会**再次**把这 20 条打回 `100644`（这就是当初坏掉的方式）。所以在 `build-mac.yml` 里加了一个构建前的结构校验步骤：逐个检查 4 个 framework 的 5 个入口是不是真符号链接、`Headers/<name>.h` 能否解析、`Versions/Current/<name>` 是否为真文件，并打印索引里 `120000` 的条数（应为 20）。它把 28 分钟的失败压缩成几秒钟的明确报错。

**M0 结果（同日）**：第五轮 run `38381672057` 全绿，26.1 分钟，13 个步骤无一失败，产物 artifact `Primuse-macos-arm64-1.9.6-b68`（DMG + ZIP，133.2 MB）。也就是说 Mac target 的 Swift 主体、WidgetKit 宿主页、FFmpeg 链接、ad-hoc 逐个签名与 `hdiutil` 打包一次性全部通过，M0 的代码部分到此结束。

**仍未验证（必须真机）**：这个包在 M 系列 Mac 上能否双击启动、Gatekeeper 是"仍要打开"一次到位还是需要在「隐私与安全性」里点"允许"；CloudKit 同步与小组件在剥掉 entitlements 后是否只是静默不可用（脚本注释如此假设，但没有实测）。artifact 需要登录才能下载，匿名 GET 返回 401，所以本机无法自证。

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
