import test from "node:test";
import assert from "node:assert/strict";
import {
  authenticateSubsonic,
  decodeSubsonicPassword,
  md5,
  parseSubsonicParams,
  playlistToSubsonic,
  subsonicError,
  subsonicResponse,
  trackToSubsonicSong,
} from "../functions/rest/_subsonic.js";
import { createPasswordSalt, hashPassword } from "../functions/api/_auth.js";

test("pure-JS md5 produces correct RFC 1321 hashes", () => {
  assert.equal(md5(""), "d41d8cd98f00b204e9800998ecf8427e");
  assert.equal(md5("admin"), "21232f297a57a5a743894a0e4a801fc3");
  assert.equal(md5("password123"), "482c811da5d5b4bc6d497ffa98491e38");
  // Standard Subsonic token test vector: password + salt
  assert.equal(md5("sesame" + "c162b"), "cfb2927d6ef5f277b8231f4041c33337");
});

test("decodeSubsonicPassword decodes plain and hex enc: passwords", () => {
  assert.equal(decodeSubsonicPassword("mySecret"), "mySecret");
  // "sesame" in hex is 736573616d65
  assert.equal(decodeSubsonicPassword("enc:736573616d65"), "sesame");
});

test("parseSubsonicParams extracts query and default values", () => {
  const req = new Request("https://example.com/rest/ping.view?u=admin&p=secret&c=Primuse");
  const params = parseSubsonicParams(req);
  assert.equal(params.u, "admin");
  assert.equal(params.p, "secret");
  assert.equal(params.c, "Primuse");
  assert.equal(params.f, "json");
  assert.equal(params.v, "1.16.1");
});

test("subsonicResponse wraps data in standard Subsonic envelope", async () => {
  const res = subsonicResponse({ customData: "hello" });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data["subsonic-response"].status, "ok");
  assert.equal(data["subsonic-response"].version, "1.16.1");
  assert.equal(data["subsonic-response"].type, "halo-music");
  assert.equal(data["subsonic-response"].customData, "hello");
});

test("subsonicError returns standard Subsonic error envelope", async () => {
  const res = subsonicError(40, "Wrong username or password");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data["subsonic-response"].status, "failed");
  assert.equal(data["subsonic-response"].error.code, 40);
  assert.equal(data["subsonic-response"].error.message, "Wrong username or password");
});

test("trackToSubsonicSong correctly maps HALO track fields", () => {
  const haloTrack = {
    uid: "qq_0039MnYb0qxYAc",
    source: "qq",
    songid: "0039MnYb0qxYAc",
    title: "晴天",
    artist: "周杰伦",
    album: "叶惠美",
    cover: "https://y.gtimg.cn/music/photo_new/T002R300x300M000000MkCQg0ZdPp5.jpg",
    duration: 269,
    quality: "lossless",
  };

  const song = trackToSubsonicSong(haloTrack, { parentId: "pl_1", trackNumber: 3 });
  assert.equal(song.id, "qq_0039MnYb0qxYAc");
  assert.equal(song.title, "晴天");
  assert.equal(song.artist, "周杰伦");
  assert.equal(song.album, "叶惠美");
  assert.equal(song.duration, 269);
  assert.equal(song.track, 3);
  assert.equal(song.parent, "pl_1");
  assert.equal(song.isDir, false);
  assert.equal(song.type, "music");
  assert.match(song.coverArt, /^cov_/);
});

test("playlistToSubsonic correctly aggregates track duration and counts", () => {
  const playlist = {
    id: "pl_favorites",
    name: "我的精选",
    tracks: [
      { uid: "t1", title: "Song 1", duration: 180 },
      { uid: "t2", title: "Song 2", duration: 240 },
    ],
  };

  const subPl = playlistToSubsonic(playlist, "admin");
  assert.equal(subPl.id, "pl_favorites");
  assert.equal(subPl.name, "我的精选");
  assert.equal(subPl.owner, "admin");
  assert.equal(subPl.songCount, 2);
  assert.equal(subPl.duration, 420);
});

