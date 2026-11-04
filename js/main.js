import {
  $, h, fmt, ago, asArray, key, shuffle, toast, cover, icon,
  getArtistImage, trackCoverEl, artistHref, createCustomSelect,
  isTrackLoved, setTrackLoved,
} from "./utils.js";
import {
  config, loadConfig, saveConfig, startAuth, finishAuth, lfm, normalize, TOP,
  loveTrack, unloveTrack,
} from "./lastfm.js";
import { initPlayer, playList, appendToQueue, activeKey, currentTrack, togglePlay, isPlaying } from "./player.js";
import { mountLovedView } from "./loved.js";
import { mountLibraryView } from "./library.js";
import { mountArtistView } from "./artist.js";

const POLL_MS = 15_000;
const STATS_POLL_MS = 30_000;

const top = { type: "tracks", period: "1month" };
let recs = [];
let pollId;
let statsId;

// Cache for Now Playing metadata: key -> { trackPlays, artistPlays, userLoved }
const nowMetaCache = new Map();
let currentNowTrack = null;

// ── Active row highlight ────────────────────────────────────────────
const markActive = () => {
  const active = activeKey();
  for (const row of document.querySelectorAll(".row, .grid-track-card")) {
    row.classList.toggle("active", row.dataset.key === active);
  }
  updateNowCoverIcon();
  updateMiniPlayerBar();
};

const updateNowCoverIcon = () => {
  const iconEl = $("#now-cover-play-icon");
  if (!iconEl) return;
  const active = activeKey();
  const nowKey = currentNowTrack && key(currentNowTrack.artist, currentNowTrack.title);
  const playing = isPlaying() && active && nowKey && active === nowKey;
  iconEl.setAttribute("href", playing ? "#i-pause" : "#i-play");
};

const updateMiniPlayerBar = () => {
  const track = currentTrack();
  const miniBar = $("#mini-player-bar");
  if (!miniBar) return;
  const isHome = !location.hash || location.hash === "#" || location.hash === "#/";
  if (isHome || !track) {
    miniBar.hidden = true;
    return;
  }
  miniBar.hidden = false;

  $("#mini-title").textContent = track.title || track.artist || "Обери трек";
  $("#mini-artist").textContent = track.artist || "";

  const miniThumb = $("#mini-thumb");
  if (miniThumb) {
    if (track.img) {
      miniThumb.src = track.img;
      miniThumb.style.display = "block";
    } else {
      miniThumb.style.display = "none";
    }
  }

  const toggleIcon = $("#mini-toggle-icon");
  if (toggleIcon) {
    toggleIcon.setAttribute("href", isPlaying() ? "#i-pause" : "#i-play");
  }
};

// ── Track row ────────────────────────────────────────────────────────
const trackRow = (t, list, index, tag, fraction) => {
  const play = () => playList(list, index);
  const thumbEl = trackCoverEl(t, "thumb", lfm);

  const artistLink = t.title && h("a", {
    class: "artist-link",
    href: artistHref(t.artist),
    onclick: (e) => e.stopPropagation(),
  }, t.artist);

  return h("li", {
    class: "row", tabindex: 0, role: "button", "data-key": key(t.artist, t.title),
    onclick: play,
    onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); play(); } },
  },
    thumbEl,
    h("div", { class: "meta" },
      h("b", {}, t.title || t.artist),
      artistLink && h("span", {}, artistLink),
    ),
    tag && h("span", { class: "tag" }, tag),
    fraction != null && h("i", { class: "bar", style: `--w:${(fraction * 100).toFixed(1)}%` }),
  );
};

const fillList = (selector, rows, emptyText) =>
  $(selector).replaceChildren(...(rows.length ? rows : [h("li", { class: "empty" }, emptyText)]));

