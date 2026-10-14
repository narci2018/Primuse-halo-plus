import Foundation
import Observation

// MARK: - 云端音乐源清单（契约 primuse.music-sources.v1）
//
// 需求 4 的本机一侧：客户端**只保存一个 URL**，通过解释这份 URL 得到可用的源。
// 三端读的是同一份 D1 名单 —— iPhone/Mac、Windows、服务端不会再各拿一份线路表，
// 所以"哪条能播"这个问题在三个屏幕上必须给出同一个答案。
//
// 需求 3 的边界：增删改只在 CF 后台，本机只读 + 刷新（界面上没有铅笔和左滑删除）。
// 这份文件的职责只有三件：拉清单、把清单落到本机线路表、以及在需要时代跑
// 洛雪 js 音源（本机没有第二个 JS 引擎，脚本跑在服务端的 runner Worker 里）。

public let cloudMusicSourcesContract = "primuse.music-sources.v1"

// MARK: - DTO

public struct CloudSourceCheckDTO: Codable, Sendable, Hashable {
    public var status: String
    public var detail: String?
    public var bytes: Int?
    public var checkedAt: Double?
    public var failStreak: Int?
}

public struct CloudSourceDTO: Codable, Sendable, Hashable {
    public var id: String
    public var name: String
    public var platform: String
    /// 清单里的字段名是 `protocol`，Swift 里 `protocol` 是关键字 → 落成本机名字，
    /// 但 CodingKeys 必须映射回 `protocol`，否则整份清单解出来全是 nil。
    public var `protocol`: String
    public var baseURL: String?
    public var scriptHash: String?
    public var hasScript: Bool?
    public var quality: String?
    public var enabled: Bool
    public var enabledLocked: Bool?
    public var priority: Int?
    public var note: String?
    public var check: CloudSourceCheckDTO?
    public var suggestDelete: Bool?

    public var protocolType: AggregatedProtocolType {
        AggregatedProtocolType(rawValue: `protocol`) ?? .customJson
    }

    public var platformValue: AggregatedPlatform { AggregatedPlatform.from(platform) }

    public var isHTTPBaseURL: Bool { CloudMusicSources.looksLikeHTTP(baseURL ?? "") }

    /// 清单给的线路能不能落到本机用。
    ///
    /// 过滤规则要说清楚（与服务端/Windows 同一条）：**lxjs 但没有脚本指纹的不进线路表**
    /// —— 走网关也解析不了，留着只会让播放变成一次注定失败的请求；
    /// HTTP 类但没有合法 baseURL 的同样不留。其它一律照清单下发，
    /// 包括"检不出结果"（no_sample / unchecked）的那些 —— 服务端把它们停在 enabled=1
    /// 是有意的：观测盲区不等于源坏了。
    public var isUsableLocally: Bool {
        if `protocol` == "lxjs" {
            return (scriptHash?.isEmpty == false)
        }
        return isHTTPBaseURL
    }
}

public struct CloudSuggestionDTO: Codable, Sendable, Hashable {
    public var id: String
    public var name: String?
    public var reason: String?
    public var status: String?
}

public struct CloudDeviceSettingsDTO: Codable, Sendable, Hashable {
    public var homeTitle: String?
    public var homeTitleFrom: String?
    public var deviceId: String?
}

public struct CloudGatewayDTO: Codable, Sendable, Hashable {
    public var base: String?
    public var actions: [String]?
    public var note: String?
}

public struct CloudManifestDTO: Codable, Sendable, Hashable {
    public var revision: Int?
    public var revisionAt: Double?
    public var serverTime: Double?
    public var contract: String
    public var settings: CloudDeviceSettingsDTO?
    public var platforms: [[String: String]]?
    public var protocols: [String]?
    public var gateway: CloudGatewayDTO?
    public var runtime: [String: String]?
    public var sources: [CloudSourceDTO]
    public var usable: [String]?
    public var suggestions: [CloudSuggestionDTO]?
    public var script: String?
}

/// `{code, message, error, data}` —— 与 `/api/sync-playlists` 同一套信封。
struct CloudEnvelope<T: Decodable>: Decodable {
    var code: Int?
    var message: String?
    var error: String?
    var data: T?

    var failureText: String {
        if let error, !error.isEmpty { return error }
        if let message, !message.isEmpty { return message }
        return "服务端返回 code \(code ?? -1)"
    }
}

