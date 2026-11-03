import {
  $, h, fmt, ago, asArray, toast, icon, getArtistImage, trackCoverEl, artistHref, key,
  createCustomSelect, isTrackLoved, setTrackLoved,
} from "./utils.js";
import { config, lfm, lfmSearch, loveTrack, unloveTrack, normalize, TOP } from "./lastfm.js";
import { playList } from "./player.js";

const PAGE_SIZE = 48;

const PERIOD_OPTIONS = [
  { value: "overall", label: "Увесь час" },
  { value: "12month", label: "Рік" },
  { value: "6month", label: "6 місяців" },
  { value: "3month", label: "3 місяці" },
  { value: "1month", label: "Місяць" },
  { value: "7day", label: "7 днів" },
];

export const mountLibraryView = (container, initialTab = "recent") => {
  let currentTab = ["recent", "tracks", "artists", "albums"].includes(initialTab) ? initialTab : "recent";
  let currentPeriod = "overall";
  let searchQuery = "";
  let searchTimeout = null;
  let page = 1;
  let totalPages = 1;
  let totalItems = 0;
  let items = [];
  let viewMode = localStorage.getItem("scrobble-deck:lib-view") || "list"; // 'list' | 'grid'

  container.innerHTML = "";

  const card = h("div", { class: "card subpage-card" });

  // Toolbar
  const headerBar = h("div", { class: "lib-header-bar" });

  // Left: Search
  const searchWrap = h("div", { class: "lib-header-left" },
    h("input", {
      type: "search",
      placeholder: "Глобальний пошук через Last.fm…",
      class: "search-input",
      style: "width:100%;padding:6px 12px;background:var(--subtle);border:1px solid var(--stroke);border-radius:var(--radius-s);color:var(--text);font-size:13px;outline:none;",
      oninput: (e) => {
        searchQuery = e.target.value;
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
          page = 1;
          loadData();
        }, 350);
      },
    }),
  );

  // Right: Tabs, Period select, View switcher, Count
  const rightGroup = h("div", { class: "lib-header-right" });

  const tabsGroup = h("div", { class: "tabs" },
    h("button", { class: "tab" + (currentTab === "recent" ? " active" : ""), "data-tab": "recent" }, "Всі скроблі"),
    h("button", { class: "tab" + (currentTab === "artists" ? " active" : ""), "data-tab": "artists" }, "Виконавці"),
    h("button", { class: "tab" + (currentTab === "albums" ? " active" : ""), "data-tab": "albums" }, "Альбоми"),
    h("button", { class: "tab" + (currentTab === "tracks" ? " active" : ""), "data-tab": "tracks" }, "Треки"),
  );

  const periodSelect = createCustomSelect({
    options: PERIOD_OPTIONS,
    value: currentPeriod,
    onChange: (val) => {
      currentPeriod = val;
      page = 1;
      loadData();
    },
  });

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

  rightGroup.append(tabsGroup, periodSelect.el, viewSwitch);
  headerBar.append(searchWrap, rightGroup);

  // Subheader: Total results count
  const subBar = h("div", {
    style: "display:flex;align-items:center;justify-content:space-between;padding:8px 16px;border-bottom:1px solid var(--stroke);font-size:13px;color:var(--text-2);background:color-mix(in srgb, var(--subtle) 40%, transparent);",
  },
    h("span", { id: "lib-count-label" }, "Завантаження…"),
    h("button", {
      class: "btn sm",
      style: "font-size:12px;",
      onclick: () => items.length && playList(items, 0),
    }, icon("play"), "Грати цю сторінку"),
  );

  const contentBox = h("div", { id: "lib-content-box", style: "min-height:360px;" });
  const paginationEl = h("div", { class: "pagination", id: "lib-pagination" });

  card.append(headerBar, subBar, contentBox, paginationEl);
  container.append(card);

  // Event handlers
  const switchView = (mode) => {
    viewMode = mode;
    localStorage.setItem("scrobble-deck:lib-view", mode);
    for (const b of viewSwitch.children) {
      b.classList.toggle("active", b.title === (mode === "list" ? "Список" : "Сітка"));
    }
    renderContent();
  };

  tabsGroup.addEventListener("click", ({ target }) => {
    const btn = target.closest("button.tab");
    if (!btn) return;
    const tab = btn.dataset.tab;
    if (!tab || tab === currentTab) return;
    currentTab = tab;
    for (const b of tabsGroup.children) b.classList.toggle("active", b === btn);
    periodSelect.el.style.display = currentTab === "recent" ? "none" : "inline-block";
    page = 1;
    loadData();
  });
  periodSelect.el.style.display = currentTab === "recent" ? "none" : "inline-block";

  const handleToggleLove = async (t, btn, e) => {
    e.stopPropagation();
    if (!config.authorized) return toast("Потрібна авторизація Last.fm у налаштуваннях");
    const loved = isTrackLoved(t.artist, t.title);
    try {
      if (loved) {
        await unloveTrack(t.artist, t.title);
        setTrackLoved(t.artist, t.title, false);
        btn.classList.remove("loved");
        toast(`«${t.title}» видалено з улюблених`);
      } else {
        await loveTrack(t.artist, t.title);
        setTrackLoved(t.artist, t.title, true);
        btn.classList.add("loved");
        toast(`«${t.title}» додано в улюблені! ❤️`);
      }
    } catch (err) {
      toast(`Помилка: ${err.message}`);
    }
  };

  const renderContent = () => {
    if (!items.length) {
      contentBox.replaceChildren(h("p", { class: "empty" }, searchQuery ? "Нічого не знайдено за пошуком" : "Порожньо"));
      return;
    }

    if (currentTab === "recent" || currentTab === "tracks") {
      if (viewMode === "list") {
        const ul = h("ul", { class: "list" });
        const max = items[0]?.plays || 1;
        ul.append(...items.map((t, i) => {
          const play = () => playList(items, i);
          const thumbEl = trackCoverEl(t, "thumb", lfm);
          const loved = isTrackLoved(t.artist, t.title);

          const loveBtn = h("button", {
            class: "btn icon btn-love" + (loved ? " loved" : ""),
            title: loved ? "В улюблених (натисни щоб прибрати)" : "Додати в улюблені",
            onclick: (e) => handleToggleLove(t, loveBtn, e),
          }, h("svg", { class: "i" }, h("use", { href: "#i-heart" })));

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
            t.ts ? h("span", { class: "tag" }, ago(t.ts)) : (t.plays ? h("span", { class: "tag" }, `${fmt.format(t.plays)} скроблів`) : null),
            t.plays && max ? h("i", { class: "bar", style: `--w:${((t.plays / max) * 100).toFixed(1)}%` }) : null,
            loveBtn,
            h("button", {
              class: "btn icon", "aria-label": "Грати",
              onclick: (e) => { e.stopPropagation(); play(); },
            }, icon("play")),
          );
        }));
        contentBox.replaceChildren(ul);
      } else {
        // Grid view for tracks / scrobbles
        const grid = h("div", { class: "grid-tracks" });
        grid.append(...items.map((t, i) => {
          const play = () => playList(items, i);
          const thumbEl = trackCoverEl(t, "grid-track-thumb", lfm);
          const loved = isTrackLoved(t.artist, t.title);

          const loveBtn = h("button", {
            class: "btn icon sm btn-love" + (loved ? " loved" : ""),
            title: loved ? "В улюблених" : "Додати в улюблені",
            onclick: (e) => handleToggleLove(t, loveBtn, e),
          }, h("svg", { class: "i" }, h("use", { href: "#i-heart" })));

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
              t.ts ? h("span", { class: "tag" }, ago(t.ts)) : (t.plays ? h("span", { class: "tag" }, `${fmt.format(t.plays)}`) : h("span", {})),
              loveBtn,
            ),
          );
        }));
        contentBox.replaceChildren(grid);
      }
    } else {
      // Artists or Albums
      if (viewMode === "list") {
        const ul = h("ul", { class: "list" });
        const max = items[0]?.plays || 1;
        ul.append(...items.map((item, i) => {
          const rank = (page - 1) * PAGE_SIZE + i + 1;
          if (currentTab === "artists") {
            const avatarPh = h("div", { class: "thumb circle ph" }, icon("artist"));
            const tryImg = item.img ? Promise.resolve(item.img) : getArtistImage(item.artist, item.mbid);
            tryImg.then((url) => {
              if (!url) return;
              const img = h("img", { class: "thumb circle", src: url, alt: "", loading: "lazy" });
              img.onerror = () => {};
              avatarPh.replaceWith(img);
            }).catch(() => {});

            const onRowClick = () => { location.href = artistHref(item.artist); };
            return h("li", {
              class: "row", tabindex: 0, role: "button",
              onclick: onRowClick,
              onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onRowClick(); } },
            },
              h("span", { class: "rank-num" }, `${rank}`),
              avatarPh,
              h("div", { class: "meta" },
                h("b", {}, h("a", { class: "artist-link", href: artistHref(item.artist), onclick: (e) => e.stopPropagation() }, item.artist)),
              ),
              item.plays ? h("span", { class: "tag" }, `${fmt.format(item.plays)} скроблів`) : null,
              item.plays && max ? h("i", { class: "bar", style: `--w:${((item.plays / max) * 100).toFixed(1)}%` }) : null,
              h("button", {
                class: "btn icon",
                title: "Відкрити виконавця",
                onclick: (e) => { e.stopPropagation(); location.href = artistHref(item.artist); },
              }, icon("external")),
            );
          } else {
            // albums
            const coverEl = trackCoverEl({ artist: item.artist, title: item.title, img: item.img }, "thumb", lfm);
            const playAlbum = () => playList(items.map((x) => ({ artist: x.artist, title: x.title || "" })), i);
            return h("li", {
              class: "row", tabindex: 0, role: "button",
              onclick: playAlbum,
              onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); playAlbum(); } },
            },
              h("span", { class: "rank-num" }, `${rank}`),
              coverEl,
              h("div", { class: "meta" },
                h("b", {}, item.title),
                h("span", {}, h("a", { class: "artist-link", href: artistHref(item.artist), onclick: (e) => e.stopPropagation() }, item.artist)),
              ),
              item.plays ? h("span", { class: "tag" }, `${fmt.format(item.plays)} скроблів`) : null,
              item.plays && max ? h("i", { class: "bar", style: `--w:${((item.plays / max) * 100).toFixed(1)}%` }) : null,
              h("button", {
                class: "btn icon",
                title: "Слухати альбом",
                onclick: (e) => { e.stopPropagation(); playAlbum(); },
              }, icon("play")),
            );
          }
        }));
        contentBox.replaceChildren(ul);
      } else {
        // Artists or Albums -> Grid
        const grid = h("div", { class: "grid-top" });
        grid.append(...items.map((item, i) => {
          const onCardClick = () => {
            if (currentTab === "artists") location.href = artistHref(item.artist);
            else playList(items.map((x) => ({ artist: x.artist, title: x.title || "" })), i);
          };

          const imgWrap = h("div", { class: "grid-card-ph" }, icon("note"));
          imgWrap.dataset.pending = "1";

          const label = currentTab === "albums"
            ? h("div", { class: "grid-card-info" },
                h("b", { title: item.title }, item.title),
                h("span", {}, h("a", {
                  class: "artist-link",
                  href: artistHref(item.artist),
                  onclick: (e) => e.stopPropagation(),
                }, item.artist)),
                item.plays ? h("span", {}, `${fmt.format(item.plays)} скроблів`) : null,
              )
            : h("div", { class: "grid-card-info" },
                h("b", { title: item.artist }, item.artist),
                item.plays ? h("span", {}, `${fmt.format(item.plays)} скроблів`) : null,
              );

          const cardEl = h("div", {
            class: "grid-card", tabindex: 0, role: "button",
            onclick: onCardClick,
            onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onCardClick(); } },
          }, imgWrap, label);

          if (currentTab === "artists") {
            const tryImg = item.img ? Promise.resolve(item.img) : getArtistImage(item.artist, item.mbid);
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

          return cardEl;
        }));
        contentBox.replaceChildren(grid);
      }
    }
  };

  const renderPagination = () => {
    if (totalPages <= 1) { paginationEl.replaceChildren(); return; }

    const itemsList = [];
    const btn = (label, p, disabled = false) => h("button", {
      class: "btn sm" + (p === page ? " accent" : ""),
      disabled: disabled || undefined,
      onclick: () => {
        if (p !== page) {
          page = p;
          loadData();
          $("#view-sub")?.scrollTo({ top: 0, behavior: "smooth" });
          window.scrollTo({ top: 0, behavior: "smooth" });
        }
      },
    }, label);

    itemsList.push(btn("←", page - 1, page === 1));

    const start = Math.max(1, page - 2);
    const end = Math.min(totalPages, page + 2);
    if (start > 1) { itemsList.push(btn("1", 1)); if (start > 2) itemsList.push(h("span", {}, "…")); }
    for (let p = start; p <= end; p++) itemsList.push(btn(String(p), p));
    if (end < totalPages) {
      if (end < totalPages - 1) itemsList.push(h("span", {}, "…"));
      itemsList.push(btn(String(totalPages), totalPages));
    }

    itemsList.push(btn("→", page + 1, page === totalPages));
    paginationEl.replaceChildren(...itemsList);
  };

  const loadData = async () => {
    contentBox.replaceChildren(h("p", { class: "empty" }, "Завантаження…"));
    try {
      if (searchQuery.trim()) {
        // Global search
        const res = await lfmSearch(currentTab, searchQuery.trim(), page, PAGE_SIZE);
        items = res.items;
        totalItems = res.total;
        totalPages = res.totalPages;
        const countLabel = $("#lib-count-label");
        if (countLabel) {
          countLabel.textContent = `Пошук «${searchQuery.trim()}»: ${fmt.format(totalItems)} результатів (сторінка ${page} з ${Math.max(1, totalPages)})`;
        }
      } else {
        // Personal Library with real Last.fm pagination
        if (currentTab === "recent") {
          const data = await lfm("user.getRecentTracks", { page, limit: PAGE_SIZE });
          const attr = data.recenttracks?.["@attr"] || {};
          totalItems = Number(attr.total || 0);
          totalPages = Number(attr.totalPages || 1);
          items = asArray(data.recenttracks?.track).map(normalize.recent).filter((t) => !t.live);
        } else {
          const cfg = TOP[currentTab];
          const data = await lfm(cfg.method, { period: currentPeriod, page, limit: PAGE_SIZE });
          const rootKey = currentTab === "tracks" ? "toptracks" : (currentTab === "artists" ? "topartists" : "topalbums");
          const attr = data[rootKey]?.["@attr"] || {};
          totalItems = Number(attr.total || 0);
          totalPages = Number(attr.totalPages || 1);
          items = asArray(cfg.items(data)).map(cfg.map);
        }

        const tabNames = { recent: "скроблів", tracks: "треків", artists: "артистів", albums: "альбомів" };
        const countLabel = $("#lib-count-label");
        if (countLabel) {
          countLabel.textContent = `Всього: ${fmt.format(totalItems)} ${tabNames[currentTab] || ""} · сторінка ${page} з ${totalPages}`;
        }
      }

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
    loadData();
  }
};
