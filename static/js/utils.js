const SVG_NS = "http://www.w3.org/2000/svg";
const PLACEHOLDER_HASH = "2a96cbd8b46e442fc41c2b86b821562f"; // зірочка-заглушка Last.fm

export const $ = (selector, root = document) => root.querySelector(selector);
export const fmt = new Intl.NumberFormat("uk-UA");
const rtf = new Intl.RelativeTimeFormat("uk", { numeric: "auto" });

// ── Мережа ──────────────────────────────────────────────────────────
export const fetchJSON = async (url, init) => (await fetch(url, init)).json();

// ── Сховище ─────────────────────────────────────────────────────────
export const readJSON = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback; }
  catch { return fallback; }
};
export const writeJSON = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* квота */ }
};

// ── DOM ─────────────────────────────────────────────────────────────
const SVG_TAGS = new Set(["svg", "use", "path", "circle", "rect", "g", "line", "polyline", "polygon"]);

export const h = (tag, props = {}, ...kids) => {
  const isSvg = SVG_TAGS.has(tag);
  const el = isSvg ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (name.startsWith("on")) el.addEventListener(name.slice(2), value);
    else if (name === "class") {
      if (isSvg) el.setAttribute("class", value);
      else el.className = value;
    }
    else if (value != null && value !== false) el.setAttribute(name, value === true ? "" : value);
  }
  el.append(...kids.flat().filter((k) => k != null && k !== false));
  return el;
};

export const icon = (name) => {
  const svg = document.createElementNS(SVG_NS, "svg");
  const use = document.createElementNS(SVG_NS, "use");
  svg.setAttribute("class", "i");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
};

let toastTimer;
export const toast = (message) => {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 4000);
};

// ── Дані ────────────────────────────────────────────────────────────
export const asArray = (value) => (value == null ? [] : [value].flat());
export const key = (artist, title) => `${artist}\u0000${title}`.toLowerCase();
export const query = ({ artist, title }) => `${artist} ${title}`.trim();

// Fisher–Yates: `sort(() => Math.random() - .5)` дає нерівномірне перемішування
export const shuffle = (list) => {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};

export const ago = (ts) => {
  const sec = Math.round(ts - Date.now() / 1000);
  const [value, unit] =
    Math.abs(sec) < 3600 ? [Math.round(sec / 60), "minute"]
    : Math.abs(sec) < 86400 ? [Math.round(sec / 3600), "hour"]
    : [Math.round(sec / 86400), "day"];
  return rtf.format(value, unit);
};

export const cover = (images = [], size = "extralarge") => {
  const url = (images.find((i) => i.size === size) ?? images.at(-1))?.["#text"];
  return url && !url.includes(PLACEHOLDER_HASH) ? url : null;
};

export const coverEl = (url, cls) =>
  url ? h("img", { class: cls, src: url, alt: "", loading: "lazy" }) : h("div", { class: `${cls} ph` }, icon("note"));

export const artistHref = (artist) => `#/artist?name=${encodeURIComponent(artist)}`;

// ── Custom Acrylic Select Component ──────────────────────────────────
export const createCustomSelect = ({ options, value, onChange }) => {
  let currentVal = value;
  const container = h("div", { class: "custom-select" });
  const labelEl = h("span", {}, options.find((o) => o.value === currentVal)?.label || currentVal);
  const trigger = h("button", {
    type: "button",
    class: "custom-select-trigger",
    onclick: (e) => {
      e.stopPropagation();
      const isOpen = container.classList.contains("open");
      document.querySelectorAll(".custom-select.open").forEach((el) => el.classList.remove("open"));
      if (!isOpen) container.classList.add("open");
    },
  },
    labelEl,
    h("svg", { class: "i chevron" }, h("use", { href: "#i-chevron-down" })),
  );

  const menu = h("div", { class: "custom-select-menu" });

  const renderOptions = () => {
    menu.replaceChildren(...options.map((opt) =>
      h("div", {
        class: "custom-select-option" + (opt.value === currentVal ? " selected" : ""),
        onclick: (e) => {
          e.stopPropagation();
          currentVal = opt.value;
          labelEl.textContent = opt.label;
          container.classList.remove("open");
          renderOptions();
          onChange(currentVal);
        },
      }, opt.label),
    ));
  };
  renderOptions();

  container.append(trigger, menu);

  // Click outside listener
  const onDocClick = (e) => {
    if (!container.contains(e.target)) container.classList.remove("open");
  };
  document.addEventListener("click", onDocClick);

  return {
    el: container,
    setValue: (newVal) => {
      currentVal = newVal;
      labelEl.textContent = options.find((o) => o.value === currentVal)?.label || currentVal;
      renderOptions();
    },
    getValue: () => currentVal,
  };
};

// ── Loved tracks local cache ─────────────────────────────────────────
const LS_LOVED = "scrobble-deck:loved-tracks";
const lovedSet = new Set(readJSON(LS_LOVED, []));

export const isTrackLoved = (artist, title) => {
  if (!artist || !title) return false;
  return lovedSet.has(key(artist, title));
};

export const setTrackLoved = (artist, title, loved) => {
  if (!artist || !title) return;
  const k = key(artist, title);
  if (loved) lovedSet.add(k);
  else lovedSet.delete(k);
  writeJSON(LS_LOVED, [...lovedSet]);
};

export const syncLovedTracks = (tracks) => {
  for (const t of tracks) {
    if (t.artist && t.title) lovedSet.add(key(t.artist, t.title));
  }
  writeJSON(LS_LOVED, [...lovedSet]);
};