// MARK: - 首页标题（需求 5）

/// 首页 header / tab 的文案由服务端按「本机唯一标识」下发（清单里的 `settings.homeTitle`），
/// 没设置时回落到本地的 `home_title`。
///
/// 为什么走 UserDefaults 而不是直接读 `CloudMusicSources.shared`：
/// 首页那几个入口（iPhone 的 TabView、iPad 侧栏、Mac 侧栏、以及 `SidebarItem` 这个枚举）
/// 里有相当一部分是 `body` **之外**的 computed var —— Swift 6 下它们不是 MainActor，
/// 去读一个 MainActor 单例就是隔离错误。`CloudMusicSources` 在清单落地时把文案写进这一份键，
/// 视图再用 `@AppStorage` 读，两边都不越界，标题也能自己刷上去。
public enum HomeTitle {
    public static let defaultsKey = "primuse.home_title.remote"

    public static func resolved(_ stored: String?) -> String {
        guard let value = stored?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
            return String(localized: "home_title")
        }
        return value
    }

    public static var current: String {
        resolved(UserDefaults.standard.string(forKey: defaultsKey))
    }

    /// 视图侧的读法：配合 `@AppStorage(HomeTitle.defaultsKey) private var remoteHomeTitle = ""`
    /// 用这一份。走 `@AppStorage` 的意义在于**服务端改文案时首页自己会刷**，
    /// 不用等下一次无关的重渲染才跟上；`current` 留给非视图的枚举成员用。
    public static func text(_ stored: String) -> String {
        resolved(stored.isEmpty ? nil : stored)
    }
}

@MainActor
@Observable
public final class CloudMusicSources {
    public static let shared = CloudMusicSources()

    private static let manifestURLKey = "primuse.cloud_sources.manifest_url"
    private static let cacheKey = "primuse.cloud_music_sources.v1"

    /// 需求 4：客户端只保存这一个 URL。默认就是现网那份 Pages 清单。
    public static let defaultManifestURL = "https://primuse-sync-server.pages.dev/api/music-sources"

    public private(set) var manifestURL: String
    public private(set) var revision: Int = -1
    public private(set) var etag: String = ""
    public private(set) var fetchedAt: Date?
    public private(set) var lastError: String = ""
    public private(set) var manifest: CloudManifestDTO?
    public private(set) var isRefreshing: Bool = false
    public private(set) var isCheckingAvailability: Bool = false
    /// 「检测全部可用」的本机实测结论，按线路 id 存；界面优先显示这一份，
    /// 没有就退回清单里服务端体检的那一份。
    public private(set) var localVerdicts: [String: AggregatedSourceVerdict] = [:]

    private let store: AggregatedSourceStore
    private var periodicTask: Task<Void, Never>?

    public init(store: AggregatedSourceStore = .shared) {
        let defaults = UserDefaults.standard
        self.manifestURL = defaults.string(forKey: Self.manifestURLKey) ?? Self.defaultManifestURL
        if let data = defaults.data(forKey: Self.cacheKey),
           let cached = try? JSONDecoder().decode(CachePayload.self, from: data) {
            self.etag = cached.etag
            self.revision = cached.revision
            self.fetchedAt = cached.fetchedAt
            self.manifest = cached.manifest
        }
        if let poolData = defaults.data(forKey: Self.samplePoolKey),
           let pool = try? JSONDecoder().decode([String: [String]].self, from: poolData) {
            self.samplePool = pool
        }
        self.store = store
        // 冷启动就把缓存里那份首页文案摆上台面：不等网络，标题先对上服务端上次的下发。
        publishHomeTitle()
    }

    private struct CachePayload: Codable {
        var etag: String
        var revision: Int
        var fetchedAt: Date
        var manifest: CloudManifestDTO
    }

    // MARK: 派生信息

    public var hasManifest: Bool { manifest != nil }

    /// 需求 5：首页 header 的文案由服务端按「本机唯一标识」下发。
    /// 空串按"没设置"处理，回落到本地的 `home_title`，不能让首页变成一个空白标题。
    public var homeTitle: String? {
        guard let raw = manifest?.settings?.homeTitle?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty else { return nil }
        return raw
    }

    /// 清单给的 gateway.base 是相对当前 Pages 项目的（`/api/music-gateway`），要拼成绝对地址。
    public var gatewayBaseURL: URL? {
        Self.absoluteGatewayBase(manifestURL: manifestURL, base: manifest?.gateway?.base)
    }

