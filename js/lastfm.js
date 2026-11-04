import { cover, fetchJSON, asArray } from "./utils.js";

// Локальний конфіг (зберігається у localStorage)
export const config = {
  user: "",
  lfmKey: "",
  lfmSecret: "",
  sk: "",
  hasSecret: false,
  authorized: false,
};

// ── Pure JS MD5 (RFC 1321 compliant, UTF-8 safe) ──────────────────────
const md5 = (string) => {
  const rotateLeft = (lValue, iShiftBits) => (lValue << iShiftBits) | (lValue >>> (32 - iShiftBits));
  const addUnsigned = (lX, lY) => {
    const lX4 = lX & 0x40000000;
    const lY4 = lY & 0x40000000;
    const lX8 = lX & 0x80000000;
    const lY8 = lY & 0x80000000;
    const lResult = (lX & 0x3fffffff) + (lY & 0x3fffffff);
    if (lX4 & lY4) return lResult ^ 0x80000000 ^ lX8 ^ lY8;
    if (lX4 | lY4) {
      if (lResult & 0x40000000) return lResult ^ 0xc0000000 ^ lX8 ^ lY8;
      return lResult ^ 0x40000000 ^ lX8 ^ lY8;
    }
    return lResult ^ lX8 ^ lY8;
  };
  const F = (x, y, z) => (x & y) | (~x & z);
  const G = (x, y, z) => (x & z) | (y & ~z);
  const H = (x, y, z) => x ^ y ^ z;
  const I = (x, y, z) => y ^ (x | ~z);
  const FF = (a, b, c, d, x, s, ac) => addUnsigned(rotateLeft(addUnsigned(a, addUnsigned(addUnsigned(F(b, c, d), x), ac)), s), b);
  const GG = (a, b, c, d, x, s, ac) => addUnsigned(rotateLeft(addUnsigned(a, addUnsigned(addUnsigned(G(b, c, d), x), ac)), s), b);
  const HH = (a, b, c, d, x, s, ac) => addUnsigned(rotateLeft(addUnsigned(a, addUnsigned(addUnsigned(H(b, c, d), x), ac)), s), b);
  const II = (a, b, c, d, x, s, ac) => addUnsigned(rotateLeft(addUnsigned(a, addUnsigned(addUnsigned(I(b, c, d), x), ac)), s), b);

  const convertToWordArray = (str) => {
    const lMessageLength = str.length;
    const lNumberOfWordsTempOne = lMessageLength + 8;
    const lNumberOfWordsTempTwo = (lNumberOfWordsTempOne - (lNumberOfWordsTempOne % 64)) / 64;
    const lNumberOfWords = (lNumberOfWordsTempTwo + 1) * 16;
    const lWordArray = new Array(lNumberOfWords).fill(0);
    let lBytePosition = 0;
    let lByteCount = 0;
    while (lByteCount < lMessageLength) {
      const lWordCount = (lByteCount - (lByteCount % 4)) / 4;
      lBytePosition = (lByteCount % 4) * 8;
      lWordArray[lWordCount] = lWordArray[lWordCount] | (str.charCodeAt(lByteCount) << lBytePosition);
      lByteCount++;
    }
    const lWordCount = (lByteCount - (lByteCount % 4)) / 4;
    lBytePosition = (lByteCount % 4) * 8;
    lWordArray[lWordCount] = lWordArray[lWordCount] | (0x80 << lBytePosition);
    lWordArray[lNumberOfWords - 2] = lMessageLength << 3;
    lWordArray[lNumberOfWords - 1] = lMessageLength >>> 29;
    return lWordArray;
  };

  const wordToHex = (lValue) => {
    let WordToHexValue = "";
    for (let lCount = 0; lCount <= 3; lCount++) {
      const lByte = (lValue >>> (lCount * 8)) & 255;
      const WordToHexValueTemp = "0" + lByte.toString(16);
      WordToHexValue += WordToHexValueTemp.slice(-2);
    }
    return WordToHexValue;
  };

  const utf8Bytes = new TextEncoder().encode(string);
  let binaryStr = "";
  for (let i = 0; i < utf8Bytes.length; i++) binaryStr += String.fromCharCode(utf8Bytes[i]);

  const x = convertToWordArray(binaryStr);
  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
  const S11 = 7, S12 = 12, S13 = 17, S14 = 22;
  const S21 = 5, S22 = 9, S23 = 14, S24 = 20;
  const S31 = 4, S32 = 11, S33 = 16, S34 = 23;
  const S41 = 6, S42 = 10, S43 = 15, S44 = 21;

  for (let k = 0; k < x.length; k += 16) {
    const AA = a, BB = b, CC = c, DD = d;
    a = FF(a, b, c, d, x[k + 0], S11, 0xd76aa478); d = FF(d, a, b, c, x[k + 1], S12, 0xe8c7b756);
    c = FF(c, d, a, b, x[k + 2], S13, 0x242070db); b = FF(b, c, d, a, x[k + 3], S14, 0xc1bdceee);
    a = FF(a, b, c, d, x[k + 4], S11, 0xf57c0faf); d = FF(d, a, b, c, x[k + 5], S12, 0x4787c62a);
    c = FF(c, d, a, b, x[k + 6], S13, 0xa8304613); b = FF(b, c, d, a, x[k + 7], S14, 0xfd469501);
    a = FF(a, b, c, d, x[k + 8], S11, 0x698098d8); d = FF(d, a, b, c, x[k + 9], S12, 0x8b44f7af);
    c = FF(c, d, a, b, x[k + 10], S13, 0xffff5bb1); b = FF(b, c, d, a, x[k + 11], S14, 0x895cd7be);
    a = FF(a, b, c, d, x[k + 12], S11, 0x6b901122); d = FF(d, a, b, c, x[k + 13], S12, 0xfd987193);
    c = FF(c, d, a, b, x[k + 14], S13, 0xa679438e); b = FF(b, c, d, a, x[k + 15], S14, 0x49b40821);
    a = GG(a, b, c, d, x[k + 1], S21, 0xf61e2562); d = GG(d, a, b, c, x[k + 6], S22, 0xc040b340);
    c = GG(c, d, a, b, x[k + 11], S23, 0x265e5a51); b = GG(b, c, d, a, x[k + 0], S24, 0xe9b6c7aa);
    a = GG(a, b, c, d, x[k + 5], S21, 0xd62f105d); d = GG(d, a, b, c, x[k + 10], S22, 0x2441453);
    c = GG(c, d, a, b, x[k + 15], S23, 0xd8a1e681); b = GG(b, c, d, a, x[k + 4], S24, 0xe7d3fbc8);
    a = GG(a, b, c, d, x[k + 9], S21, 0x21e1cde6); d = GG(d, a, b, c, x[k + 14], S22, 0xc33707d6);
    c = GG(c, d, a, b, x[k + 3], S23, 0xf4d50d87); b = GG(b, c, d, a, x[k + 8], S24, 0x455a14ed);
    a = GG(a, b, c, d, x[k + 13], S21, 0xa9e3e905); d = GG(d, a, b, c, x[k + 2], S22, 0xfcefa3f8);
    c = GG(c, d, a, b, x[k + 7], S23, 0x676f02d9); b = GG(b, c, d, a, x[k + 12], S24, 0x8d2a4c8a);
    a = HH(a, b, c, d, x[k + 5], S31, 0xfffa3942); d = HH(d, a, b, c, x[k + 8], S32, 0x8771f681);
    c = HH(c, d, a, b, x[k + 11], S33, 0x6d9d6122); b = HH(b, c, d, a, x[k + 14], S34, 0xfde5380c);
    a = HH(a, b, c, d, x[k + 1], S31, 0xa4beea44); d = HH(d, a, b, c, x[k + 4], S32, 0x4bdecfa9);
    c = HH(c, d, a, b, x[k + 7], S33, 0xf6bb4b60); b = HH(b, c, d, a, x[k + 10], S34, 0xbebfbc70);
    a = HH(a, b, c, d, x[k + 13], S31, 0x289b7ec6); d = HH(d, a, b, c, x[k + 0], S32, 0xeaa127fa);
    c = HH(c, d, a, b, x[k + 3], S33, 0xd4ef3085); b = HH(b, c, d, a, x[k + 6], S34, 0x4881d05);
    a = HH(a, b, c, d, x[k + 9], S31, 0xd9d4d039); d = HH(d, a, b, c, x[k + 12], S32, 0xe6db99e5);
    c = HH(c, d, a, b, x[k + 15], S33, 0x1fa27cf8); b = HH(b, c, d, a, x[k + 2], S34, 0xc4ac5665);
    a = II(a, b, c, d, x[k + 0], S41, 0xf4292244); d = II(d, a, b, c, x[k + 7], S42, 0x432aff97);
    c = II(c, d, a, b, x[k + 14], S43, 0xab9423a7); b = II(b, c, d, a, x[k + 5], S44, 0xfc93a039);
    a = II(a, b, c, d, x[k + 12], S41, 0x655b59c3); d = II(d, a, b, c, x[k + 3], S42, 0x8f0ccc92);
    c = II(c, d, a, b, x[k + 10], S43, 0xffeff47d); b = II(b, c, d, a, x[k + 1], S44, 0x85845dd1);
    a = II(a, b, c, d, x[k + 8], S41, 0x6fa87e4f); d = II(d, a, b, c, x[k + 15], S42, 0xfe2ce6e0);
    c = II(c, d, a, b, x[k + 6], S43, 0xa3014314); b = II(b, c, d, a, x[k + 13], S44, 0x4e0811a1);
    a = II(a, b, c, d, x[k + 4], S41, 0xf7537e82); d = II(d, a, b, c, x[k + 11], S42, 0xbd3af235);
    c = II(c, d, a, b, x[k + 2], S43, 0x2ad7d2bb); b = II(b, c, d, a, x[k + 9], S44, 0xeb86d391);
    a = addUnsigned(a, AA); b = addUnsigned(b, BB); c = addUnsigned(c, CC); d = addUnsigned(d, DD);
  }
  return (wordToHex(a) + wordToHex(b) + wordToHex(c) + wordToHex(d)).toLowerCase();
};