// ── Redesigned Now Playing Card (No flicker, 2 square cards, Love heart, Play overlay)
const renderNow = async (t) => {
  const box = $("#now");
  if (!t) {
    box.replaceChildren(h("p", { class: "empty" }, "Скроблів ще немає"));
    currentNowTrack = null;
    return;
  }

  const trackK = key(t.artist, t.title);
  const prevK = currentNowTrack ? key(currentNowTrack.artist, currentNowTrack.title) : null;

  // If same track, do not destroy DOM — just update live badge
  if (trackK === prevK && box.querySelector(".now-main")) {
    const badge = box.querySelector(".badge");
    if (badge) {
      badge.className = t.live ? "badge live" : "badge";
      badge.textContent = t.live ? "Зараз грає" : `Останній скробл, ${ago(t.ts)}`;
    }
    updateNowCoverIcon();
    return;
  }

  currentNowTrack = t;

  const cached = nowMetaCache.get(trackK) || {};
  const isLoved = cached.userLoved ?? isTrackLoved(t.artist, t.title);

  // Cover with Play overlay
  const thumbImg = trackCoverEl(t, "cover", lfm);
  const coverWrap = h("div", {
    class: "now-cover-wrap",
    title: "Слухати трек",
    onclick: () => {
      const active = activeKey();
      if (active === trackK) togglePlay();
      else playList([t], 0);
    },
  },
    thumbImg,
    h("div", { class: "now-cover-play-btn" },
      h("svg", { class: "i" },
        h("use", { id: "now-cover-play-icon", href: isPlaying() && activeKey() === trackK ? "#i-pause" : "#i-play" }),
      ),
    ),
  );

  // Middle info
  const infoEl = h("div", { class: "now-info" },
    h("span", { class: t.live ? "badge live" : "badge" }, t.live ? "Зараз грає" : `Останній скробл, ${ago(t.ts)}`),
    h("h3", { title: t.title || t.artist }, t.title || t.artist),
    t.title && h("p", { class: "artist" },
      h("a", { href: artistHref(t.artist), class: "link" }, t.artist),
    ),
  );

  // Right square stat cards + Love button
  const trackPlaysStr = cached.trackPlays != null ? fmt.format(cached.trackPlays) : "—";
  const artistPlaysStr = cached.artistPlays != null ? fmt.format(cached.artistPlays) : "—";

  const trackStatCard = h("div", { class: "now-square-stat now-stat-track" },
    h("span", { class: "now-stat-icon", "aria-hidden": "true" }, "♪"),
    h("strong", { id: "now-stat-track-num" }, trackPlaysStr),
    h("small", {}, "Скробли треку"),
  );

  const artistStatCard = h("div", { class: "now-square-stat now-stat-artist" },
    h("span", { class: "now-stat-icon", "aria-hidden": "true" }, "🎤"),
    h("strong", { id: "now-stat-artist-num" }, artistPlaysStr),
    h("small", {}, "Скроблів автора"),
  );

  const loveBtn = h("button", {
    class: "now-love-btn" + (isLoved ? " loved" : ""),
    title: isLoved ? "В улюблених (натисни щоб видалити)" : "Додати в улюблені",
    onclick: async (e) => {
      e.stopPropagation();
      if (!config.authorized) return toast("Потрібна авторизація Last.fm у налаштуваннях");
      try {
        const currentlyLoved = loveBtn.classList.contains("loved");
        if (currentlyLoved) {
          await unloveTrack(t.artist, t.title);
          loveBtn.classList.remove("loved");
          setTrackLoved(t.artist, t.title, false);
          cached.userLoved = false;
          nowMetaCache.set(trackK, cached);
          toast(`«${t.title}» видалено з улюблених`);
        } else {
          await loveTrack(t.artist, t.title);
          loveBtn.classList.add("loved");
          setTrackLoved(t.artist, t.title, true);
          cached.userLoved = true;
          nowMetaCache.set(trackK, cached);
          toast(`«${t.title}» додано в улюблені! ❤️`);
        }
      } catch (err) {
        toast(`Помилка: ${err.message}`);
      }
    },
  }, h("svg", { class: "i" }, h("use", { href: "#i-heart" })));

  const rightStats = h("div", { class: "now-right-stats" },
    trackStatCard,
    artistStatCard,
    loveBtn,
  );

  box.replaceChildren(
    h("div", { class: "now-main" },
      h("div", { class: "now-left-group" }, coverWrap, infoEl),
      rightStats,
    ),
  );

  // Async meta enrichment
  if (t.title && config.lfmKey) {
    Promise.all([
      lfm("track.getInfo", { artist: t.artist, track: t.title, username: config.user, autocorrect: 1 }),
      lfm("artist.getInfo", { artist: t.artist, username: config.user, autocorrect: 1 }),
    ]).then(([td, ad]) => {
      const trackPlays = td?.track?.userplaycount != null ? Number(td.track.userplaycount) : 0;
      const artistPlays = ad?.artist?.stats?.userplaycount != null ? Number(ad.artist.stats.userplaycount) : 0;
      const userLoved = td?.track?.userloved === "1" || isTrackLoved(t.artist, t.title);

      nowMetaCache.set(trackK, { trackPlays, artistPlays, userLoved });

      const trackNum = $("#now-stat-track-num");
      const artistNum = $("#now-stat-artist-num");
      if (trackNum) trackNum.textContent = fmt.format(trackPlays);
      if (artistNum) artistNum.textContent = fmt.format(artistPlays);

      if (userLoved) {
        loveBtn.classList.add("loved");
        setTrackLoved(t.artist, t.title, true);
      }
    }).catch(() => {});
  }
};