    public var hasEnabledLXJS: Bool {
        store.sources.contains { $0.protocolType == .lxjs && $0.isEnabled }
    }

    private static func absoluteGatewayBase(manifestURL: String, base: String?) -> URL? {
        guard let originRoot = URL(string: manifestURL), let scheme = originRoot.scheme, let host = originRoot.host else { return nil }
        let trimmedBase = (base ?? "/api/music-gateway").trimmingCharacters(in: .whitespacesAndNewlines)
        if looksLikeHTTP(trimmedBase) {
            var end = trimmedBase.endIndex
            while end > trimmedBase.startIndex, trimmedBase[trimmedBase.index(before: end)] == "/" {
                end = trimmedBase.index(before: end)
            }
            return URL(string: String(trimmedBase[..<end]))
        }
        let suffix = trimmedBase.hasPrefix("/") ? trimmedBase : "/\(trimmedBase)"
        let port = originRoot.port.map { ":\($0)" } ?? ""
        return URL(string: "\(scheme)://\(host)\(port)\(suffix)")
    }

    /// `^https?://` 的大小写不敏感判断（不引 NSRegularExpression，就为这两个前缀）。
    ///
    /// `nonisolated`：`CloudSourceDTO.isHTTPBaseURL` 是顶层 struct 的计算属性（非隔离），
    /// 它也要用这条判断；挂在 MainActor 类上而不忘 `nonisolated` 就是 CI 报的
    /// "call to main actor-isolated static method in a synchronous nonisolated context"。
    nonisolated static func looksLikeHTTP(_ raw: String) -> Bool {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return value.hasPrefix("http://") || value.hasPrefix("https://")
    }

    // MARK: - 清单 URL 本身

    /// 换地址就是换了一份真相：旧的 ETag/正文/云端线路一律作废，
    /// 否则会拿 A 站的清单去配 B 站的网关。
    public func setManifestURL(_ url: String) {
        let clean = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Self.looksLikeHTTP(clean) else {
            lastError = "音乐源清单地址必须以 http:// 或 https:// 开头"
            return
        }
        manifestURL = clean
        etag = ""
        revision = -1
        fetchedAt = nil
        manifest = nil
        localVerdicts = [:]
        store.dropCloudSources()
        UserDefaults.standard.set(clean, forKey: Self.manifestURLKey)
        persistCache()
        // 换了清单地址，上一家的首页文案不该还挂在标题上（manifest 已是 nil → 键被删，回本地文案）。
        publishHomeTitle()
    }

    // MARK: - 拉清单

    public struct RefreshOutcome: Sendable {
        public var ok: Bool
        public var changed: Bool
        public var revision: Int
        public var error: String
        public var sourceCount: Int
        public var usableCount: Int
    }

