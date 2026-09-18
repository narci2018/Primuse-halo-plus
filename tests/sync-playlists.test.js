import test from "node:test";
import assert from "node:assert/strict";
import { onRequest } from "../functions/api/sync-playlists.js";

function mockEnv() {
  const store = new Map();
  return {
    DB: {
      prepare(query) {
        let boundArgs = [];
        return {
          bind(...args) {
            boundArgs = args;
            return this;
          },
          async run() {
            if (query.includes("INSERT INTO device_playlists")) {
              const [deviceId, deviceName, platform, playlistsJson, playlistCount, songCount, createdAt, updatedAt] = boundArgs;
              store.set(deviceId, {
                device_id: deviceId,
                device_name: deviceName,
                platform,
                playlists_json: playlistsJson,
                playlist_count: playlistCount,
                song_count: songCount,
                created_at: createdAt,
                updated_at: updatedAt,
              });
            }
            return { success: true };
          },
          async first() {
            if (query.includes("WHERE device_id = ?")) {
              return store.get(boundArgs[0]) || null;
            }
            return null;
          },
          async all() {
            return { results: Array.from(store.values()) };
          },
        };
      },
    },
  };
}

test("sync-playlists OPTIONS handles CORS preflight", async () => {
  const req = new Request("https://example.com/api/sync-playlists", { method: "OPTIONS" });
  const res = await onRequest({ request: req, env: mockEnv() });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
});

test("sync-playlists POST requires deviceId and playlists array", async () => {
  const env = mockEnv();
  // Missing deviceId
  const req1 = new Request("https://example.com/api/sync-playlists", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playlists: [] }),
  });
  const res1 = await onRequest({ request: req1, env });
  assert.equal(res1.status, 400);

  // Missing playlists
  const req2 = new Request("https://example.com/api/sync-playlists", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: "DEV123" }),
  });
  const res2 = await onRequest({ request: req2, env });
  assert.equal(res2.status, 400);
});

test("sync-playlists POST saves playlist data and GET retrieves it", async () => {
  const env = mockEnv();
  const samplePlaylists = [
    {
      id: "pl_1",
      name: "我的歌单1",
      songs: [
        { id: "s1", title: "晴天", artist: "周杰伦" },
        { id: "s2", title: "七里香", artist: "周杰伦" },
      ],
    },
    {
      id: "pl_2",
      name: "华语经典",
      songs: [
        { id: "s3", title: "海阔天空", artist: "Beyond" },
      ],
    },
  ];

  // 1. Upload playlists
  const postReq = new Request("https://example.com/api/sync-playlists", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      deviceId: "MOCK-DEVICE-UUID-12345",
      deviceName: "MacBook Pro",
      platform: "macOS",
      playlists: samplePlaylists,
    }),
  });
  const postRes = await onRequest({ request: postReq, env });
  assert.equal(postRes.status, 200);
  const postData = await postRes.json();
  assert.equal(postData.code, 0);
  assert.equal(postData.data.playlistCount, 2);
  assert.equal(postData.data.songCount, 3);
  assert.equal(postData.data.deviceId, "MOCK-DEVICE-UUID-12345");

  // 2. Query playlists by deviceId
  const getReq = new Request("https://example.com/api/sync-playlists?deviceId=MOCK-DEVICE-UUID-12345");
  const getRes = await onRequest({ request: getReq, env });
  assert.equal(getRes.status, 200);
  const getData = await getRes.json();
  assert.equal(getData.code, 0);
  assert.equal(getData.data.playlistCount, 2);
  assert.equal(getData.data.songCount, 3);
  assert.equal(getData.data.playlists.length, 2);
  assert.equal(getData.data.playlists[0].name, "我的歌单1");
});
