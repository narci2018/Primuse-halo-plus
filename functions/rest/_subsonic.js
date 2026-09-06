// Subsonic protocol helpers, authentication, and response formatting for HALO Music
import { hashPassword } from "../api/_auth.js";

// Pure JavaScript RFC 1321 MD5 implementation (UTF-8 safe, zero external dependencies)
export function md5(string) {
  function safeAdd(x, y) {
    const lsw = (x & 0xffff) + (y & 0xffff);
    const msw = (x >> 16) + (y >> 16) + (lsw >> 16);
    return (msw << 16) | (lsw & 0xffff);
  }

  function bitRotateLeft(num, cnt) {
    return (num << cnt) | (num >>> (32 - cnt));
  }

  function md5cmn(q, a, b, x, s, t) {
    return safeAdd(bitRotateLeft(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b);
  }

  function md5ff(a, b, c, d, x, s, t) {
    return md5cmn((b & c) | (~b & d), a, b, x, s, t);
  }

  function md5gg(a, b, c, d, x, s, t) {
    return md5cmn((b & d) | (c & ~d), a, b, x, s, t);
  }

  function md5hh(a, b, c, d, x, s, t) {
    return md5cmn(b ^ c ^ d, a, b, x, s, t);
  }

  function md5ii(a, b, c, d, x, s, t) {
    return md5cmn(c ^ (b | ~d), a, b, x, s, t);
  }

  function binlMD5(x, len) {
    x[len >> 5] |= 0x80 << (len % 32);
    x[(((len + 64) >>> 9) << 4) + 14] = len;

    let a = 1732584193;
    let b = -271733879;
    let c = -1732584194;
    let d = 271733878;

    for (let i = 0; i < x.length; i += 16) {
      const olda = a;
      const oldb = b;
      const oldc = c;
      const oldd = d;

      a = md5ff(a, b, c, d, x[i], 7, -680876936);
      d = md5ff(d, a, b, c, x[i + 1], 12, -389564586);
      c = md5ff(c, d, a, b, x[i + 2], 17, 606105819);
      b = md5ff(b, c, d, a, x[i + 3], 22, -1044525330);
      a = md5ff(a, b, c, d, x[i + 4], 7, -176418897);
      d = md5ff(d, a, b, c, x[i + 5], 12, 1200080426);
      c = md5ff(c, d, a, b, x[i + 6], 17, -1473231341);
      b = md5ff(b, c, d, a, x[i + 7], 22, -45705983);
      a = md5ff(a, b, c, d, x[i + 8], 7, 1770035416);
      d = md5ff(d, a, b, c, x[i + 9], 12, -1958414417);
      c = md5ff(c, d, a, b, x[i + 10], 17, -42063);
      b = md5ff(b, c, d, a, x[i + 11], 22, -1990404162);
      a = md5ff(a, b, c, d, x[i + 12], 7, 1804603682);
      d = md5ff(d, a, b, c, x[i + 13], 12, -40341101);
      c = md5ff(c, d, a, b, x[i + 14], 17, -1502002290);
      b = md5ff(b, c, d, a, x[i + 15], 22, 1236535329);

      a = md5gg(a, b, c, d, x[i + 1], 5, -165796510);
      d = md5gg(d, a, b, c, x[i + 6], 9, -1069501632);
      c = md5gg(c, d, a, b, x[i + 11], 14, 643717713);
      b = md5gg(b, c, d, a, x[i], 20, -373897302);
      a = md5gg(a, b, c, d, x[i + 5], 5, -701558691);
      d = md5gg(d, a, b, c, x[i + 10], 9, 38016083);
      c = md5gg(c, d, a, b, x[i + 15], 14, -660478335);
      b = md5gg(b, c, d, a, x[i + 4], 20, -405537848);
      a = md5gg(a, b, c, d, x[i + 9], 5, 568446438);
      d = md5gg(d, a, b, c, x[i + 14], 9, -1019803690);
      c = md5gg(c, d, a, b, x[i + 3], 14, -187363961);
      b = md5gg(b, c, d, a, x[i + 8], 20, 1163531501);
      a = md5gg(a, b, c, d, x[i + 13], 5, -1444681467);
      d = md5gg(d, a, b, c, x[i + 2], 9, -51403784);
      c = md5gg(c, d, a, b, x[i + 7], 14, 1735328473);
      b = md5gg(b, c, d, a, x[i + 12], 20, -1926607734);

      a = md5hh(a, b, c, d, x[i + 5], 4, -378558);
      d = md5hh(d, a, b, c, x[i + 8], 11, -2022574463);
      c = md5hh(c, d, a, b, x[i + 11], 16, 1839030562);
      b = md5hh(b, c, d, a, x[i + 14], 23, -35309556);
      a = md5hh(a, b, c, d, x[i + 1], 4, -1530992060);
      d = md5hh(d, a, b, c, x[i + 4], 11, 1272893353);
      c = md5hh(c, d, a, b, x[i + 7], 16, -155497632);
      b = md5hh(b, c, d, a, x[i + 10], 23, -1094730640);
      a = md5hh(a, b, c, d, x[i + 13], 4, 681279174);
      d = md5hh(d, a, b, c, x[i], 11, -358537222);
      c = md5hh(c, d, a, b, x[i + 3], 16, -722521979);
      b = md5hh(b, c, d, a, x[i + 6], 23, 76029189);
      a = md5hh(a, b, c, d, x[i + 9], 4, -640364487);
      d = md5hh(d, a, b, c, x[i + 12], 11, -421815835);
      c = md5hh(c, d, a, b, x[i + 15], 16, 530742520);
      b = md5hh(b, c, d, a, x[i + 2], 23, -995338651);

      a = md5ii(a, b, c, d, x[i], 6, -198630844);
      d = md5ii(d, a, b, c, x[i + 7], 10, 1126891415);
      c = md5ii(c, d, a, b, x[i + 14], 15, -1416354905);
      b = md5ii(b, c, d, a, x[i + 5], 21, -57434055);
      a = md5ii(a, b, c, d, x[i + 12], 6, 1700485571);
      d = md5ii(d, a, b, c, x[i + 3], 10, -1894986606);
      c = md5ii(c, d, a, b, x[i + 10], 15, -1051523);
      b = md5ii(b, c, d, a, x[i + 1], 21, -2054922799);
      a = md5ii(a, b, c, d, x[i + 8], 6, 1873313359);
      d = md5ii(d, a, b, c, x[i + 15], 10, -30611744);
      c = md5ii(c, d, a, b, x[i + 6], 15, -1560198380);
      b = md5ii(b, c, d, a, x[i + 13], 21, 1309151649);
      a = md5ii(a, b, c, d, x[i + 4], 6, -145523070);
      d = md5ii(d, a, b, c, x[i + 11], 10, -1120210379);
      c = md5ii(c, d, a, b, x[i + 2], 15, 718787259);
      b = md5ii(b, c, d, a, x[i + 9], 21, -343485551);

      a = safeAdd(a, olda);
      b = safeAdd(b, oldb);
      c = safeAdd(c, oldc);
      d = safeAdd(d, oldd);
    }
    return [a, b, c, d];
  }

  function rstr2binl(input) {
    const output = Array.from({ length: input.length >> 2 }, () => 0);
    for (let i = 0; i < input.length * 8; i += 8) {
      output[i >> 5] |= (input.charCodeAt(i / 8) & 0xff) << (i % 32);
    }
    return output;
  }

  function binl2hex(binarray) {
    const hexTab = "0123456789abcdef";
    let str = "";
    for (let i = 0; i < binarray.length * 4; i++) {
      str += hexTab.charAt((binarray[i >> 2] >> ((i % 4) * 8 + 4)) & 0xf) +
             hexTab.charAt((binarray[i >> 2] >> ((i % 4) * 8)) & 0xf);
    }
    return str;
  }

  // Handle UTF-8 encoding
  const utf8 = unescape(encodeURIComponent(string));
  return binl2hex(binlMD5(rstr2binl(utf8), utf8.length * 8));
}

// Decode hex-encoded Subsonic password (e.g., "enc:70617373")
export function decodeSubsonicPassword(p) {
  if (!p) return "";
  if (p.startsWith("enc:")) {
    const hex = p.slice(4);
    let str = "";
    for (let i = 0; i < hex.length; i += 2) {
      str += String.fromCharCode(Number.parseInt(hex.substr(i, 2), 16));
    }
    return str;
  }
  return p;
}

// Extract Subsonic request parameters from GET or POST
export function parseSubsonicParams(request) {
  const url = new URL(request.url);
  const params = {};
  for (const key of url.searchParams.keys()) {
    const all = url.searchParams.getAll(key);
    params[key] = all.length > 1 ? all : all[0];
  }
  // Standard defaults
  params.f = (Array.isArray(params.f) ? params.f[0] : (params.f || "json")).toLowerCase();
  params.v = Array.isArray(params.v) ? params.v[0] : (params.v || "1.16.1");
  params.c = Array.isArray(params.c) ? params.c[0] : (params.c || "generic");
  return params;
}

// Subsonic response envelope builder
export function subsonicResponse(data, format = "json", status = 200) {
  const envelope = {
    "subsonic-response": {
      status: "ok",
      version: "1.16.1",
      type: "halo-music",
      serverVersion: "2.0.0",
      openSubsonic: true,
      ...data,
    },
  };

  if (format === "xml") {
    // Basic XML fallback if a legacy client asks for XML
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<subsonic-response xmlns="http://subsonic.org/restapi" status="ok" version="1.16.1" type="halo-music" serverVersion="2.0.0" openSubsonic="true">
</subsonic-response>`;
    return new Response(xml, {
      status,
      headers: { "Content-Type": "text/xml; charset=UTF-8" },
    });
  }

  return new Response(JSON.stringify(envelope), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

// Standard Subsonic error response
export function subsonicError(code, message, format = "json") {
  const envelope = {
    "subsonic-response": {
      status: "failed",
      version: "1.16.1",
      error: {
        code,
        message,
      },
    },
  };

  return new Response(JSON.stringify(envelope), {
    status: 200, // Subsonic specification returns HTTP 200 with error envelope
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// Authenticate a Subsonic client request
export async function authenticateSubsonic(params, env) {
  const username = (params.u || "").trim();
  if (!username) {
    return { ok: false, error: subsonicError(10, "Required parameter is missing: u", params.f) };
  }
  if (!params.p && (!params.t || !params.s)) {
    return { ok: false, error: subsonicError(10, "Required parameter is missing: p or (t, s)", params.f) };
  }

  if (!env?.DB) {
    return { ok: false, error: subsonicError(0, "Database not bound", params.f) };
  }

  // 1. Fetch user account from "user" table
  let account = null;
  try {
    account = await env.DB.prepare(
      'SELECT username, password_hash, password_salt FROM "user" WHERE username = ?',
    ).bind(username).first();
  } catch (err) {
    console.error("Subsonic auth query failed", err);
  }

  if (!account) {
    return { ok: false, error: subsonicError(40, "Wrong username or password", params.f) };
  }

  // 2. Fetch or check subsonic_auth table
  let subsonicSecret = null;
  try {
    const subAuth = await env.DB.prepare(
      "SELECT subsonic_secret FROM subsonic_auth WHERE username = ?",
    ).bind(username).first();
    if (subAuth?.subsonic_secret) {
      subsonicSecret = subAuth.subsonic_secret;
    }
  } catch {
    // Table might not exist yet if migrations haven't run
  }

  // Verification Branch A: Plaintext or enc: password (p)
  if (params.p) {
    const plain = decodeSubsonicPassword(params.p);
    const hash = await hashPassword(plain, account.password_salt);
    const matchesUserPass = hash === account.password_hash;
    const matchesSubSecret = subsonicSecret && plain === subsonicSecret;

    if (matchesUserPass || matchesSubSecret) {
      // Auto-populate or refresh subsonic_auth table
      if (matchesUserPass && plain) {
        try {
          await env.DB.prepare(
            `INSERT INTO subsonic_auth (username, subsonic_secret, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(username) DO UPDATE SET subsonic_secret = excluded.subsonic_secret, updated_at = excluded.updated_at`,
          ).bind(username, plain, Date.now()).run();
        } catch {}
      }
      return { ok: true, username };
    }
    return { ok: false, error: subsonicError(40, "Wrong username or password", params.f) };
  }

  // Verification Branch B: Token + Salt (t, s)
  if (params.t && params.s) {
    const receivedToken = params.t.toLowerCase();
    const salt = params.s;

    if (subsonicSecret) {
      const expectedToken = md5(subsonicSecret + salt).toLowerCase();
      if (expectedToken === receivedToken) {
        return { ok: true, username };
      }
    }

    return {
      ok: false,
      error: subsonicError(40, "Wrong username or password. (Note: for token auth, log into HALO Music Web once to sync credentials)", params.f),
    };
  }

  return { ok: false, error: subsonicError(40, "Wrong username or password", params.f) };
}

// Convert a HALO Track into a Subsonic Child/Song object
export function trackToSubsonicSong(track, options = {}) {
  const id = track.uid || `${track.source || "qq"}_${track.songid || track.mid || track.id}`;
  const artist = track.artist || "未知歌手";
  const album = track.album || "未知专辑";
  const title = track.title || track.name || "未知曲目";
  const duration = Math.round(Number(track.duration) || 210);

  const isM4A = (track.source || "").toLowerCase() === "qq" || /\.m4a/i.test(track.url || "");
  const suffix = isM4A ? "m4a" : "mp3";
  const contentType = isM4A ? "audio/mp4" : "audio/mpeg";
  const bitRate = track.quality === "lossless" ? 320 : 192;
  const size = Number(track.totalBytes || track.size) || Math.round(duration * (bitRate * 125));

  return {
    id,
    parent: options.parentId || "root",
    isDir: false,
    title,
    album,
    artist,
    track: options.trackNumber || 1,
    year: track.year || 2024,
    genre: "Pop",
    coverArt: track.cover ? `cov_${id}` : undefined,
    size,
    contentType,
    suffix,
    duration,
    bitRate,
    path: `${artist}/${album}/${artist} - ${title}.${suffix}`,
    playCount: 1,
    created: new Date().toISOString(),
    albumId: `al_${encodeURIComponent(album)}`,
    artistId: `ar_${encodeURIComponent(artist)}`,
    type: "music",
  };
}

// Convert a HALO Playlist into a Subsonic Playlist object
export function playlistToSubsonic(playlist, username = "admin") {
  const tracks = playlist.tracks || [];
  const duration = tracks.reduce((acc, t) => acc + (Number(t.duration) || 210), 0);

  return {
    id: playlist.id,
    name: playlist.name || "未命名歌单",
    comment: "HALO Music 歌单",
    owner: username,
    public: true,
    songCount: tracks.length,
    duration: Math.round(duration),
    created: playlist.created || new Date().toISOString(),
    changed: playlist.updated || new Date().toISOString(),
    coverArt: tracks[0]?.cover ? `cov_${tracks[0].uid || tracks[0].songid}` : undefined,
  };
}