    /// - Parameter force: true 时不带 If-None-Match（后台刚改过源，本机主动刷）。
    @discardableResult
    public func refresh(force: Bool = false) async -> RefreshOutcome {
        guard let base = URL(string: manifestURL) else {
            lastError = "清单地址无法解析：\(manifestURL)"
            return RefreshOutcome(ok: false, changed: false, revision: revision, error: lastError, sourceCount: 0, usableCount: 0)
        }
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
        var items = components?.queryItems ?? []
        items.removeAll { $0.name == "deviceId" }
        items.append(URLQueryItem(name: "deviceId", value: DeviceIdentity.currentDeviceID))
        components?.queryItems = items
        guard let url = components?.url else {
            lastError = "清单地址无法解析"
            return RefreshOutcome(ok: false, changed: false, revision: revision, error: lastError, sourceCount: 0, usableCount: 0)
        }

        isRefreshing = true
        defer { isRefreshing = false }

        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(AudioSniff.userAgent, forHTTPHeaderField: "User-Agent")
        if !force, !etag.isEmpty {
            request.setValue(etag, forHTTPHeaderField: "If-None-Match")
        }

        let data: Data
        let response: HTTPURLResponse
        do {
            let (d, r) = try await URLSession.shared.data(for: request)
            guard let http = r as? HTTPURLResponse else { throw NSError.cloudManifest("清单响应不是 HTTP") }
            data = d
            response = http
        } catch {
            // 够不到服务端 ≠ 名单作废：本机继续用缓存里那一份。
            lastError = error.localizedDescription
            return RefreshOutcome(ok: false, changed: false, revision: revision, error: lastError,
                                  sourceCount: manifest?.sources.count ?? 0, usableCount: manifest?.usable?.count ?? 0)
        }

        if response.statusCode == 304 {
            fetchedAt = Date()
            lastError = ""
            persistCache()
            // 没变也要把缓存落到线路表：上次进程崩溃前可能拉到了新清单却没来得及 apply。
            if let manifest {
                apply(manifest)
                publishHomeTitle()
            }
            return RefreshOutcome(ok: true, changed: false, revision: revision, error: "",
                                  sourceCount: store.sources.count, usableCount: (manifest?.usable ?? []).count)
        }
        guard response.statusCode == 200 else {
            lastError = "清单拉取失败（HTTP \(response.statusCode)）"
            return RefreshOutcome(ok: false, changed: false, revision: revision, error: lastError, sourceCount: 0, usableCount: 0)
        }

        let envelope: CloudEnvelope<CloudManifestDTO>
        do {
            envelope = try JSONDecoder().decode(CloudEnvelope<CloudManifestDTO>.self, from: data)
        } catch {
            lastError = "清单解析失败：\(error.localizedDescription)"
            return RefreshOutcome(ok: false, changed: false, revision: revision, error: lastError, sourceCount: 0, usableCount: 0)
        }
        guard (envelope.code ?? 0) == 0, let payload = envelope.data else {
            lastError = envelope.failureText
            return RefreshOutcome(ok: false, changed: false, revision: revision, error: lastError, sourceCount: 0, usableCount: 0)
        }
        // 契约不对就整份拒绝：认不得的清单硬解释一遍，比不解释更糟（会把线路表写成一堆空壳）。
        guard payload.contract == cloudMusicSourcesContract else {
            lastError = "清单契约不是 \(cloudMusicSourcesContract)（拿到 \(payload.contract)），本机继续使用缓存"
            return RefreshOutcome(ok: false, changed: false, revision: revision, error: lastError,
                                  sourceCount: manifest?.sources.count ?? 0, usableCount: manifest?.usable?.count ?? 0)
        }

        manifest = payload
        revision = payload.revision ?? revision
        if let newEtag = response.value(forHTTPHeaderField: "ETag"), !newEtag.isEmpty { etag = newEtag }
        fetchedAt = Date()
        lastError = ""
        apply(payload)
        publishHomeTitle()
        persistCache()
        return RefreshOutcome(ok: true, changed: true, revision: revision, error: "",
                              sourceCount: payload.sources.count, usableCount: (payload.usable ?? []).count)
    }

    /// 清单落成线路（只替换云端管下来的那些，保留本机手工加的备用线路）。
    private func apply(_ payload: CloudManifestDTO) {
        var mapped: [AggregatedSourceItem] = []
        for dto in payload.sources where dto.isUsableLocally {
            let check = dto.check
            let verdict = check.map { AggregatedSourceVerdict(status: $0.status, detail: $0.detail ?? "", bytes: $0.bytes ?? 0, origin: .server) }
            mapped.append(AggregatedSourceItem(
                id: dto.id,
                name: dto.name,
                platform: dto.platformValue,
                protocolType: dto.protocolType,
                baseURL: dto.baseURL ?? "",
                isEnabled: dto.enabled,
                // 清单的 priority 是"越快越优先"的评分，直接沿用；洛雪源给 5 之类的低分，
                // 让本机的 HTTP 线路先试，网关只在 HTTP 全挂时才顶上（省一次跨区往返）。
                priority: dto.priority ?? 0,
                latencyMs: nil,
                cloudSourced: true,
                cloudPlatform: dto.platform,
                quality: dto.quality ?? "320k",
                scriptHash: dto.scriptHash,
                verdict: verdict,
                suggestDelete: dto.suggestDelete ?? false
            ))
        }
        store.applyCloudSources(mapped)
    }

    private func persistCache() {
        guard let manifest else {
            UserDefaults.standard.removeObject(forKey: Self.cacheKey)
            return
        }
        let payload = CachePayload(etag: etag, revision: revision, fetchedAt: fetchedAt ?? Date(), manifest: manifest)
        if let data = try? JSONEncoder().encode(payload) {
            UserDefaults.standard.set(data, forKey: Self.cacheKey)
        }
    }