// ── Stats (5 окремих кольорових карток над колонками) ────────────────
const updateWhoLink = (name, url) => {
  const whoEl = $("#who");
  if (!whoEl) return;
  if (!name) {
    whoEl.hidden = true;
    return;
  }
  whoEl.textContent = name;
  whoEl.href = url || `https://www.last.fm/user/${encodeURIComponent(name)}`;
  whoEl.hidden = false;
};

const renderStats = async () => {
  const { user } = await lfm("user.getInfo");
  updateWhoLink(user.name, user.url);
  const cells = [
    ["Скроблів", fmt.format(user.playcount), "stat-1"],
    ["Артистів", fmt.format(user.artist_count), "stat-2"],
    ["Треків",   fmt.format(user.track_count), "stat-3"],
    ["Альбомів", fmt.format(user.album_count), "stat-4"],
  ];
  const statsEl = $("#stats");
  const streamCard = $("#stat-stream-card") || statsEl.querySelector(".stat-stream");
  statsEl.replaceChildren(
    ...cells.map(([label, value, cls]) =>
      h("div", { class: `stat ${cls}` }, h("small", {}, label), h("strong", {}, value))),
    ...(streamCard ? [streamCard] : []),
  );
};

const renderScrobbleState = () => {
  const chip = $("#scrobble-chip");
  chip.classList.toggle("on", config.authorized);
  chip.textContent = config.authorized ? "Скроблінг увімкнено" : "Скроблінг вимкнено";
  updateWhoLink(config.user);
  $("#auth-state").textContent = config.authorized
    ? `Підключено: ${config.user}`
    : "Не авторизовано — відтворені треки не потраплять в історію";
};

// ── Tabs (Home view) ─────────────────────────────────────────────────
let currentTab = "recent";
const tabBtns = document.querySelectorAll(".tab");
const panels = {
  recent: $("#panel-recent"),
  top: $("#panel-top"),
  recs: $("#panel-recs"),
};

const switchTab = (tab) => {
  currentTab = tab;
  tabBtns.forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  Object.entries(panels).forEach(([id, el]) => { el.hidden = id !== tab; });

  const recentCtrl = $("#recent-controls");
  const topCtrl = $("#top-controls");
  const recsCtrl = $("#recs-controls");
  if (recentCtrl) recentCtrl.style.display = tab === "recent" ? "flex" : "none";
  if (topCtrl) topCtrl.style.display = tab === "top" ? "flex" : "none";
  if (recsCtrl) recsCtrl.style.display = tab === "recs" ? "flex" : "none";

  if (tab === "top") loadTop();
  if (tab === "recs" && recs.length === 0) loadRecs();
};

$("#main-tabs").addEventListener("click", ({ target }) => {
  const tab = target.dataset.tab;
  if (tab) switchTab(tab);
});

// Custom Select for Top period
const topPeriodSelect = createCustomSelect({
  options: [
    { value: "7day", label: "7 днів" },
    { value: "1month", label: "Місяць" },
    { value: "3month", label: "3 місяці" },
    { value: "6month", label: "6 місяців" },
    { value: "12month", label: "Рік" },
    { value: "overall", label: "Увесь час" },
  ],
  value: top.period,
  onChange: (val) => {
    top.period = val;
    loadTop();
  },
});
$("#top-period-container").replaceChildren(topPeriodSelect.el);

