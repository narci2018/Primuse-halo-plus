import SwiftUI
import PrimuseKit

struct HomeListeningRankingSection: View {
    @Environment(HomeDiscoveryModel.self) private var model
    @Environment(MusicLibrary.self) private var library
    @Environment(AudioPlayerService.self) private var player
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var period: HomeListeningPeriod = .week
    @State private var category: HomeListeningCategory = .songs
    @State private var ranks: [HomeListeningRank] = []
    @State private var isLoading = true
    @State private var preparedRequest: Request?

    private struct Request: Equatable {
        let revision: Int
        let period: HomeListeningPeriod
        let category: HomeListeningCategory
        let calendar: Calendar
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ViewThatFits(in: .horizontal) {
                HStack {
                    heading
                    Spacer(minLength: 12)
                    periodPicker.frame(width: 190)
                }
                VStack(alignment: .leading, spacing: 10) { heading; periodPicker }
            }

            VStack(spacing: 14) {
                categoryPicker
                if isLoading {
                    ProgressView().frame(maxWidth: .infinity, minHeight: 170)
                } else if let first = ranks.first {
                    if dynamicTypeSize.isAccessibilitySize {
                        VStack(spacing: 10) { highlights(first) }
                    } else {
                        HStack(alignment: .top, spacing: 10) { highlights(first) }
                    }
                    VStack(spacing: 0) {
                        ForEach(Array(ranks.prefix(4).enumerated()), id: \.element.id) { position, rank in
                            rankRow(rank, position: position)
                            if position < min(ranks.count, 4) - 1 { Divider() }
                        }
                    }
                } else {
                    VStack(spacing: 8) {
                        Image(systemName: "chart.bar.xaxis").font(.title2).foregroundStyle(.secondary)
                        Text(HomeDiscoveryText.string("empty_ranking")).font(.headline)
                        Text(HomeDiscoveryText.string("ranking_hint"))
                            .font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity, minHeight: 150)
                }
            }
            .padding(16)
            .background(cardSurface, in: RoundedRectangle(cornerRadius: 22))