// ── Signed Call to Last.fm API ────────────────────────────────────────
const signedCall = async (method, extraParams = {}, includeSk = true) => {
  if (!config.lfmKey || !config.lfmSecret) {
    throw new Error("Не вказано Last.fm API Key або Secret у налаштуваннях");
  }
  if (includeSk && !config.sk) {
    throw new Error("Необхідна авторизація Last.fm у налаштуваннях");
  }

  const params = {
    method,
    api_key: config.lfmKey,
    ...(includeSk && config.sk ? { sk: config.sk } : {}),
    ...extraParams,
  };

  const keys = Object.keys(params).sort();
  const sigRaw = keys.map((k) => `${k}${params[k]}`).join("") + config.lfmSecret;
  const api_sig = md5(sigRaw);

  const body = new URLSearchParams({
    ...params,
    api_sig,
    format: "json",
  });

  const res = await fetch("https://ws.audioscrobbler.com/2.0/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const data = await res.json().catch(() => null);
  if (!res.ok || data?.error) {
    throw new Error(data?.message || `Помилка Last.fm API (${res.status})`);
  }
  return data;
};

// ── Config Management (localStorage with config.json auto-migration) ──
const CONFIG_KEY = "scrobble-deck:config";

export const loadConfig = async () => {
  let saved = null;
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) saved = JSON.parse(raw);
  } catch {}

  if (saved && (saved.user || saved.lfmKey || saved.sk)) {
    Object.assign(config, saved);
  } else {
    // Автоматична міграція з config.json поруч, якщо він існує
    try {
      const res = await fetch("config.json");
      if (res.ok) {
        const fileCfg = await res.json();
        if (fileCfg) {
          config.user = fileCfg.user || "";
          config.lfmKey = fileCfg.lfmKey || "";
          config.lfmSecret = fileCfg.lfmSecret || "";
          config.sk = fileCfg.sk || fileCfg.sessionKey || "";
          saveConfig(config);
        }
      }
    } catch {
      // Працює чисто офлайн / без сервера
    }
  }

  config.hasSecret = !!config.lfmSecret;
  config.authorized = !!(config.sk && config.user);
  return config;
};

