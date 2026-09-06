import Foundation

public enum ListeningCalendar {
    public static var current: Calendar {
        let system = Calendar.autoupdatingCurrent
        let locale = Locale.autoupdatingCurrent
        let regional = Locale(identifier: locale.identifier).calendar
        let preferred = system.firstWeekday != regional.firstWeekday ? system.firstWeekday : nil
        return make(locale: locale, timeZone: system.timeZone, identifier: system.identifier, firstWeekday: preferred)
    }

    public static func make(
        locale: Locale, timeZone: TimeZone, identifier: Calendar.Identifier = .gregorian,
        firstWeekday: Int? = nil
    ) -> Calendar {
        var calendar = Calendar(identifier: identifier)
        calendar.locale = locale
        calendar.timeZone = timeZone
        if let firstWeekday {
            calendar.firstWeekday = firstWeekday
        } else if locale.region?.identifier == "CN",
                  Locale.Components(identifier: locale.identifier).firstDayOfWeek == nil {
            // CLDR uses Monday for mainland China; some Foundation releases
            // still carry the older Sunday default. Keep explicit overrides.
            calendar.firstWeekday = 2
        }
        return calendar
    }

    public static func interval(component: Calendar.Component?, now: Date, calendar: Calendar) -> DateInterval {
        let start = component.flatMap { calendar.dateInterval(of: $0, for: now)?.start } ?? .distantPast
        return DateInterval(start: start, end: now)
    }
}

public enum HomeListeningPeriod: String, CaseIterable, Sendable {
    case week, month, all

    public func interval(now: Date, calendar: Calendar) -> DateInterval {
        let component: Calendar.Component? = self == .all ? nil : (self == .week ? .weekOfYear : .month)
        return ListeningCalendar.interval(component: component, now: now, calendar: calendar)
    }

    public func previousInterval(now: Date, calendar: Calendar) -> DateInterval? {
        guard self != .all else { return nil }
        let component: Calendar.Component = self == .week ? .weekOfYear : .month
        guard let current = calendar.dateInterval(of: component, for: now),
              let previous = calendar.date(byAdding: component, value: -1, to: current.start)
        else { return nil }
        return DateInterval(start: previous, end: current.start)
    }
}

public enum HomeListeningCategory: String, CaseIterable, Sendable {
    case songs, artists, albums, folders
}

public struct HomeListeningEvent: Sendable {
    public let songID: String
    public let playedAt: Date
    public let listenedSeconds: TimeInterval
    public let songTitle: String?
    public let artistName: String?
    public let albumTitle: String?

    public init(
        songID: String, playedAt: Date, listenedSeconds: TimeInterval,
        songTitle: String? = nil, artistName: String? = nil, albumTitle: String? = nil
    ) {
        self.songID = songID
        self.playedAt = playedAt
        self.listenedSeconds = listenedSeconds
        self.songTitle = songTitle
        self.artistName = artistName
        self.albumTitle = albumTitle
    }
}

public struct HomeListeningRank: Identifiable, Sendable {
    public let id: String
    public let title: String
    public let subtitle: String
    public let songIDs: [String]
    public let folderID: LibraryFolderNodeID?
    public let playCount: Int
    public let listenedSeconds: TimeInterval
    public var positionsGained: Int?
}

public enum HomeListeningRanking {
    private struct GroupKey: Hashable {
        let category: HomeListeningCategory
        let components: [String]

        var id: String {
            let data = (try? JSONEncoder().encode([category.rawValue] + components)) ?? Data()
            return String(decoding: data, as: UTF8.self)
        }
    }

    private struct Accumulator {
        var title: String
        var subtitle: String
        var folderID: LibraryFolderNodeID?
        var songIDs = Set<String>()
        var count = 0
        var seconds: TimeInterval = 0
        var latestDate = Date.distantPast
    }

    /// Listening history remains valid after library changes. Only directory
    /// membership depends on the current library index.
    public static func ranks(
        events: [HomeListeningEvent],
        songs: [String: Song],
        folders: LibraryFolderIndex?,
        period: HomeListeningPeriod,
        category: HomeListeningCategory,
        now: Date = Date(),
        calendar: Calendar = ListeningCalendar.current
    ) -> [HomeListeningRank] {
        let current = aggregate(
            events: events, songs: songs, folders: folders, category: category,
            interval: period.interval(now: now, calendar: calendar), includesEnd: true
        )
        guard let interval = period.previousInterval(now: now, calendar: calendar) else {
            return current
        }
        let previous = aggregate(
            events: events, songs: songs, folders: folders, category: category,
            interval: interval, includesEnd: false
        )
        let positions = Dictionary(uniqueKeysWithValues: previous.enumerated().map { ($1.id, $0) })
        return current.enumerated().map { position, value in
            var value = value
            if let oldPosition = positions[value.id] {
                value.positionsGained = oldPosition - position
            }
            return value
        }
    }

