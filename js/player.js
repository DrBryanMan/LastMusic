import { $, h, key, query, readJSON, writeJSON, fetchJSON, toast } from "./utils.js";
import { config, scrobble, updateNowPlaying } from "./lastfm.js";

const LS_CACHE = "scrobble-deck:yt-cache";
const SKIPPABLE_ERRORS = new Set([100, 101, 150]); // відео видалене / вбудовування заборонене
const SCROBBLE_MIN_DURATION = 30;   // с: коротші треки Last.fm не приймає
const SCROBBLE_MAX_THRESHOLD = 240; // с: правило Last.fm — половина треку або 4 хвилини
const SKIP_DELAY_MS = 800;
const QUEUE_LOW_THRESHOLD = 5;

const cache = readJSON(LS_CACHE, {});
const hooks = { onChange() {}, onScrobbled() {}, onQueueLow() {} };

let queue = [];
let idx = -1;
let player = null;
let playerPromise = null;
let apiPromise = null;
let session = null; // { track, startedAt, played, announced, done }
let request = 0;   // номер останнього запиту: відсікає застарілі відповіді й таймери
let queueLowFired = false;

export const activeKey = () => {
  const track = queue[idx];
  return track && key(track.artist, track.title);
};

export const currentTrack = () => queue[idx] || null;

export const appendToQueue = (tracks) => {
  queue.push(...tracks);
  queueLowFired = false;
};

export const togglePlay = () => {
  if (!player) return;
  player.getPlayerState() === YT.PlayerState.PLAYING ? player.pauseVideo() : player.playVideo();
};

export const isPlaying = () => {
  return player && player.getPlayerState() === YT.PlayerState.PLAYING;
};

// ── Кеш відео ───────────────────────────────────────────────────────
const cacheSet = (track, videoId) => {
  cache[key(track.artist, track.title)] = videoId;
  writeJSON(LS_CACHE, cache);
};

const cacheDrop = (track) => {
  if (!track || delete cache[key(track.artist, track.title)] === false) return;
  writeJSON(LS_CACHE, cache);
};

// ── Статус ──────────────────────────────────────────────────────────
const setStatus = (text) => {
  const s = $("#status");
  if (s) s.textContent = text;
  const ms = $("#mini-status");
  if (ms) ms.textContent = text;
};

const setLink = (href) => {
  const link = $("#ytm-link");
  if (link) { link.hidden = !href; if (href) link.href = href; }
  const mLink = $("#mini-ytm-link");
  if (mLink) { mLink.hidden = !href; if (href) mLink.href = href; }
};

const updatePlayIcons = (playing) => {
  const icon = playing ? "#i-pause" : "#i-play";
  $("#toggle-icon")?.setAttribute("href", icon);
  $("#mini-toggle-icon")?.setAttribute("href", icon);
  $("#now-cover-play-icon")?.setAttribute("href", icon);
};

const ytmSearchUrl = (t) => `https://music.youtube.com/search?q=${encodeURIComponent(query(t))}`;
const ytmWatchUrl = (id) => `https://music.youtube.com/watch?v=${id}`;

// Перехід до наступного треку, якщо за цей час користувач нічого не обрав
const skipAfter = (index, ms = SKIP_DELAY_MS) => {
  const id = request;
  setTimeout(() => id === request && playIndex(index + 1), ms);
};

// ── Пошук відео ─────────────────────────────────────────────────────
const resolveVideo = async (track) => {
  const cached = cache[key(track.artist, track.title)];
  if (cached) return cached;
  if (!config.ytKey) return null;

  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.search = new URLSearchParams({
    part: "snippet", type: "video", videoCategoryId: "10",
    videoEmbeddable: "true", videoSyndicated: "true",
    maxResults: "1", q: query(track), key: config.ytKey,
  });
  const data = await fetchJSON(url);
  if (data.error) throw new Error(`YouTube: ${data.error.message}`);

  const id = data.items?.[0]?.id?.videoId ?? null;
  if (id) cacheSet(track, id);
  return id;
};

// ── YouTube IFrame API ──────────────────────────────────────────────
const loadYtApi = () => {
  if (globalThis.YT?.Player) return Promise.resolve();
  if (!apiPromise) {
    const { promise, resolve } = Promise.withResolvers();
    globalThis.onYouTubeIframeAPIReady = resolve;
    document.head.append(h("script", { src: "https://www.youtube.com/iframe_api" }));
    apiPromise = promise;
  }
  return apiPromise;
};