test("authenticateSubsonic authenticates both plaintext password and token+salt", async () => {
  const salt = createPasswordSalt();
  const passwordHash = await hashPassword("superSecret", salt);

  const mockDb = {
    prepare(query) {
      return {
        bind(...args) {
          return {
            async first() {
              if (query.includes('FROM "user"')) {
                const [username] = args;
                if (username === "alice") {
                  return { username: "alice", password_hash: passwordHash, password_salt: salt };
                }
                return null;
              }
              if (query.includes("FROM subsonic_auth")) {
                const [username] = args;
                if (username === "alice") {
                  return { subsonic_secret: "superSecret" };
                }
                return null;
              }
              return null;
            },
            async run() {
              return { success: true };
            },
          };
        },
      };
    },
  };

  const env = { DB: mockDb };

  // 1. Plaintext password test
  const authPlain = await authenticateSubsonic({ u: "alice", p: "superSecret" }, env);
  assert.equal(authPlain.ok, true);
  assert.equal(authPlain.username, "alice");

  // 2. Wrong password test
  const authWrong = await authenticateSubsonic({ u: "alice", p: "wrongPassword" }, env);
  assert.equal(authWrong.ok, false);

  // 3. Subsonic Token + Salt test
  const clientSalt = "randomSalt123";
  const token = md5("superSecret" + clientSalt);
  const authToken = await authenticateSubsonic({ u: "alice", t: token, s: clientSalt }, env);
  assert.equal(authToken.ok, true);
  assert.equal(authToken.username, "alice");

  // 4. Bad Token test
  const authBadToken = await authenticateSubsonic({ u: "alice", t: "invalidToken", s: clientSalt }, env);
  assert.equal(authBadToken.ok, false);
});