    private static func aggregate(
        events: [HomeListeningEvent], songs: [String: Song], folders: LibraryFolderIndex?,
        category: HomeListeningCategory, interval: DateInterval, includesEnd: Bool
    ) -> [HomeListeningRank] {
        var groups: [GroupKey: Accumulator] = [:]
        for event in events {
            guard event.playedAt >= interval.start,
                  includesEnd ? event.playedAt <= interval.end : event.playedAt < interval.end else { continue }
            let song = songs[event.songID]
            let artist = event.artistName ?? song?.artistName ?? ""
            let album = event.albumTitle ?? song?.albumTitle ?? ""
            let components: [String]
            let title: String
            let subtitle: String
            var folderID: LibraryFolderNodeID?
            switch category {
            case .songs:
                components = [event.songID]
                title = event.songTitle ?? song?.title ?? event.songID
                subtitle = artist
            case .artists:
                guard !artist.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
                components = [artist]
                title = artist
                subtitle = ""
            case .albums:
                guard !album.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
                components = [album, artist]
                title = album
                subtitle = artist
            case .folders:
                // One play belongs to its containing directory, not every
                // ancestor. This keeps nested-folder totals comparable.
                guard let folders, let id = folders.nodeID(containingSongID: event.songID),
                      let node = folders.node(withID: id),
                      node.kind == .folder || node.kind == .scanRoot else { continue }
                components = [id.sourceID, id.kind.rawValue, id.normalizedRelativePath]
                title = node.displayName ?? ""
                subtitle = folders.sourceNode(for: id.sourceID)?.displayName ?? ""
                folderID = id
            }
            let key = GroupKey(category: category, components: components)
            var group = groups[key] ?? Accumulator(title: title, subtitle: subtitle, folderID: folderID)
            if event.playedAt > group.latestDate {
                group.title = title
                group.subtitle = subtitle
                group.latestDate = event.playedAt
            }
            group.songIDs.insert(event.songID)
            group.count += 1
            if event.listenedSeconds.isFinite { group.seconds += max(0, event.listenedSeconds) }
            groups[key] = group
        }
        return groups.map { key, value in
            HomeListeningRank(
                id: key.id, title: value.title, subtitle: value.subtitle,
                songIDs: value.songIDs.sorted(), folderID: value.folderID,
                playCount: value.count, listenedSeconds: value.seconds, positionsGained: nil
            )
        }.sorted {
            if $0.playCount != $1.playCount { return $0.playCount > $1.playCount }
            if $0.listenedSeconds != $1.listenedSeconds { return $0.listenedSeconds > $1.listenedSeconds }
            return $0.id < $1.id
        }
    }
}

public enum HomeFolderPinStorage {
    public static let key = "primuse.home.folders.v1"
    public static let displayCountKey = "primuse.home.folderDisplayCount"
    public static let defaultDisplayCount = 3
    public static let displayCountRange = 1...30

    public static func displayCount(_ value: Int) -> Int {
        min(displayCountRange.upperBound, max(displayCountRange.lowerBound, value))
    }

    public static func resolvedPins(
        _ value: String, index: LibraryFolderIndex?, defaultCount: Int
    ) -> [LibraryFolderNodeID] {
        guard value.isEmpty else { return decode(value) }
        guard let index else { return [] }
        var result: [LibraryFolderNodeID] = []
        for source in index.sourceNodes {
            for node in index.children(of: source.id) {
                guard node.kind == .scanRoot || node.kind == .folder,
                      node.descendantSongCount > 0 else { continue }
                result.append(node.id)
                if result.count == displayCount(defaultCount) { return result }
            }
        }
        return result
    }

    private struct Record: Codable {
        let sourceID: String
        let kind: String
        let path: String
    }

    public static func decode(_ value: String) -> [LibraryFolderNodeID] {
        guard let data = value.data(using: .utf8),
              let records = try? JSONDecoder().decode([Record].self, from: data) else { return [] }
        var seen = Set<LibraryFolderNodeID>()
        return records.compactMap { record in
            guard let kind = LibraryFolderNodeKind(rawValue: record.kind) else { return nil }
            let id = LibraryFolderNodeID(sourceID: record.sourceID, kind: kind, normalizedRelativePath: record.path)
            return seen.insert(id).inserted ? id : nil
        }
    }

    public static func encode(_ ids: [LibraryFolderNodeID]) -> String {
        let records = ids.map { Record(sourceID: $0.sourceID, kind: $0.kind.rawValue, path: $0.normalizedRelativePath) }
        guard let data = try? JSONEncoder().encode(records) else { return "[]" }
        return String(decoding: data, as: UTF8.self)
    }
}