// ── Grid rendering (artists / albums) ────────────────────────────────
const renderGrid = (items, type) => {
  const box = $("#top-list");
  if (type === "tracks") {
    const max = items[0]?.plays || 1;
    box.className = "list";
    box.replaceChildren(...items.map((t, i) => trackRow(t, items, i, fmt.format(t.plays), t.plays / max)));
    if (!items.length) box.replaceChildren(h("li", { class: "empty" }, "Даних за цей період немає"));
    markActive();
    return;
  }
  box.className = "";
  const grid = h("div", { class: "grid-top" });
  grid.append(...items.map((item, i) => {
    const onCardClick = () => {
      if (type === "artists") {
        location.hash = artistHref(item.artist);
      } else {
        playList(items.map((x) => ({ artist: x.artist, title: x.title || "" })), i);
      }
    };

    const imgWrap = h("div", { class: "grid-card-ph" }, icon("note"));
    imgWrap.dataset.pending = "1";

    const label = type === "albums"
      ? h("div", { class: "grid-card-info" },
          h("b", { title: item.title }, item.title),
          h("span", {}, h("a", {
            class: "artist-link",
            href: artistHref(item.artist),
            onclick: (e) => e.stopPropagation(),
          }, item.artist)),
          h("span", {}, `${fmt.format(item.plays)} скроблів`),
        )
      : h("div", { class: "grid-card-info" },
          h("b", { title: item.artist }, item.artist),
          h("span", {}, `${fmt.format(item.plays)} скроблів`),
        );

    const card = h("div", {
      class: "grid-card", tabindex: 0, role: "button",
      onclick: onCardClick,
      onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onCardClick(); } },
    }, imgWrap, label);

    if (type === "artists") {
      const tryImg = item.img
        ? Promise.resolve(item.img)
        : getArtistImage(item.artist, item.mbid);

      tryImg.then((url) => {
        if (!url || !imgWrap.dataset.pending) return;
        const img = h("img", { class: "grid-card-img", src: url, alt: "", loading: "lazy" });
        img.onerror = () => {};
        imgWrap.replaceWith(img);
      }).catch(() => {});
    } else if (item.img) {
      const img = h("img", { class: "grid-card-img", src: item.img, alt: "", loading: "lazy" });
      imgWrap.replaceWith(img);
    }

    return card;
  }));
  if (!items.length) grid.append(h("p", { class: "empty" }, "Даних за цей період немає"));
  box.replaceChildren(grid);
};

// ── Load data ─────────────────────────────────────────────────────────
const loadRecent = async () => {
  if (document.hidden) return;
  try {
    const data = await lfm("user.getRecentTracks", { limit: 15 });
    const tracks = asArray(data.recenttracks.track).map(normalize.recent);
    renderNow(tracks[0]);
    const finished = tracks.filter((t) => !t.live);
    fillList("#recent", finished.map((t, i) => trackRow(t, finished, i, ago(t.ts))), "Порожньо");
    markActive();
  } catch (err) {
    toast(err.message);
  }
};

const loadTop = async () => {
  const { type, period } = top;
  const cfg = TOP[type];
  const box = $("#top-list");
  box.className = "list";
  box.replaceChildren(h("li", { class: "empty" }, "Завантаження…"));
  try {
    const raw = await lfm(cfg.method, { period, limit: 24 });
    const items = asArray(cfg.items(raw)).map(cfg.map);
    renderGrid(items, type);
  } catch (err) {
    box.className = "list";
    box.replaceChildren(h("li", { class: "empty" }, err.message));
  }
};

const loadRecs = async () => {
  fillList("#recs", [], "Шукаємо схожі треки…");
  try {
    const data = await lfm("user.getTopTracks", { period: "3month", limit: 40 });
    const topTracks = asArray(data.toptracks.track).map(normalize.track);
    const known = new Set(topTracks.map((t) => key(t.artist, t.title)));

    const settled = await Promise.allSettled(
      shuffle(topTracks).slice(0, 6).map((s) =>
        lfm("track.getSimilar", { artist: s.artist, track: s.title, limit: 10, autocorrect: 1 })),
    );

    const found = new Map();
    for (const result of settled) {
      if (result.status !== "fulfilled") continue;
      for (const t of asArray(result.value.similartracks?.track)) {
        const k = key(t.artist.name, t.name);
        if (known.has(k) || found.has(k)) continue;
        found.set(k, { artist: t.artist.name, title: t.name, img: cover(t.image), match: Number(t.match) });
      }
    }

    recs = [...found.values()].sort((a, b) => b.match - a.match).slice(0, 30);
    fillList("#recs",
      recs.map((t, i) => trackRow(t, recs, i, `${Math.round(t.match * 100)}%`)),
      "Не вдалося знайти схожі треки");
    markActive();
  } catch (err) {
    fillList("#recs", [], err.message);
  }
};

