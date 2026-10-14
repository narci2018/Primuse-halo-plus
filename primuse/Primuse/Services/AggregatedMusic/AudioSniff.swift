import Foundation

/// 字节层的"能不能出声"判定 —— 三端（CF 服务端 `functions/lib/protocols.js`、
/// Windows `src/main/cloud-sources.js`、本机）必须共用同一条口径，否则同一线路在
/// 两边得出相反结论时根本没法谈。需求 2 的原话：能访问不等于能播放。
///
/// 这里刻意**不看 HTTP 状态码**：报错页、反爬页、登录跳转全都回 200，
/// 旧版「测速」就是被这一点骗的（HEAD 回 200 就算线路健康）。判据只有字节。
public enum AudioSniff {
    /// 一次判定最多取这么多字节。音频站给 10MB 是常态，体检要过几十条线路，
    /// 取够判定需要的量就断开，别把流量花在下载整首歌上。
    public static let probeBytes = 65536
    /// 少于这个字节数的"音频"不当数：几十个字节的 HTML 壳也能命中 `<html` 之外的分支。
    public static let audioMinBytes = 8192

    /// 与服务端 `UA` 同一串：有的站按 UA 放不同的编码（给错 UA 直接回 m3u8 或反爬页），
    /// 两边用同一串，结论才对得上。
    public static let userAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"

    /// 音频魔数：ID3 / OggS / fLaC / MPEG-ADTS 帧同步 / RIFF…WAVE / ISO-BMFF(mp4,m4a)。
    ///
    /// `ftyp` 在**偏移 4**（mp4 前 4 字节是 box 长度，可能是 0x18/0x20/0x1C，不能当定长前缀比）；
    /// 这一条写错过一次，后果是 m4a 直链永远认不出 —— QQ 音乐/网易云的高音质恰好全是 m4a。
    /// 但魔数认不出不能直接判死：音频站给错 content-type 是常事，所以真正的判据是
    /// 「命中魔数 **或** 服务器确实声称这是音频」。
    public static func hasAudioMagic(_ bytes: [UInt8]) -> Bool {
        guard bytes.count >= 12 else { return false }
        func ascii(_ at: Int, _ text: String) -> Bool {
            guard at + text.utf8.count <= bytes.count else { return false }
            for (i, ch) in text.utf8.enumerated() {
                if bytes[at + i] != ch { return false }
            }
            return true
        }
        return ascii(0, "ID3")
            || ascii(0, "OggS")
            || ascii(0, "fLaC")
            || (bytes[0] == 0xFF && (bytes[1] & 0xE0) == 0xE0)
            || (ascii(0, "RIFF") && ascii(8, "WAVE"))
            || ascii(4, "ftyp")
    }

    /// 反爬页、报错 JSON、XML 报错、登录跳转 —— 全都长这样（服务端同一条正则）。
    public static func looksLikeText(_ bytes: [UInt8]) -> Bool {
        guard !bytes.isEmpty else { return false }
        let head = Array(bytes.prefix(64))
        // 与服务端 `TextDecoder(..., {fatal:false})` 对齐：二进制里非法的 UTF-8 序列替换掉再看开头。
        let asText = String(decoding: head, as: UTF8.self)
        return asText.range(of: #"^\s*(<\?xml|<!DOCTYPE|<html|<HTML|\{|\[)"#, options: [.regularExpression]) != nil
    }

    /// 服务端认的那几种"声称是音频"的 content-type。
    public static func isAudioContentType(_ contentType: String?) -> Bool {
        contentType?.range(of: #"(?i)^(audio|application\/octet-stream|video\/mp2a)"#, options: [.regularExpression]) != nil
    }

    /// 一条直链到底能不能出声 —— 字节够长 + 不像文本 + （命中魔数 或 content-type 是音频）。
    public static func isPlayable(bytes: Int, magic: Bool, textish: Bool, contentType: String?) -> Bool {
        bytes > audioMinBytes && !textish && (magic || isAudioContentType(contentType))
    }

    public struct ProbeResult: Sendable, Hashable {
        public var status: Int
        public var contentType: String
        public var bytes: Int
        public var magic: Bool
        public var textish: Bool
        /// 最终结论；调用处别再各写一遍判据。
        public var playable: Bool
        public var finalHost: String

        /// 界面/日志里那句说明，三端格式对齐。
        public var detailLabel: String {
            "\(status) \(contentType.split(separator: ";").first.map(String.init) ?? contentType) \(bytes)B\(magic ? " 命中音频魔数" : " 按 content-type 判定")"
        }
    }

    /// 每个 host 各开一条连接就够，避免同时体检时对同一个站点倾泻请求。
    ///
    /// `nonisolated(unsafe)`：`URLSession` 不是 Sendable，Swift 6 不让我把一个不可发的类型
    /// 放进枚举的全局 `static let`（`@MainActor` 又能把 `probe` 拽回主线程，检测就不并发了）。
    /// 这里的安全由用法保证：只在这条只读路径上取/发起请求，配置建好之后不再改。
    @nonisolated(unsafe) private static let probeSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 15
        config.timeoutIntervalForResource = 30
        config.waitsForConnectivity = false
        config.httpShouldSetCookies = false
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.httpAdditionalHeaders = ["User-Agent": userAgent, "Accept": "*/*"]
        return URLSession(configuration: config)
    }()

    /// 真去取前 64KB 字节并判定。
    ///
    /// **传输层失败一律 throw**（超时、连接被重置、DNS 挂了、TLS 失败）。
    /// 服务端用的是 `fetch` + `AbortSignal`，这几种情况本来就会抛；客户端早先把它咽成
    /// "0 字节、不可播"，等于把"我们这次没测成"上报成"这条源死了"，两边口径就分叉了。
    /// 现在统一成：抛出去 → 调用方落 `error`（`AggregatedSourceVerdict.isBlind`，有宽限、不停用）。
    public static func probe(url: URL, timeout: TimeInterval = 15) async throws -> ProbeResult {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = timeout
        request.setValue("bytes=0-\(probeBytes - 1)", forHTTPHeaderField: "Range")
        request.cachePolicy = .reloadIgnoringLocalCacheData

        let (response, byteStream) = try await probeSession.bytes(for: request)
        var buffer: [UInt8] = []
        buffer.reserveCapacity(probeBytes)
        // 不套 try-catch：读body 半路断（`网络链接已中断`）同样属于"我们没测成"。
        for try await byte in byteStream {
            buffer.append(byte)
            if buffer.count >= probeBytes { break }
        }

        let contentType = response.value(forHTTPHeaderField: "Content-Type") ?? ""
        let magic = hasAudioMagic(buffer)
        let textish = looksLikeText(buffer)
        return ProbeResult(
            status: response.statusCode,
            contentType: contentType,
            bytes: buffer.count,
            magic: magic,
            textish: textish,
            playable: isPlayable(bytes: buffer.count, magic: magic, textish: textish, contentType: contentType),
            finalHost: (response.url ?? url).host ?? ""
        )
    }
}