            Text(HomeDiscoveryText.string(category == .folders ? "folder_ranking_scope" : "ranking_scope"))
                .font(.caption2).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 20)
        .task(id: Request(revision: model.revision, period: period, category: category, calendar: ListeningCalendar.current)) {
            await refresh()
        }
    }

    private var heading: some View {
        Text(HomeDiscoveryText.string("ranking"))
            .font(.title2.bold()).fixedSize(horizontal: true, vertical: false)
            .accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier("home.listeningRanking")
    }

    private var periodPicker: some View {
        Picker("stats_range", selection: $period) {
            ForEach(HomeListeningPeriod.allCases, id: \.self) { period in
                Text(LocalizedStringKey("stats_range_" + period.rawValue)).tag(period)
            }
        }
        .pickerStyle(.segmented)
        .accessibilityIdentifier("home.rankingPeriod")
    }

    private var categoryPicker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(HomeListeningCategory.allCases, id: \.self) { item in
                    Button { category = item } label: {
                        Text(categoryTitle(item))
                            .font(.subheadline.weight(category == item ? .semibold : .regular))
                            .padding(.horizontal, 14).frame(minHeight: 40)
                            .foregroundStyle(category == item ? Color.accentColor : Color.secondary)
                            .background(category == item ? Color.accentColor.opacity(0.12) : .clear, in: Capsule())
                            .overlay(Capsule().strokeBorder(category == item ? Color.accentColor.opacity(0.4) : Color.secondary.opacity(0.25)))
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(category == item ? .isSelected : [])
                    .accessibilityIdentifier("home.rankingCategory." + item.rawValue)
                }
            }
        }
    }

    private func categoryTitle(_ category: HomeListeningCategory) -> String {
        category == .folders ? HomeDiscoveryText.string("folders")
            : NSLocalizedString("stats_rank_" + category.rawValue, comment: "")
    }

    @ViewBuilder
    private func highlights(_ champion: HomeListeningRank) -> some View {
        highlight(champion, title: "champion", icon: "trophy.fill", accent: .accentColor,
                  detail: String(format: HomeDiscoveryText.string("play_count"), champion.playCount))
        if let rising = ranks.filter({ ($0.positionsGained ?? 0) > 0 }).max(by: {
            ($0.positionsGained ?? 0) < ($1.positionsGained ?? 0)
        }) {
            highlight(rising, title: "rising", icon: "chart.line.uptrend.xyaxis", accent: .indigo,
                      detail: String(format: HomeDiscoveryText.string("positions_gained"), rising.positionsGained ?? 0))
        } else if let longest = ranks.max(by: { $0.listenedSeconds < $1.listenedSeconds }) {
            highlight(longest, title: "longest", icon: "headphones", accent: .indigo,
                      detail: Duration.seconds(longest.listenedSeconds).formatted(.units(allowed: [.hours, .minutes], width: .abbreviated)))
        }
    }

    private func highlight(_ rank: HomeListeningRank, title: String, icon: String, accent: Color, detail: String) -> some View {
        Button { play(rank) } label: {
            VStack(alignment: .leading, spacing: 8) {
                Label(HomeDiscoveryText.string(title), systemImage: icon)
                    .font(.caption.weight(.semibold)).foregroundStyle(accent).lineLimit(2)
                Text(rankTitle(rank)).font(.headline).foregroundStyle(.primary).lineLimit(1)
                Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            .frame(maxWidth: .infinity, minHeight: 86, alignment: .leading)
            .padding(12)
            .background(.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 16))
            .contentShape(RoundedRectangle(cornerRadius: 16))
        }
        .buttonStyle(.plain)
        .accessibilityHint("play")
        .disabled(!canPlay(rank))
    }

    private func rankRow(_ rank: HomeListeningRank, position: Int) -> some View {
        Group {
            if let folderID = rank.folderID {
                NavigationLink { HomeFolderBrowser(nodeID: folderID) } label: { rankLabel(rank, position: position) }
            } else if category == .songs {
                Button {
                    HomeDiscoveryPlayback.play(
                        ids: ranks.flatMap(\.songIDs), startingAt: rank.songIDs.first,
                        library: library, player: player
                    )
                } label: { rankLabel(rank, position: position) }
                .disabled(!canPlay(rank))
            } else {
                NavigationLink {
                    HomeRankedSongsView(title: rank.title, songIDs: rank.songIDs)
                } label: { rankLabel(rank, position: position) }
                .disabled(!canPlay(rank))
            }
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button("play", systemImage: "play.fill") { play(rank) }
                .disabled(!canPlay(rank))
        }
    }

    private func rankLabel(_ rank: HomeListeningRank, position: Int) -> some View {
        HStack(spacing: 10) {
            Text("\(position + 1)").font(.headline.monospacedDigit())
                .foregroundStyle(position == 0 ? Color.accentColor : Color.secondary)
                .frame(width: 18)
            if let song = rank.songIDs.first.flatMap({ model.songsByID[$0] }) {
                CachedArtworkView(
                    coverRef: song.coverArtFileName, songID: song.id, size: 40, cornerRadius: 7,
                    sourceID: song.sourceID, filePath: song.filePath, fileFormat: song.fileFormat
                )
                .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 8) {
                    Text(rankTitle(rank)).font(.subheadline.weight(.medium)).lineLimit(1)
                    Spacer(minLength: 0)
                    Text(rank.playCount.formatted()).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
                GeometryReader { geometry in
                    Capsule().fill(.primary.opacity(0.09))
                    Capsule().fill(Color.accentColor.opacity(position == 0 ? 1 : 0.55))
                        .frame(width: geometry.size.width * CGFloat(rank.playCount) / CGFloat(max(1, ranks.first?.playCount ?? 1)))
                }
                .frame(height: 3)
                .accessibilityHidden(true)
            }
        }
        .foregroundStyle(.primary)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(position + 1), \(rankTitle(rank)), \(String(format: HomeDiscoveryText.string("play_count"), rank.playCount))")
    }

    private func rankTitle(_ rank: HomeListeningRank) -> String {
        if let id = rank.folderID, let node = model.index?.node(withID: id) {
            return HomeDiscoveryText.folderTitle(node)
        }
        return rank.title
    }

    private func play(_ rank: HomeListeningRank) {
        let ids = rank.folderID.map { model.songs(in: $0).map(\.id) } ?? rank.songIDs
        HomeDiscoveryPlayback.play(ids: ids, library: library, player: player)
    }

    private func canPlay(_ rank: HomeListeningRank) -> Bool {
        !rank.songIDs.compactMap { library.unobservedVisibleSong(id: $0) }.filteredPlayable().isEmpty
    }

    private var cardSurface: Color {
        #if os(iOS)
        Color(uiColor: .secondarySystemBackground)
        #else
        Color(nsColor: .controlBackgroundColor)
        #endif
    }

    private func refresh() async {
        let request = Request(revision: model.revision, period: period, category: category, calendar: ListeningCalendar.current)
        // Lazy-stack reappearance must not collapse a loaded card to its
        // spinner height and repeatedly move it across the visible boundary.
        guard preparedRequest != request else { return }
        isLoading = ranks.isEmpty
        let events = PlayHistoryStore.shared.entries.map(\.listeningEvent)
        let songs = model.songsByID
        let folders = model.index
        let period = period
        let category = category
        let task = Task.detached(priority: .utility) {
            HomeListeningRanking.ranks(events: events, songs: songs, folders: folders, period: period, category: category, calendar: request.calendar)
        }
        let result = await withTaskCancellationHandler { await task.value } onCancel: { task.cancel() }
        guard !Task.isCancelled else { return }
        ranks = result
        isLoading = false
        preparedRequest = request
    }
}

private struct HomeRankedSongsView: View {
    let title: String
    let songIDs: [String]
    @Environment(MusicLibrary.self) private var library
    @Environment(AudioPlayerService.self) private var player
    #if os(iOS)
    @Environment(\.appNavigationMode) private var appNavigationMode
    #endif

    private var legacyBottomClearance: CGFloat {
        #if os(iOS)
        appNavigationMode == .minimal ? 0 : 90
        #else
        90
        #endif
    }

    var body: some View {
        List {
            ForEach(songIDs, id: \.self) { id in
                if let song = library.unobservedVisibleSong(id: id) {
                    SongRowView(song: song, isPlaying: player.currentSong?.id == id)
                        .contentShape(Rectangle())
                        .onTapGesture {
                            HomeDiscoveryPlayback.play(ids: songIDs, startingAt: id, library: library, player: player)
                        }
                }
            }
        }
        .navigationTitle(title)
        #if os(iOS)
        .minimalNavigationDetail()
        #endif
        .safeAreaInset(edge: .bottom, spacing: legacyBottomClearance == 0 ? 0 : nil) {
            Color.clear.frame(height: legacyBottomClearance)
        }
    }
}