// ── Infinite stream ───────────────────────────────────────────────────
let streamMode = null;
let streamTracks = [];

const STREAM_SOURCES = {
  library: async () => {
    const data = await lfm("user.getTopTracks", { period: "overall", limit: 200 });
    return shuffle(asArray(data.toptracks.track).map(normalize.track));
  },
  mix: async () => {
    const [topData, lovedData] = await Promise.all([
      lfm("user.getTopTracks", { period: "overall", limit: 50 }),
      lfm("user.getLovedTracks", { limit: 50 }).catch(() => null),
    ]);
    const topItems = asArray(topData.toptracks.track).map(normalize.track);
    const lovedItems = asArray(lovedData?.lovedtracks?.track).map((t) => ({
      artist: t.artist.name, title: t.name, img: cover(t.image),
    }));
    const seeds = shuffle([...topItems, ...lovedItems]).slice(0, 6);
    const settled = await Promise.allSettled(
      seeds.map((s) => lfm("track.getSimilar", { artist: s.artist, track: s.title, limit: 12, autocorrect: 1 })),
    );
    const extra = [];
    const known = new Set(topItems.map((t) => key(t.artist, t.title)));
    for (const r of settled) {
      if (r.status !== "fulfilled") continue;
      for (const t of asArray(r.value.similartracks?.track)) {
        const k = key(t.artist.name, t.name);
        if (!known.has(k)) {
          extra.push({ artist: t.artist.name, title: t.name, img: cover(t.image) });
          known.add(k);
        }
      }
    }
    return shuffle([...topItems, ...lovedItems, ...extra]);
  },
  recs: async () => {
    if (!recs.length) await loadRecs();
    return shuffle([...recs]);
  },
};

const startStream = async (mode) => {
  streamMode = mode;
  const titles = { library: "Бібліотека", mix: "Мікс", recs: "Рекомендації" };
  try {
    toast(`Запуск потоку: ${titles[mode]}…`);
    streamTracks = await STREAM_SOURCES[mode]();
    if (!streamTracks.length) return toast("Не вдалося знайти треки");
    playList(streamTracks, 0);
  } catch (err) {
    toast(err.message);
  }
};

const refillStream = async () => {
  if (!streamMode) return;
  try {
    const more = await STREAM_SOURCES[streamMode]();
    if (more.length) appendToQueue(more);
  } catch { /* silent */ }
};

["library", "mix", "recs"].forEach((mode) => {
  const el = $(`#stream-${mode}`);
  if (el) el.addEventListener("click", () => startStream(mode));
});

// ── Settings & auth ───────────────────────────────────────────────────
const dialog = $("#settings");
const form = $("#settings-form");
const formValues = () => Object.fromEntries(new FormData(form));

const openSettings = () => {
  for (const name of ["user", "lfmKey"]) form.elements[name].value = config[name] ?? "";
  form.elements.lfmSecret.value = "";
  form.elements.lfmSecret.placeholder = config.hasSecret ? "Збережено у localStorage — залиш порожнім" : "";
  $("#auth-finish").hidden = !sessionStorage.getItem("scrobble-deck:pendingToken");
  renderScrobbleState();
  dialog.showModal();
};

form.addEventListener("submit", async (e) => {
  if (e.submitter?.value !== "save") return;
  try {
    await saveConfig(formValues());
  } catch (err) {
    return toast(err.message);
  }
  start();
});

$("#auth-start").addEventListener("click", async () => {
  try {
    await saveConfig(formValues());
    const { url } = await startAuth();
    window.open(url, "_blank", "noopener");
    $("#auth-finish").hidden = false;
    toast("Дозволь доступ на сторінці Last.fm і натисни «Завершити»");
  } catch (err) {
    toast(err.message);
  }
});

$("#auth-finish").addEventListener("click", async () => {
  try {
    await finishAuth();
    $("#auth-finish").hidden = true;
    renderScrobbleState();
    toast("Last.fm підключено — відтворені треки скроблитимуться");
    start();
  } catch (err) {
    toast(err.message);
  }
});

