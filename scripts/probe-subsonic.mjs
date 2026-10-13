// Read-only probe: does the HALO Subsonic surface satisfy what a Primuse-style
// client needs? Run: node scripts/probe-subsonic.mjs [baseUrl]
const BASE = process.argv[2] || "http://127.0.0.1:8799/rest";
const SECRET = process.env.SUB_SECRET || "primuse-probe-secret";
const SALT = process.env.SUB_SALT || "zz9s4t";
const USER = process.env.SUB_USER || "admin";
const crypto = await import("node:crypto");
const TOKEN = crypto.createHash("md5").update(SECRET + SALT).digest("hex");
const AUTH = `u=${USER}&t=${TOKEN}&s=${SALT}&v=1.16.1&c=PrimuseWin&f=json`;

function show(label, resp, bodyPreview) {
  const ct = resp.headers.get("content-type") || "";
  const ar = resp.headers.get("accept-ranges") || "-";
  const cr = resp.headers.get("content-range") || "-";
  const cl = resp.headers.get("content-length") || "-";
  console.log(`${label}: HTTP ${resp.status} ct=${ct.split(";")[0]} acceptRanges=${ar} contentRange=${cr} contentLength=${cl}`);
  if (bodyPreview) console.log(`   ${bodyPreview.replace(/\s+/g, " ").slice(0, 220)}`);
}

// 1. search3 with a real query
const search = await fetch(`${BASE}/search3.view?${AUTH}&query=${encodeURIComponent("周杰伦")}&count=5`);
const searchData = await search.json();
const songs = (searchData["subsonic-response"].searchResult3 || {}).song || [];
console.log(`search3(周杰伦): HTTP ${search.status} songs=${songs.length}`);
for (const s of songs.slice(0, 5)) {
  console.log(`   id=${s.id} | ${s.title} | ${s.artist} | album=${s.album} | ${s.duration}s | ${s.contentType} | coverArt=${s.coverArt} | bitRate=${s.bitRate}`);
}
const sid = songs.length ? songs[0].id : "netease-4878606";

// 2. album/artist containers the client expects for browsing
for (const action of ["getAlbum.view", "getArtist.view", "getIndexes.view", "getMusicFolders.view", "getStarred.view"]) {
  const r = await fetch(`${BASE}/${action}?${AUTH}&id=${encodeURIComponent(sid)}`);
  const t = await r.text();
  console.log(`${action}: HTTP ${r.status} ${t.slice(0, 120).replace(/\s+/g, " ")}`);
}

// 3. lyrics, both classic and OpenSubsonic
const lyr = await fetch(`${BASE}/getLyrics.view?${AUTH}&artist=${encodeURIComponent("陈淑桦")}&title=${encodeURIComponent("笑红尘")}`);
show("getLyrics", lyr, await lyr.text());
const lyr2 = await fetch(`${BASE}/getLyricsBySongId.view?${AUTH}&id=${encodeURIComponent(sid)}`);
show("getLyricsBySongId", lyr2, await lyr2.text());

// 4. stream, full and with Range (progressive playback / seeking depend on this)
const full = await fetch(`${BASE}/stream.view?${AUTH}&id=${encodeURIComponent(sid)}&maxBitRate=320&format=mp3`);
const fullBuf = await full.arrayBuffer();
show("stream(full)", full, `bytes=${fullBuf.byteLength} first16=${Buffer.from(fullBuf.slice(0, 16)).toString("hex")}`);

const ranged = await fetch(`${BASE}/stream.view?${AUTH}&id=${encodeURIComponent(sid)}`, {
  headers: { Range: "bytes=1000000-1000999" },
});
const rangedBuf = await ranged.arrayBuffer();
show("stream(Range 1MB..1MB+999)", ranged, `bytes=${rangedBuf.byteLength}`);

// 5. cover art
const art = await fetch(`${BASE}/getCoverArt.view?${AUTH}&id=${encodeURIComponent(sid)}`);
const artBuf = await art.arrayBuffer();
show("getCoverArt", art, `bytes=${artBuf.byteLength} magic=${Buffer.from(artBuf.slice(0, 4)).toString("hex")}`);