    /// 把云端下发的首页文案搬到 UserDefaults 那份键上（视图侧靠 @AppStorage 感知变化）。
    /// 没设置就删键，让本地 `home_title` 重新生效 —— 留一个空串会让首页标题变成空白。
    private func publishHomeTitle() {
        if let title = homeTitle {
            UserDefaults.standard.set(title, forKey: HomeTitle.defaultsKey)
        } else {
            UserDefaults.standard.removeObject(forKey: HomeTitle.defaultsKey)
        }
    }

    // MARK: - 本机结论

    public func setLocalVerdict(_ verdict: AggregatedSourceVerdict, for sourceID: String) {
        localVerdicts[sourceID] = verdict
    }

    /// 界面该看的那一份结论：本机实测优先，其次服务端体检下发的那份，最后"未检出"。
    public func verdict(for source: AggregatedSourceItem) -> AggregatedSourceVerdict {
        if let local = localVerdicts[source.id] { return local }
        return source.verdict ?? AggregatedSourceVerdict(status: "unchecked", detail: "还没有体检过这条", origin: .server)
    }

    public func clearLocalVerdicts() {
        localVerdicts = [:]
    }

    // MARK: - 样本 id 池（服务端 `ensureSamples` 的本机对应物）

    /// 每个平台留 12 个真实歌曲 id，由任何一次成功的搜索喂进来。
    ///
    /// 为什么要这份池子：**搜索没结果 ≠ 这条源不能播。** 第三方解析站的 /search 路径经常
    /// 单独挂掉（520 的 Cloudflare 拦截页、`{"error":"unknown type"}`、"需要卡密"），
    /// 而它的 /url 那条路还是好的。判据是"能不能出声"，所以搜索空了就退回池子里的 id 继续验播放；
    /// 只有池子也空着才是真的无从判断 —— 那是观测盲区，报 `no_sample`，绝不停用。
    private static let samplePoolKey = "primuse.aggregated.sample_ids.v1"
    private var samplePool: [String: [String]] = [:]

    private func feedSamples(_ items: [AggregatedSongItem], platformRaw: String) {
        guard !items.isEmpty else { return }
        let existing = samplePool[platformRaw] ?? []
        var merged: [String] = []
        for rawID in (items.map(\.rawID) + existing) where !rawID.isEmpty && !merged.contains(rawID) {
            merged.append(rawID)
            if merged.count >= 12 { break }
        }
        samplePool[platformRaw] = merged
        if let data = try? JSONEncoder().encode(samplePool) {
            UserDefaults.standard.set(data, forKey: Self.samplePoolKey)
        }
    }

    // MARK: - 「检测全部可用」（需求 2）

    /// 体检用的关键词：与服务端 `check.js` 同一个词，两边检同一首歌，
    /// 结论对不上时才有得谈。清单目前没有下发这个字段（`check.keyword`），
    /// 万一以后下发了，这里跟着换成清单的值即可。
    public var probeKeyword: String { "晴天" }

    /// 逐条过一遍已启用的线路：搜索 → 解析直链 → Range 真取 64KB 字节 → 字节层判定。
    ///
    /// 与 Windows 侧同一条边界：**本机的结论只上报显示，不改 isEnabled** ——
    /// 停用与删除建议是 CF 后台的权力（决策③：音源增删改只在 CF 管理，App 侧只读 + 刷新）。
    /// 并发压到 4，第三方站点都可能慢。
    public func checkAllAvailable() async {
        guard !isCheckingAvailability else { return }
        let list = store.sources.filter { $0.isEnabled }
        guard !list.isEmpty else {
            lastError = "没有已启用的线路可检测"
            return
        }
        isCheckingAvailability = true
        defer { isCheckingAvailability = false }

        let keyword = probeKeyword
        await withTaskGroup(of: (String, AggregatedSourceVerdict).self) { group in
            var nextIndex = 0
            let total = list.count
            // 并发压到 4：第三方站点都可能慢，一次开十几条只会集体超时。
            while nextIndex < total, nextIndex < 4 {
                let source = list[nextIndex]
                nextIndex += 1
                group.addTask {
                    let verdict = await self.probeSource(source, keyword: keyword)
                    return (source.id, verdict)
                }
            }
            while let (id, verdict) = await group.next() {
                localVerdicts[id] = verdict
                if nextIndex < total {
                    let source = list[nextIndex]
                    nextIndex += 1
                    group.addTask {
                        let verdict = await self.probeSource(source, keyword: keyword)
                        return (source.id, verdict)
                    }
                }
            }
        }
    }

