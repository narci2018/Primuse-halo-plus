import SwiftUI
import PrimuseKit

enum HomeDiscoveryText {
    static func string(_ key: String) -> String {
        NSLocalizedString(key, tableName: "HomeDiscovery", bundle: .main, comment: "")
    }

    static func folderTitle(_ node: LibraryFolderNode) -> String {
        if let name = node.displayName, !name.isEmpty { return name }
        let key: String
        switch node.kind {
        case .source: key = "source_label"
        case .scanRoot, .folder: key = "library_folder_scan_root"
        case .librarySongs: key = "library_folder_apple_music_library_songs"
        case .playlist: key = "library_folder_apple_music_unnamed_playlist"
        case .notInPlaylist: key = "library_folder_apple_music_not_in_playlist"
        case .uncategorized: key = "library_folder_uncategorized"
        case .other: key = "library_folder_other"
        }
        return NSLocalizedString(key, comment: "")
    }
}

@MainActor
@Observable
final class HomeDiscoveryModel {
    private(set) var index: LibraryFolderIndex?
    private(set) var revision = 0
    @ObservationIgnored private(set) var songsByID: [String: Song] = [:]
    @ObservationIgnored private(set) var folderCoverSongIDs: [LibraryFolderNodeID: [String]] = [:]
    @ObservationIgnored private(set) var lastPlayedByFolder: [LibraryFolderNodeID: Date] = [:]

    func publish(index: LibraryFolderIndex, songs: [String: Song], covers: [LibraryFolderNodeID: [String]]) {
        self.songsByID = songs
        self.folderCoverSongIDs = covers
        self.index = index
        refreshHistory()
    }

    func refreshHistory() {
        var dates: [LibraryFolderNodeID: Date] = [:]
        for entry in PlayHistoryStore.shared.entries {
            var nodeID = index?.nodeID(containingSongID: entry.songID)
            while let id = nodeID {
                dates[id] = max(dates[id] ?? .distantPast, entry.playedAt)
                nodeID = index?.node(withID: id)?.parentID
            }
        }
        lastPlayedByFolder = dates
        revision &+= 1
    }

    func updateMetadata(song: Song) {
        songsByID[song.id] = song
        if song.coverArtFileName != nil {
            var nodeID = index?.nodeID(containingSongID: song.id)
            while let id = nodeID {
                if (folderCoverSongIDs[id]?.count ?? 0) < 4,
                   !(folderCoverSongIDs[id]?.contains(song.id) ?? false) {
                    folderCoverSongIDs[id, default: []].append(song.id)
                }
                nodeID = index?.node(withID: id)?.parentID
            }
        }
        revision &+= 1
    }

    func pins(from rawValue: String) -> [LibraryFolderNodeID] {
        let count = UserDefaults.standard.object(forKey: HomeFolderPinStorage.displayCountKey) as? Int
            ?? HomeFolderPinStorage.defaultDisplayCount
        return HomeFolderPinStorage.resolvedPins(rawValue, index: index, defaultCount: count)
    }

    func songs(in id: LibraryFolderNodeID, scope: LibraryFolderSongScope = .descendants) -> [Song] {
        (index?.songIDs(in: id, scope: scope) ?? []).compactMap { songsByID[$0] }
            .sorted {
                if $0.discNumber != $1.discNumber { return ($0.discNumber ?? 0) < ($1.discNumber ?? 0) }
                if $0.trackNumber != $1.trackNumber { return ($0.trackNumber ?? 0) < ($1.trackNumber ?? 0) }
                return $0.title.localizedStandardCompare($1.title) == .orderedAscending
            }
    }
}

/// Observe scan revisions outside HomeView so background metadata updates do
/// not invalidate the entire dashboard. A cancelled build never publishes.
struct HomeDiscoveryObserver: View {
    let model: HomeDiscoveryModel
    @Environment(MusicLibrary.self) private var library
    @Environment(SourcesStore.self) private var sourcesStore
    @Environment(ScanService.self) private var scanService
    @Environment(\.scenePhase) private var scenePhase
    @State private var nameRevision = 0
    @State private var pendingMetadataIDs: Set<String> = []

    private struct Request: Equatable {
        let collection: Int
        let playlists: Int
        let hierarchy: Int
        let names: Int
        let sources: [LibraryFolderSourceDescriptor]
    }

    private struct ProviderInput: Sendable {
        let items: [String: SourceSyncIndexedItem]
        let rootNames: [String: String]
        let indexedRoots: Bool
    }

    private var request: Request {
        Request(
            collection: library.visibleSongCollectionRevision,
            playlists: library.playlistCollectionRevision,
            hierarchy: scanService.folderHierarchyRevision,
            names: nameRevision,
            sources: sourcesStore.allSources.map(LibraryFolderSourceDescriptor.init(source:))
        )
    }

