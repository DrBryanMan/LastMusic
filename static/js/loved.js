import {
  $, h, fmt, ago, asArray, cover, toast, icon, trackCoverEl, artistHref, key,
  setTrackLoved, syncLovedTracks,
} from "./utils.js";
import { config, lfm, unloveTrack } from "./lastfm.js";
import { playList, activeKey } from "./player.js";

const PAGE_LIMIT = 48;
let page = 1;
let totalPages = 1;
let totalTracks = 0;
let tracks = [];
let viewMode = localStorage.getItem("scrobble-deck:loved-view") || "list"; // 'list' | 'grid'

const normalizeLoved = (t) => ({
  artist: t.artist.name,
  title: t.name,
  img: cover(t.image),
  ts: t.date?.uts ? Number(t.date.uts) : null,
});

export const mountLovedView = (container) => {
  page = 1;
  tracks = [];

  container.innerHTML = "";

  const card = h("div", { class: "card subpage-card" });

  // Header toolbar
  const header = h("div", { class: "tabs-header" });
  const titleGroup = h("div", { style: "display:flex;align-items:center;gap:12px;" },
    h("h2", { style: "padding:0;margin:0;" }, "Улюблені пісні"),
    h("span", { id: "loved-count", style: "font-size:13px;color:var(--text-2);" }, "Завантаження…"),
  );

  const actionsGroup = h("div", { style: "display:flex;align-items:center;gap:10px;margin-left:auto;" });

  const viewSwitch = h("div", { class: "view-switch" },
    h("button", {
      class: viewMode === "list" ? "active" : "",
      title: "Список",
      onclick: () => switchView("list"),
    }, h("svg", { class: "i" }, h("use", { href: "#i-list" }))),
    h("button", {
      class: viewMode === "grid" ? "active" : "",
      title: "Сітка",
      onclick: () => switchView("grid"),
    }, h("svg", { class: "i" }, h("use", { href: "#i-grid" }))),
  );

  const playAllBtn = h("button", {
    class: "btn accent sm",
    onclick: () => tracks.length && playList(tracks, 0),
  }, icon("play"), "Грати всі");

  actionsGroup.append(viewSwitch, playAllBtn);
  header.append(titleGroup, actionsGroup);

  const contentBox = h("div", { id: "loved-content-box" });
  const paginationEl = h("div", { class: "pagination", id: "loved-pagination" });

  card.append(header, contentBox, paginationEl);
  container.append(card);

  const switchView = (mode) => {
    viewMode = mode;
    localStorage.setItem("scrobble-deck:loved-view", mode);
    for (const b of viewSwitch.children) {
      b.classList.toggle("active", b.title === (mode === "list" ? "Список" : "Сітка"));
    }
    renderContent();
  };

  const handleUnlove = async (t, e) => {
    e.stopPropagation();
    if (!config.authorized) return toast("Потрібна авторизація Last.fm у налаштуваннях");
    try {
      await unloveTrack(t.artist, t.title);
      setTrackLoved(t.artist, t.title, false);
      tracks = tracks.filter((x) => key(x.artist, x.title) !== key(t.artist, t.title));
      totalTracks = Math.max(0, totalTracks - 1);
      $("#loved-count") && ($("#loved-count").textContent = `${fmt.format(totalTracks)} треків`);
      toast(`«${t.title}» видалено з улюблених`);
      renderContent();
    } catch (err) {
      toast(`Помилка: ${err.message}`);
    }
  };

  const renderContent = () => {
    if (!tracks.length) {
      contentBox.replaceChildren(h("p", { class: "empty" }, "Улюблених треків не знайдено"));
      return;
    }

    if (viewMode === "list") {
      const ul = h("ul", { class: "list" });
      ul.append(...tracks.map((t, i) => {
        const play = () => playList(tracks, i);
        const thumbEl = trackCoverEl(t, "thumb", lfm);

        const unloveBtn = h("button", {
          class: "btn icon",
          title: "Видалити з улюблених",
          onclick: (e) => handleUnlove(t, e),
          style: "color:var(--text-3);transition:color .15s;",
          onmouseenter: (e) => { e.currentTarget.style.color = "#f43f5e"; },
          onmouseleave: (e) => { e.currentTarget.style.color = "var(--text-3)"; },
        }, h("svg", { class: "i" }, h("use", { href: "#i-trash" })));

        return h("li", {
          class: "row", tabindex: 0, role: "button",
          "data-key": key(t.artist, t.title),
          onclick: play,
          onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); play(); } },
        },
          thumbEl,
          h("div", { class: "meta" },
            h("b", {}, t.title),
            h("span", {}, h("a", {
              class: "artist-link",
              href: artistHref(t.artist),
              onclick: (e) => e.stopPropagation(),
            }, t.artist)),
          ),
          t.ts && h("span", { class: "tag" }, ago(t.ts)),
          unloveBtn,
          h("button", {
            class: "btn icon", "aria-label": "Грати",
            onclick: (e) => { e.stopPropagation(); play(); },
          }, icon("play")),
        );
      }));
      contentBox.replaceChildren(ul);
    } else {
      // Grid view
      const grid = h("div", { class: "grid-tracks" });
      grid.append(...tracks.map((t, i) => {
        const play = () => playList(tracks, i);
        const thumbEl = trackCoverEl(t, "grid-track-thumb", lfm);

        const unloveBtn = h("button", {
          class: "btn icon sm",
          title: "Видалити з улюблених",
          onclick: (e) => handleUnlove(t, e),
          style: "color:var(--text-3);",
          onmouseenter: (e) => { e.currentTarget.style.color = "#f43f5e"; },
          onmouseleave: (e) => { e.currentTarget.style.color = "var(--text-3)"; },
        }, h("svg", { class: "i" }, h("use", { href: "#i-trash" })));

        return h("div", {
          class: "grid-track-card", tabindex: 0, role: "button",
          "data-key": key(t.artist, t.title),
          onclick: play,
          onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); play(); } },
        },
          h("div", { class: "grid-track-thumb-wrap" },
            thumbEl,
            h("div", { class: "grid-track-play-btn" }, icon("play")),
          ),
          h("div", { class: "grid-track-info" },
            h("b", { title: t.title }, t.title),
            h("span", {}, h("a", {
              class: "artist-link",
              href: artistHref(t.artist),
              onclick: (e) => e.stopPropagation(),
            }, t.artist)),
          ),
          h("div", { class: "grid-track-bottom" },
            t.ts ? h("span", { class: "tag" }, ago(t.ts)) : h("span", {}),
            unloveBtn,
          ),
        );
      }));
      contentBox.replaceChildren(grid);
    }
  };

  const renderPagination = () => {
    if (totalPages <= 1) { paginationEl.replaceChildren(); return; }

    const items = [];
    const btn = (label, p, disabled = false) => h("button", {
      class: "btn sm" + (p === page ? " accent" : ""),
      disabled: disabled || undefined,
      onclick: () => {
        if (p !== page) {
          page = p;
          loadPage();
          $("#view-sub")?.scrollTo({ top: 0, behavior: "smooth" });
          window.scrollTo({ top: 0, behavior: "smooth" });
        }
      },
    }, label);

    items.push(btn("←", page - 1, page === 1));

    const start = Math.max(1, page - 2);
    const end = Math.min(totalPages, page + 2);
    if (start > 1) { items.push(btn("1", 1)); if (start > 2) items.push(h("span", {}, "…")); }
    for (let p = start; p <= end; p++) items.push(btn(String(p), p));
    if (end < totalPages) {
      if (end < totalPages - 1) items.push(h("span", {}, "…"));
      items.push(btn(String(totalPages), totalPages));
    }

    items.push(btn("→", page + 1, page === totalPages));
    paginationEl.replaceChildren(...items);
  };

  const loadPage = async () => {
    contentBox.replaceChildren(h("p", { class: "empty" }, "Завантаження…"));
    try {
      const data = await lfm("user.getLovedTracks", { limit: PAGE_LIMIT, page });
      const attr = data.lovedtracks?.["@attr"] || {};
      totalPages = Number(attr.totalPages || 1);
      totalTracks = Number(attr.total || 0);
      tracks = asArray(data.lovedtracks?.track).map(normalizeLoved);
      syncLovedTracks(tracks);

      $("#loved-count") && ($("#loved-count").textContent = `${fmt.format(totalTracks)} треків (сторінка ${page} з ${totalPages})`);
      renderContent();
      renderPagination();
    } catch (err) {
      contentBox.replaceChildren(h("p", { class: "empty" }, err.message));
      toast(err.message);
    }
  };

  if (!config.user || !config.lfmKey) {
    contentBox.replaceChildren(
      h("p", { class: "empty" }, "Налаштуй ім'я користувача та API key у налаштуваннях"),
    );
  } else {
    loadPage();
  }
};
