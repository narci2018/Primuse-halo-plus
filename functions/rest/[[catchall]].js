// Subsonic API handler for HALO Music (Cloudflare Pages Functions)
import {
  authenticateSubsonic,
  parseSubsonicParams,
  playlistToSubsonic,
  subsonicError,
  subsonicResponse,
  trackToSubsonicSong,
} from "./_subsonic.js";
import {
  compatibleQQCacheGet,
  normalizeTimedLyric,
  qqAudioCacheKey,
  qqAudioCandidates,
  qqOfficialLyric,
  resolveNeteaseUrl,
  searchNetease,
  searchQQ,
  selectVerifiedAudio,
} from "../api/music.js";

function parseRawId(id) {
  const cleanId = String(id || "").trim();
  const match = cleanId.match(/^(qq|netease|bili)[-_](.+)$/i);
  if (match) {
    return { source: match[1].toLowerCase(), rawId: match[2] };
  }
  if (/^\d{3,20}$/.test(cleanId)) return { source: "netease", rawId: cleanId };
  return { source: "qq", rawId: cleanId };
}

function parseLrcToLines(lrcText) {
  if (!lrcText) return [];
  const lines = [];
  for (const line of lrcText.split("\n")) {
    const match = line.match(/^\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\](.*)$/);
    if (match) {
      const minutes = Number(match[1]) || 0;
      const seconds = Number(match[2]) || 0;
      const millis = Number(String(match[3] || "0").padEnd(3, "0").slice(0, 3)) || 0;
      const start = minutes * 60 * 1000 + seconds * 1000 + millis;
      const value = match[4].trim();
      if (value) lines.push({ start, value });
    }
  }
  return lines;
}