    /// 单条线路的探测；任何"我们没测成"（够不到、超时、body 半路断）都落成 `error`，
    /// 不落成 `audio_fail` —— 见 `AggregatedSourceVerdict.isBlind`。
    private func probeSource(_ source: AggregatedSourceItem, keyword: String) async -> AggregatedSourceVerdict {
        // 洛雪 js 源本机跑不了脚本，它的结论只能用服务端体检下发的那一份（origin 如实标 server）。
        if source.protocolType == .lxjs {
            return source.verdict ?? AggregatedSourceVerdict(status: "unchecked", detail: "服务端还没体检过这条", origin: .server)
        }

        var tried: [String] = []
        do {
            let items = await AggregatedMusicService.shared.probeSearch(source: source, keyword: keyword)
            var labels: [String: String] = [:]
            for item in items where !item.rawID.isEmpty {
                labels[item.rawID] = item.title + (item.artist.isEmpty ? "" : " / \(item.artist)")
            }
            var ids = items.map(\.rawID).filter { !$0.isEmpty }
            let platformRaw = source.cloudPlatform ?? source.platform.rawValue
            if ids.isEmpty {
                // 搜索没结果 ≠ 不能播：退回样本池里（别的线路喂进来的）真实歌曲 id 继续验播放。
                ids = samplePool[platformRaw] ?? []
                if ids.isEmpty {
                    return AggregatedSourceVerdict(
                        status: "no_sample",
                        detail: "搜索无结果（这条线路的搜索接口可能单独挂了），本机也没有 \(source.platform.displayName) 的可考歌曲 id，暂无法验证",
                        origin: .local
                    )
                }
            } else {
                feedSamples(items, platformRaw: platformRaw)
            }

            for rawID in ids.prefix(3) {
                guard let url = await AggregatedMusicService.shared.probeResolveURL(source: source, rawID: rawID) else {
                    tried.append("解析无直链 \(labels[rawID] ?? rawID)")
                    continue
                }
                // 取字节这一跳**不在 try 之外的 catch 里**：AudioSniff.probe 抛异常（15 秒没回数据、
                // 连接被重置、DNS 挂了）是"我们这次没测成"，让它一路抛到下面的 catch 落成 error。
                let a = try await AudioSniff.probe(url: url)
                if a.playable {
                    return AggregatedSourceVerdict(
                        status: "ok",
                        detail: "\(labels[rawID] ?? rawID) · \(a.detailLabel)\(a.finalHost.isEmpty ? "" : " · \(a.finalHost)")\(labels.isEmpty ? "（搜索接口当前无结果，用样本池的歌曲 id 验的播放）" : "")",
                        bytes: a.bytes,
                        origin: .local
                    )
                }
                tried.append("直链不可播 \(a.status) \(a.contentType.isEmpty ? "无 content-type" : a.contentType) \(a.bytes)B\(a.textish ? " 实为文本" : "")")
            }
            return AggregatedSourceVerdict(
                status: "resolve_fail",
                detail: String(tried.joined(separator: " / ").prefix(300)),
                origin: .local
            )
        } catch {
            return AggregatedSourceVerdict(
                status: "error",
                detail: error.localizedDescription.isEmpty ? "本机探测失败" : error.localizedDescription,
                origin: .local
            )
        }
    }

    // MARK: - 音乐网关