    var body: some View {
        Color.clear.frame(width: 0, height: 0)
            .task(id: request) { await rebuild() }
            .onChange(of: library.songReplacementToken) { _, _ in
                let sources = Dictionary(sourcesStore.allSources.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
                var structureChanged = false
                for id in library.lastReplacedSongIDs {
                    pendingMetadataIDs.insert(id)
                    guard let song = library.unobservedVisibleSong(id: id) else { continue }
                    if let source = sources[song.sourceID],
                       !source.type.isCloudDrive, !source.type.isServerLibrary,
                       source.type != .upnp, song.sourceID != AppleMusicLibraryIdentity.sourceID,
                       LibraryFolderSourceDescriptor(source: source).placementNodeID(for: song)
                        != model.index?.nodeID(containingSongID: id) {
                        structureChanged = true
                    }
                    model.updateMetadata(song: song)
                }
                if structureChanged { nameRevision &+= 1 }
            }
            .onReceive(NotificationCenter.default.publisher(for: .primuseListeningStatsDidChange)) { _ in
                model.refreshHistory()
            }
            .onReceive(NotificationCenter.default.publisher(for: NSLocale.currentLocaleDidChangeNotification)) { _ in
                model.refreshHistory()
            }
            .onReceive(NotificationCenter.default.publisher(for: .NSSystemTimeZoneDidChange)) { _ in
                model.refreshHistory()
            }
            .onReceive(NotificationCenter.default.publisher(for: .NSCalendarDayChanged)) { _ in
                model.refreshHistory()
            }
            .onReceive(NotificationCenter.default.publisher(for: CloudDirectoryNameStore.didChangeNotification)) { _ in
                nameRevision &+= 1
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { model.refreshHistory() }
            }
    }

    private func rebuild() async {
        if model.index != nil {
            do { try await Task.sleep(for: .seconds(3)) } catch { return }
        }
        guard !Task.isCancelled else { return }
        pendingMetadataIDs.removeAll()
        let songs = library.visibleSongs
        let collections = library.appleMusicFolderCollections(availableSongs: songs)
        var descriptors = request.sources
        var known = Set(descriptors.map(\.sourceID))
        for song in songs where known.insert(song.sourceID).inserted {
            descriptors.append(LibraryFolderSourceDescriptor(
                sourceID: song.sourceID,
                displayName: song.sourceID == AppleMusicLibraryIdentity.sourceID
                    ? String(localized: "apple_music_library_section") : String(localized: "source_label"),
                scanRoots: [], pathSemantics: .opaque
            ))
        }
        var providers: [String: ProviderInput] = [:]
        for source in sourcesStore.allSources {
            guard source.type.isCloudDrive || source.type.isServerLibrary || source.type == .upnp else { continue }
            providers[source.id] = ProviderInput(
                items: scanService.libraryFolderSyncIndex(for: source.id),
                rootNames: source.type.isCloudDrive ? CloudDirectoryNameStore.displayNames(for: source.id) : [:],
                indexedRoots: source.type.isServerLibrary || source.type == .upnp
            )
        }
        let task = Task.detached(priority: .utility) { [descriptors, providers] in
            let resolved = descriptors.map { descriptor in
                guard let provider = providers[descriptor.sourceID], !provider.items.isEmpty else { return descriptor }
                let indexedRoots = provider.items.values.filter { $0.isDirectory && $0.parentPath == nil }
                    .sorted { $0.path < $1.path }
                let rootPaths = provider.indexedRoots && !indexedRoots.isEmpty
                    ? indexedRoots.map(\.path) : descriptor.scanRoots
                let roots = rootPaths.map { path in
                    let indexedName = indexedRoots.first { $0.path == path }?.displayName
                    let pathName = descriptor.pathSemantics == .hierarchical && path != "/"
                        ? (path as NSString).lastPathComponent : nil
                    return LibraryFolderProviderRootDescriptor(
                        path: path, displayName: indexedName ?? provider.rootNames[path] ?? pathName
                    )
                }
                return descriptor.withProviderHierarchy(LibraryFolderProviderHierarchy(
                    roots: roots,
                    items: provider.items.values.map {
                        LibraryFolderProviderItemDescriptor(
                            path: $0.path, displayName: $0.displayName,
                            parentPath: $0.parentPath, isDirectory: $0.isDirectory
                        )
                    }
                ))
            }
            let index = LibraryFolderIndexBuilder.build(sources: resolved, songs: songs, virtualCollections: collections)
            let songsByID = Dictionary(songs.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            var covers: [LibraryFolderNodeID: [String]] = [:]
            for song in songs where song.coverArtFileName != nil {
                if Task.isCancelled { break }
                var id = index.nodeID(containingSongID: song.id)
                while let current = id {
                    if (covers[current]?.count ?? 0) < 4 { covers[current, default: []].append(song.id) }
                    id = index.node(withID: current)?.parentID
                }
            }
            return (index, songsByID, covers)
        }
        let result = await withTaskCancellationHandler {
            await task.value
        } onCancel: {
            task.cancel()
        }
        guard !Task.isCancelled else { return }
        model.publish(index: result.0, songs: result.1, covers: result.2)
        for id in pendingMetadataIDs {
            if let song = library.unobservedVisibleSong(id: id) { model.updateMetadata(song: song) }
        }
        pendingMetadataIDs.removeAll()
    }
}