export async function onRequest({ request, env, waitUntil }) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "*",
      },
    });
  }

  const url = new URL(request.url);
  const pathPart = url.pathname.replace(/^\/rest\/?/i, "");
  const action = pathPart.replace(/\.view$/i, "").toLowerCase();

  const params = parseSubsonicParams(request);

  // Debug request logging to D1
  if (env?.DB) {
    try {
      const sanitizedUrl = request.url.replace(/([?&](p|t|s)=)[^&]+/gi, "$1***");
      const headersObj = {};
      for (const [k, v] of request.headers.entries()) {
        if (!["cookie", "authorization"].includes(k.toLowerCase())) {
          headersObj[k] = v;
        }
      }
      const logPromise = env.DB.prepare(
        "INSERT INTO subsonic_request_log (created_at, action, url, headers) VALUES (?, ?, ?, ?)"
      ).bind(Date.now(), action, sanitizedUrl, JSON.stringify(headersObj)).run().catch(() => {});
      if (typeof waitUntil === "function") {
        waitUntil(logPromise);
      }
    } catch {}
  }

  // Authenticate user for all Subsonic endpoints
  const auth = await authenticateSubsonic(params, env);
  if (!auth.ok) return auth.error;

  const username = auth.username;

  try {
    // 1. Connectivity & License
    if (action === "ping") {
      return subsonicResponse({
        type: "Navidrome",
        serverVersion: "0.52.5",
        openSubsonic: true,
      }, params.f);
    }

    if (action === "getscanstatus" || action === "startscan") {
      const lib = await getUserLibrary();
      const allTracks = await getAllLibraryTracks();
      const stableScanTime = new Date(lib.updated_at || 1788697600000).toISOString();
      return subsonicResponse({
        scanStatus: {
          scanning: false,
          count: allTracks.length,
          folderCount: 2,
          lastScan: stableScanTime,
        },
      }, params.f);
    }

    if (action === "getlicense") {
      return subsonicResponse({
        license: {
          valid: true,
          email: `${username}@halomusic.local`,
          key: "HALO-SUBSONIC-LICENSE",
        },
      }, params.f);
    }

    // 2. Folders & Navigation
    if (action === "getmusicfolders") {
      return subsonicResponse({
        musicFolders: {
          musicFolder: [
            { id: 1, name: "我的收藏 (Favorites)" },
            { id: 2, name: "我的歌单 (Playlists)" },
          ],
        },
      }, params.f);
    }

    // Helper: fetch user's library from D1
    async function getUserLibrary() {
      if (!env?.DB) return { favorites: [], playlists: [], updated_at: 0 };
      const row = await env.DB.prepare(
        "SELECT library_json, updated_at FROM music_libraries WHERE username = ?",
      ).bind(username).first();
      if (!row?.library_json) return { favorites: [], playlists: [], updated_at: 0 };
      try {
        const parsed = JSON.parse(row.library_json);
        return {
          favorites: Array.isArray(parsed.favorites) ? parsed.favorites : [],
          playlists: Array.isArray(parsed.playlists) ? parsed.playlists : [],
          updated_at: Number(row.updated_at) || 1788697600000,
        };
      } catch {
        return { favorites: [], playlists: [], updated_at: 0 };
      }
    }

    // Helper: collect all tracks from user's library
    async function getAllLibraryTracks() {
      const lib = await getUserLibrary();
      const map = new Map();
      for (const track of lib.favorites) {
        const sid = track.uid || `${track.source || "qq"}_${track.songid || track.mid}`;
        if (!map.has(sid)) map.set(sid, track);
      }
      for (const pl of lib.playlists) {
        for (const track of pl.tracks || []) {
          const sid = track.uid || `${track.source || "qq"}_${track.songid || track.mid}`;
          if (!map.has(sid)) map.set(sid, track);
        }
      }
      return Array.from(map.values());
    }

    // 3. Playlists (Core Primuse feature)
    if (action === "getplaylists") {
      const lib = await getUserLibrary();
      const list = [];
      if (lib.favorites.length > 0) {
        list.push(playlistToSubsonic({ id: "fav", name: "我喜欢的音乐", tracks: lib.favorites }, username));
      }
      for (const pl of lib.playlists) {
        list.push(playlistToSubsonic(pl, username));
      }
      return subsonicResponse({ playlists: { playlist: list } }, params.f);
    }

    if (action === "getplaylist") {
      const id = String(params.id || "").trim();
      const lib = await getUserLibrary();
      let playlist = null;

      if (id === "fav" || id === "favorites") {
        playlist = { id: "fav", name: "我喜欢的音乐", tracks: lib.favorites };
      } else {
        playlist = lib.playlists.find((p) => p.id === id);
      }

      if (!playlist) {
        return subsonicError(70, "Playlist not found", params.f);
      }

      const entry = (playlist.tracks || []).map((track, idx) =>
        trackToSubsonicSong(track, { parentId: id, trackNumber: idx + 1 }),
      );

      return subsonicResponse({
        playlist: {
          ...playlistToSubsonic(playlist, username),
          entry,
        },
      }, params.f);
    }

    // Helper: resolve track details from library, search cache, or fallback
    async function resolveTrackById(id) {
      if (!id) return null;
      const cleanId = String(id).trim();

      // 1. Check local library
      const allTracks = await getAllLibraryTracks();
      const local = allTracks.find((t) =>
        t.uid === cleanId ||
        `${t.source}_${t.songid || t.mid}` === cleanId ||
        `${t.source}-${t.songid || t.mid}` === cleanId
      );
      if (local) return local;

      // 2. Check search cache in D1
      if (env?.DB) {
        try {
          const row = await env.DB.prepare(
            "SELECT value_json FROM search_cache WHERE key = ?"
          ).bind(`track_meta:${cleanId}`).first();
          if (row?.value_json) {
            const cached = JSON.parse(row.value_json);
            if (cached?.title) return cached;
          }
        } catch {}
      }

      // 3. Reconstruct basic track from ID
      const { source, rawId } = parseRawId(cleanId);
      return {
        uid: cleanId,
        source,
        songid: rawId,
        title: `曲目 ${rawId}`,
        artist: source === "qq" ? "QQ 音乐" : (source === "netease" ? "网易云音乐" : "HALO Music"),
        album: "在线音源",
      };
    }

    // 4. Songs & Details (getSong.view)
    if (action === "getsong") {
      const id = String(params.id || "").trim();
      if (!id) return subsonicError(10, "Required parameter is missing: id", params.f);
      const track = await resolveTrackById(id);
      if (track) {
        return subsonicResponse({ song: trackToSubsonicSong(track) }, params.f);
      }
      return subsonicError(70, "Song not found", params.f);
    }

    // Playlist Management: createPlaylist.view, updatePlaylist.view, deletePlaylist.view
    if (action === "createplaylist") {
      const name = String(params.name || "新建歌单").trim();
      const lib = await getUserLibrary();
      const newPlId = `pl-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
      const newPl = {
        id: newPlId,
        name,
        tracks: [],
      };

      const songIds = Array.isArray(params.songId) ? params.songId : (params.songId ? [params.songId] : []);
      for (const sid of songIds) {
        const track = await resolveTrackById(sid);
        if (track) newPl.tracks.push(track);
      }

      lib.playlists = lib.playlists || [];
      lib.playlists.push(newPl);

      if (env?.DB) {
        await env.DB.prepare(
          "UPDATE music_libraries SET library_json = ?, updated_at = ? WHERE username = ?"
        ).bind(JSON.stringify(lib), Date.now(), username).run().catch(() => {});
      }

      return subsonicResponse({ playlist: playlistToSubsonic(newPl, username) }, params.f);
    }

    if (action === "updateplaylist") {
      const playlistId = String(params.playlistId || "").trim();
      if (!playlistId) return subsonicError(10, "Required parameter is missing: playlistId", params.f);

      const lib = await getUserLibrary();
      lib.playlists = lib.playlists || [];
      const playlist = lib.playlists.find((p) => p.id === playlistId);
      if (!playlist) return subsonicError(70, "Playlist not found", params.f);

      if (params.name) playlist.name = String(params.name).trim();
      if (params.comment !== undefined) playlist.comment = String(params.comment);

      // Handle songIndexToRemove (sorted descending so splicing is stable)
      const toRemove = Array.isArray(params.songIndexToRemove)
        ? params.songIndexToRemove.map(Number)
        : (params.songIndexToRemove !== undefined ? [Number(params.songIndexToRemove)] : []);
      if (toRemove.length) {
        toRemove.sort((a, b) => b - a);
        for (const idx of toRemove) {
          if (idx >= 0 && idx < playlist.tracks.length) {
            playlist.tracks.splice(idx, 1);
          }
        }
      }

      // Handle songIdToAdd
      const toAdd = Array.isArray(params.songIdToAdd)
        ? params.songIdToAdd
        : (params.songIdToAdd ? [params.songIdToAdd] : []);
      for (const sid of toAdd) {
        const track = await resolveTrackById(sid);
        if (track) playlist.tracks.push(track);
      }

      if (env?.DB) {
        await env.DB.prepare(
          "UPDATE music_libraries SET library_json = ?, updated_at = ? WHERE username = ?"
        ).bind(JSON.stringify(lib), Date.now(), username).run().catch(() => {});
      }

      const entry = (playlist.tracks || []).map((track, idx) =>
        trackToSubsonicSong(track, { parentId: playlistId, trackNumber: idx + 1 }),
      );

      return subsonicResponse({
        playlist: {
          ...playlistToSubsonic(playlist, username),
          entry,
        },
      }, params.f);
    }

    if (action === "deleteplaylist") {
      const playlistId = String(params.id || "").trim();
      if (!playlistId) return subsonicError(10, "Required parameter is missing: id", params.f);

      const lib = await getUserLibrary();
      lib.playlists = (lib.playlists || []).filter((p) => p.id !== playlistId);

      if (env?.DB) {
        await env.DB.prepare(
          "UPDATE music_libraries SET library_json = ?, updated_at = ? WHERE username = ?"
        ).bind(JSON.stringify(lib), Date.now(), username).run().catch(() => {});
      }

      return subsonicResponse({}, params.f);
    }

    // 5. Search (search2.view & search3.view)
    if (action === "search2" || action === "search3") {
      const query = (params.query || "").trim();
      const isSearch3 = action === "search3";
      const key = isSearch3 ? "searchResult3" : "searchResult2";

      if (!query) {
        // Return user's library tracks when query is empty
        const allTracks = await getAllLibraryTracks();
        const offset = Math.max(0, Number(params.songOffset) || 0);
        const limit = Math.min(500, Math.max(1, Number(params.songCount || params.count) || 50));
        const songs = allTracks.slice(offset, offset + limit).map((t, idx) =>
          trackToSubsonicSong(t, { parentId: "root", trackNumber: offset + idx + 1 }),
        );
        return subsonicResponse({
          [key]: {
            artist: [],
            album: [],
            song: songs,
          },
        }, params.f);
      }

      const songLimit = Math.min(25, Math.max(1, Number(params.songCount || params.count) || 15));

      // 1. Search local library first
      const allTracks = await getAllLibraryTracks();
      const qLower = query.toLowerCase();
      const localMatches = allTracks.filter((t) =>
        (t.title && t.title.toLowerCase().includes(qLower)) ||
        (t.artist && t.artist.toLowerCase().includes(qLower)) ||
        (t.album && t.album.toLowerCase().includes(qLower))
      );

      // 2. Search online (QQ Music and NetEase in parallel)
      let qqList = [];
      let neteaseList = [];
      try {
        const [qqRes, neteaseRes] = await Promise.allSettled([
          searchQQ(query, songLimit, env, waitUntil),
          searchNetease(query, songLimit, env),
        ]);
        if (qqRes.status === "fulfilled" && qqRes.value?.list) {
          qqList = qqRes.value.list;
        }
        if (neteaseRes.status === "fulfilled" && Array.isArray(neteaseRes.value)) {
          neteaseList = neteaseRes.value;
        }
      } catch (err) {
        console.warn("Online search error", err);
      }

      // Convert local matches
      const localSongs = localMatches.map((t, idx) =>
        trackToSubsonicSong(t, { parentId: "search", trackNumber: idx + 1 }),
      );

      // Convert QQ results
      const qqSongs = qqList.map((item, idx) =>
        trackToSubsonicSong({
          uid: `qq_${item.mid}`,
          source: "qq",
          songid: item.mid,
          title: item.name,
          artist: item.artist,
          album: item.album || "QQ音乐",
          cover: item.cover,
          duration: item.duration,
          quality: item.pay ? "standard" : "lossless",
        }, { trackNumber: localSongs.length + idx + 1 }),
      );

      // Convert NetEase results
      const neteaseSongs = neteaseList.map((item, idx) => {
        const neteaseId = String(item.id || item.songid || item.url?.match(/[?&]id=(\d+)/)?.[1] || idx + 1);
        return trackToSubsonicSong({
          uid: `netease_${neteaseId}`,
          source: "netease",
          songid: neteaseId,
          title: item.name || item.title,
          artist: item.artist || item.singer || item.author || "群星",
          album: item.album || "网易云音乐",
          cover: item.pic || item.cover,
          duration: Number(item.duration) || 210,
          quality: "lossless",
        }, { trackNumber: localSongs.length + qqSongs.length + idx + 1 });
      });

      // Cache online track metadata in D1 for fast playback & playlist adds
      const onlineTracksToCache = [
        ...qqList.map((item) => ({
          uid: `qq_${item.mid}`,
          source: "qq",
          songid: item.mid,
          title: item.name,
          artist: item.artist,
          album: item.album || "QQ音乐",
          cover: item.cover,
          duration: item.duration,
          quality: item.pay ? "standard" : "lossless",
        })),
        ...neteaseList.map((item, idx) => {
          const neteaseId = String(item.id || item.songid || item.url?.match(/[?&]id=(\d+)/)?.[1] || idx + 1);
          return {
            uid: `netease_${neteaseId}`,
            source: "netease",
            songid: neteaseId,
            title: item.name || item.title,
            artist: item.artist || item.singer || item.author || "群星",
            album: item.album || "网易云音乐",
            cover: item.pic || item.cover,
            duration: Number(item.duration) || 210,
            quality: "lossless",
          };
        }),
      ];

      if (env?.DB && onlineTracksToCache.length) {
        const cachePromise = Promise.all(
          onlineTracksToCache.map((t) => {
            const key = `track_meta:${t.uid}`;
            return env.DB.prepare(
              "INSERT OR REPLACE INTO search_cache (key, value_json, expires_at) VALUES (?, ?, ?)"
            ).bind(key, JSON.stringify(t), Date.now() + 86400 * 1000).run().catch(() => {});
          }),
        );
        if (typeof waitUntil === "function") waitUntil(cachePromise);
      }

      // Combine songs
      const songs = [...localSongs, ...qqSongs, ...neteaseSongs].slice(0, Math.max(songLimit * 2, 40));

      // Extract distinct artists & albums for Primuse tabs
      const artistMap = new Map();
      const albumMap = new Map();
      for (const s of songs) {
        if (s.artist && !artistMap.has(s.artist)) {
          artistMap.set(s.artist, {
            id: `ar_${encodeURIComponent(s.artist)}`,
            name: s.artist,
            artist: s.artist,
          });
        }
        if (s.album && !albumMap.has(s.album)) {
          albumMap.set(s.album, {
            id: `al_${encodeURIComponent(s.album)}`,
            name: s.album,
            title: s.album,
            artist: s.artist,
            artistId: `ar_${encodeURIComponent(s.artist || "")}`,
            coverArt: s.coverArt,
          });
        }
      }

      return subsonicResponse({
        [key]: {
          artist: Array.from(artistMap.values()),
          album: Array.from(albumMap.values()),
          song: songs,
        },
      }, params.f);
    }

    // 6. Audio Streaming & Downloading (stream.view & download.view)
    if (action === "stream" || action === "download") {
      let id = String(params.id || "").trim();
      if (!id) return subsonicError(10, "Required parameter is missing: id", params.f);

      // 1. Recursive URL decode for double-encoded IDs (e.g. ar_%25E5...)
      try {
        while (id.includes("%")) {
          const next = decodeURIComponent(id);
          if (next === id) break;
          id = next;
        }
      } catch {}

      // 2. Resolve artist, album, or playlist IDs to the first playable track
      if (id.startsWith("ar_")) {
        const artistName = id.slice(3).trim();
        const allTracks = await getAllLibraryTracks();
        const matched = allTracks.find((t) => (t.artist || "").trim() === artistName) || allTracks[0];
        if (matched) id = matched.uid || `${matched.source || "qq"}_${matched.songid || matched.mid}`;
      } else if (id.startsWith("al_")) {
        const albumName = id.slice(3).trim();
        const allTracks = await getAllLibraryTracks();
        const matched = allTracks.find((t) => (t.album || "").trim() === albumName) || allTracks[0];
        if (matched) id = matched.uid || `${matched.source || "qq"}_${matched.songid || matched.mid}`;
      } else if (id === "fav" || id.startsWith("pl_")) {
        const lib = await getUserLibrary();
        const tracks = id === "fav" ? lib.favorites : (lib.playlists.find((p) => p.id === id)?.tracks || []);
        if (tracks?.[0]) {
          const first = tracks[0];
          id = first.uid || `${first.source || "qq"}_${first.songid || first.mid}`;
        }
      }

      const allTracks = await getAllLibraryTracks();
      const matchedTrack = allTracks.find((t) => {
        const sid = t.uid || `${t.source || "qq"}_${t.songid || t.mid}`;
        return sid === id || sid.replace(/[-_]/g, "") === id.replace(/[-_]/g, "");
      });
      const expectedSize = matchedTrack ? trackToSubsonicSong(matchedTrack).size : null;

      const { source, rawId } = parseRawId(id);

      async function respondWithAudio(audioUrl, src) {
        const secureUrl = audioUrl.replace(/^http:\/\//i, "https://");

        // If client explicitly requests 302 redirect via redirect=1 or proxy=0
        if (params.redirect === "1" || params.proxy === "0") {
          return new Response(null, {
            status: 302,
            headers: {
              Location: secureUrl,
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Headers": "*",
              "Cache-Control": "private, max-age=3600",
            },
          });
        }

        // Default: Native streaming proxy with HTTP Range support for Subsonic players (e.g. Primuse)
        const range = request.headers.get("range");
        const referer = src === "qq" ? "https://y.qq.com/" : "https://music.163.com/";
        const fetchHeaders = {
          referer,
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/134.0.0.0 Safari/537.36",
        };
        if (range) fetchHeaders.range = range;

        try {
          const upstream = await fetch(secureUrl, {
            headers: fetchHeaders,
            method: request.method === "HEAD" ? "HEAD" : "GET",
            cf: {
              cacheEverything: true,
              cacheTtl: 86400,
            },
          });

          if (upstream.ok || upstream.status === 206) {
            const resHeaders = new Headers();
            for (const name of ["content-length", "accept-ranges", "etag", "last-modified"]) {
              const val = upstream.headers.get(name);
              if (val) resHeaders.set(name, val);
            }
            resHeaders.set("accept-ranges", "bytes");
            resHeaders.set("access-control-allow-origin", "*");
            resHeaders.set("access-control-allow-headers", "*");
            resHeaders.set("access-control-expose-headers", "Content-Range, Content-Length, Accept-Ranges");
            resHeaders.set("cache-control", "public, max-age=86400");

            const isM4A = /\.m4a/i.test(audioUrl) || src === "qq";
            resHeaders.set("content-type", isM4A ? "audio/mp4" : "audio/mpeg");

            const upstreamRange = upstream.headers.get("content-range");
            if (upstreamRange) {
              if (expectedSize) {
                // Primuse's CloudPlaybackSource validates: validatedTotalLength(...) == totalLength
                // Rewrite Content-Range total length to match what the catalog reported!
                const rewritten = upstreamRange.replace(/\/(\d+|\*)$/, `/${expectedSize}`);
                resHeaders.set("content-range", rewritten);
              } else {
                resHeaders.set("content-range", upstreamRange);
              }
            } else if (expectedSize && range) {
              const m = range.match(/bytes=(\d+)-(\d+)?/);
              if (m) {
                const s = Number(m[1]) || 0;
                const e = m[2] ? Number(m[2]) : (s + (Number(upstream.headers.get("content-length")) || 1) - 1);
                resHeaders.set("content-range", `bytes ${s}-${e}/${expectedSize}`);
              }
            }

            return new Response(request.method === "HEAD" ? null : upstream.body, {
              status: upstream.status,
              headers: resHeaders,
            });
          }
        } catch (fetchErr) {
          console.warn("Direct stream proxy failed, falling back to 302", fetchErr);
        }

        // Fallback to 302 if upstream direct proxy fails
        return new Response(null, {
          status: 302,
          headers: {
            Location: secureUrl,
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "*",
            "Cache-Control": "private, max-age=3600",
          },
        });
      }

      if (source === "netease") {
        try {
          const audioCacheKey = `netease_audio_${rawId}`;
          const cached = await compatibleQQCacheGet(audioCacheKey, "", env);
          let streamUrl = cached?.verified?.[0]?.url;
          if (!streamUrl) {
            streamUrl = await resolveNeteaseUrl(rawId, env);
            if (streamUrl && env?.DB) {
              const cachedVal = { verified: [{ url: streamUrl }], expiresAt: Date.now() + 3600 * 1000 };
              const p = env.DB.prepare(
                "INSERT OR REPLACE INTO music_cache (key, value_json, expires_at) VALUES (?, ?, ?)"
              ).bind(audioCacheKey, JSON.stringify({ value: cachedVal, expiresAt: cachedVal.expiresAt }), cachedVal.expiresAt).run().catch(() => {});
              if (typeof waitUntil === "function") waitUntil(p);
            }
          }
          if (streamUrl) {
            return await respondWithAudio(streamUrl, "netease");
          }
        } catch (err) {
          console.error("Netease stream resolve error", err);
        }
      }

      // Default to QQ
      const audioCacheKey = qqAudioCacheKey(rawId);
      const cached = await compatibleQQCacheGet(audioCacheKey, "", env);
      const cachedUrl = cached?.verified?.[0]?.url;
      if (cachedUrl) {
        return await respondWithAudio(cachedUrl, "qq");
      }

      try {
        const candidates = await qqAudioCandidates(rawId, "", "", null, { env });
        const first = candidates.find((c) => /^https?:\/\//i.test(c?.url));
        if (first?.url) {
          if (env?.DB) {
            const cachedVal = { verified: [first], expiresAt: Date.now() + 3600 * 1000 };
            const p = env.DB.prepare(
              "INSERT OR REPLACE INTO music_cache (key, value_json, expires_at) VALUES (?, ?, ?)"
            ).bind(audioCacheKey, JSON.stringify({ value: cachedVal, expiresAt: cachedVal.expiresAt }), cachedVal.expiresAt).run().catch(() => {});
            if (typeof waitUntil === "function") waitUntil(p);
          }
          return await respondWithAudio(first.url, "qq");
        }
      } catch (err) {
        console.error("QQ stream resolve error", err);
      }

      return subsonicError(70, "Playable audio stream not found", params.f);
    }

    // 7. Cover Art (getCoverArt.view)
    if (action === "getcoverart") {
      let id = String(params.id || "").trim();
      if (id.startsWith("cov_")) id = id.slice(4);

      const allTracks = await getAllLibraryTracks();
      const matched = allTracks.find((t) => t.uid === id || t.songid === id);
      if (matched?.cover) {
        return new Response(null, {
          status: 302,
          headers: { Location: matched.cover.replace(/^http:\/\//i, "https://"), "Access-Control-Allow-Origin": "*" },
        });
      }

      const { source, rawId } = parseRawId(id);
      if (source === "qq" && rawId) {
        const coverUrl = `https://y.gtimg.cn/music/photo_new/T002R300x300M000${rawId}.jpg`;
        return new Response(null, {
          status: 302,
          headers: { Location: coverUrl, "Access-Control-Allow-Origin": "*" },
        });
      }

      // Fallback SVG image
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300">
        <rect width="300" height="300" fill="#1e1e24"/>
        <circle cx="150" cy="150" r="80" fill="#2a2b36"/>
        <circle cx="150" cy="150" r="30" fill="#00A1D6"/>
      </svg>`;
      return new Response(svg, {
        headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" },
      });
    }

    // 8. Lyrics (getLyrics.view & getLyricsBySongId.view)
    if (action === "getlyrics" || action === "getlyricsbysongid") {
      const id = String(params.id || "").trim();
      const { source, rawId } = parseRawId(id);

      let lrcText = "";
      if (source === "qq" && rawId) {
        try {
          const rawLyric = await qqOfficialLyric(rawId);
          lrcText = normalizeTimedLyric(rawLyric);
        } catch {}
      }

      if (action === "getlyricsbysongid") {
        const lines = parseLrcToLines(lrcText);
        return subsonicResponse({
          lyricsList: {
            structuredLyrics: [
              {
                lang: "zh",
                synced: lines.length > 0,
                line: lines,
              },
            ],
          },
        }, params.f);
      }

      return subsonicResponse({
        lyrics: {
          artist: params.artist || "",
          title: params.title || "",
          value: lrcText,
        },
      }, params.f);
    }

    // 9. Albums, Artists & Directories (Subsonic library exploration)
    if (action === "getalbum") {
      const albumId = String(params.id || "").trim();
      let albumName = albumId.startsWith("al_") ? decodeURIComponent(albumId.slice(3)) : albumId;
      const allTracks = await getAllLibraryTracks();
      let albumTracks = allTracks.filter((t) => (t.album || "精选单曲") === albumName);

      if (!albumTracks.length && allTracks.length) {
        albumTracks = allTracks.filter((t) => t.album && albumId.includes(encodeURIComponent(t.album)));
      }
      if (!albumTracks.length && allTracks.length) {
        albumTracks = allTracks;
        albumName = albumTracks[0]?.album || albumName || "精选专辑";
      }

      const artist = albumTracks[0]?.artist || "未知歌手";
      const duration = Math.round(albumTracks.reduce((acc, t) => acc + (Number(t.duration) || 180), 0));
      const coverArt = albumTracks[0]?.cover ? `cov_${albumTracks[0].uid || albumTracks[0].songid}` : undefined;

      const songs = albumTracks.map((t, idx) =>
        trackToSubsonicSong(t, { parentId: albumId, trackNumber: idx + 1 }),
      );

      return subsonicResponse({
        album: {
          id: albumId,
          name: albumName,
          title: albumName,
          artist,
          artistId: `ar_${encodeURIComponent(artist)}`,
          coverArt,
          songCount: songs.length,
          duration,
          created: new Date().toISOString(),
          year: 2024,
          genre: "Pop",
          song: songs,
        },
      }, params.f);
    }

    if (action === "getindexes") {
      const allTracks = await getAllLibraryTracks();
      const entries = allTracks.slice(0, 100).map((t, idx) =>
        trackToSubsonicSong(t, { parentId: "root", trackNumber: idx + 1 }),
      );
      return subsonicResponse({
        indexes: {
          lastModified: Date.now(),
          ignoredArticles: "The El La Los Las Le Les",
          child: entries,
        },
      }, params.f);
    }

    if (action === "getmusicdirectory") {
      const dirId = String(params.id || "root").trim();
      const allTracks = await getAllLibraryTracks();
      const entries = allTracks.map((t, idx) =>
        trackToSubsonicSong(t, { parentId: dirId, trackNumber: idx + 1 }),
      );
      return subsonicResponse({
        directory: {
          id: dirId,
          name: "HALO 曲库",
          parent: "root",
          child: entries,
        },
      }, params.f);
    }

    if (action === "getartists") {
      const allTracks = await getAllLibraryTracks();
      const artistsMap = new Map();
      for (const t of allTracks) {
        const name = t.artist || "未知歌手";
        if (!artistsMap.has(name)) {
          artistsMap.set(name, {
            id: `ar_${encodeURIComponent(name)}`,
            name,
            albumCount: 1,
          });
        }
      }
      return subsonicResponse({
        artists: {
          ignoredArticles: "The El La Los Las Le Les",
          index: [
            {
              name: "全部歌手",
              artist: Array.from(artistsMap.values()),
            },
          ],
        },
      }, params.f);
    }

    if (action === "getartist") {
      const artistId = String(params.id || "").trim();
      const artistName = artistId.startsWith("ar_") ? decodeURIComponent(artistId.slice(3)) : artistId;
      const allTracks = await getAllLibraryTracks();
      const artistTracks = allTracks.filter((t) => (t.artist || "未知歌手") === artistName);

      const albumMap = new Map();
      for (const t of (artistTracks.length ? artistTracks : allTracks)) {
        const alb = t.album || "精选单曲";
        if (!albumMap.has(alb)) {
          albumMap.set(alb, {
            id: `al_${encodeURIComponent(alb)}`,
            name: alb,
            title: alb,
            artist: t.artist || artistName,
            artistId,
            coverArt: t.cover ? `cov_${t.uid || t.songid}` : undefined,
            songCount: 0,
            duration: 0,
            created: new Date().toISOString(),
            year: 2024,
          });
        }
        const a = albumMap.get(alb);
        a.songCount += 1;
        a.duration += Math.round(Number(t.duration) || 180);
      }

      return subsonicResponse({
        artist: {
          id: artistId,
          name: artistName,
          albumCount: albumMap.size,
          album: Array.from(albumMap.values()),
        },
      }, params.f);
    }

    // 10. Star / Unstar / Scrobble
    if (action === "star" || action === "unstar") {
      const songIds = Array.isArray(params.id) ? params.id : (params.id ? [params.id] : []);
      if (songIds.length && env?.DB) {
        try {
          const lib = await getUserLibrary();
          lib.favorites = lib.favorites || [];

          for (const rawSongId of songIds) {
            const songId = String(rawSongId).trim();
            if (!songId) continue;
            if (action === "star") {
              if (!lib.favorites.some((t) => t.uid === songId || `${t.source}_${t.songid}` === songId)) {
                const track = await resolveTrackById(songId);
                if (track) lib.favorites.unshift(track);
              }
            } else {
              lib.favorites = lib.favorites.filter((t) => t.uid !== songId && `${t.source}_${t.songid}` !== songId);
            }
          }

          await env.DB.prepare(
            "UPDATE music_libraries SET library_json = ?, updated_at = ? WHERE username = ?",
          ).bind(JSON.stringify(lib), Date.now(), username).run();
        } catch (err) {
          console.error("Star/unstar update failed", err);
        }
      }
      return subsonicResponse({}, params.f);
    }

    // 11. Album Lists (Crucial for Primuse initial sync)
    if (action === "getalbumlist" || action === "getalbumlist2") {
      const allTracks = await getAllLibraryTracks();
      const albumMap = new Map();
      for (const t of allTracks) {
        const albumName = t.album || "精选单曲";
        if (!albumMap.has(albumName)) {
          albumMap.set(albumName, {
            id: `al_${encodeURIComponent(albumName)}`,
            name: albumName,
            title: albumName,
            artist: t.artist || "未知歌手",
            artistId: `ar_${encodeURIComponent(t.artist || "未知歌手")}`,
            coverArt: t.cover ? `cov_${t.uid || t.songid}` : undefined,
            songCount: 0,
            duration: 0,
            created: new Date().toISOString(),
            year: 2024,
            genre: "Pop",
          });
        }
        const entry = albumMap.get(albumName);
        entry.songCount += 1;
        entry.duration += Math.round(Number(t.duration) || 180);
      }
      const albums = Array.from(albumMap.values());
      const key = action === "getalbumlist2" ? "albumList2" : "albumList";
      return subsonicResponse({ [key]: { album: albums } }, params.f);
    }

    if (action === "getstarred" || action === "getstarred2") {
      const lib = await getUserLibrary();
      const songs = (lib.favorites || []).map((t, idx) =>
        trackToSubsonicSong(t, { parentId: "fav", trackNumber: idx + 1 }),
      );
      const key = action === "getstarred2" ? "starred2" : "starred";
      return subsonicResponse({
        [key]: {
          song: songs,
          album: [],
          artist: [],
        },
      }, params.f);
    }

    if (action === "getrandomsongs") {
      const allTracks = await getAllLibraryTracks();
      const count = Math.min(50, Math.max(1, Number(params.size) || 10));
      const shuffled = allTracks.slice().sort(() => Math.random() - 0.5).slice(0, count);
      const songs = shuffled.map((t, idx) => trackToSubsonicSong(t, { trackNumber: idx + 1 }));
      return subsonicResponse({ randomSongs: { song: songs } }, params.f);
    }

    if (action === "gettopsongs") {
      const allTracks = await getAllLibraryTracks();
      const songs = allTracks.slice(0, 50).map((t, idx) => trackToSubsonicSong(t, { trackNumber: idx + 1 }));
      return subsonicResponse({ topSongs: { song: songs } }, params.f);
    }

    if (action === "getnowplaying") {
      return subsonicResponse({ nowPlaying: { entry: [] } }, params.f);
    }

    if (action === "getgenres") {
      const allTracks = await getAllLibraryTracks();
      return subsonicResponse({
        genres: {
          genre: [
            { value: "Pop", songCount: allTracks.length, albumCount: 1 },
            { value: "华语", songCount: allTracks.length, albumCount: 1 },
          ],
        },
      }, params.f);
    }

    if (action === "getuser") {
      return subsonicResponse({
        user: {
          username,
          scrobblingEnabled: true,
          adminRole: true,
          settingsRole: true,
          downloadRole: true,
          uploadRole: true,
          playlistRole: true,
          coverArtRole: true,
          commentRole: true,
          podcastRole: true,
          streamRole: true,
          jmsRole: true,
          shareRole: true,
        },
      }, params.f);
    }

    if (action === "getscanstatus" || action === "startscan") {
      const allTracks = await getAllLibraryTracks();
      return subsonicResponse({
        scanStatus: {
          scanning: false,
          count: allTracks.length,
        },
      }, params.f);
    }

    if (action === "getnowplaying") {
      return subsonicResponse({ nowPlaying: { entry: [] } }, params.f);
    }

    if (action === "getartistinfo" || action === "getartistinfo2") {
      const key = action === "getartistinfo2" ? "artistInfo2" : "artistInfo";
      return subsonicResponse({
        [key]: {
          biography: "",
          musicBrainzId: "",
          lastFmUrl: "",
          smallImageUrl: "",
          mediumImageUrl: "",
          largeImageUrl: "",
        },
      }, params.f);
    }

    if (action === "getalbuminfo" || action === "getalbuminfo2") {
      const key = action === "getalbuminfo2" ? "albumInfo" : "albumInfo";
      return subsonicResponse({
        [key]: {
          notes: "",
          musicBrainzId: "",
          lastFmUrl: "",
          smallImageUrl: "",
          mediumImageUrl: "",
          largeImageUrl: "",
        },
      }, params.f);
    }

    // Fallback for any unknown Subsonic endpoint (graceful return)
    return subsonicResponse({}, params.f);
  } catch (error) {
    console.error(`Subsonic endpoint [${action}] error:`, error);
    return subsonicError(0, error?.message || "Subsonic internal error", params.f);
  }
}