// ── Artist & Track image resolution ──────────────────────────────────
// Last.fm публічний API не повертає фото виконавців і часто не дає обкладинку в getTopTracks / getLovedTracks.
// Кешуємо знайдені URL у localStorage на 14 днів.
const LS_ART = "scrobble-deck:artist-img-v2";
const LS_TRK = "scrobble-deck:track-img-v2";
const IMG_TTL = 14 * 24 * 3600 * 1000;

const loadStore = (k) => {
  try { return JSON.parse(localStorage.getItem(k) ?? "{}"); } catch { return {}; }
};
const saveStore = (k, store) => {
  try { localStorage.setItem(k, JSON.stringify(store)); } catch { /* квота */ }
};

const artStore = loadStore(LS_ART);
const trkStore = loadStore(LS_TRK);
const inflightArt = new Map();
const inflightTrk = new Map();

const MB_UA = "ScrobbleDeck/1.0 (personal-use)";

async function resolveArtistImg(name, mbid) {
  // 1. TheAudioDB
  try {
    const res = await fetch(
      `https://www.theaudiodb.com/api/v1/json/2/search.php?s=${encodeURIComponent(name)}`
    );
    const data = await res.json();
    const url = data?.artists?.[0]?.strArtistThumb;
    if (url) return url;
  } catch { /* далі */ }

  // 2. MusicBrainz → Wikidata → Wikimedia Commons
  if (mbid) {
    try {
      const mbRes = await fetch(
        `https://musicbrainz.org/ws/2/artist/${mbid}?inc=url-rels&fmt=json`,
        { headers: { "User-Agent": MB_UA } }
      );
      const mbData = await mbRes.json();
      const wdRel = mbData.relations?.find((r) => r.type === "wikidata");
      if (wdRel) {
        const wdId = wdRel.url.resource.split("/").pop();
        const wdRes = await fetch(
          `https://www.wikidata.org/w/api.php?action=wbgetclaims&entity=${wdId}&property=P18&format=json&origin=*`
        );
        const wdData = await wdRes.json();
        const imgName = wdData?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
        if (imgName) {
          return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(imgName)}?width=300`;
        }
      }
    } catch { /* далі */ }
  }

  // 3. iTunes Search API — обкладинка найпопулярнішого релізу виконавця
  try {
    const res = await fetch(
      `https://itunes.apple.com/search?term=${encodeURIComponent(name)}&entity=album&limit=1`
    );
    const data = await res.json();
    const art = data?.results?.[0]?.artworkUrl100;
    if (art) return art.replace("100x100bb", "300x300bb");
  } catch { /* далі */ }

  return null;
}

export const getArtistImage = async (name, mbid = "") => {
  if (!name) return null;
  const k = name.toLowerCase();
  const cached = artStore[k];
  if (cached && Date.now() - cached.ts < IMG_TTL) return cached.url;
  if (inflightArt.has(k)) return inflightArt.get(k);

  const p = resolveArtistImg(name, mbid).then((url) => {
    artStore[k] = { url, ts: Date.now() };
    saveStore(LS_ART, artStore);
    inflightArt.delete(k);
    return url;
  });
  inflightArt.set(k, p);
  return p;
};

async function resolveTrackImg(artist, title, lfmFn) {
  // 1. Last.fm track.getInfo → album.image
  if (lfmFn) {
    try {
      const data = await lfmFn("track.getInfo", { artist, track: title, autocorrect: 1 });
      const url = cover(data?.track?.album?.image);
      if (url) return url;
    } catch { /* далі */ }
  }

  // 2. iTunes Search API — обкладинка альбому треку
  try {
    const q = `${artist} ${title}`.trim();
    const res = await fetch(
      `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=song&limit=1`
    );
    const data = await res.json();
    const art = data?.results?.[0]?.artworkUrl100;
    if (art) return art.replace("100x100bb", "300x300bb");
  } catch { /* далі */ }

  return null;
}

export const getTrackImage = async (artist, title, lfmFn) => {
  if (!artist || !title) return null;
  const k = key(artist, title);
  const cached = trkStore[k];
  if (cached && Date.now() - cached.ts < IMG_TTL) return cached.url;
  if (inflightTrk.has(k)) return inflightTrk.get(k);

  const p = resolveTrackImg(artist, title, lfmFn).then((url) => {
    trkStore[k] = { url, ts: Date.now() };
    saveStore(LS_TRK, trkStore);
    inflightTrk.delete(k);
    return url;
  });
  inflightTrk.set(k, p);
  return p;
};

// Створює DOM-елемент обкладинки треку з автоматичним підвантаженням обкладинки альбому
export const trackCoverEl = (track, cls, lfmFn) => {
  if (track.img) {
    return h("img", { class: cls, src: track.img, alt: "", loading: "lazy" });
  }
  const k = track.artist && track.title ? key(track.artist, track.title) : null;
  const cachedUrl = k && trkStore[k] && (Date.now() - trkStore[k].ts < IMG_TTL) ? trkStore[k].url : null;
  if (cachedUrl) {
    track.img = cachedUrl;
    return h("img", { class: cls, src: cachedUrl, alt: "", loading: "lazy" });
  }
  const ph = h("div", { class: `${cls} ph` }, icon("note"));
  if (track.artist && track.title) {
    getTrackImage(track.artist, track.title, lfmFn).then((url) => {
      if (!url) return;
      track.img = url;
      const img = h("img", { class: cls, src: url, alt: "", loading: "lazy" });
      img.onerror = () => {};
      ph.replaceWith(img);
    }).catch(() => {});
  }
  return ph;
};