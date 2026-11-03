import {
  $, h, fmt, asArray, cover, toast, icon, shuffle,
  getArtistImage, trackCoverEl, artistHref, key,
} from "./utils.js";
import { config, lfm } from "./lastfm.js";
import { playList } from "./player.js";

const stripBio = (html = "") => {
  const clean = html.replace(/<a\b[^>]*>.*?<\/a>/gi, "").replace(/<[^>]+>/g, "").trim();
  return clean.length > 520 ? clean.slice(0, 520).trim() + "…" : clean;
};

export const mountArtistView = (container, artistName) => {
  let popularTracks = [];
  let userTracks = [];
  let currentTrackTab = "popular";

  container.innerHTML = "";

  if (!artistName) {
    container.append(h("p", { class: "empty" }, "Не вказано ім'я виконавця"));
    return;
  }

  // Create layout
  const heroSection = h("section", { class: "card artist-hero" }, h("p", { class: "empty" }, "Завантаження даних виконавця…"));
  const statsSection = h("section", { class: "stats", style: "grid-template-columns: repeat(4, minmax(0, 1fr));" });

  const grid2col = h("div", { class: "artist-grid-2col" });

  // Left col: Tracks with tabs
  const leftCol = h("section", { class: "card" });
  const tabsHeader = h("div", { class: "tabs-header" });
  const trackTabs = h("div", { class: "tabs" },
    h("button", { class: "tab active", "data-tab": "popular" }, "Популярні треки"),
    h("button", { class: "tab", "data-tab": "user" }, "Мої програвання"),
  );
  tabsHeader.append(trackTabs);
  const tracksUl = h("ul", { class: "list" });
  leftCol.append(tabsHeader, tracksUl);

  // Right col: Albums & Similar
  const rightCol = h("div", { style: "display:flex;flex-direction:column;gap:16px;" });
  const albumsSection = h("section", { class: "card" },
    h("h2", {}, "Топ альбоми"),
    h("div", { id: "artist-albums-box" }),
  );
  const similarSection = h("section", { class: "card" },
    h("h2", {}, "Схожі виконавці"),
    h("div", { id: "artist-similar-box" }),
  );
  rightCol.append(albumsSection, similarSection);

  grid2col.append(leftCol, rightCol);
  container.append(heroSection, statsSection, grid2col);

  // ── Functions ────────────────────────────────────────────────────────
  const renderHero = (artist, userScrobbles, userTrackCount) => {
    document.title = `${artist.name} — Scrobble Deck`;

    const avatarWrap = h("div", { class: "artist-avatar ph" }, icon("note"));
    getArtistImage(artist.name, artist.mbid).then((url) => {
      if (!url) return;
      const img = h("img", { class: "artist-avatar", src: url, alt: artist.name });
      img.onerror = () => {};
      avatarWrap.replaceWith(img);
    });

    const tags = asArray(artist.tags?.tag).slice(0, 6).map((t) =>
      h("span", { class: "artist-tag" }, t.name),
    );
    const bioText = stripBio(artist.bio?.summary || "");

    heroSection.replaceChildren(
      avatarWrap,
      h("div", { class: "artist-hero-info" },
        h("h1", {}, artist.name),
        tags.length > 0 && h("div", { class: "artist-tags" }, ...tags),
        bioText && h("p", { class: "artist-bio" }, bioText),
        h("div", { class: "now-actions" },
          h("button", {
            class: "btn accent sm",
            onclick: () => popularTracks.length && playList(popularTracks, 0),
          }, icon("play"), "Слухати топ-треки"),
          h("button", {
            class: "btn sm",
            onclick: playArtistRadio,
          }, icon("shuffle"), "Радіо виконавця"),
          artist.url && h("a", {
            class: "btn sm",
            href: artist.url,
            target: "_blank",
            rel: "noopener",
          }, "Last.fm ", icon("external")),
        ),
      ),
    );

    const listeners = Number(artist.stats?.listeners || 0);
    const totalPlays = Number(artist.stats?.playcount || 0);

    const cells = [
      ["Моїх скроблів", fmt.format(userScrobbles), "stat-1"],
      ["Треків у топі", fmt.format(userTrackCount), "stat-2", "user-stat-cnt"],
      ["Слухачів у світі", fmt.format(listeners), "stat-3"],
      ["Всього скроблів у світі", fmt.format(totalPlays), "stat-4"],
    ];

    statsSection.replaceChildren(
      ...cells.map(([label, value, cls, id]) =>
        h("div", { class: `stat ${cls}` }, h("small", {}, label), h("strong", { id }, value)),
      ),
    );
  };

  const renderTracks = () => {
    const list = currentTrackTab === "popular" ? popularTracks : userTracks;
    if (!list.length) {
      tracksUl.replaceChildren(
        h("li", { class: "empty" },
          currentTrackTab === "popular"
            ? "Треків не знайдено"
            : "У твоїх топ-треках ще немає пісень цього виконавця"),
      );
      return;
    }

    const max = Math.max(...list.map((t) => (currentTrackTab === "popular" ? t.listeners || t.plays : t.userPlays || t.plays) || 1), 1);

    tracksUl.replaceChildren(...list.map((t, i) => {
      const play = () => playList(list, i);
      const thumbEl = trackCoverEl(t, "thumb", lfm);

      const metric = currentTrackTab === "popular"
        ? (t.userPlays > 0 ? `♪ Моїх: ${fmt.format(t.userPlays)} · ${fmt.format(t.plays)}` : `${fmt.format(t.plays)} скроблів`)
        : `${fmt.format(t.userPlays || t.plays)} моїх скроблів`;

      const val = currentTrackTab === "popular" ? (t.listeners || t.plays) : (t.userPlays || t.plays);
      const fraction = val / max;

      const tagEl = h("span", { class: "tag" }, metric);

      if (currentTrackTab === "popular" && t.userPlays === undefined && i < 15 && config.user) {
        lfm("track.getInfo", { artist: t.artist, track: t.title, username: config.user, autocorrect: 1 })
          .then((res) => {
            const up = Number(res?.track?.userplaycount || 0);
            t.userPlays = up;
            if (up > 0) {
              tagEl.textContent = `♪ Моїх: ${fmt.format(up)} · ${fmt.format(t.plays)}`;
              tagEl.style.color = "var(--accent)";
            }
          })
          .catch(() => {});
      }

      return h("li", {
        class: "row", tabindex: 0, role: "button",
        "data-key": key(t.artist, t.title),
        onclick: play,
        onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); play(); } },
      },
        thumbEl,
        h("div", { class: "meta" },
          h("b", {}, t.title),
          h("span", {}, t.artist),
        ),
        tagEl,
        h("i", { class: "bar", style: `--w:${(fraction * 100).toFixed(1)}%` }),
      );
    }));
  };

  const renderAlbums = (albums) => {
    const box = albumsSection.querySelector("#artist-albums-box");
    if (!albums.length) {
      box.replaceChildren(h("p", { class: "empty" }, "Альбомів не знайдено"));
      return;
    }
    const grid = h("div", { class: "grid-top", style: "grid-template-columns:repeat(auto-fill,minmax(120px,1fr));" });
    grid.append(...albums.map((a) => {
      const playAlbum = async () => {
        try {
          toast(`Завантаження альбому «${a.title}»…`);
          const info = await lfm("album.getInfo", { artist: a.artist, album: a.title, autocorrect: 1 });
          const albumTracks = asArray(info?.album?.tracks?.track).map((t) => ({
            artist: a.artist,
            title: t.name,
            img: a.img,
          }));
          playList(albumTracks.length ? albumTracks : [{ artist: a.artist, title: a.title, img: a.img }], 0);
        } catch {
          playList([{ artist: a.artist, title: a.title, img: a.img }], 0);
        }
      };

      const imgEl = a.img
        ? h("img", { class: "grid-card-img", src: a.img, alt: a.title, loading: "lazy" })
        : h("div", { class: "grid-card-ph" }, icon("note"));

      return h("div", {
        class: "grid-card", tabindex: 0, role: "button",
        onclick: playAlbum,
        onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); playAlbum(); } },
      },
        imgEl,
        h("div", { class: "grid-card-info" },
          h("b", { title: a.title }, a.title),
          h("span", {}, `${fmt.format(a.plays)} скроблів`),
        ),
      );
    }));
    box.replaceChildren(grid);
  };

  const renderSimilar = (similar) => {
    const box = similarSection.querySelector("#artist-similar-box");
    if (!similar.length) {
      box.replaceChildren(h("p", { class: "empty" }, "Схожих виконавців не знайдено"));
      return;
    }
    const grid = h("div", { class: "grid-top", style: "grid-template-columns:repeat(auto-fill,minmax(115px,1fr));" });
    grid.append(...similar.map((s) => {
      const goArtist = () => { location.hash = `#/artist?name=${encodeURIComponent(s.artist)}`; };
      const imgWrap = h("div", { class: "grid-card-ph" }, icon("note"));

      getArtistImage(s.artist, s.mbid).then((url) => {
        if (!url) return;
        const img = h("img", { class: "grid-card-img", src: url, alt: s.artist, loading: "lazy" });
        img.onerror = () => {};
        imgWrap.replaceWith(img);
      }).catch(() => {});

      return h("div", {
        class: "grid-card", tabindex: 0, role: "button",
        onclick: goArtist,
        onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); goArtist(); } },
      },
        imgWrap,
        h("div", { class: "grid-card-info" },
          h("b", { title: s.artist }, s.artist),
          s.match != null && h("span", {}, `${Math.round(s.match * 100)}% схожість`),
        ),
      );
    }));
    box.replaceChildren(grid);
  };

  const playArtistRadio = async () => {
    if (!popularTracks.length) return;
    toast(`Формуємо радіо виконавця ${artistName}…`);
    try {
      const seeds = shuffle(popularTracks).slice(0, 5);
      const settled = await Promise.allSettled(
        seeds.map((s) => lfm("track.getSimilar", { artist: s.artist, track: s.title, limit: 10, autocorrect: 1 })),
      );
      const pool = [...popularTracks];
      const seen = new Set(pool.map((t) => key(t.artist, t.title)));
      for (const r of settled) {
        if (r.status !== "fulfilled") continue;
        for (const t of asArray(r.value.similartracks?.track)) {
          const k = key(t.artist.name, t.name);
          if (!seen.has(k)) {
            pool.push({ artist: t.artist.name, title: t.name, img: cover(t.image) });
            seen.add(k);
          }
        }
      }
      playList(shuffle(pool), 0);
    } catch {
      playList(shuffle(popularTracks), 0);
    }
  };

  trackTabs.addEventListener("click", ({ target }) => {
    const btn = target.closest("button.tab");
    if (!btn) return;
    const tab = btn.dataset.tab;
    if (!tab || tab === currentTrackTab) return;
    currentTrackTab = tab;
    for (const b of trackTabs.children) b.classList.toggle("active", b === btn);
    renderTracks();
  });

  // Load data
  const loadData = async () => {
    try {
      const [infoRes, tracksRes, albumsRes, simRes] = await Promise.all([
        lfm("artist.getInfo", { artist: artistName, username: config.user, autocorrect: 1, lang: "uk" }),
        lfm("artist.getTopTracks", { artist: artistName, limit: 30, autocorrect: 1 }),
        lfm("artist.getTopAlbums", { artist: artistName, limit: 12, autocorrect: 1 }),
        lfm("artist.getSimilar", { artist: artistName, limit: 12, autocorrect: 1 }).catch(() => null),
      ]);

      const artist = infoRes.artist;
      const userScrobbles = Number(artist.stats?.userplaycount || 0);

      popularTracks = asArray(tracksRes.toptracks?.track).map((t) => ({
        artist: artist.name,
        title: t.name,
        plays: Number(t.playcount || 0),
        listeners: Number(t.listeners || 0),
        img: cover(t.image),
      }));

      const albums = asArray(albumsRes.topalbums?.album)
        .filter((a) => a.name && a.name !== "(null)")
        .map((a) => ({
          artist: artist.name,
          title: a.name,
          plays: Number(a.playcount || 0),
          img: cover(a.image),
        }));

      const similar = asArray(simRes?.similarartists?.artist || artist.similar?.artist).map((s) => ({
        artist: s.name,
        mbid: s.mbid || "",
        match: s.match != null ? Number(s.match) : null,
      }));

      renderHero(artist, userScrobbles, 0);
      renderTracks();
      renderAlbums(albums);
      renderSimilar(similar);

      // Load user top tracks to count artist tracks in user library
      lfm("user.getTopTracks", { period: "overall", limit: 500 })
        .then((uData) => {
          const targetLower = artist.name.toLowerCase();
          userTracks = asArray(uData.toptracks?.track)
            .filter((t) => t.artist?.name?.toLowerCase() === targetLower)
            .map((t) => ({
              artist: t.artist.name,
              title: t.name,
              plays: Number(t.playcount || 0),
              userPlays: Number(t.playcount || 0),
              img: cover(t.image),
            }));

          const mapByTitle = new Map(userTracks.map((t) => [t.title.toLowerCase(), t.userPlays]));
          for (const pt of popularTracks) {
            if (mapByTitle.has(pt.title.toLowerCase())) {
              pt.userPlays = mapByTitle.get(pt.title.toLowerCase());
            }
          }

          const statEl = container.querySelector("#user-stat-cnt");
          if (statEl) statEl.textContent = fmt.format(userTracks.length);
          renderTracks();
        })
        .catch(() => {});
    } catch (err) {
      heroSection.replaceChildren(h("p", { class: "empty" }, err.message));
      toast(err.message);
    }
  };

  loadData();
};