export const saveConfig = async (values = {}) => {
  if (values.user !== undefined) config.user = (values.user || "").trim();
  if (values.lfmKey !== undefined) config.lfmKey = (values.lfmKey || "").trim();
  if (values.lfmSecret) {
    config.lfmSecret = values.lfmSecret.trim();
  }
  if (values.sk !== undefined) config.sk = (values.sk || "").trim();

  config.hasSecret = !!config.lfmSecret;
  config.authorized = !!(config.sk && config.user);

  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify({
      user: config.user,
      lfmKey: config.lfmKey,
      lfmSecret: config.lfmSecret,
      sk: config.sk,
    }));
  } catch {}

  // Якщо локальний server.py все ще запущений, синхронізуємо також туди
  try {
    fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    }).catch(() => {});
  } catch {}

  return config;
};

// ── Auth (Direct Last.fm Web Authentication) ──────────────────────────
export const startAuth = async () => {
  if (!config.lfmKey) throw new Error("Спочатку збережи Last.fm API Key у налаштуваннях");
  const res = await fetch(`https://ws.audioscrobbler.com/2.0/?method=auth.gettoken&api_key=${encodeURIComponent(config.lfmKey)}&format=json`);
  const data = await res.json().catch(() => null);
  if (!data?.token) {
    throw new Error(data?.message || "Не вдалося отримати токен від Last.fm");
  }
  sessionStorage.setItem("scrobble-deck:pendingToken", data.token);
  return {
    url: `http://www.last.fm/api/auth/?api_key=${encodeURIComponent(config.lfmKey)}&token=${encodeURIComponent(data.token)}`,
  };
};

