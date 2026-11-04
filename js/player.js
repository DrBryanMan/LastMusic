import { $, h, key, query, readJSON, writeJSON, fetchJSON, toast, getTrackImage } from "./utils.js";
import { config, lfm, scrobble, updateNowPlaying } from "./lastfm.js";

const LS_MODE = "scrobble-deck:player-mode";
const LS_VOL = "scrobble-deck:volume";
const LS_YTM_CACHE = "scrobble-deck:ytm-cache-v2";
const SCROBBLE_MIN_DURATION = 30;   // с: коротші треки Last.fm не приймає
const SCROBBLE_MAX_THRESHOLD = 240; // с: правило Last.fm — половина треку або 4 хвилини
const SKIP_DELAY_MS = 900;
const QUEUE_LOW_THRESHOLD = 5;
const SKIPPABLE_YT_ERRORS = new Set([100, 101, 150]);

// Публічні інстанси Piped API з підтримкою CORS для безключового пошуку YTM на GitHub Pages
const PIPED_INSTANCES = [
  "https://pipedapi.ducks.party",
  "https://api.piped.private.coffee",
];

const hooks = { onChange() {}, onScrobbled() {}, onQueueLow() {} };

let queue = [];
let idx = -1;
let mode = localStorage.getItem(LS_MODE) === "video" ? "video" : "song";
let session = null; // { track, startedAt, played, announced, done, fallbackDuration, currentId, altIds }
let request = 0;    // номер останнього запиту: відсікає застарілі відповіді й таймери
let queueLowFired = false;
let isSeeking = false;

// Автоматичне визначення середовища: локальний server.py чи онлайн GitHub Pages
let useCloudFallback = /\.github\.io$/i.test(location.hostname) || location.protocol === "file:";

// Подвійний аудіо-буфер для чистого Gapless-переходу між треками (локальний режим)
let activeAudio = new Audio();
let nextAudio = new Audio();
activeAudio.preload = "auto";
nextAudio.preload = "auto";

// YouTube IFrame Player для онлайн-режиму (GitHub Pages без server.py)
let ytPlayer = null;
let ytPlayerPromise = null;
let ytApiPromise = null;

// Кеш метаданих: у сесії та в localStorage для онлайн-режиму
const mediaCache = new Map();
const persistentIdCache = readJSON(LS_YTM_CACHE, {});
let prefetched = null; // { index, trackKey, mode, data }

const savedVol = readJSON(LS_VOL, { volume: 0.85, muted: false });
let volume = typeof savedVol.volume === "number" ? Math.min(1, Math.max(0, savedVol.volume)) : 0.85;
let muted = Boolean(savedVol.muted);

const getVideoEl = () => $("#video-el");
const getYtWrap = () => $("#yt-iframe-wrap");