// Експорт та імпорт конфігурації
$("#export-config")?.addEventListener("click", () => {
  const exportData = {
    user: config.user,
    lfmKey: config.lfmKey,
    lfmSecret: config.lfmSecret,
    sk: config.sk,
  };
  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `scrobble-deck-config-${config.user || "backup"}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast("Конфігурацію експортовано у файл");
});

const importFile = $("#import-file");
$("#import-config")?.addEventListener("click", () => importFile?.click());
importFile?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    await saveConfig(data);
    openSettings();
    toast("Конфігурацію успішно імпортовано! ✅");
    start();
  } catch (err) {
    toast(`Помилка імпорту: ${err.message}`);
  }
  importFile.value = "";
});

$("#settings-cancel").addEventListener("click", () => dialog.close("cancel"));
$("#open-settings").addEventListener("click", openSettings);
$("#scrobble-chip").addEventListener("click", openSettings);

// ── Top controls ──────────────────────────────────────────────────────
$("#recs-refresh").addEventListener("click", loadRecs);
$("#recs-play").addEventListener("click", () => recs.length && playList(recs, 0));

$("#top-tabs").addEventListener("click", ({ target }) => {
  const { type } = target.dataset;
  if (!type) return;
  top.type = type;
  for (const btn of $("#top-tabs").children) btn.setAttribute("aria-pressed", String(btn === target));
  loadTop();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && config.user) {
    loadRecent();
    renderStats();
  }
});

// ── SPA Router ────────────────────────────────────────────────────────
const handleRoute = () => {
  const hash = location.hash.replace(/^#/, "") || "/";
  const [path, queryString] = hash.split("?");
  const qParams = new URLSearchParams(queryString || "");

  // Update nav links active status
  document.querySelectorAll("#appbar-nav .nav-link").forEach((link) => {
    const route = link.dataset.route;
    if (path === "/" || path === "") {
      link.classList.toggle("active", route === "home");
    } else if (path.startsWith("/loved")) {
      link.classList.toggle("active", route === "loved");
    } else if (path.startsWith("/library")) {
      link.classList.toggle("active", route === "library");
    } else {
      link.classList.remove("active");
    }
  });

  const viewHome = $("#view-home");
  const viewSub = $("#view-sub");
  const subContent = $("#spa-sub-content");
  const miniBar = $("#mini-player-bar");

  if (path === "/" || path === "") {
    viewHome.hidden = false;
    viewSub.hidden = true;
    if (miniBar) miniBar.hidden = true;
    document.title = "Scrobble Deck";
    updateNowCoverIcon();
  } else {
    viewHome.hidden = true;
    viewSub.hidden = false;
    viewSub.scrollTop = 0;
    if (miniBar && currentTrack()) {
      miniBar.hidden = false;
      updateMiniPlayerBar();
    }

    if (path.startsWith("/loved")) {
      document.title = "Улюблені — Scrobble Deck";
      mountLovedView(subContent);
    } else if (path.startsWith("/library")) {
      document.title = "Бібліотека — Scrobble Deck";
      const initialTab = qParams.get("tab") || "recent";
      mountLibraryView(subContent, initialTab);
    } else if (path.startsWith("/artist")) {
      const artistName = qParams.get("name") || "";
      document.title = `${artistName || "Виконавець"} — Scrobble Deck`;
      mountArtistView(subContent, artistName);
    }
  }
};

window.addEventListener("hashchange", handleRoute);

// Mini-player click to return home
$("#mini-go-home")?.addEventListener("click", () => {
  location.hash = "#/";
});

// ── Start ─────────────────────────────────────────────────────────────
const start = async () => {
  clearInterval(pollId);
  clearInterval(statsId);
  renderScrobbleState();
  if (!config.user || !config.lfmKey) return openSettings();

  try {
    await renderStats();
  } catch (err) {
    toast(err.message);
    return openSettings();
  }

  await Promise.all([loadRecent(), loadTop(), loadRecs()]);

  pollId = setInterval(loadRecent, POLL_MS);
  statsId = setInterval(renderStats, STATS_POLL_MS);
};

initPlayer({
  onChange: markActive,
  onScrobbled: () => { loadRecent(); renderStats(); },
  onQueueLow: refillStream,
});

try {
  await loadConfig();
} catch {}

start();
handleRoute();