export const finishAuth = async () => {
  const token = sessionStorage.getItem("scrobble-deck:pendingToken");
  if (!token) throw new Error("Токен авторизації не знайдено. Натисни «Авторизувати» знову.");
  if (!config.lfmSecret) throw new Error("Вкажи Last.fm Shared secret для завершення авторизації.");

  const data = await signedCall("auth.getSession", { token }, false);
  if (!data?.session?.key) throw new Error("Не вдалося отримати сесію Last.fm");

  config.sk = data.session.key;
  config.user = data.session.name || config.user;
  config.authorized = true;
  await saveConfig(config);
  sessionStorage.removeItem("scrobble-deck:pendingToken");
  return config;
};

// ── Write operations ──────────────────────────────────────────────────
export const updateNowPlaying = async (track) => {
  if (!config.authorized) return;
  const title = track.track || track.title;
  if (!track.artist || !title) return;
  return signedCall("track.updateNowPlaying", {
    artist: track.artist,
    track: title,
    ...(track.duration ? { duration: track.duration } : {}),
  });
};

export const scrobble = async (track) => {
  if (!config.authorized) return;
  const title = track.track || track.title;
  if (!track.artist || !title) return;
  const ts = track.timestamp || Math.floor(Date.now() / 1000);
  return signedCall("track.scrobble", {
    artist: track.artist,
    track: title,
    timestamp: ts,
    ...(track.duration ? { duration: track.duration } : {}),
  });
};

export const loveTrack = async (artist, track) => {
  return signedCall("track.love", { artist, track });
};

export const unloveTrack = async (artist, track) => {
  return signedCall("track.unlove", { artist, track });
};

// ── Last.fm (читання напряму з браузера) ────────────────────────────
export const lfm = async (method, params = {}) => {
  const url = new URL("https://ws.audioscrobbler.com/2.0/");
  url.search = new URLSearchParams({
    method,
    api_key: config.lfmKey,
    user: config.user,
    format: "json",
    ...params,
  });
  const data = await fetchJSON(url);
  if (data.error) throw new Error(`Last.fm: ${data.message}`);
  return data;
};

// Глобальний пошук через Last.fm API
export const lfmSearch = async (type, q, page = 1, limit = 48) => {
  if (!q.trim()) return { items: [], total: 0, totalPages: 0 };
  const methodMap = {
    tracks: { method: "track.search", param: "track", extract: (d) => d.results?.trackmatches?.track, map: (t) => ({ artist: t.artist, title: t.name, img: cover(t.image), plays: Number(t.listeners || 0) }) },
    recent: { method: "track.search", param: "track", extract: (d) => d.results?.trackmatches?.track, map: (t) => ({ artist: t.artist, title: t.name, img: cover(t.image), plays: Number(t.listeners || 0) }) },
    artists: { method: "artist.search", param: "artist", extract: (d) => d.results?.artistmatches?.artist, map: (a) => ({ artist: a.name, title: "", plays: Number(a.listeners || 0), img: cover(a.image), mbid: a.mbid || "" }) },
    albums: { method: "album.search", param: "album", extract: (d) => d.results?.albummatches?.album, map: (a) => ({ artist: a.artist, title: a.name, plays: 0, img: cover(a.image) }) },
  };
  const cfg = methodMap[type] || methodMap.tracks;
  const data = await lfm(cfg.method, { [cfg.param]: q, page, limit });
  const total = Number(data.results?.["opensearch:totalResults"] || 0);
  const items = asArray(cfg.extract(data)).map(cfg.map);
  const totalPages = Math.ceil(total / limit);
  return { items, total, totalPages };
};

// Нормалізація різних форматів відповіді до одного вигляду
export const normalize = {
  recent: (t) => ({
    artist: t.artist["#text"], title: t.name, img: cover(t.image),
    ts: t.date?.uts ? Number(t.date.uts) : null, live: t["@attr"]?.nowplaying === "true",
  }),
  track: (t) => ({ artist: t.artist.name, title: t.name, plays: Number(t.playcount), img: cover(t.image) }),
  artist: (a) => ({ artist: a.name, title: "", plays: Number(a.playcount), img: cover(a.image), mbid: a.mbid || "" }),
  album: (a) => ({ artist: a.artist.name, title: a.name, plays: Number(a.playcount), img: cover(a.image) }),
};

export const TOP = {
  tracks: { method: "user.getTopTracks", items: (d) => d.toptracks.track, map: normalize.track },
  artists: { method: "user.getTopArtists", items: (d) => d.topartists.artist, map: normalize.artist },
  albums: { method: "user.getTopAlbums", items: (d) => d.topalbums.album, map: normalize.album },
};