const fmtTime = (sec) => {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const total = Math.floor(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
};

export const activeKey = () => {
  const track = queue[idx];
  return track && key(track.artist, track.title);
};

export const currentTrack = () => queue[idx] || null;

export const appendToQueue = (tracks) => {
  queue.push(...tracks);
  queueLowFired = false;
  if (idx >= 0 && (!prefetched || prefetched.index !== idx + 1)) {
    prepareNextTrack(idx + 1);
  }
};

export const isPlaying = () => {
  if (useCloudFallback) {
    return Boolean(ytPlayer && globalThis.YT?.PlayerState && ytPlayer.getPlayerState?.() === YT.PlayerState.PLAYING);
  }
  return Boolean(activeAudio && !activeAudio.paused && !activeAudio.ended && activeAudio.readyState > 0);
};

export const togglePlay = () => {
  if (useCloudFallback) {
    if (!ytPlayer || !ytPlayer.getPlayerState) return;
    ytPlayer.getPlayerState() === YT.PlayerState.PLAYING ? ytPlayer.pauseVideo() : ytPlayer.playVideo();
    return;
  }
  if (!activeAudio || !activeAudio.getAttribute("src")) return;
  if (activeAudio.paused) {
    activeAudio.play().catch((err) => toast(`Відтворення: ${err.message}`));
    if (mode === "video") getVideoEl()?.play().catch(() => {});
  } else {
    activeAudio.pause();
    getVideoEl()?.pause();
  }
};

// ── Статус, іконки та візуал сцени ──────────────────────────────────
const setStatus = (text) => {
  const s = $("#status");
  if (s) s.textContent = text;
};

const setLoading = (loading) => {
  $(".player-card")?.classList.toggle("is-loading", Boolean(loading));
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
  $(".player-card")?.classList.toggle("is-playing", Boolean(playing));
};

const applyVolume = () => {
  for (const el of [activeAudio, nextAudio]) {
    if (!el) continue;
    el.volume = volume;
    el.muted = muted;
  }
  const v = getVideoEl();
  if (v) v.muted = true;

  if (ytPlayer && ytPlayer.setVolume) {
    try {
      ytPlayer.setVolume(Math.round(volume * 100));
      if (muted || volume === 0) ytPlayer.mute();
      else ytPlayer.unMute();
    } catch {}
  }

  const volBar = $("#vol-bar");
  if (volBar) volBar.value = String(muted ? 0 : volume);
  const volIcon = $("#vol-icon");
  if (volIcon) {
    volIcon.setAttribute("href", muted || volume === 0 ? "#i-mute" : "#i-volume");
  }
};

const updateStageCover = (url) => {
  const coverImg = $("#player-cover");
  const coverPh = $("#player-cover-ph");
  const bg = $("#player-bg");

  if (url) {
    if (coverImg) {
      coverImg.src = url;
      coverImg.hidden = false;
    }
    if (coverPh) coverPh.hidden = true;
    if (bg) bg.style.backgroundImage = `url("${url}")`;
  } else {
    if (coverImg) {
      coverImg.removeAttribute("src");
      coverImg.hidden = true;
    }
    if (coverPh) coverPh.hidden = false;
    if (bg) bg.style.backgroundImage = "none";
  }
};

const updateStageMeta = (track, mediaData = null) => {
  const titleEl = $("#player-title");
  const artistEl = $("#player-artist");
  if (!track) {
    if (titleEl) titleEl.textContent = "Обери трек зі списку";
    if (artistEl) artistEl.textContent = "YouTube Music · Без лімітів";
    updateStageCover(null);
    return;
  }
  if (titleEl) titleEl.textContent = track.title || track.artist || "Без назви";
  if (artistEl) artistEl.textContent = track.artist || "";

  const immediateCover = track.img || mediaData?.thumbnail || null;
  updateStageCover(immediateCover);

  if (!track.img && mediaData?.thumbnail) {
    track.img = mediaData.thumbnail;
    hooks.onChange();
  }

  if (!immediateCover && track.artist && track.title) {
    const k = key(track.artist, track.title);
    getTrackImage(track.artist, track.title, lfm).then((url) => {
      if (!url) return;
      track.img = url;
      if (activeKey() === k) {
        updateStageCover(url);
        hooks.onChange();
      }
    }).catch(() => {});
  }
};

const syncVideoToAudio = (force = false) => {
  if (useCloudFallback || mode !== "video") return;
  const v = getVideoEl();
  if (!v || !v.getAttribute("src") || v.readyState < 1) return;
  const diff = Math.abs((v.currentTime || 0) - (activeAudio.currentTime || 0));
  if (force || diff > 0.35) {
    try { v.currentTime = activeAudio.currentTime || 0; } catch {}
  }
  if (!activeAudio.paused && v.paused) {
    v.play().catch(() => {});
  } else if (activeAudio.paused && !v.paused) {
    v.pause();
  }
};

const getPlaybackMetrics = () => {
  if (useCloudFallback && ytPlayer && ytPlayer.getCurrentTime) {
    const cur = Number(ytPlayer.getCurrentTime()) || 0;
    const rawDur = Number(ytPlayer.getDuration()) || 0;
    const dur = rawDur > 0 ? rawDur : (session?.fallbackDuration || 0);
    return { cur, dur };
  }
  const cur = activeAudio?.currentTime || 0;
  const rawDur = activeAudio?.duration;
  const dur = Number.isFinite(rawDur) && rawDur > 0
    ? rawDur
    : (session?.fallbackDuration || 0);
  return { cur, dur };
};

const updateProgressUI = () => {
  const { cur, dur } = getPlaybackMetrics();
  const pct = dur > 0 ? Math.min(100, Math.max(0, (cur / dur) * 100)) : 0;

  if (!isSeeking) {
    const seekBar = $("#seek-bar");
    if (seekBar) seekBar.value = String(pct);
    const curEl = $("#time-cur");
    if (curEl) curEl.textContent = fmtTime(cur);
  }
  const durEl = $("#time-dur");
  if (durEl) durEl.textContent = fmtTime(dur);

  const miniFill = $("#mini-progress-fill");
  if (miniFill) miniFill.style.width = `${pct.toFixed(1)}%`;
  const miniTime = $("#mini-time");
  if (miniTime) miniTime.textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`;
};

const ytmSearchUrl = (t) => `https://music.youtube.com/search?q=${encodeURIComponent(query(t))}`;
const ytmWatchUrl = (id) => `https://music.youtube.com/watch?v=${id}`;

const skipAfter = (index, ms = SKIP_DELAY_MS) => {
  const id = request;
  setTimeout(() => id === request && playIndex(index + 1), ms);
};

// ── Онлайн-пошук через Piped API та YT.Player (для GitHub Pages) ─────
const extractVideoIdFromUrl = (urlStr = "") => {
  const m = String(urlStr).match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
};

const searchPiped = async (qStr, filter) => {
  for (const host of PIPED_INSTANCES) {
    try {
      const res = await fetch(`${host}/search?q=${encodeURIComponent(qStr)}&filter=${filter}`);
      if (!res.ok) continue;
      const data = await res.json();
      const items = (data?.items || [])
        .map((item) => ({
          id: extractVideoIdFromUrl(item.url),
          duration: Number(item.duration) || 0,
          thumbnail: item.thumbnail ? item.thumbnail.replace("=w120-h120", "=w544-h544") : null,
        }))
        .filter((x) => x.id);
      if (items.length) return items;
    } catch {
      // Наступний інстанс
    }
  }
  return [];
};

const resolveCloudMedia = async (track, targetMode = mode) => {
  const trkK = key(track.artist, track.title);
  const cacheK = `${trkK}|${targetMode}|cloud`;
  if (mediaCache.has(cacheK)) return mediaCache.get(cacheK);

  const cachedEntry = persistentIdCache[trkK] || {};
  const field = targetMode === "video" ? "videoItems" : "songItems";

  if (!cachedEntry[field]?.length) {
    const qStr = query(track);
    const primaryFilter = targetMode === "video" ? "music_videos" : "music_songs";
    const fallbackFilter = targetMode === "video" ? "music_songs" : "music_videos";

    let items = await searchPiped(qStr, primaryFilter);
    if (!items.length) items = await searchPiped(qStr, fallbackFilter);
    if (!items.length) throw new Error("Не знайдено трек у YouTube Music");

    cachedEntry[field] = items.slice(0, 4);
    persistentIdCache[trkK] = cachedEntry;
    writeJSON(LS_YTM_CACHE, persistentIdCache);
  }

  const list = cachedEntry[field];
  const first = list[0];
  const result = {
    id: first.id,
    altIds: list.slice(1).map((x) => x.id),
    mode: targetMode,
    duration: first.duration || 0,
    thumbnail: first.thumbnail || null,
    isCloud: true,
  };
  mediaCache.set(cacheK, result);
  return result;
};

const loadYtApi = () => {
  if (globalThis.YT?.Player) return Promise.resolve();
  if (!ytApiPromise) {
    const { promise, resolve } = Promise.withResolvers();
    globalThis.onYouTubeIframeAPIReady = resolve;
    document.head.append(h("script", { src: "https://www.youtube.com/iframe_api" }));
    ytApiPromise = promise;
  }
  return ytApiPromise;
};

const ensureYtPlayer = async () => {
  if (ytPlayer) return ytPlayer;
  if (!ytPlayerPromise) {
    ytPlayerPromise = (async () => {
      await loadYtApi();
      const { promise, resolve } = Promise.withResolvers();
      const instance = new YT.Player("yt", {
        width: "100%",
        height: "100%",
        playerVars: {
          playsinline: 1,
          autoplay: 1,
          rel: 0,
          ...(location.protocol.startsWith("http") && { origin: location.origin }),
        },
        events: {
          onReady: () => {
            ytPlayer = instance;
            applyVolume();
            resolve(instance);
          },
          onStateChange: ({ data }) => {
            if (!useCloudFallback) return;
            const { PLAYING, ENDED } = YT.PlayerState;
            updatePlayIcons(data === PLAYING);
            updateProgressUI();
            hooks.onChange();
            if (data === ENDED) handleTrackEnded();
          },
          onError: ({ data }) => {
            if (!useCloudFallback) return;
            if (SKIPPABLE_YT_ERRORS.has(data) && session?.altIds?.length) {
              const nextAltId = session.altIds.shift();
              session.currentId = nextAltId;
              setLink(ytmWatchUrl(nextAltId));
              ytPlayer?.loadVideoById(nextAltId);
              return;
            }
            setStatus("Відео недоступне — перехід до наступного…");
            skipAfter(idx);
          },
        },
      });
      return promise;
    })();
  }
  return ytPlayerPromise;
};

// ── Запити до локального YTM + yt-dlp сервера (з фолбеком на Cloud) ──
const resolveMedia = async (track, targetMode = mode) => {
  if (useCloudFallback) {
    return resolveCloudMedia(track, targetMode);
  }

  const cacheK = `${key(track.artist, track.title)}|${targetMode}`;
  if (mediaCache.has(cacheK)) return mediaCache.get(cacheK);

  const url = new URL("/api/ytm/resolve", location.origin);
  url.search = new URLSearchParams({
    artist: track.artist || "",
    track: track.title || "",
    mode: targetMode,
  });

  try {
    const res = await fetch(url);
    const contentType = res.headers.get("content-type") || "";
    if (res.status === 404 || !contentType.includes("application/json")) {
      // Сервер статичний (наприклад, GitHub Pages або npx serve) — переходимо в онлайн-режим
      useCloudFallback = true;
      syncModeUI();
      return resolveCloudMedia(track, targetMode);
    }
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    mediaCache.set(cacheK, data);
    return data;
  } catch (err) {
    if (useCloudFallback) throw err;
    // Якщо локальний API не відповів, пробуємо хмарний пошук
    try {
      const cloudData = await resolveCloudMedia(track, targetMode);
      useCloudFallback = true;
      syncModeUI();
      return cloudData;
    } catch {
      throw err;
    }
  }
};

// Фонове передзавантаження наступного треку з черги
const prepareNextTrack = async (nextIndex) => {
  const nextTrack = queue[nextIndex];
  if (!nextTrack) {
    prefetched = null;
    nextAudio.removeAttribute("src");
    return;
  }

  const nextK = key(nextTrack.artist, nextTrack.title);
  if (prefetched && prefetched.index === nextIndex && prefetched.trackKey === nextK && prefetched.mode === mode) {
    return;
  }

  try {
    const data = await resolveMedia(nextTrack, mode);
    if (idx + 1 !== nextIndex) return;
    if (!useCloudFallback && data.streamUrl) {
      nextAudio.src = data.streamUrl;
      nextAudio.load();
    }
    prefetched = { index: nextIndex, trackKey: nextK, mode, data };
  } catch {
    // Ігноруємо помилки фонового префетчу
  }
};

// ── Події аудіо-елементів (локальний режим) ─────────────────────────
const bindAudioEvents = (audioEl) => {
  audioEl.addEventListener("play", () => {
    if (useCloudFallback || audioEl !== activeAudio) return;
    updatePlayIcons(true);
    if (mode === "video") getVideoEl()?.play().catch(() => {});
    hooks.onChange();
  });

  audioEl.addEventListener("pause", () => {
    if (useCloudFallback || audioEl !== activeAudio) return;
    updatePlayIcons(false);
    if (mode === "video") getVideoEl()?.pause();
    hooks.onChange();
  });

  audioEl.addEventListener("timeupdate", () => {
    if (useCloudFallback || audioEl !== activeAudio) return;
    updateProgressUI();
    syncVideoToAudio(false);
  });

  audioEl.addEventListener("loadedmetadata", () => {
    if (useCloudFallback || audioEl !== activeAudio) return;
    updateProgressUI();
  });

  audioEl.addEventListener("ended", () => {
    if (useCloudFallback || audioEl !== activeAudio) return;
    handleTrackEnded();
  });

  audioEl.addEventListener("error", () => {
    if (useCloudFallback || audioEl !== activeAudio || !audioEl.getAttribute("src")) return;
    setStatus("Помилка потоку — перехід до наступного…");
    skipAfter(idx);
  });
};

bindAudioEvents(activeAudio);
bindAudioEvents(nextAudio);

const handleTrackEnded = () => {
  const nextIdx = idx + 1;
  const nextTrack = queue[nextIdx];
  if (!nextTrack) {
    updatePlayIcons(false);
    getVideoEl()?.pause();
    setStatus("Черга закінчилась");
    hooks.onChange();
    return;
  }

  // Gapless (локальний режим): якщо наступний потік вже збуферизований у nextAudio — стартуємо миттєво!
  if (
    !useCloudFallback &&
    prefetched &&
    prefetched.index === nextIdx &&
    prefetched.trackKey === key(nextTrack.artist, nextTrack.title) &&
    prefetched.mode === mode &&
    prefetched.data?.streamUrl &&
    nextAudio.getAttribute("src")
  ) {
    request++;
    idx = nextIdx;

    const remaining = queue.length - idx;
    if (remaining <= QUEUE_LOW_THRESHOLD && !queueLowFired) {
      queueLowFired = true;
      hooks.onQueueLow();
    }

    const oldAudio = activeAudio;
    activeAudio = nextAudio;
    nextAudio = oldAudio;
    oldAudio.pause();
    oldAudio.removeAttribute("src");

    const mediaData = prefetched.data;
    prefetched = null;

    applyVolume();
    beginSession(nextTrack, mediaData.duration, mediaData.id);
    updateStageMeta(nextTrack, mediaData);
    setStatus(`${nextTrack.artist} — ${nextTrack.title || "…"}`);
    setLink(ytmWatchUrl(mediaData.id));
    hooks.onChange();

    if (mode === "video") {
      const v = getVideoEl();
      if (v) {
        v.src = mediaData.videoStreamUrl;
        v.load();
        v.play().catch(() => {});
      }
    }

    activeAudio.play().catch(() => {});
    updateProgressUI();
    prepareNextTrack(idx + 1);
    return;
  }

  playIndex(nextIdx);
};

// ── Скроблінг Last.fm ───────────────────────────────────────────────
const beginSession = (track, fallbackDuration = 0, currentId = "", altIds = []) => {
  session = {
    track,
    startedAt: Math.floor(Date.now() / 1000),
    played: 0,
    announced: false,
    done: false,
    fallbackDuration: Number(fallbackDuration) || 0,
    currentId,
    altIds: [...(altIds || [])],
  };
};

const tick = async () => {
  if (useCloudFallback && isPlaying()) {
    updateProgressUI();
  }
  if (!session || session.done || !isPlaying()) return;
  session.played++;

  const { track, startedAt } = session;
  if (!config.authorized || !track.title) return;

  const { dur } = getPlaybackMetrics();
  const duration = Math.round(dur);
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

// ── Перемикання режиму «Пісня | Відео» зі збереженням секунди ───────
const syncModeUI = () => {
  $("#mode-song")?.classList.toggle("active", mode === "song");
  $("#mode-video")?.classList.toggle("active", mode === "video");

  const audioStage = $("#audio-stage");
  const videoEl = getVideoEl();
  const ytWrap = getYtWrap();

  if (audioStage) audioStage.hidden = mode === "video";

  if (useCloudFallback) {
    if (videoEl) videoEl.hidden = true;
    if (ytWrap) {
      ytWrap.hidden = false;
      ytWrap.classList.toggle("audio-only-bg", mode === "song");
    }
  } else {
    if (ytWrap) ytWrap.hidden = true;
    if (videoEl) videoEl.hidden = mode !== "video";
  }
};

export const setMode = async (newMode) => {
  if (newMode !== "song" && newMode !== "video") return;
  if (newMode === mode) return;

  const { cur: savedTime } = getPlaybackMetrics();
  const wasPlaying = isPlaying();
  const prevId = session?.currentId || "";

  mode = newMode;
  localStorage.setItem(LS_MODE, mode);
  syncModeUI();

  const videoEl = getVideoEl();
  if (mode === "song" && videoEl) {
    videoEl.pause();
    videoEl.removeAttribute("src");
  }

  const track = currentTrack();
  if (!track) return;

  const current = ++request;
  setLoading(true);
  setStatus(`Перемикання на ${mode === "video" ? "відео" : "пісню"}…`);

  try {
    const mediaData = await resolveMedia(track, mode);
    if (current !== request) return;

    const sameMediaId = prevId && prevId === mediaData.id;

    if (useCloudFallback) {
      const playerInstance = await ensureYtPlayer();
      if (current !== request) return;
      if (!sameMediaId) {
        playerInstance.loadVideoById({ videoId: mediaData.id, startSeconds: Math.floor(savedTime) });
        if (!wasPlaying) playerInstance.pauseVideo();
      }
    } else {
      if (!sameMediaId) {
        activeAudio.pause();
        applyVolume();
        activeAudio.src = mediaData.streamUrl;

        const restorePos = () => {
          activeAudio.removeEventListener("loadedmetadata", restorePos);
          if (savedTime > 0 && (!activeAudio.duration || savedTime < activeAudio.duration - 1)) {
            try { activeAudio.currentTime = savedTime; } catch {}
          }
          updateProgressUI();
        };
        activeAudio.addEventListener("loadedmetadata", restorePos);
        activeAudio.load();
      }

      if (mode === "video" && videoEl) {
        videoEl.muted = true;
        videoEl.src = mediaData.videoStreamUrl;
        const onVidLoaded = () => {
          videoEl.removeEventListener("loadedmetadata", onVidLoaded);
          try { videoEl.currentTime = activeAudio.currentTime || savedTime; } catch {}
          if (wasPlaying || isPlaying()) videoEl.play().catch(() => {});
        };
        videoEl.addEventListener("loadedmetadata", onVidLoaded);
        videoEl.load();
      }

      if (!sameMediaId && wasPlaying) {
        await activeAudio.play().catch(() => {});
      }
    }

    if (session) {
      session.currentId = mediaData.id;
      session.altIds = [...(mediaData.altIds || [])];
      if (mediaData.duration && !session.fallbackDuration) {
        session.fallbackDuration = mediaData.duration;
      }
    }

    updateStageMeta(track, mediaData);
    setStatus(`${track.artist} — ${track.title || "…"}`);
    setLink(ytmWatchUrl(mediaData.id));
    setLoading(false);
    prepareNextTrack(idx + 1);
  } catch (err) {
    if (current !== request) return;
    setLoading(false);
    setStatus(err.message);
    toast(err.message);
  }
};

// ── Відтворення треку за індексом у черзі ───────────────────────────
export const playIndex = async (index) => {
  const track = queue[index];
  if (!track) {
    updatePlayIcons(false);
    return setStatus("Черга закінчилась");
  }

  const remaining = queue.length - index;
  if (remaining <= QUEUE_LOW_THRESHOLD && !queueLowFired) {
    queueLowFired = true;
    hooks.onQueueLow();
  }

  const current = ++request;
  idx = index;

  activeAudio.pause();
  const videoEl = getVideoEl();
  if (videoEl) {
    videoEl.pause();
    videoEl.removeAttribute("src");
  }
  if (ytPlayer?.pauseVideo) {
    try { ytPlayer.pauseVideo(); } catch {}
  }

  updateStageMeta(track);
  hooks.onChange();
  setLoading(true);
  setStatus(`Пошук у YTM: ${query(track)}…`);
  setLink(ytmSearchUrl(track));

  try {
    const mediaData = await resolveMedia(track, mode);
    if (current !== request) return;

    syncModeUI();
    applyVolume();
    beginSession(track, mediaData.duration, mediaData.id, mediaData.altIds);
    updateStageMeta(track, mediaData);

    setStatus(`${track.artist} — ${track.title || "…"}`);
    setLink(ytmWatchUrl(mediaData.id));

    if (useCloudFallback) {
      const playerInstance = await ensureYtPlayer();
      if (current !== request) return;
      setLoading(false);
      playerInstance.loadVideoById(mediaData.id);
    } else {
      activeAudio.src = mediaData.streamUrl;
      activeAudio.load();

      if (mode === "video" && videoEl) {
        videoEl.muted = true;
        videoEl.src = mediaData.videoStreamUrl;
        videoEl.load();
        videoEl.play().catch(() => {});
      }

      setLoading(false);
      await activeAudio.play();
    }

    updateProgressUI();
    prepareNextTrack(index + 1);
  } catch (err) {
    if (current !== request) return;
    setLoading(false);
    setStatus(`${err.message} — наступний…`);
    toast(err.message);
    skipAfter(index);
  }
};

export const playList = (list, index = 0) => {
  queue = list;
  queueLowFired = false;
  prefetched = null;
  return playIndex(index);
};

// ── Ініціалізація плеєра та елементів керування ─────────────────────
export const initPlayer = (options) => {
  Object.assign(hooks, options);

  syncModeUI();
  applyVolume();

  const videoEl = getVideoEl();
  if (videoEl) {
    videoEl.muted = true;
    videoEl.addEventListener("click", togglePlay);
  }

  $("#prev")?.addEventListener("click", () => playIndex(Math.max(0, idx - 1)));
  $("#next")?.addEventListener("click", () => playIndex(idx + 1));
  $("#toggle")?.addEventListener("click", togglePlay);

  $("#mini-prev")?.addEventListener("click", () => playIndex(Math.max(0, idx - 1)));
  $("#mini-next")?.addEventListener("click", () => playIndex(idx + 1));
  $("#mini-toggle")?.addEventListener("click", togglePlay);

  // Перемикач «Пісня | Відео»
  $("#mode-song")?.addEventListener("click", () => setMode("song"));
  $("#mode-video")?.addEventListener("click", () => setMode("video"));

  // Клік по обкладинці на аудіо-сцені також перемикає Play / Pause
  $("#player-cover-wrap")?.addEventListener("click", () => {
    if (currentTrack()) togglePlay();
  });

  // Інтерактивний прогрес-бар (Seek)
  const seekBar = $("#seek-bar");
  if (seekBar) {
    seekBar.addEventListener("input", () => {
      isSeeking = true;
      const { dur } = getPlaybackMetrics();
      const previewSec = (Number(seekBar.value) / 100) * dur;
      const curEl = $("#time-cur");
      if (curEl) curEl.textContent = fmtTime(previewSec);
    });

    seekBar.addEventListener("change", () => {
      const { dur } = getPlaybackMetrics();
      const targetSec = (Number(seekBar.value) / 100) * dur;
      if (dur > 0) {
        if (useCloudFallback && ytPlayer?.seekTo) {
          try { ytPlayer.seekTo(targetSec, true); } catch {}
        } else if (activeAudio) {
          try {
            activeAudio.currentTime = targetSec;
            syncVideoToAudio(true);
          } catch {}
        }
      }
      isSeeking = false;
      updateProgressUI();
    });
  }

  // Керування гучністю та Mute
  const volBar = $("#vol-bar");
  if (volBar) {
    volBar.addEventListener("input", () => {
      volume = Math.min(1, Math.max(0, Number(volBar.value)));
      if (volume > 0 && muted) muted = false;
      writeJSON(LS_VOL, { volume, muted });
      applyVolume();
    });
  }

  $("#mute-btn")?.addEventListener("click", () => {
    muted = !muted;
    if (!muted && volume === 0) volume = 0.5;
    writeJSON(LS_VOL, { volume, muted });
    applyVolume();
  });

  setInterval(tick, 1000);
};