    /// 所有 lxjs 源的搜索/取流/歌词都走这里；deviceId 是网关的必填项（它替本机转发第三方）。
    public func gateway(action: String, payload: [String: Any], timeout: TimeInterval = 20) async throws -> [String: Any] {
        guard let base = gatewayBaseURL else {
            throw NSError.cloudManifest("还没有云端清单，走不了音乐网关")
        }
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
        var items = components?.queryItems ?? []
        items.removeAll { $0.name == "action" || $0.name == "deviceId" }
        items.append(URLQueryItem(name: "action", value: action))
        items.append(URLQueryItem(name: "deviceId", value: DeviceIdentity.currentDeviceID))
        components?.queryItems = items
        guard let url = components?.url else { throw NSError.cloudManifest("网关地址无法解析") }

        var body: [String: Any] = payload
        body["action"] = action
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(AudioSniff.userAgent, forHTTPHeaderField: "User-Agent")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw NSError.cloudManifest("网关响应不是 HTTP") }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NSError.cloudManifest("网关返回的不是 JSON（HTTP \(http.statusCode)）")
        }
        let code = (json["code"] as? Int) ?? -1
        guard code == 0 else {
            let text = (json["error"] as? String) ?? (json["message"] as? String) ?? "网关 HTTP \(http.statusCode)"
            throw NSError.cloudManifest(text)
        }
        return (json["data"] as? [String: Any]) ?? [:]
    }

    /// 洛雪 js 音源的搜索：脚本在服务端跑，回来的是本机认识的曲型字段。
    public func gatewaySearch(keyword: String, source: AggregatedSourceItem? = nil, limit: Int = 20) async throws -> [AggregatedSongItem] {
        var payload: [String: Any] = ["keyword": keyword, "limit": limit]
        if let source { payload["sourceId"] = source.id }
        let data = try await gateway(action: "search", payload: payload, timeout: 25)
        let rows = (data["results"] as? [[String: Any]]) ?? []
        // 用 uniquingKeysWith 而不是 uniqueKeysWithValues：线路表里万一有重复 id（用户手动
        // 复制过一条内置线路），后者覆盖前者会直接 crash 在一次搜索上。
        let nameById = Dictionary(store.sources.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
        return rows.compactMap { row in
            guard let rawID = row["rawID"] as? String, !rawID.isEmpty else { return nil }
            let platform = AggregatedPlatform.from(row["platform"] as? String)
            let sourceID = (row["sourceId"] as? String) ?? source?.id ?? ""
            return AggregatedSongItem(
                id: (row["id"] as? String) ?? "agg_\(platform.rawValue)_\(rawID)",
                rawID: rawID,
                title: (row["title"] as? String) ?? "",
                artist: (row["artist"] as? String) ?? "",
                album: (row["album"] as? String) ?? "",
                duration: Self.interval(row["duration"]),
                coverURLString: (row["coverURL"] as? String)?.nilIfEmpty,
                platform: platform,
                sourceName: (row["sourceName"] as? String)?.nilIfEmpty ?? nameById[sourceID] ?? "云端洛雪音源",
                mediaMid: nil
            )
        }
    }

    /// 洛雪 js 音源取直链。409 表示这条源已被服务端判死/停用 —— 那是结论，不是网络故障。
    public func gatewayResolveURL(source: AggregatedSourceItem, rawID: String) async throws -> URL? {
        let data = try await gateway(action: "url", payload: [
            "sourceId": source.id,
            "rawID": rawID,
            "platform": source.cloudPlatform ?? source.platform.rawValue,
            "quality": source.quality ?? "320k",
        ], timeout: 25)
        guard let string = data["url"] as? String, Self.looksLikeHTTP(string) else { return nil }
        return URL(string: string)
    }

    public func gatewayLyric(source: AggregatedSourceItem, rawID: String) async throws -> String? {
        let data = try await gateway(action: "lyric", payload: [
            "sourceId": source.id,
            "rawID": rawID,
            "platform": source.cloudPlatform ?? source.platform.rawValue,
        ], timeout: 20)
        let text = (data["lyric"] as? String) ?? (data["lrc"] as? String)
        return (text?.contains("[") == true) ? text : nil
    }

    private static func interval(_ raw: Any?) -> TimeInterval {
        if let d = raw as? Double { return d }
        if let i = raw as? Int { return TimeInterval(i) }
        if let s = raw as? String, let d = Double(s) { return d }
        return 0
    }

    // MARK: - 周期刷新

    /// 启动即刷一次，之后每 15 分钟带 ETag 刷一次（没变就是 304，一个字节都不落盘）。
    /// 后台改了名单，客户端最迟一刻钟就跟得上；这也让"实时更新音乐源"不需要推送通道。
    public func startPeriodicRefresh(interval: TimeInterval = 900) {
        guard periodicTask == nil else { return }
        periodicTask = Task { [weak self] in
            _ = await self?.refresh()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(interval))
                if Task.isCancelled { break }
                _ = await self?.refresh()
            }
        }
    }

    public func stopPeriodicRefresh() {
        periodicTask?.cancel()
        periodicTask = nil
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

extension NSError {
    static func cloudManifest(_ text: String) -> NSError {
        NSError(domain: "CloudMusicSources", code: 502, userInfo: [NSLocalizedDescriptionKey: text])
    }
}