test("onRequest handles ping and getPlaylists for Subsonic client", async () => {
  const { onRequest } = await import("../functions/rest/[[catchall]].js");

  const mockLibrary = JSON.stringify({
    favorites: [{ uid: "qq_fav1", title: "Favorite Song", artist: "Artist A", duration: 200 }],
    playlists: [
      { id: "pl_rock", name: "摇滚精选", tracks: [{ uid: "qq_rock1", title: "Rock Song", artist: "Band B", duration: 180 }] },
    ],
  });

  const mockDb = {
    prepare(query) {
      return {
        bind(...args) {
          return {
            async first() {
              if (query.includes('FROM "user"')) {
                return { username: "bob", password_hash: "dummy", password_salt: "00" };
              }
              if (query.includes("FROM subsonic_auth")) {
                return { subsonic_secret: "bobSecret" };
              }
              if (query.includes("FROM music_libraries")) {
                return { library_json: mockLibrary };
              }
              return null;
            },
            async run() {
              return { success: true };
            },
          };
        },
      };
    },
  };

  const env = { DB: mockDb };

  // 1. ping.view test
  const pingReq = new Request("https://example.com/rest/ping.view?u=bob&p=bobSecret&f=json&c=Primuse");
  const pingRes = await onRequest({ request: pingReq, env });
  assert.equal(pingRes.status, 200);
  const pingData = await pingRes.json();
  assert.equal(pingData["subsonic-response"].status, "ok");
  assert.equal(pingData["subsonic-response"].type, "Navidrome");
  assert.equal(pingData["subsonic-response"].openSubsonic, true);

  // 1b. getScanStatus.view test (Primuse revision checking)
  const scanReq = new Request("https://example.com/rest/getScanStatus.view?u=bob&p=bobSecret&f=json");
  const scanRes = await onRequest({ request: scanReq, env });
  assert.equal(scanRes.status, 200);
  const scanData = await scanRes.json();
  assert.equal(scanData["subsonic-response"].status, "ok");
  assert.equal(scanData["subsonic-response"].scanStatus.scanning, false);
  assert.equal(scanData["subsonic-response"].scanStatus.count, 2);

  // 2. getPlaylists.view test
  const plReq = new Request("https://example.com/rest/getPlaylists.view?u=bob&p=bobSecret&f=json");
  const plRes = await onRequest({ request: plReq, env });
  assert.equal(plRes.status, 200);
  const plData = await plRes.json();
  const playlists = plData["subsonic-response"].playlists.playlist;
  assert.equal(playlists.length, 2); // 1 favorites virtual playlist + 1 custom playlist
  assert.equal(playlists[0].name, "我喜欢的音乐");
  assert.equal(playlists[1].name, "摇滚精选");

  // 3. getPlaylist.view test
  const plDetailReq = new Request("https://example.com/rest/getPlaylist.view?u=bob&p=bobSecret&id=pl_rock&f=json");
  const plDetailRes = await onRequest({ request: plDetailReq, env });
  const plDetailData = await plDetailRes.json();
  const playlistDetail = plDetailData["subsonic-response"].playlist;
  assert.equal(playlistDetail.name, "摇滚精选");
  assert.equal(playlistDetail.entry.length, 1);
  assert.equal(playlistDetail.entry[0].title, "Rock Song");

  // 4. getAlbumList2.view test (Primuse initial sync)
  const albumReq = new Request("https://example.com/rest/getAlbumList2.view?u=bob&p=bobSecret&type=newest&f=json");
  const albumRes = await onRequest({ request: albumReq, env });
  assert.equal(albumRes.status, 200);
  const albumData = await albumRes.json();
  assert.ok(albumData["subsonic-response"].albumList2);
  assert.ok(Array.isArray(albumData["subsonic-response"].albumList2.album));

  // 5. search3.view with empty query (Primuse full sync request)
  const searchEmptyReq = new Request("https://example.com/rest/search3.view?u=bob&p=bobSecret&query=&artistCount=0&albumCount=0&songCount=500&songOffset=0&f=json");
  const searchEmptyRes = await onRequest({ request: searchEmptyReq, env });
  assert.equal(searchEmptyRes.status, 200);
  const searchEmptyData = await searchEmptyRes.json();
  assert.ok(searchEmptyData["subsonic-response"].searchResult3);
  assert.equal(searchEmptyData["subsonic-response"].searchResult3.song.length, 2);

  // 6. createPlaylist.view test
  const createPlReq = new Request("https://example.com/rest/createPlaylist.view?u=bob&p=bobSecret&name=%E6%96%B0%E6%AD%8C%E5%8D%95&songId=qq_fav1&f=json");
  const createPlRes = await onRequest({ request: createPlReq, env });
  assert.equal(createPlRes.status, 200);
  const createPlData = await createPlRes.json();
  assert.ok(createPlData["subsonic-response"].playlist);
  assert.equal(createPlData["subsonic-response"].playlist.name, "新歌单");

  // 7. updatePlaylist.view test (add song)
  const updatePlReq = new Request("https://example.com/rest/updatePlaylist.view?u=bob&p=bobSecret&playlistId=pl_rock&songIdToAdd=qq_fav1&f=json");
  const updatePlRes = await onRequest({ request: updatePlReq, env });
  assert.equal(updatePlRes.status, 200);
  const updatePlData = await updatePlRes.json();
  assert.ok(updatePlData["subsonic-response"].playlist);
  assert.equal(updatePlData["subsonic-response"].playlist.entry.length, 2);

  // 8. star.view and unstar.view test
  const starReq = new Request("https://example.com/rest/star.view?u=bob&p=bobSecret&id=qq_new_star&f=json");
  const starRes = await onRequest({ request: starReq, env });
  assert.equal(starRes.status, 200);
  const unstarReq = new Request("https://example.com/rest/unstar.view?u=bob&p=bobSecret&id=qq_new_star&f=json");
  const unstarRes = await onRequest({ request: unstarReq, env });
  assert.equal(unstarRes.status, 200);

  // 9. deletePlaylist.view test
  const delPlReq = new Request("https://example.com/rest/deletePlaylist.view?u=bob&p=bobSecret&id=pl_rock&f=json");
  const delPlRes = await onRequest({ request: delPlReq, env });
  assert.equal(delPlRes.status, 200);
});


