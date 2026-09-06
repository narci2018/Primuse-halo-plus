import Foundation
import Testing
@testable import PrimuseKit

struct HomeListeningRankingTests {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .iso8601)
        calendar.timeZone = TimeZone(identifier: "Asia/Shanghai")!
        return calendar
    }

    private func date(_ day: Int, month: Int = 9, hour: Int = 12) -> Date {
        calendar.date(from: DateComponents(year: 2026, month: month, day: day, hour: hour))!
    }

    private func song(_ id: String, artist: String = "Artist", album: String = "Album", path: String? = nil, source: String = "nas") -> Song {
        Song(id: id, title: id, albumTitle: album, artistName: artist, fileFormat: .mp3,
             filePath: path ?? "/Music/Pop/\(id).mp3", sourceID: source)
    }

    private func event(_ song: String, day: Int, month: Int = 9, seconds: Double = 180) -> HomeListeningEvent {
        HomeListeningEvent(songID: song, playedAt: date(day, month: month), listenedSeconds: seconds)
    }

    @Test func periodsUseCalendarBoundariesAndExcludeFutureEvents() {
        let events = [event("a", day: 30, month: 8), event("a", day: 31, month: 8), event("a", day: 1), event("a", day: 6)]
        let songs = ["a": song("a")]
        let week = HomeListeningRanking.ranks(events: events, songs: songs, folders: nil, period: .week, category: .songs, now: date(5), calendar: calendar)
        let month = HomeListeningRanking.ranks(events: events, songs: songs, folders: nil, period: .month, category: .songs, now: date(5), calendar: calendar)
        #expect(week.first?.playCount == 2)
        #expect(month.first?.playCount == 1)
    }

    @Test func comparisonsUsePreviousPeriodWithoutInventingRankForNewEntries() {
        let events = [event("a", day: 28, month: 8), event("a", day: 29, month: 8), event("b", day: 30, month: 8),
                      event("b", day: 1), event("b", day: 2), event("b", day: 3), event("c", day: 4), event("a", day: 4)]
        let songs = Dictionary(uniqueKeysWithValues: ["a", "b", "c"].map { ($0, song($0)) })
        let ranks = HomeListeningRanking.ranks(events: events, songs: songs, folders: nil, period: .week, category: .songs, now: date(5), calendar: calendar)
        #expect(ranks.first?.title == "b")
        #expect(ranks.first?.positionsGained == 1)
        #expect(ranks.first { $0.title == "c" }?.positionsGained == nil)
        let all = HomeListeningRanking.ranks(events: events, songs: songs, folders: nil, period: .all, category: .songs, now: date(5), calendar: calendar)
        #expect(all.allSatisfy { $0.positionsGained == nil })
    }

    @Test func tiesAreStableRegardlessOfInputOrderAndAlbumKeysDoNotCollide() {
        let songs = ["a": song("a", artist: "b|c", album: "a"), "b": song("b", artist: "c", album: "a|b")]
        let events = [event("b", day: 1), event("a", day: 2)]
        let first = HomeListeningRanking.ranks(events: events, songs: songs, folders: nil, period: .all, category: .albums, now: date(5), calendar: calendar)
        let reversed = HomeListeningRanking.ranks(events: events.reversed(), songs: songs, folders: nil, period: .all, category: .albums, now: date(5), calendar: calendar)
        #expect(first.count == 2)
        #expect(first.map(\.id) == reversed.map(\.id))
    }

    @Test func unavailableSongsRemainInHistoryAndEmptyArtistMetadataIsExcluded() {
        let songs = ["a": song("a", artist: "", album: "")]
        let events = [event("a", day: 1), event("removed", day: 2)]
        let songsRank = HomeListeningRanking.ranks(events: events, songs: songs, folders: nil, period: .week, category: .songs, now: date(5), calendar: calendar)
        let artists = HomeListeningRanking.ranks(events: events, songs: songs, folders: nil, period: .week, category: .artists, now: date(5), calendar: calendar)
        #expect(songsRank.count == 2)
        #expect(artists.isEmpty)
    }

    @Test func historicalMetadataSurvivesLibraryChangesAndUsesLatestRecordedTitle() {
        let events = [
            HomeListeningEvent(songID: "a", playedAt: date(1), listenedSeconds: 90,
                               songTitle: "Old title", artistName: "Original artist", albumTitle: "Original album"),
            HomeListeningEvent(songID: "a", playedAt: date(2), listenedSeconds: 120,
                               songTitle: "Latest title", artistName: "Original artist", albumTitle: "Original album"),
            HomeListeningEvent(songID: "removed", playedAt: date(3), listenedSeconds: 180,
                               songTitle: "Archived song", artistName: "Original artist", albumTitle: "Original album")
        ]
        let currentSongs = ["a": song("a", artist: "Retagged artist", album: "Retagged album")]
        for category in [HomeListeningCategory.artists, .albums] {
            let current = HomeListeningRanking.ranks(events: events, songs: currentSongs, folders: nil,
                                                     period: .week, category: category, now: date(5), calendar: calendar)
            let historyOnly = HomeListeningRanking.ranks(events: events, songs: [:], folders: nil,
                                                         period: .week, category: category, now: date(5), calendar: calendar)
            #expect(current.count == 1)
            #expect(current.first?.playCount == 3)
            #expect(current.first?.listenedSeconds == 390)
            #expect(current.map(\.id) == historyOnly.map(\.id))
        }
        let ranks = HomeListeningRanking.ranks(events: events, songs: currentSongs, folders: nil,
                                               period: .week, category: .songs, now: date(5), calendar: calendar)
        #expect(ranks.first?.title == "Latest title")
        #expect(ranks.first?.playCount == 2)
    }

    @Test func weekBoundariesFollowRegionAndExplicitFirstWeekday() {
        let zone = TimeZone(identifier: "Asia/Shanghai")!
        for (locale, weekday, start) in [("zh_CN", 2, date(31, month: 8, hour: 0)),
                                         ("en_GB", 2, date(31, month: 8, hour: 0)),
                                         ("en_US", 1, date(6, hour: 0)),
                                         ("zh_Hans_US", 1, date(6, hour: 0)),
                                         ("zh_CN@fw=sun", 1, date(6, hour: 0))] {
            let regional = ListeningCalendar.make(locale: Locale(identifier: locale), timeZone: zone)
            #expect(regional.firstWeekday == weekday)
            #expect(HomeListeningPeriod.week.interval(now: date(6), calendar: regional).start == start)
        }
        let preferred = ListeningCalendar.make(locale: Locale(identifier: "zh_CN"), timeZone: zone, firstWeekday: 1)
        #expect(preferred.firstWeekday == 1)
    }

    @Test func directoryCountCanExceedThreeWithoutTruncatingStoredOrder() {
        let sources = (1...6).map {
            LibraryFolderSourceDescriptor(sourceID: "nas\($0)", displayName: "NAS \($0)", scanRoots: ["/Music"], pathSemantics: .hierarchical)
        }
        let index = LibraryFolderIndexBuilder.build(sources: sources, songs: (1...6).map { song("song\($0)", source: "nas\($0)") })
        #expect(HomeFolderPinStorage.resolvedPins("", index: index, defaultCount: 3).count == 3)
        let six = HomeFolderPinStorage.resolvedPins("", index: index, defaultCount: 6)
        #expect(six.count == 6)
        let reordered = Array(six.reversed())
        let saved = HomeFolderPinStorage.encode(reordered)
        #expect(HomeFolderPinStorage.resolvedPins(saved, index: index, defaultCount: 1) == reordered)
        #expect(HomeFolderPinStorage.resolvedPins("[]", index: index, defaultCount: 6).isEmpty)
        #expect(HomeFolderPinStorage.displayCount(0) == 1)
        #expect(HomeFolderPinStorage.displayCount(100) == 30)
    }

    @Test func nestedFoldersCountEachPlayOnceAndKeepSourcesSeparate() throws {
        let songs = [song("a", path: "/Music/Pop/Live/a.mp3"), song("b", path: "/Music/Pop/Live/b.mp3", source: "other")]
        let sources = ["nas", "other"].map {
            LibraryFolderSourceDescriptor(sourceID: $0, displayName: "NAS", scanRoots: ["/Music"], pathSemantics: .hierarchical)
        }
        let index = LibraryFolderIndexBuilder.build(sources: sources, songs: songs)
        let ranks = HomeListeningRanking.ranks(events: [event("a", day: 1), event("b", day: 2)],
                                              songs: Dictionary(uniqueKeysWithValues: songs.map { ($0.id, $0) }), folders: index,
                                              period: .all, category: .folders, now: date(5), calendar: calendar)
        #expect(ranks.count == 2)
        #expect(ranks.reduce(0) { $0 + $1.playCount } == 2)
        #expect(ranks.allSatisfy { $0.title == "Live" })
        #expect(Set(ranks.compactMap(\.folderID).map(\.sourceID)) == Set(["nas", "other"]))
    }

    @Test func folderPinsResolveLiveMembershipAfterRescanAndSourceRestoration() throws {
        let source = LibraryFolderSourceDescriptor(sourceID: "nas", displayName: "NAS", scanRoots: ["/Music"], pathSemantics: .hierarchical)
        let first = LibraryFolderIndexBuilder.build(sources: [source], songs: [song("a")])
        let id = try #require(first.nodeID(containingSongID: "a"))
        let encoded = HomeFolderPinStorage.encode([id, id])
        let pins = HomeFolderPinStorage.decode(encoded)
        #expect(pins == [id])
        let rescanned = LibraryFolderIndexBuilder.build(sources: [source], songs: [song("a"), song("b")])
        #expect(Set(rescanned.songIDs(in: pins[0], scope: .descendants)) == Set(["a", "b"]))
        let disabled = LibraryFolderSourceDescriptor(sourceID: "nas", displayName: "NAS", scanRoots: ["/Music"], pathSemantics: .hierarchical, isEnabled: false)
        #expect(LibraryFolderIndexBuilder.build(sources: [disabled], songs: [song("a")]).node(withID: pins[0]) == nil)
        #expect(HomeFolderPinStorage.decode(encoded) == pins)
        #expect(rescanned.node(withID: pins[0]) != nil)
    }

    @Test func pinsRoundTripSpecialCharactersAndKeepAnExplicitEmptySelection() {
        let ids = [LibraryFolderNodeID(sourceID: "source:1", kind: .folder, normalizedRelativePath: "/音乐/a|b/\"Live\""),
                   LibraryFolderNodeID(sourceID: "source:2", kind: .folder, normalizedRelativePath: "/音乐/a|b/\"Live\"")]
        #expect(HomeFolderPinStorage.decode(HomeFolderPinStorage.encode(ids)) == ids)
        #expect(HomeFolderPinStorage.encode([]) == "[]")
        #expect(HomeFolderPinStorage.decode("invalid").isEmpty)
    }
}