const createPlayer = async () => {
  await loadYtApi();
  const { promise, resolve } = Promise.withResolvers();
  const instance = new YT.Player("yt", {
    width: "100%", height: "100%",
    playerVars: {
      playsinline: 1, autoplay: 1, rel: 0,
      ...(location.protocol.startsWith("http") && { origin: location.origin }),
    },
    events: {
      onReady: () => { player = instance; resolve(instance); },
      onStateChange: onYtState,
      onError: onYtError,
    },
  });
  return promise;
};

const ensurePlayer = () => (playerPromise ??= createPlayer());

function onYtState({ data }) {
  const { PLAYING, ENDED } = YT.PlayerState;
  updatePlayIcons(data === PLAYING);
  hooks.onChange();
  if (data === ENDED) playIndex(idx + 1);
}

function onYtError({ data }) {
  if (!SKIPPABLE_ERRORS.has(data)) {
    const hint = location.protocol === "file:"
      ? "відкрий через python server.py, а не file://"
      : "перевір, що сторінка надсилає Referer";
    return setStatus(`Помилка ${data}: ${hint}`);
  }
  cacheDrop(queue[idx]);
  setStatus("Відео недоступне для вбудовування — наступний…");
  skipAfter(idx);
}

// ── Скроблінг ───────────────────────────────────────────────────────
const beginSession = (track) => {
  session = { track, startedAt: Math.floor(Date.now() / 1000), played: 0, announced: false, done: false };
};

const tick = async () => {
  if (!session || session.done || !player || player.getPlayerState() !== YT.PlayerState.PLAYING) return;
  session.played++;

  const { track, startedAt } = session;
  if (!config.authorized || !track.title) return;

  const duration = Math.round(player.getDuration());
  const payload = { artist: track.artist, track: track.title, ...(duration > 0 && { duration }) };

  if (!session.announced) {
    session.announced = true;
    updateNowPlaying(payload).catch(() => {});
  }

  if (duration >= SCROBBLE_MIN_DURATION && session.played >= Math.min(duration / 2, SCROBBLE_MAX_THRESHOLD)) {
    session.done = true;
    try {
      await scrobble({ ...payload, timestamp: startedAt });
      setTimeout(hooks.onScrobbled, 2000);
    } catch (err) {
      toast(`Скроблінг: ${err.message}`);
    }
  }
};

// ── Відтворення ─────────────────────────────────────────────────────
export const playIndex = async (index) => {
  const track = queue[index];
  if (!track) return setStatus("Черга закінчилась");

  // Check if queue is running low and trigger refill
  const remaining = queue.length - index;
  if (remaining <= QUEUE_LOW_THRESHOLD && !queueLowFired) {
    queueLowFired = true;
    hooks.onQueueLow();
  }

  const current = ++request;
  idx = index;
  hooks.onChange();
  setStatus(`Пошук: ${query(track)}…`);
  setLink(ytmSearchUrl(track));

  try {
    const videoId = await resolveVideo(track);
    if (current !== request) return;
    if (!videoId) {
      setStatus(config.ytKey ? "Нічого не знайдено — наступний…" : "Додай YouTube API key у налаштуваннях");
      if (config.ytKey) skipAfter(index);
      return;
    }
    const instance = await ensurePlayer();
    if (current !== request) return;
    beginSession(track);
    instance.loadVideoById(videoId);
    setStatus(`${track.artist} — ${track.title || "…"}`);
    setLink(ytmWatchUrl(videoId));
  } catch (err) {
    if (current !== request) return;
    setStatus(err.message);
    toast(err.message);
  }
};

export const playList = (list, index = 0) => {
  queue = list;
  queueLowFired = false;
  return playIndex(index);
};

export const initPlayer = (options) => {
  Object.assign(hooks, options);
  $("#prev")?.addEventListener("click", () => playIndex(Math.max(0, idx - 1)));
  $("#next")?.addEventListener("click", () => playIndex(idx + 1));
  $("#toggle")?.addEventListener("click", togglePlay);

  $("#mini-prev")?.addEventListener("click", () => playIndex(Math.max(0, idx - 1)));
  $("#mini-next")?.addEventListener("click", () => playIndex(idx + 1));
  $("#mini-toggle")?.addEventListener("click", togglePlay);

  setInterval(tick, 1000);
};
