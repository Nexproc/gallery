/**
 * Lightsync Gallery — High-Scale Single-Page Photograph Viewer
 * - Default Highlights (4★+) landing with Shoots (>24h sessions), Archive, and Favorites views
 * - Editorial spreads + Contact Sheet density toggle with photo-anchored scroll preservation
 * - Exact-height virtualized reel & offscreen bitmap LRU eviction for 2k–10k+ photo archives
 * - Hierarchical Month + Active-Month Day timeline scrubber & sticky navigation
 * - Two-tier image loading (800px WebP grid thumbs + 3K lightbox/hero masters)
 * - Cursor-proximity 2x magnification & touch scrubbing on hero carousel selectors
 */

(() => {
  "use strict";

  const STORAGE_KEYS = {
    theme: "lightsync_gallery_theme",
    favorites: "lightsync_gallery_favorites",
    density: "lightsync_gallery_density",
  };

  const REMOTE_MANIFEST_URL =
    "https://storage.googleapis.com/lightsync-gallery-media-8f4a2c/manifest.json";

  const MAX_CAROUSEL_SLIDES = 7;
  const HERO_PROXIMITY_RADIUS_PX = 165;
  const MAX_CONCURRENT_HYDRATIONS = 8;
  const SESSION_GAP_MS = 24 * 60 * 60 * 1000;
  const VIRTUAL_OVERSCAN_PX = 1250;
  const DIVIDER_BLOCK_HEIGHT = 44;
  const MAX_DECODED_CARDS = 220;
  const FILMSTRIP_HALF_WINDOW = 40;

  const SHORT_MONTHS = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const LONG_MONTHS = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];

  const ICONS = {
    compactGrid: `
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.35" aria-hidden="true">
        <rect x="1.2" y="1.2" width="4.6" height="4.6" rx="0.6" />
        <rect x="8.2" y="1.2" width="4.6" height="4.6" rx="0.6" />
        <rect x="1.2" y="8.2" width="4.6" height="4.6" rx="0.6" />
        <rect x="8.2" y="8.2" width="4.6" height="4.6" rx="0.6" />
      </svg>
    `,
    editorialRows: `
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.35" aria-hidden="true">
        <rect x="1.2" y="1.5" width="7.2" height="11" rx="0.6" />
        <rect x="10.1" y="1.5" width="2.7" height="4.8" rx="0.5" />
        <rect x="10.1" y="7.7" width="2.7" height="4.8" rx="0.5" />
      </svg>
    `,
    share: `
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M4.8 4.3L7 2.1l2.2 2.2" />
        <path d="M7 2.3v6.6" />
        <path d="M2.5 8v3a.9.9 0 0 0 .9.9h7.2a.9.9 0 0 0 .9-.9V8" />
      </svg>
    `,
    check: `
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M2.5 7.4l3 3 6-6.5" />
      </svg>
    `,
  };

  const state = {
    manifest: null,
    photos: [],
    photoById: new Map(),
    chapters: [],
    shoots: [],
    shootById: new Map(),
    heroPhotos: [],
    assetBaseUrl: "./3k_exports",
    thumbBaseUrl: "",

    filter: "highlights", // 'highlights' | 'shoots' | 'archive' | 'favorites'
    hasExplicitUrlView: false,
    urlPhotoId: "",
    urlDate: "",
    urlAnchorId: "",
    sharedPicks: new Set(),
    activeShootId: null,
    shootsIndexScrollY: 0,
    density: "editorial", // 'editorial' | 'compact'

    favorites: new Set(),
    hydratedIds: new Set(),
    activeDate: null,

    layoutBlocks: [],
    photoTopById: new Map(),
    layoutTotalHeight: 0,
    layoutKeySignature: "",
    virtStartIdx: -1,
    virtEndIdx: -1,

    heroSlideIdx: 0,
    heroTimer: null,

    lightboxOpen: false,
    lightboxList: [],
    lightboxIdx: 0,
    lightboxZoomed: false,
    filmstripStart: -1,
    filmstripEnd: -1,
  };

  const dom = {
    html: document.documentElement,
    heroStage: document.getElementById("hero-stage"),
    heroCopy: document.getElementById("hero-copy"),
    collectionEyebrow: document.getElementById("collection-eyebrow"),
    collectionTitle: document.getElementById("collection-title"),
    collectionSubtitle: document.getElementById("collection-subtitle"),
    heroShowcase: document.getElementById("hero-showcase"),
    heroSlidesLayer: document.getElementById("hero-slides-layer"),
    heroDots: document.getElementById("hero-dots"),
    btnExplore: document.getElementById("btn-explore-collection"),

    galleryNav: document.getElementById("gallery-nav"),
    dateChaptersNav: document.getElementById("date-chapters-nav"),
    filterHighlights: document.getElementById("filter-highlights"),
    filterShoots: document.getElementById("filter-shoots"),
    filterArchive: document.getElementById("filter-archive"),
    filterFavorites: document.getElementById("filter-favorites"),
    btnShareView: document.getElementById("btn-share-view"),
    btnDensityToggle: document.getElementById("btn-density-toggle"),
    btnThemeToggle: document.getElementById("btn-theme-toggle"),

    timelineScrubber: document.getElementById("timeline-scrubber"),
    galleryMain: document.getElementById("gallery-main"),
    chaptersContainer: document.getElementById("chapters-container"),

    footer: document.querySelector(".gallery-footer"),
    footerCopyright: document.getElementById("footer-copyright"),
    btnBackTop: document.getElementById("btn-back-top"),

    lightbox: document.getElementById("lightbox-modal"),
    lbCounter: document.getElementById("lb-counter"),
    lbTitle: document.getElementById("lb-title"),
    lbBtnZoom: document.getElementById("lb-btn-zoom"),
    lbBtnFav: document.getElementById("lb-btn-fav"),
    lbBtnShare: document.getElementById("lb-btn-share"),
    lbBtnDownload: document.getElementById("lb-btn-download"),
    lbBtnClose: document.getElementById("lb-btn-close"),
    lbStage: document.getElementById("lightbox-stage"),
    lbImgWrap: document.getElementById("lb-img-wrap"),
    lbImg: document.getElementById("lb-img"),
    lbPrev: document.getElementById("lb-prev"),
    lbNext: document.getElementById("lb-next"),
    lbFilmstrip: document.getElementById("lightbox-filmstrip"),
    shareToast: document.getElementById("share-toast"),
  };

  const cardCache = new Map(); // photoId -> { figure, hiImg, btnFav, btnShare }
  const decodedCardLru = new Set(); // photoId in insertion order for offscreen bitmap eviction
  const mountedReelBlocks = new Map(); // blockKey -> HTMLElement
  const pendingHydrationSet = new Set();

  let reelWrapEl = null;
  let imgObserver = null;
  let proximityRaf = 0;
  let scrollRaf = 0;
  let pumpRaf = 0;
  let postJumpTimer = null;
  let urlScrollSyncTimer = null;
  let shareToastTimer = null;
  let lightboxPushedHistory = false;
  let closingLightboxViaBack = false;
  let activeHydrations = 0;
  let lastContainerWidth = 0;
  let lastDateNavKey = "";
  let lastExpandedMonthKey = "";
  let suppressScrollObserversUntil = 0;
  let lastHeroDotsTouchTime = 0;
  let lastHeroSwipeTime = 0;
  let lastHeroOrientation = "";

  // =========================================================================
  // Preferences, Live URL State, Sharing & Asset Resolution
  // =========================================================================

  function parseUrlViewState() {
    try {
      const params = new URLSearchParams(window.location.search);
      const rawView = (params.get("view") || "").toLowerCase();
      const shootParam = params.get("shoot") || "";
      const photoParam = params.get("photo") || "";
      const dateParam = params.get("date") || "";
      const atParam = params.get("at") || "";
      const picksParam = params.get("picks") || "";

      state.urlPhotoId = photoParam;
      state.urlDate = /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : "";
      state.urlAnchorId = atParam;
      state.sharedPicks = new Set(
        picksParam
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      );

      if (shootParam) {
        state.filter = "shoots";
        state.activeShootId = shootParam;
        state.hasExplicitUrlView = true;
        return;
      }

      if (rawView === "all" || rawView === "archive") {
        state.filter = "archive";
        state.activeShootId = null;
        state.hasExplicitUrlView = true;
      } else if (["highlights", "shoots", "favorites"].includes(rawView)) {
        state.filter = rawView;
        state.activeShootId = null;
        state.hasExplicitUrlView = true;
      } else {
        state.filter = "highlights";
        state.activeShootId = null;
        state.hasExplicitUrlView = Boolean(state.urlDate || state.urlAnchorId);
      }
    } catch (_) {}
  }

  function loadPersistedState() {
    try {
      const savedTheme = localStorage.getItem(STORAGE_KEYS.theme);
      if (savedTheme === "dark" || savedTheme === "light") {
        dom.html.setAttribute("data-theme", savedTheme);
      }
      const savedDensity = localStorage.getItem(STORAGE_KEYS.density);
      if (savedDensity === "compact" || savedDensity === "editorial") {
        state.density = savedDensity;
      }
      const savedFavs = JSON.parse(localStorage.getItem(STORAGE_KEYS.favorites) || "[]");
      if (Array.isArray(savedFavs)) {
        state.favorites = new Set(savedFavs);
      }
    } catch (_) {}

    parseUrlViewState();
    syncDensityUI();
  }

  function saveFavorites() {
    try {
      localStorage.setItem(STORAGE_KEYS.favorites, JSON.stringify([...state.favorites]));
    } catch (_) {}
  }

  function isScrolledIntoGallery() {
    if (!dom.heroStage) return window.scrollY > 40;
    const navH = dom.galleryNav ? dom.galleryNav.getBoundingClientRect().height : 58;
    return dom.heroStage.getBoundingClientRect().bottom <= navH + 16;
  }

  function getDeepScrollAnchorPhotoId() {
    if (!reelWrapEl || !state.layoutBlocks.length || !isScrolledIntoGallery()) return null;
    const navH = dom.galleryNav ? dom.galleryNav.getBoundingClientRect().height : 58;
    const relY = navH + 24 - reelWrapEl.getBoundingClientRect().top;
    const firstBlockH = state.layoutBlocks[0] ? state.layoutBlocks[0].height : 240;
    if (relY < Math.min(firstBlockH * 0.7, 220)) return null;
    return captureViewportAnchorPhotoId();
  }

  function buildUrlForState({ photoId = null, includeScrollPosition = true } = {}) {
    try {
      const url = new URL(window.location.href);
      for (const k of ["view", "shoot", "date", "at", "photo", "picks"]) {
        url.searchParams.delete(k);
      }

      if (state.filter !== "highlights") {
        url.searchParams.set("view", state.filter);
      }

      if (state.filter === "shoots" && state.activeShootId) {
        url.searchParams.set("shoot", state.activeShootId);
      }

      if (state.filter === "favorites") {
        const activeFavIds = state.favorites.size
          ? [...state.favorites]
          : [...state.sharedPicks];
        if (activeFavIds.length > 0 && activeFavIds.length <= 80) {
          url.searchParams.set("picks", activeFavIds.join(","));
        }
      }

      if (photoId) {
        url.searchParams.set("photo", photoId);
        return url.toString();
      }

      if (includeScrollPosition && isScrolledIntoGallery()) {
        if (isShootsIndexMode()) {
          if (
            state.activeDate &&
            state.chapters.length > 1 &&
            state.activeDate !== state.chapters[0].date
          ) {
            url.searchParams.set("date", state.activeDate);
          }
        } else if (getActiveShoot()) {
          const anchorId = getDeepScrollAnchorPhotoId();
          if (anchorId) {
            url.searchParams.set("at", anchorId);
          }
        } else {
          const anchorId = getDeepScrollAnchorPhotoId();
          const anchorPhoto = anchorId ? state.photoById.get(anchorId) : null;
          const visibleDate = (anchorPhoto && anchorPhoto.date) || state.activeDate;

          if (visibleDate && state.chapters.length > 1) {
            url.searchParams.set("date", visibleDate);
          }

          if (anchorId) {
            const reelPhotos = getReelPhotos();
            const firstOfDate = visibleDate
              ? reelPhotos.find((p) => p.date === visibleDate)
              : reelPhotos[0];
            if (!firstOfDate || firstOfDate.id !== anchorId) {
              url.searchParams.set("at", anchorId);
            }
          }
        }
      }

      return url.toString();
    } catch (_) {
      return window.location.href;
    }
  }

  function syncUrlParams(pushHistory = false, { includeScrollPosition = true } = {}) {
    try {
      clearTimeout(urlScrollSyncTimer);
      const lbPhoto =
        state.lightboxOpen && state.lightboxList[state.lightboxIdx]
          ? state.lightboxList[state.lightboxIdx].id
          : null;
      const nextUrl = buildUrlForState({
        photoId: lbPhoto,
        includeScrollPosition,
      });

      if (nextUrl === window.location.href) return;

      if (pushHistory) {
        window.history.pushState({}, "", nextUrl);
      } else {
        window.history.replaceState({}, "", nextUrl);
      }
    } catch (_) {}
  }

  function scheduleScrollUrlSync(delayMs = 240) {
    if (state.lightboxOpen || performance.now() < suppressScrollObserversUntil) return;
    clearTimeout(urlScrollSyncTimer);
    urlScrollSyncTimer = setTimeout(() => {
      if (!state.lightboxOpen && performance.now() >= suppressScrollObserversUntil) {
        syncUrlParams(false, { includeScrollPosition: true });
      }
    }, delayMs);
  }

  function showShareToast(message) {
    if (!dom.shareToast) return;
    clearTimeout(shareToastTimer);
    dom.shareToast.textContent = message;
    dom.shareToast.hidden = false;
    requestAnimationFrame(() => {
      dom.shareToast.classList.add("is-visible");
    });
    shareToastTimer = setTimeout(() => {
      dom.shareToast.classList.remove("is-visible");
      setTimeout(() => {
        if (!dom.shareToast.classList.contains("is-visible")) {
          dom.shareToast.hidden = true;
        }
      }, 220);
    }, 2200);
  }

  async function copyTextToClipboard(text) {
    if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (_) {}
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return Boolean(ok);
    } catch (_) {
      return false;
    }
  }

  function flashButtonCopied(btn) {
    if (!btn) return;
    btn.classList.add("is-copied", "is-active");
    setTimeout(() => {
      btn.classList.remove("is-copied");
      if (btn !== dom.btnDensityToggle || state.density !== "compact") {
        btn.classList.remove("is-active");
      }
    }, 1400);
  }

  async function shareUrlWithFeedback({ url, title, toastMessage, triggerBtn = null }) {
    const canMobileNativeShare =
      typeof navigator !== "undefined" &&
      typeof navigator.share === "function" &&
      window.matchMedia &&
      window.matchMedia("(pointer: coarse)").matches;

    if (canMobileNativeShare) {
      try {
        await navigator.share({ title, url });
        return;
      } catch (err) {
        if (err && err.name === "AbortError") return;
      }
    }

    const copied = await copyTextToClipboard(url);
    flashButtonCopied(triggerBtn);
    showShareToast(copied ? toastMessage : url);
  }

  function getBaseDocumentTitle() {
    return (state.manifest && state.manifest.collection && state.manifest.collection.title) || document.title || "Gallery";
  }

  function shareCurrentLocation(triggerBtn = null) {
    syncUrlParams(false, { includeScrollPosition: true });
    const url = window.location.href;
    const baseTitle = getBaseDocumentTitle();
    const activeShoot = getActiveShoot();

    let contextTitle = baseTitle;
    let toastMessage = "Link copied to clipboard";

    if (activeShoot) {
      contextTitle = `${baseTitle} — ${activeShoot.title}`;
      toastMessage = "Shoot link copied";
    } else if (state.filter === "shoots") {
      contextTitle = `${baseTitle} — Shoots`;
      toastMessage = "Shoots link copied";
    } else if (state.filter === "archive") {
      contextTitle = `${baseTitle} — Archive`;
      toastMessage = isScrolledIntoGallery() ? "Position link copied" : "Archive link copied";
    } else if (state.filter === "favorites") {
      contextTitle = `${baseTitle} — Favorites`;
      toastMessage = "Favorites link copied";
    } else if (isScrolledIntoGallery()) {
      toastMessage = "Position link copied";
    }

    shareUrlWithFeedback({ url, title: contextTitle, toastMessage, triggerBtn });
  }

  function sharePhotoById(photoId, triggerBtn = null) {
    const photo = state.photoById.get(photoId);
    if (!photo) return;
    const url = buildUrlForState({ photoId: photo.id, includeScrollPosition: false });
    const title = `${getBaseDocumentTitle()} — ${photo.filename}`;
    shareUrlWithFeedback({
      url,
      title,
      toastMessage: "Photo link copied",
      triggerBtn,
    });
  }

  function syncDensityUI() {
    const isCompact = state.density === "compact";
    if (dom.galleryMain) {
      dom.galleryMain.classList.toggle("is-compact", isCompact);
    }
    if (dom.btnDensityToggle) {
      dom.btnDensityToggle.classList.toggle("is-active", isCompact);
      dom.btnDensityToggle.innerHTML = isCompact ? ICONS.editorialRows : ICONS.compactGrid;
      dom.btnDensityToggle.title = isCompact
        ? "Switch to Editorial layout"
        : "Switch to Contact Sheet grid";
    }
  }

  function resolvePhotoUrl(photo) {
    if (photo.embeddedSrc) return photo.embeddedSrc;
    if (photo.url && /^https?:\/\//i.test(photo.url)) return photo.url;
    const base = (state.assetBaseUrl || "./3k_exports").replace(/\/+$/, "");
    return `${base}/${photo.filename}`;
  }

  function resolveThumbUrl(photo) {
    if (photo.embeddedSrc) return photo.embeddedSrc;
    if (photo.thumbUrl && /^https?:\/\//i.test(photo.thumbUrl)) return photo.thumbUrl;
    if (state.thumbBaseUrl && photo.thumb) {
      const tBase = state.thumbBaseUrl.replace(/\/+$/, "");
      return `${tBase}/${photo.thumb}`;
    }
    return resolvePhotoUrl(photo);
  }

  function formatCount(n) {
    return Number(n || 0).toLocaleString();
  }

  function getActiveShoot() {
    if (state.filter !== "shoots" || !state.activeShootId) return null;
    return state.shootById.get(state.activeShootId) || null;
  }

  function isShootsIndexMode() {
    return state.filter === "shoots" && !getActiveShoot();
  }

  function getReelPhotos() {
    if (state.filter === "highlights") {
      return state.photos.filter((p) => p.hero);
    }
    if (state.filter === "favorites") {
      if (state.favorites.size > 0) {
        return state.photos.filter((p) => state.favorites.has(p.id));
      }
      if (state.sharedPicks.size > 0) {
        return state.photos.filter((p) => state.sharedPicks.has(p.id));
      }
      return [];
    }
    if (state.filter === "shoots") {
      const shoot = getActiveShoot();
      return shoot ? shoot.photos : [];
    }
    return state.photos;
  }

  function syncNavHeight() {
    if (!dom.galleryNav) return 58;
    const h = Math.ceil(dom.galleryNav.getBoundingClientRect().height);
    if (h >= 40) {
      dom.html.style.setProperty("--nav-height", `${h}px`);
      return h;
    }
    return 58;
  }

  function updateToolbarCounts() {
    const favCount = state.favorites.size;
    const totalCount = state.photos.length;
    const shootsCount = state.shoots.length;

    dom.filterHighlights.textContent = "Highlights";
    dom.filterShoots.textContent =
      shootsCount > 0 ? `Shoots (${formatCount(shootsCount)})` : "Shoots";
    dom.filterArchive.textContent =
      totalCount > 0 ? `Archive (${formatCount(totalCount)})` : "Archive";
    dom.filterFavorites.textContent =
      favCount > 0 ? `Favorites (${formatCount(favCount)})` : "Favorites";

    dom.filterHighlights.classList.toggle("is-active", state.filter === "highlights");
    dom.filterShoots.classList.toggle("is-active", state.filter === "shoots");
    dom.filterArchive.classList.toggle("is-active", state.filter === "archive");
    dom.filterFavorites.classList.toggle("is-active", state.filter === "favorites");
  }

  // =========================================================================
  // Session / Shoot Derivation (>24h Gaps)
  // =========================================================================

  function parsePhotoTimestampMs(photo) {
    if (!photo || typeof photo.timestamp !== "string") return NaN;
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/.exec(
      photo.timestamp.trim()
    );
    if (m) {
      return Date.UTC(
        Number(m[1]),
        Number(m[2]) - 1,
        Number(m[3]),
        Number(m[4]),
        Number(m[5]),
        Number(m[6])
      );
    }
    return Date.parse(photo.timestamp);
  }

  function groupPhotosIntoSessions(photos) {
    const sessions = [];
    for (let i = 0; i < photos.length; i++) {
      const photo = photos[i];
      if (i === 0) {
        sessions.push([photo]);
        continue;
      }
      const tPrev = parsePhotoTimestampMs(photos[i - 1]);
      const tCurr = parsePhotoTimestampMs(photo);
      const isNewSession =
        Number.isFinite(tPrev) &&
        Number.isFinite(tCurr) &&
        Math.abs(tPrev - tCurr) > SESSION_GAP_MS;
      if (isNewSession) {
        sessions.push([photo]);
      } else {
        sessions[sessions.length - 1].push(photo);
      }
    }
    return sessions;
  }

  function parseYmdParts(ymd) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ""));
    if (!m) return null;
    return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  }

  function formatShootDateRange(oldestDate, newestDate) {
    const a = parseYmdParts(oldestDate);
    const b = parseYmdParts(newestDate);
    if (!a || !b) return newestDate || oldestDate || "";

    if (oldestDate === newestDate) {
      return `${LONG_MONTHS[b.m - 1]} ${b.d}, ${b.y}`;
    }
    if (a.y === b.y && a.m === b.m) {
      return `${LONG_MONTHS[a.m - 1]} ${a.d}–${b.d}, ${a.y}`;
    }
    if (a.y === b.y) {
      return `${SHORT_MONTHS[a.m - 1]} ${a.d} – ${SHORT_MONTHS[b.m - 1]} ${b.d}, ${a.y}`;
    }
    return `${SHORT_MONTHS[a.m - 1]} ${a.d}, ${a.y} – ${SHORT_MONTHS[b.m - 1]} ${b.d}, ${b.y}`;
  }

  function pickShootPreviewPhotos(sessionPhotos) {
    if (sessionPhotos.length <= 1) return sessionPhotos.slice();

    let bestCover = sessionPhotos[0];
    let bestScore = -Infinity;
    for (const p of sessionPhotos) {
      const score =
        (typeof p.rating === "number" ? p.rating * 12 : 0) +
        (p.hero ? 5 : 0) +
        (isWellExposedForHero(p) ? 3 : 0) +
        (p.orientation === "landscape" ? 1.5 : 0);
      if (score > bestScore) {
        bestScore = score;
        bestCover = p;
      }
    }

    const rest = sessionPhotos.filter((p) => p.id !== bestCover.id);
    const maxRest = Math.min(3, rest.length);
    const previews = [bestCover];
    if (maxRest > 0) {
      const preferredRest = rest.filter((p) => p.hero && isWellExposedForHero(p));
      const pool = preferredRest.length >= maxRest ? preferredRest : rest;
      for (let i = 0; i < maxRest; i++) {
        const idx =
          maxRest === 1 ? 0 : Math.floor((i * (pool.length - 1)) / (maxRest - 1));
        previews.push(pool[idx]);
      }
    }
    return previews;
  }

  function buildShootsFromPhotos(photos) {
    const sessions = groupPhotosIntoSessions(photos);
    const shoots = [];
    const byId = new Map();

    for (const sessionPhotos of sessions) {
      if (!sessionPhotos.length) continue;
      const newest = sessionPhotos[0];
      const oldest = sessionPhotos[sessionPhotos.length - 1];
      const id = `${newest.date}_${newest.id}`;
      const datesSet = new Set(sessionPhotos.map((p) => p.date));
      const shoot = {
        id,
        photos: sessionPhotos,
        newestDate: newest.date,
        oldestDate: oldest.date,
        datesSet,
        title: formatShootDateRange(oldest.date, newest.date),
        countLabel:
          sessionPhotos.length === 1
            ? "1 photo"
            : `${formatCount(sessionPhotos.length)} photos`,
        previews: pickShootPreviewPhotos(sessionPhotos),
      };
      shoots.push(shoot);
      byId.set(id, shoot);
    }

    state.shoots = shoots;
    state.shootById = byId;

    if (state.activeShootId && !byId.has(state.activeShootId)) {
      state.activeShootId = null;
    }
  }

  // =========================================================================
  // 1. Hero Carousel & 2x Cursor-Proximity Selector Magnification
  // =========================================================================

  function estimateHexLuminance(hex) {
    if (typeof hex !== "string" || !/^#[0-9a-f]{6}$/i.test(hex)) return 64;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }

  function isWellExposedForHero(photo) {
    const lum = estimateHexLuminance(photo.dominantColor);
    const lqipLen = (photo.lqip || "").length;
    return lum >= 26 && lqipLen >= 100;
  }

  function getDesiredHeroOrientation() {
    const w = window.innerWidth || 1024;
    const h = window.innerHeight || 768;
    return h > w * 1.05 ? "portrait" : "landscape";
  }

  function getPhotoFocalPosition(photo) {
    if (Array.isArray(photo.focalPoint) && photo.focalPoint.length >= 2) {
      const fx = Number(photo.focalPoint[0]);
      const fy = Number(photo.focalPoint[1]);
      if (Number.isFinite(fx) && Number.isFinite(fy)) {
        const cx = Math.max(0, Math.min(100, fx)).toFixed(1);
        const cy = Math.max(0, Math.min(100, fy)).toFixed(1);
        return `${cx}% ${cy}%`;
      }
    }
    return "50% 44%";
  }

  function pickCarouselSlides(targetOrientation) {
    const wantOrientation = targetOrientation || getDesiredHeroOrientation();
    const rated = state.photos.filter(
      (p) => typeof p.rating === "number" && p.rating > 0
    );

    let tierCandidates = [];
    if (rated.length > 0) {
      const maxRating = rated.reduce((acc, p) => Math.max(acc, p.rating), 0);
      const topRated = state.photos.filter((p) => p.rating === maxRating);
      const topOriented = topRated.filter((p) => p.orientation === wantOrientation);

      if (topOriented.length > 0) {
        tierCandidates = topOriented;
      } else if (maxRating > 1) {
        const nextOriented = state.photos.filter(
          (p) => (p.rating || 0) >= maxRating - 1 && p.orientation === wantOrientation
        );
        tierCandidates = nextOriented.length > 0 ? nextOriented : topRated;
      } else {
        tierCandidates = topRated;
      }
    } else {
      const heroOriented = state.photos.filter(
        (p) => p.hero && p.orientation === wantOrientation
      );
      tierCandidates =
        heroOriented.length > 0
          ? heroOriented
          : state.photos.filter((p) => p.orientation === wantOrientation);
    }

    const brightPool = tierCandidates.filter(isWellExposedForHero);
    let source =
      brightPool.length >= Math.min(3, tierCandidates.length)
        ? brightPool
        : tierCandidates;

    if (source.length === 0) {
      source = state.photos;
    }

    if (source.length <= MAX_CAROUSEL_SLIDES) {
      return source;
    }

    const sampled = [];
    for (let i = 0; i < MAX_CAROUSEL_SLIDES; i++) {
      const idx = Math.floor((i * (source.length - 1)) / (MAX_CAROUSEL_SLIDES - 1));
      sampled.push(source[idx]);
    }
    return sampled;
  }

  function ensureHeroSlideLoaded(slideIdx, isPriority = false) {
    const slides = dom.heroSlidesLayer.querySelectorAll(".hero-slide");
    const count = slides.length;
    if (!count) return;
    const normIdx = ((slideIdx % count) + count) % count;
    const slide = slides[normIdx];
    const photo = state.heroPhotos[normIdx];
    if (!slide || !photo) return;

    const hiImg = slide.querySelector(".hero-hi");
    if (!hiImg || hiImg.dataset.started === "1") return;

    hiImg.dataset.started = "1";
    if (isPriority && "fetchPriority" in hiImg) {
      hiImg.fetchPriority = "high";
    }

    const reveal = () => {
      slide.classList.add("is-loaded");
      state.hydratedIds.add(photo.id);
      if (isPriority && count > 1) {
        ensureHeroSlideLoaded(normIdx + 1, false);
      }
    };

    hiImg.addEventListener(
      "load",
      () => {
        if (typeof hiImg.decode === "function") {
          hiImg.decode().then(reveal).catch(reveal);
        } else {
          reveal();
        }
      },
      { once: true }
    );
    hiImg.addEventListener("error", reveal, { once: true });
    hiImg.src = resolvePhotoUrl(photo);
  }

  function renderHeroCover() {
    const wantOrientation = getDesiredHeroOrientation();
    lastHeroOrientation = wantOrientation;
    state.heroPhotos = pickCarouselSlides(wantOrientation);

    if (state.heroSlideIdx >= state.heroPhotos.length) {
      state.heroSlideIdx = 0;
    }

    dom.heroSlidesLayer.replaceChildren();
    dom.heroDots.replaceChildren();
    dom.heroDots.hidden = state.heroPhotos.length <= 1;

    state.heroPhotos.forEach((photo, idx) => {
      const slide = document.createElement("div");
      const mismatchClass =
        photo.orientation && photo.orientation !== wantOrientation
          ? " is-contain-fallback"
          : "";
      slide.className = `hero-slide${idx === state.heroSlideIdx ? " is-active" : ""}${mismatchClass}`;
      slide.style.backgroundColor = photo.dominantColor || "#141210";
      slide.style.setProperty("--focal-pos", getPhotoFocalPosition(photo));

      if (photo.lqip) {
        const lqipImg = document.createElement("img");
        lqipImg.className = "hero-lqip";
        lqipImg.src = photo.lqip;
        lqipImg.alt = "";
        lqipImg.draggable = false;
        lqipImg.setAttribute("aria-hidden", "true");
        slide.appendChild(lqipImg);
      }

      const img = document.createElement("img");
      img.className = "hero-hi";
      img.alt = photo.filename;
      img.decoding = "async";
      img.draggable = false;
      slide.appendChild(img);

      slide.addEventListener("click", () => {
        if (performance.now() - lastHeroSwipeTime < 450) return;
        openLightboxByPhotoId(photo.id, state.heroPhotos);
      });
      dom.heroSlidesLayer.appendChild(slide);

      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = `hero-dot${idx === state.heroSlideIdx ? " is-active" : ""}`;
      dot.setAttribute("role", "tab");
      dot.setAttribute("aria-selected", idx === state.heroSlideIdx ? "true" : "false");
      dot.setAttribute("aria-label", `Slide ${idx + 1}`);

      const bar = document.createElement("span");
      bar.className = "hero-dot-bar";
      dot.appendChild(bar);

      dot.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (performance.now() - lastHeroDotsTouchTime < 600) return;
        setActiveHeroSlide(idx);
        restartHeroSlideshow();
      });

      dom.heroDots.appendChild(dot);
    });

    ensureHeroSlideLoaded(state.heroSlideIdx, true);
    restartHeroSlideshow();
  }

  function setActiveHeroSlide(nextIdx) {
    const count = state.heroPhotos.length;
    if (!count) return;
    state.heroSlideIdx = ((nextIdx % count) + count) % count;

    const slides = dom.heroSlidesLayer.querySelectorAll(".hero-slide");
    slides.forEach((el, idx) => el.classList.toggle("is-active", idx === state.heroSlideIdx));

    const dots = dom.heroDots.querySelectorAll(".hero-dot");
    dots.forEach((dot, idx) => {
      const active = idx === state.heroSlideIdx;
      dot.classList.toggle("is-active", active);
      dot.setAttribute("aria-selected", active ? "true" : "false");
    });

    ensureHeroSlideLoaded(state.heroSlideIdx, true);
  }

  function restartHeroSlideshow() {
    clearInterval(state.heroTimer);
    if (state.heroPhotos.length <= 1) return;
    state.heroTimer = setInterval(() => {
      if (state.lightboxOpen) return;
      const rect = dom.heroStage.getBoundingClientRect();
      if (rect.bottom < 0) return;
      setActiveHeroSlide(state.heroSlideIdx + 1);
    }, 5500);
  }

  function updateHeroDotsProximity(clientX, clientY) {
    const dots = dom.heroDots.querySelectorAll(".hero-dot");
    if (!dots.length) return;

    const groupRect = dom.heroDots.getBoundingClientRect();
    if (
      clientX < groupRect.left - HERO_PROXIMITY_RADIUS_PX ||
      clientX > groupRect.right + HERO_PROXIMITY_RADIUS_PX ||
      clientY < groupRect.top - HERO_PROXIMITY_RADIUS_PX ||
      clientY > groupRect.bottom + HERO_PROXIMITY_RADIUS_PX
    ) {
      resetHeroDotsProximity();
      return;
    }

    dots.forEach((dot) => {
      const r = dot.getBoundingClientRect();
      const cx = r.left + r.width * 0.5;
      const cy = r.top + r.height * 0.5;
      const dist = Math.hypot(clientX - cx, clientY - cy);
      const t = Math.max(0, Math.min(1, 1 - dist / HERO_PROXIMITY_RADIUS_PX));
      const smooth = t * t * (3 - 2 * t);
      dot.style.setProperty("--prox", smooth.toFixed(3));
    });
  }

  function selectHeroDotAtTouchX(clientX) {
    const dots = Array.from(dom.heroDots.querySelectorAll(".hero-dot"));
    if (!dots.length) return;

    let closestIdx = 0;
    let minDist = Infinity;
    dots.forEach((dot, idx) => {
      const r = dot.getBoundingClientRect();
      const cx = r.left + r.width * 0.5;
      const dist = Math.abs(clientX - cx);
      if (dist < minDist) {
        minDist = dist;
        closestIdx = idx;
      }
      const t = Math.max(0, Math.min(1, 1 - dist / 64));
      const smooth = t * t * (3 - 2 * t);
      dot.style.setProperty("--prox", smooth.toFixed(3));
    });

    if (closestIdx !== state.heroSlideIdx) {
      setActiveHeroSlide(closestIdx);
    }
    restartHeroSlideshow();
  }

  function resetHeroDotsProximity() {
    dom.heroDots.querySelectorAll(".hero-dot").forEach((dot) => {
      dot.style.setProperty("--prox", "0");
    });
  }

  // =========================================================================
  // 2. Hierarchical Year → Month → Day Navigation & Timeline Scrubber
  // =========================================================================

  function syncScrubberVisibility() {
    if (!dom.timelineScrubber || dom.timelineScrubber.hidden) {
      if (dom.timelineScrubber) dom.timelineScrubber.classList.remove("is-visible");
      return;
    }
    if (!dom.heroStage) {
      dom.timelineScrubber.classList.add("is-visible");
      return;
    }
    const heroRect = dom.heroStage.getBoundingClientRect();
    dom.timelineScrubber.classList.toggle("is-visible", heroRect.bottom <= 4);
  }

  function formatMonthLabel(monthKey) {
    const m = /^(\d{4})-(\d{2})$/.exec(monthKey);
    if (!m) return monthKey;
    const yrShort = m[1].slice(2);
    const moIdx = Math.max(0, Math.min(11, Number(m[2]) - 1));
    return `${SHORT_MONTHS[moIdx]} '${yrShort}`;
  }

  function buildMonthBuckets(activeChapters) {
    const buckets = [];
    const byKey = new Map();
    for (const ch of activeChapters) {
      const mKey = String(ch.date || "").slice(0, 7);
      let b = byKey.get(mKey);
      if (!b) {
        b = {
          monthKey: mKey,
          label: formatMonthLabel(mKey),
          firstDate: ch.date,
          chapters: [],
        };
        byKey.set(mKey, b);
        buckets.push(b);
      }
      b.chapters.push(ch);
    }
    return buckets;
  }

  function getActiveNavContextPhotos() {
    if (getActiveShoot()) return [];
    if (isShootsIndexMode()) return state.photos;
    return getReelPhotos();
  }

  function populateScrubberTicks(activeChapters, monthBuckets, activeDate) {
    dom.timelineScrubber.replaceChildren();

    if (activeChapters.length <= 8) {
      lastExpandedMonthKey = "*flat*";
      for (const ch of activeChapters) {
        const isCurrent = activeDate === ch.date;
        const tick = document.createElement("button");
        tick.type = "button";
        tick.className = `scrubber-tick${isCurrent ? " is-active" : ""}`;
        tick.dataset.date = ch.date;
        tick.innerHTML = `
          <span class="scrubber-label">${ch.label}</span>
          <span class="scrubber-line"></span>
        `;
        tick.addEventListener("click", () => jumpToDateChapter(ch.date));
        dom.timelineScrubber.appendChild(tick);
      }
      return;
    }

    const activeMonthKey = String(activeDate || "").slice(0, 7);
    lastExpandedMonthKey = activeMonthKey;

    for (const bucket of monthBuckets) {
      const isActiveMonth = bucket.monthKey === activeMonthKey;
      const mTick = document.createElement("button");
      mTick.type = "button";
      mTick.className = `scrubber-tick is-month${isActiveMonth ? " is-active" : ""}`;
      mTick.dataset.month = bucket.monthKey;
      mTick.dataset.date = bucket.firstDate;
      mTick.innerHTML = `
        <span class="scrubber-label">${bucket.label}</span>
        <span class="scrubber-line"></span>
      `;
      mTick.addEventListener("click", () => jumpToDateChapter(bucket.firstDate));
      dom.timelineScrubber.appendChild(mTick);

      if (isActiveMonth && bucket.chapters.length > 1) {
        const maxSubTicks = 10;
        let subChapters = bucket.chapters;
        if (subChapters.length > maxSubTicks) {
          const sampled = [];
          for (let i = 0; i < maxSubTicks; i++) {
            const idx = Math.floor((i * (subChapters.length - 1)) / (maxSubTicks - 1));
            sampled.push(subChapters[idx]);
          }
          if (!sampled.some((c) => c.date === activeDate)) {
            const exact = subChapters.find((c) => c.date === activeDate);
            if (exact) sampled[0] = exact;
          }
          subChapters = sampled;
        }

        for (const ch of subChapters) {
          const isDayCurrent = ch.date === activeDate;
          const dTick = document.createElement("button");
          dTick.type = "button";
          dTick.className = `scrubber-tick is-day-sub${isDayCurrent ? " is-active" : ""}`;
          dTick.dataset.date = ch.date;
          dTick.innerHTML = `
            <span class="scrubber-label">${ch.label}</span>
            <span class="scrubber-line"></span>
          `;
          dTick.addEventListener("click", () => jumpToDateChapter(ch.date));
          dom.timelineScrubber.appendChild(dTick);
        }
      }
    }
  }

  function renderDateNavigation(contextPhotos) {
    if (!contextPhotos || contextPhotos.length === 0) {
      lastDateNavKey = "";
      lastExpandedMonthKey = "";
      dom.dateChaptersNav.replaceChildren();
      dom.timelineScrubber.replaceChildren();
      dom.dateChaptersNav.hidden = true;
      dom.timelineScrubber.hidden = true;
      dom.timelineScrubber.classList.remove("is-visible");
      return;
    }

    const countsByDate = new Map();
    for (const p of contextPhotos) {
      countsByDate.set(p.date, (countsByDate.get(p.date) || 0) + 1);
    }

    const activeChapters = state.chapters.filter((ch) => countsByDate.has(ch.date));
    if (activeChapters.length <= 1) {
      lastDateNavKey = "";
      lastExpandedMonthKey = "";
      dom.dateChaptersNav.replaceChildren();
      dom.timelineScrubber.replaceChildren();
      dom.dateChaptersNav.hidden = true;
      dom.timelineScrubber.hidden = true;
      dom.timelineScrubber.classList.remove("is-visible");
      return;
    }

    if (!state.activeDate || !countsByDate.has(state.activeDate)) {
      state.activeDate = activeChapters[0].date;
    }

    const monthBuckets = buildMonthBuckets(activeChapters);
    const useMonthPills = activeChapters.length > 6 && monthBuckets.length > 1;
    const navKey = `${useMonthPills ? "M" : "D"}:${activeChapters.map((ch) => ch.date).join("|")}`;

    dom.dateChaptersNav.hidden = false;
    dom.timelineScrubber.hidden = false;
    syncScrubberVisibility();

    if (navKey === lastDateNavKey) {
      highlightActiveDateUI(state.activeDate, false, activeChapters, monthBuckets);
      return;
    }

    lastDateNavKey = navKey;
    dom.dateChaptersNav.replaceChildren();

    if (useMonthPills) {
      const activeMonth = String(state.activeDate || "").slice(0, 7);
      for (const bucket of monthBuckets) {
        const pill = document.createElement("button");
        pill.type = "button";
        pill.className = `nav-pill${bucket.monthKey === activeMonth ? " is-active" : ""}`;
        pill.dataset.month = bucket.monthKey;
        pill.dataset.date = bucket.firstDate;
        pill.textContent = bucket.label;
        pill.addEventListener("click", () => jumpToDateChapter(bucket.firstDate));
        dom.dateChaptersNav.appendChild(pill);
      }
    } else {
      for (const ch of activeChapters) {
        const pill = document.createElement("button");
        pill.type = "button";
        pill.className = `nav-pill${state.activeDate === ch.date ? " is-active" : ""}`;
        pill.dataset.date = ch.date;
        pill.textContent = ch.label;
        pill.addEventListener("click", () => jumpToDateChapter(ch.date));
        dom.dateChaptersNav.appendChild(pill);
      }
    }

    populateScrubberTicks(activeChapters, monthBuckets, state.activeDate);
  }

  function highlightActiveDateUI(dateKey, centerStrip = true, cachedChapters = null, cachedBuckets = null) {
    const activeMonth = String(dateKey || "").slice(0, 7);
    let activePill = null;

    dom.dateChaptersNav.querySelectorAll(".nav-pill").forEach((btn) => {
      const match = btn.dataset.month
        ? btn.dataset.month === activeMonth
        : btn.dataset.date === dateKey;
      btn.classList.toggle("is-active", match);
      if (match) activePill = btn;
    });

    if (lastExpandedMonthKey && lastExpandedMonthKey !== "*flat*" && lastExpandedMonthKey !== activeMonth) {
      const ctxPhotos = getActiveNavContextPhotos();
      const countsByDate = new Map();
      for (const p of ctxPhotos) countsByDate.set(p.date, 1);
      const activeChs = cachedChapters || state.chapters.filter((ch) => countsByDate.has(ch.date));
      const buckets = cachedBuckets || buildMonthBuckets(activeChs);
      populateScrubberTicks(activeChs, buckets, dateKey);
    } else {
      dom.timelineScrubber.querySelectorAll(".scrubber-tick").forEach((btn) => {
        const match = btn.classList.contains("is-month")
          ? btn.dataset.month === activeMonth
          : btn.dataset.date === dateKey;
        btn.classList.toggle("is-active", match);
      });
    }

    if (centerStrip && activePill && !dom.dateChaptersNav.hidden) {
      const strip = dom.dateChaptersNav;
      if (strip.scrollWidth > strip.clientWidth + 4) {
        const targetLeft =
          activePill.offsetLeft - (strip.clientWidth - activePill.offsetWidth) * 0.5;
        strip.scrollTo({ left: Math.max(0, targetLeft), behavior: "smooth" });
      }
    }
  }

  function scheduleHydrationAfterJump(delayMs = 380) {
    clearTimeout(postJumpTimer);
    postJumpTimer = setTimeout(() => {
      suppressScrollObserversUntil = 0;
      syncVirtualReelDOM();
      schedulePumpHydration();
      syncUrlParams(false, { includeScrollPosition: true });
    }, delayMs);
  }

  function scrollSmoothWithLongApproach(targetTop) {
    const clampedTop = Math.max(0, targetTop);
    const dist = Math.abs(clampedTop - window.scrollY);

    if (dist > window.innerHeight * 2.5) {
      const approachOffset = Math.min(220, Math.round(window.innerHeight * 0.28));
      const approachTop =
        clampedTop > window.scrollY
          ? Math.max(0, clampedTop - approachOffset)
          : clampedTop + approachOffset;
      window.scrollTo({ top: approachTop, behavior: "instant" });
      syncVirtualReelDOM();
      requestAnimationFrame(() => {
        window.scrollTo({ top: clampedTop, behavior: "smooth" });
        scheduleHydrationAfterJump(420);
      });
    } else {
      window.scrollTo({ top: clampedTop, behavior: "smooth" });
      scheduleHydrationAfterJump(420);
    }
  }

  function jumpToDateChapter(dateKey) {
    suppressScrollObserversUntil = performance.now() + 900;
    state.activeDate = dateKey;
    highlightActiveDateUI(dateKey, true);

    if (isShootsIndexMode()) {
      requestAnimationFrame(() => {
        const navH = syncNavHeight();
        const cards = Array.from(dom.chaptersContainer.querySelectorAll(".shoot-card"));
        const targetCard =
          cards.find((el) => {
            const shoot = state.shootById.get(el.dataset.shootId);
            return shoot && shoot.datesSet.has(dateKey);
          }) ||
          cards.find((el) => {
            const shoot = state.shootById.get(el.dataset.shootId);
            return shoot && shoot.newestDate <= dateKey;
          });
        if (!targetCard) return;
        const targetTop =
          window.scrollY + targetCard.getBoundingClientRect().top - navH - 14;
        scrollSmoothWithLongApproach(targetTop);
      });
      return;
    }

    const reelPhotos = getReelPhotos();
    const targetPhoto = reelPhotos.find((p) => p.date === dateKey);
    if (!targetPhoto || !reelWrapEl) return;

    const offsetY = state.photoTopById.get(targetPhoto.id);
    if (offsetY === undefined) return;

    requestAnimationFrame(() => {
      const navH = syncNavHeight();
      const reelOriginTop = window.scrollY + reelWrapEl.getBoundingClientRect().top;
      scrollSmoothWithLongApproach(reelOriginTop + offsetY - navH - 12);
    });
  }

  function updateActiveChapterFromScroll() {
    if (performance.now() < suppressScrollObserversUntil) return;
    if (dom.dateChaptersNav.hidden) return;

    const navH = dom.galleryNav ? dom.galleryNav.getBoundingClientRect().height : 58;
    const thresholdY = navH + 56;

    if (isShootsIndexMode()) {
      const cards = dom.chaptersContainer.querySelectorAll(".shoot-card");
      if (!cards.length) return;
      let candidate = null;
      for (const card of cards) {
        const rect = card.getBoundingClientRect();
        if (rect.top <= thresholdY + 40) {
          const shoot = state.shootById.get(card.dataset.shootId);
          if (shoot) candidate = shoot.newestDate;
        } else {
          break;
        }
      }
      if (!candidate) {
        const firstShoot = state.shootById.get(cards[0].dataset.shootId);
        if (firstShoot) candidate = firstShoot.newestDate;
      }
      if (candidate && candidate !== state.activeDate) {
        state.activeDate = candidate;
        highlightActiveDateUI(candidate, true);
      }
      return;
    }

    const blocks = state.layoutBlocks;
    if (!blocks.length || !reelWrapEl) return;

    const relThreshold = thresholdY - reelWrapEl.getBoundingClientRect().top;
    if (relThreshold <= 0) {
      const firstPhotoBlock = blocks.find((b) => b.firstDate);
      const firstDate = firstPhotoBlock && firstPhotoBlock.firstDate;
      if (firstDate && firstDate !== state.activeDate) {
        state.activeDate = firstDate;
        highlightActiveDateUI(firstDate, true);
      }
      return;
    }

    // Binary search last block with b.top <= relThreshold
    let lo = 0;
    let hi = blocks.length - 1;
    let bestIdx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (blocks[mid].top <= relThreshold) {
        bestIdx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    let candidate = null;
    for (let i = bestIdx; i >= 0; i--) {
      const b = blocks[i];
      if (!b.photoEntries || !b.photoEntries.length) continue;
      for (const pe of b.photoEntries) {
        if (pe.top <= relThreshold) {
          candidate = pe.photo.date;
        }
      }
      if (candidate) break;
    }

    if (candidate && candidate !== state.activeDate) {
      state.activeDate = candidate;
      highlightActiveDateUI(candidate, true);
    }
  }

  // =========================================================================
  // 3. Aspect-Preserving Auto-Layout Engine (Editorial + Contact Sheet)
  // =========================================================================

  function getContainerInnerWidth() {
    if (dom.galleryMain) {
      const style = window.getComputedStyle(dom.galleryMain);
      const padX =
        (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
      const inner = dom.galleryMain.clientWidth - padX;
      if (inner > 80) return Math.floor(inner);
    }
    const fallbackViewport = document.documentElement.clientWidth || window.innerWidth;
    return Math.min(1400, Math.max(280, fallbackViewport - 32));
  }

  function getTargetRowHeight(containerWidth, isCompact = false) {
    if (isCompact) {
      if (containerWidth < 560) return 104;
      if (containerWidth < 900) return 128;
      return 154;
    }
    if (containerWidth < 560) return 230;
    if (containerWidth < 900) return 300;
    return 390;
  }

  function makeRowBlock(items, height, clamped) {
    const hRounded = Math.round(height * 100) / 100;
    const ids = items.map((x) => x.photo.id).join(",");
    return {
      type: "row",
      clamped: Boolean(clamped),
      height: hRounded,
      key: `r:${clamped ? 1 : 0}:${Math.round(hRounded * 10)}:${ids}`,
      items,
      firstDate: items[0] ? items[0].photo.date : "",
    };
  }

  function solveJustifiedRows(photos, containerWidth, gutter, isCompact = false) {
    const targetH = getTargetRowHeight(containerWidth, isCompact);
    const maxPerRow = isCompact ? 9 : 4;
    const maxSingleH = isCompact
      ? Math.round(targetH * 1.45)
      : Math.min(520, Math.round((window.innerHeight || 800) * 0.68));
    const blocks = [];

    let row = [];
    let aspectSum = 0;

    for (let i = 0; i < photos.length; i++) {
      const p = photos[i];
      row.push(p);
      aspectSum += p.aspect;

      const availW = Math.max(80, containerWidth - gutter * (row.length - 1));
      const naturalH = availW / aspectSum;
      const isLast = i === photos.length - 1;

      if (naturalH <= targetH * 1.16 || row.length >= maxPerRow) {
        blocks.push(
          makeRowBlock(
            row.map((item) => ({
              photo: item,
              width: item.aspect * naturalH,
              height: naturalH,
            })),
            naturalH,
            false
          )
        );
        row = [];
        aspectSum = 0;
      } else if (isLast) {
        const clampedH = Math.min(naturalH, maxSingleH);
        const isClamped = clampedH < naturalH - 0.5;
        blocks.push(
          makeRowBlock(
            row.map((item) => ({
              photo: item,
              width: item.aspect * clampedH,
              height: clampedH,
            })),
            clampedH,
            isClamped
          )
        );
      }
    }

    return blocks;
  }

  function trySolveHeroSpread(slice, containerWidth, gutter, heroOnRight) {
    if (containerWidth < 680 || slice.length < 3) return null;

    const heroIdx = slice.findIndex((p) => p.hero);
    if (heroIdx === -1) return null;

    const hero = slice[heroIdx];
    const companions = slice.filter((_, idx) => idx !== heroIdx).slice(0, 2);
    if (companions.length < 2) return null;

    const aH = hero.aspect;
    const a1 = companions[0].aspect;
    const a2 = companions[1].aspect;
    const invSum = 1 / a1 + 1 / a2;

    const wStack = (containerWidth - gutter * (1 + aH)) / (1 + aH * invSum);
    if (wStack < 165) return null;

    const h1 = Math.round((wStack / a1) * 100) / 100;
    const h2 = Math.round((wStack / a2) * 100) / 100;
    const totalH = Math.round((h1 + h2 + gutter) * 100) / 100;
    const wHero = containerWidth - gutter - wStack;

    if (totalH < 330 || totalH > 760 || wHero < 280) {
      return null;
    }

    return {
      type: "spread",
      heroOnRight,
      height: totalH,
      key: `s:${heroOnRight ? 1 : 0}:${Math.round(totalH * 10)}:${hero.id}:${companions[0].id},${companions[1].id}`,
      heroItem: { photo: hero, width: wHero, height: totalH },
      stackWidth: wStack,
      stackItems: [
        { photo: companions[0], width: wStack, height: h1 },
        { photo: companions[1], width: wStack, height: h2 },
      ],
      sliceOrder: slice,
      firstDate: slice[0].date,
    };
  }

  function solveAutoLayout(photos, containerWidth, gutter) {
    const isCompact = state.density === "compact";
    if (isCompact || containerWidth < 680 || state.filter === "highlights") {
      return solveJustifiedRows(photos, containerWidth, gutter, isCompact);
    }

    const blocks = [];
    let cursor = 0;
    let spreadParity = 0;

    while (cursor < photos.length) {
      const spread = trySolveHeroSpread(
        photos.slice(cursor, cursor + 3),
        containerWidth,
        gutter,
        spreadParity % 2 === 1
      );

      if (spread) {
        blocks.push(spread);
        spreadParity += 1;
        cursor += 3;
        continue;
      }

      const rowSlice = [];
      while (cursor < photos.length && rowSlice.length < 3) {
        if (
          rowSlice.length >= 2 &&
          trySolveHeroSpread(photos.slice(cursor, cursor + 3), containerWidth, gutter, false)
        ) {
          break;
        }
        rowSlice.push(photos[cursor]);
        cursor += 1;

        const aspectSum = rowSlice.reduce((acc, p) => acc + p.aspect, 0);
        const estH = (containerWidth - gutter * (rowSlice.length - 1)) / aspectSum;
        if (estH <= getTargetRowHeight(containerWidth, false) * 1.15) {
          break;
        }
      }

      blocks.push(...solveJustifiedRows(rowSlice, containerWidth, gutter, false));
    }

    return blocks;
  }

  function computeReelLayout(photos, containerWidth) {
    const isCompact = state.density === "compact";
    const gutter = isCompact ? 6 : 12;
    const sessions = groupPhotosIntoSessions(photos);
    const blocks = [];

    for (let sIdx = 0; sIdx < sessions.length; sIdx++) {
      if (sIdx > 0) {
        const prevSession = sessions[sIdx - 1];
        const prevPhoto = prevSession[prevSession.length - 1];
        const nextPhoto = sessions[sIdx][0];
        blocks.push({
          type: "divider",
          height: DIVIDER_BLOCK_HEIGHT,
          key: `div:${prevPhoto.id}:${nextPhoto.id}`,
          firstDate: "",
          photoEntries: [],
        });
      }
      blocks.push(...solveAutoLayout(sessions[sIdx], containerWidth, gutter));
    }

    const photoTopById = new Map();
    let cursorY = 0;

    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      b.top = cursorY;

      if (b.type === "row") {
        b.photoEntries = b.items.map((it) => {
          photoTopById.set(it.photo.id, b.top);
          return { photo: it.photo, top: b.top };
        });
      } else if (b.type === "spread") {
        const topMap = new Map();
        topMap.set(b.heroItem.photo.id, b.top);
        topMap.set(b.stackItems[0].photo.id, b.top);
        topMap.set(
          b.stackItems[1].photo.id,
          b.top + b.stackItems[0].height + gutter
        );
        b.photoEntries = b.sliceOrder.map((p) => {
          const pTop = topMap.get(p.id) ?? b.top;
          photoTopById.set(p.id, pTop);
          return { photo: p, top: pTop };
        });
      }

      cursorY = Math.round((cursorY + b.height + (i < blocks.length - 1 ? gutter : 0)) * 100) / 100;
    }

    return {
      blocks,
      photoTopById,
      totalHeight: Math.max(0, cursorY),
    };
  }

  // =========================================================================
  // 4. Cached Photo Cards, Hydration Queue & Offscreen Bitmap LRU Eviction
  // =========================================================================

  function touchDecodedCard(photoId) {
    decodedCardLru.delete(photoId);
    decodedCardLru.add(photoId);
  }

  function evictOffscreenBitmaps() {
    if (decodedCardLru.size <= MAX_DECODED_CARDS) return;
    for (const oldId of decodedCardLru) {
      if (decodedCardLru.size <= MAX_DECODED_CARDS) break;
      const entry = cardCache.get(oldId);
      if (!entry || entry.figure.isConnected) continue;
      entry.hiImg.removeAttribute("src");
      delete entry.hiImg.dataset.fallbackTried;
      entry.figure.classList.remove("is-loaded");
      decodedCardLru.delete(oldId);
    }
  }

  function syncCardFavoriteButton(photoId) {
    const cached = cardCache.get(photoId);
    if (!cached) return;
    const isFav = state.favorites.has(photoId);
    cached.btnFav.classList.toggle("is-fav", isFav);
    cached.btnFav.title = isFav ? "Remove from Favorites" : "Save to Favorites";
    cached.btnFav.textContent = isFav ? "♥" : "♡";
  }

  function getOrCreatePhotoCard(photo) {
    let entry = cardCache.get(photo.id);
    if (!entry) {
      const figure = document.createElement("figure");
      figure.className = "photo-card";
      figure.style.margin = "0";
      figure.style.setProperty("--tile-bg", photo.dominantColor || "#1c1917");
      figure.style.setProperty("--focal-pos", getPhotoFocalPosition(photo));

      const lqipImg = document.createElement("img");
      lqipImg.className = "photo-lqip";
      lqipImg.src = photo.lqip;
      lqipImg.alt = "";
      lqipImg.setAttribute("aria-hidden", "true");
      figure.appendChild(lqipImg);

      const hiImg = document.createElement("img");
      hiImg.className = "photo-hi";
      hiImg.alt = photo.filename;
      hiImg.decoding = "async";
      hiImg.dataset.photoId = photo.id;
      figure.appendChild(hiImg);

      const overlay = document.createElement("div");
      overlay.className = "card-overlay";

      const topActions = document.createElement("div");
      topActions.className = "card-top-actions";

      const btnFav = document.createElement("button");
      btnFav.type = "button";
      btnFav.className = "card-action-btn";
      btnFav.addEventListener("click", (ev) => {
        ev.stopPropagation();
        togglePhotoFavorite(photo.id);
      });

      const btnShare = document.createElement("button");
      btnShare.type = "button";
      btnShare.className = "card-action-btn";
      btnShare.title = "Share photograph";
      btnShare.setAttribute("aria-label", "Share photograph");
      btnShare.innerHTML = ICONS.share;
      btnShare.addEventListener("click", (ev) => {
        ev.stopPropagation();
        sharePhotoById(photo.id, btnShare);
      });

      const btnDl = document.createElement("a");
      btnDl.className = "card-action-btn";
      btnDl.href = resolvePhotoUrl(photo);
      btnDl.download = photo.filename;
      btnDl.title = "Download photograph";
      btnDl.textContent = "↓";
      btnDl.addEventListener("click", (ev) => ev.stopPropagation());

      topActions.append(btnFav, btnShare, btnDl);
      overlay.appendChild(topActions);
      figure.appendChild(overlay);

      figure.addEventListener("click", () => openLightboxByPhotoId(photo.id));

      entry = { figure, hiImg, btnFav, btnShare };
      cardCache.set(photo.id, entry);
    }

    syncCardFavoriteButton(photo.id);

    if (entry.hiImg.getAttribute("src")) {
      touchDecodedCard(photo.id);
    } else if (!pendingHydrationSet.has(entry.hiImg) && imgObserver) {
      imgObserver.observe(entry.hiImg);
    }

    return entry.figure;
  }

  function startImageHydration(imgEl) {
    const photoId = imgEl.dataset.photoId;
    if (!photoId || imgEl.getAttribute("src")) return;
    const photo = state.photoById.get(photoId);
    if (!photo) return;

    const primaryUrl = resolveThumbUrl(photo);
    const fallbackMasterUrl = resolvePhotoUrl(photo);

    activeHydrations += 1;
    let settled = false;

    const finalize = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(safetyTimer);
      activeHydrations = Math.max(0, activeHydrations - 1);

      if (ok) {
        const tile = imgEl.closest(".photo-card, .shoot-cell");
        if (tile) tile.classList.add("is-loaded");
        if (tile && tile.classList.contains("photo-card")) {
          touchDecodedCard(photoId);
        }
      } else {
        imgEl.removeAttribute("src");
        if (imgEl.isConnected && imgObserver) {
          imgObserver.observe(imgEl);
        }
      }

      schedulePumpHydration();
    };

    const safetyTimer = setTimeout(() => {
      finalize(Boolean(imgEl.complete && imgEl.naturalWidth > 0));
    }, 9000);

    const onLoaded = () => {
      if (typeof imgEl.decode === "function") {
        imgEl
          .decode()
          .then(() => finalize(true))
          .catch(() => finalize(true));
      } else {
        finalize(true);
      }
    };

    const onError = () => {
      if (imgEl.dataset.fallbackTried !== "1" && primaryUrl !== fallbackMasterUrl) {
        imgEl.dataset.fallbackTried = "1";
        imgEl.addEventListener("load", onLoaded, { once: true });
        imgEl.addEventListener("error", () => finalize(false), { once: true });
        imgEl.src = fallbackMasterUrl;
        return;
      }
      finalize(false);
    };

    imgEl.addEventListener("load", onLoaded, { once: true });
    imgEl.addEventListener("error", onError, { once: true });
    imgEl.src = primaryUrl;

    if (imgEl.complete && imgEl.naturalWidth > 0) {
      onLoaded();
    }
  }

  function schedulePumpHydration() {
    if (pumpRaf) return;
    pumpRaf = requestAnimationFrame(() => {
      pumpRaf = 0;
      pumpHydrationQueue();
    });
  }

  function pumpHydrationQueue() {
    if (!pendingHydrationSet.size) return;

    const now = performance.now();
    if (now < suppressScrollObserversUntil) {
      scheduleHydrationAfterJump(Math.ceil(suppressScrollObserversUntil - now) + 30);
      return;
    }

    if (activeHydrations >= MAX_CONCURRENT_HYDRATIONS) return;

    const vh = window.innerHeight || 800;
    const centerV = vh * 0.5;
    const candidates = [];

    for (const imgEl of pendingHydrationSet) {
      if (!imgEl.isConnected || imgEl.getAttribute("src")) {
        pendingHydrationSet.delete(imgEl);
        continue;
      }

      const rect = imgEl.getBoundingClientRect();
      if (rect.bottom < -600 || rect.top > vh + 600) {
        pendingHydrationSet.delete(imgEl);
        if (imgObserver) imgObserver.observe(imgEl);
        continue;
      }

      const inViewport = rect.bottom >= 0 && rect.top <= vh;
      const midY = (rect.top + rect.bottom) * 0.5;
      const score = (inViewport ? 0 : 10000) + Math.abs(midY - centerV);
      candidates.push({ imgEl, score });
    }

    candidates.sort((a, b) => a.score - b.score);

    for (const item of candidates) {
      if (activeHydrations >= MAX_CONCURRENT_HYDRATIONS) break;
      pendingHydrationSet.delete(item.imgEl);
      startImageHydration(item.imgEl);
    }
  }

  function setupObservers() {
    if (imgObserver) imgObserver.disconnect();
    imgObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            imgObserver.unobserve(entry.target);
            pendingHydrationSet.add(entry.target);
          }
        }
        schedulePumpHydration();
      },
      { rootMargin: "420px 0px" }
    );
  }

  // =========================================================================
  // 5. Virtualized Reel & Shoots Index Rendering
  // =========================================================================

  function buildSingleBlockDOM(block) {
    if (block.type === "divider") {
      const divEl = document.createElement("div");
      divEl.className = "session-divider";
      divEl.dataset.blockKey = block.key;
      divEl.setAttribute("role", "separator");
      return divEl;
    }

    if (block.type === "spread") {
      const spreadEl = document.createElement("div");
      spreadEl.className = "editorial-spread";
      spreadEl.dataset.blockKey = block.key;

      const heroCard = getOrCreatePhotoCard(block.heroItem.photo);
      heroCard.style.flex = `${block.heroItem.width.toFixed(3)} 1 0%`;
      heroCard.style.width = "auto";
      heroCard.style.height = `${block.heroItem.height.toFixed(2)}px`;

      const stackEl = document.createElement("div");
      stackEl.className = "spread-stack";
      stackEl.style.flex = `${block.stackWidth.toFixed(3)} 1 0%`;
      stackEl.style.width = "auto";

      for (const sItem of block.stackItems) {
        const sCard = getOrCreatePhotoCard(sItem.photo);
        sCard.style.flex = `0 0 ${sItem.height.toFixed(2)}px`;
        sCard.style.width = "100%";
        sCard.style.height = `${sItem.height.toFixed(2)}px`;
        stackEl.appendChild(sCard);
      }

      if (block.heroOnRight) {
        spreadEl.append(stackEl, heroCard);
      } else {
        spreadEl.append(heroCard, stackEl);
      }
      return spreadEl;
    }

    const rowEl = document.createElement("div");
    rowEl.className = "gallery-row";
    rowEl.dataset.blockKey = block.key;

    for (const rItem of block.items) {
      const card = getOrCreatePhotoCard(rItem.photo);
      if (block.clamped) {
        card.style.flex = `0 1 ${rItem.width.toFixed(2)}px`;
        card.style.width = `${rItem.width.toFixed(2)}px`;
      } else {
        card.style.flex = `${rItem.photo.aspect} 1 0%`;
        card.style.width = "auto";
      }
      card.style.height = `${rItem.height.toFixed(2)}px`;
      rowEl.appendChild(card);
    }

    return rowEl;
  }

  function clearMountedReel() {
    mountedReelBlocks.clear();
    state.virtStartIdx = -1;
    state.virtEndIdx = -1;
    reelWrapEl = null;
  }

  function syncVirtualReelDOM(forceUpdate = false) {
    if (!reelWrapEl || !reelWrapEl.isConnected) return;
    const blocks = state.layoutBlocks;
    if (!blocks.length) {
      reelWrapEl.replaceChildren();
      mountedReelBlocks.clear();
      return;
    }

    const vh = window.innerHeight || 800;
    const reelRectTop = reelWrapEl.getBoundingClientRect().top;
    const viewMinY = -reelRectTop - VIRTUAL_OVERSCAN_PX;
    const viewMaxY = -reelRectTop + vh + VIRTUAL_OVERSCAN_PX;

    // Binary search first block where b.top + b.height >= viewMinY
    let lo = 0;
    let hi = blocks.length - 1;
    let startIdx = blocks.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (blocks[mid].top + blocks[mid].height >= viewMinY) {
        startIdx = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    if (startIdx >= blocks.length) startIdx = blocks.length - 1;

    // Advance endIdx while b.top <= viewMaxY
    let endIdx = startIdx;
    while (endIdx + 1 < blocks.length && blocks[endIdx + 1].top <= viewMaxY) {
      endIdx += 1;
    }

    if (
      !forceUpdate &&
      startIdx === state.virtStartIdx &&
      endIdx === state.virtEndIdx
    ) {
      return;
    }

    state.virtStartIdx = startIdx;
    state.virtEndIdx = endIdx;

    const wantedKeys = new Set();
    for (let i = startIdx; i <= endIdx; i++) {
      wantedKeys.add(blocks[i].key);
    }

    for (const [key, el] of mountedReelBlocks) {
      if (!wantedKeys.has(key)) {
        el.remove();
        mountedReelBlocks.delete(key);
      }
    }

    for (let i = startIdx; i <= endIdx; i++) {
      const b = blocks[i];
      let el = mountedReelBlocks.get(b.key);
      if (!el) {
        el = buildSingleBlockDOM(b);
        el.style.position = "absolute";
        el.style.left = "0";
        el.style.right = "0";
        mountedReelBlocks.set(b.key, el);
        reelWrapEl.appendChild(el);
      } else {
        // Re-ensure cards inside existing block remain observed if evicted earlier
        el.querySelectorAll(".photo-hi").forEach((imgEl) => {
          if (!imgEl.getAttribute("src") && !pendingHydrationSet.has(imgEl) && imgObserver) {
            imgObserver.observe(imgEl);
          }
        });
      }
      el.style.top = `${b.top.toFixed(2)}px`;
      el.style.height = `${b.height.toFixed(2)}px`;
    }

    evictOffscreenBitmaps();
    schedulePumpHydration();
  }

  function captureViewportAnchorPhotoId() {
    if (!reelWrapEl || !state.layoutBlocks.length) return null;
    const navH = dom.galleryNav ? dom.galleryNav.getBoundingClientRect().height : 58;
    const relY = navH + 24 - reelWrapEl.getBoundingClientRect().top;
    if (relY < 40) return null;

    let lo = 0;
    let hi = state.layoutBlocks.length - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (state.layoutBlocks[mid].top <= relY) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    for (let i = best; i < state.layoutBlocks.length; i++) {
      const b = state.layoutBlocks[i];
      if (b.photoEntries && b.photoEntries.length > 0) {
        return b.photoEntries[0].photo.id;
      }
    }
    return null;
  }

  function openShootDetail(shootId, pushHistory = true) {
    if (!state.shootById.has(shootId)) return;
    state.shootsIndexScrollY = window.scrollY;
    state.filter = "shoots";
    state.activeShootId = shootId;
    state.activeDate = null;
    syncUrlParams(pushHistory, { includeScrollPosition: false });
    renderGallery(true);

    requestAnimationFrame(() => {
      const navH = syncNavHeight();
      const mainTop = window.scrollY + dom.galleryMain.getBoundingClientRect().top - navH + 4;
      if (window.scrollY > mainTop) {
        window.scrollTo({ top: Math.max(0, mainTop), behavior: "instant" });
      }
      syncVirtualReelDOM(true);
    });
  }

  function closeShootDetail(pushHistory = true) {
    const restoreY = state.shootsIndexScrollY;
    state.activeShootId = null;
    state.activeDate = null;
    syncUrlParams(pushHistory, { includeScrollPosition: false });
    renderGallery(true);

    if (restoreY > 0) {
      requestAnimationFrame(() => {
        window.scrollTo({ top: restoreY, behavior: "instant" });
        schedulePumpHydration();
      });
    }
  }

  function buildShootCardDOM(shoot) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "shoot-card";
    btn.dataset.shootId = shoot.id;

    const collage = document.createElement("div");
    collage.className = "shoot-collage";
    collage.dataset.count = String(Math.max(1, Math.min(4, shoot.previews.length)));

    for (const p of shoot.previews) {
      const cell = document.createElement("div");
      cell.className = "shoot-cell";
      cell.style.setProperty("--tile-bg", p.dominantColor || "#1c1917");
      cell.style.setProperty("--focal-pos", getPhotoFocalPosition(p));

      if (p.lqip) {
        const lqip = document.createElement("img");
        lqip.className = "photo-lqip";
        lqip.src = p.lqip;
        lqip.alt = "";
        lqip.setAttribute("aria-hidden", "true");
        cell.appendChild(lqip);
      }

      const hi = document.createElement("img");
      hi.className = "photo-hi";
      hi.alt = p.filename;
      hi.decoding = "async";
      hi.dataset.photoId = p.id;
      cell.appendChild(hi);
      if (imgObserver) imgObserver.observe(hi);

      collage.appendChild(cell);
    }

    const meta = document.createElement("div");
    meta.className = "shoot-meta";

    const titleSpan = document.createElement("span");
    titleSpan.className = "shoot-title";
    titleSpan.textContent = shoot.title;

    const countSpan = document.createElement("span");
    countSpan.className = "shoot-count";
    countSpan.textContent = shoot.countLabel;

    meta.append(titleSpan, countSpan);
    btn.append(collage, meta);

    btn.addEventListener("click", () => openShootDetail(shoot.id, true));
    return btn;
  }

  function renderShootsIndex() {
    clearMountedReel();
    state.layoutBlocks = [];
    state.photoTopById = new Map();

    if (dom.chaptersContainer.dataset.mode !== "shoots-index") {
      dom.chaptersContainer.replaceChildren();
      dom.chaptersContainer.dataset.mode = "shoots-index";
      const grid = document.createElement("div");
      grid.className = "shoots-grid";
      for (const shoot of state.shoots) {
        grid.appendChild(buildShootCardDOM(shoot));
      }
      dom.chaptersContainer.appendChild(grid);
    }

    schedulePumpHydration();
  }

  function renderGallery(forceRemount = false) {
    updateToolbarCounts();
    syncDensityUI();

    if (isShootsIndexMode()) {
      renderDateNavigation(state.photos);
      syncNavHeight();
      renderShootsIndex();
      return;
    }

    const activeShoot = getActiveShoot();
    const filtered = getReelPhotos();
    renderDateNavigation(activeShoot ? [] : filtered);
    syncNavHeight();

    if (filtered.length === 0) {
      clearMountedReel();
      state.layoutBlocks = [];
      state.photoTopById = new Map();
      dom.chaptersContainer.replaceChildren();
      dom.chaptersContainer.dataset.mode = "empty";
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.innerHTML =
        state.filter === "favorites"
          ? `
            <h3>No saved favorites yet</h3>
            <p>Click ♡ on any photograph to add it to your favorites.</p>
          `
          : `
            <h3>No photographs in this view</h3>
            <p>Switch to Archive to browse all photographs.</p>
          `;
      dom.chaptersContainer.appendChild(empty);
      return;
    }

    const containerWidth = getContainerInnerWidth();
    lastContainerWidth = containerWidth;

    const wantMode = activeShoot ? `shoot:${activeShoot.id}` : "reel";
    if (dom.chaptersContainer.dataset.mode !== wantMode || forceRemount) {
      clearMountedReel();
      dom.chaptersContainer.replaceChildren();
      dom.chaptersContainer.dataset.mode = wantMode;

      if (activeShoot) {
        const detailBar = document.createElement("div");
        detailBar.className = "shoot-detail-bar";

        const backBtn = document.createElement("button");
        backBtn.type = "button";
        backBtn.className = "shoot-back-btn";
        backBtn.textContent = "← All Shoots";
        backBtn.addEventListener("click", () => closeShootDetail(true));

        const detailRight = document.createElement("div");
        detailRight.className = "shoot-detail-right";

        const detailMeta = document.createElement("div");
        detailMeta.className = "shoot-detail-meta";
        const titleEl = document.createElement("span");
        titleEl.className = "shoot-detail-title";
        titleEl.textContent = activeShoot.title;
        const countEl = document.createElement("span");
        countEl.className = "shoot-detail-count";
        countEl.textContent = activeShoot.countLabel;
        detailMeta.append(titleEl, countEl);

        const shareShootBtn = document.createElement("button");
        shareShootBtn.type = "button";
        shareShootBtn.className = "shoot-share-btn";
        shareShootBtn.title = "Share this shoot";
        shareShootBtn.innerHTML = `${ICONS.share}<span>Share</span>`;
        shareShootBtn.addEventListener("click", () => shareCurrentLocation(shareShootBtn));

        detailRight.append(detailMeta, shareShootBtn);
        detailBar.append(backBtn, detailRight);
        dom.chaptersContainer.appendChild(detailBar);
      }

      reelWrapEl = document.createElement("div");
      reelWrapEl.className = "virtual-reel";
      dom.chaptersContainer.appendChild(reelWrapEl);
    } else if (!reelWrapEl) {
      reelWrapEl = dom.chaptersContainer.querySelector(".virtual-reel");
    }

    const layout = computeReelLayout(filtered, containerWidth);
    state.layoutBlocks = layout.blocks;
    state.photoTopById = layout.photoTopById;
    state.layoutTotalHeight = layout.totalHeight;
    reelWrapEl.style.height = `${layout.totalHeight.toFixed(2)}px`;

    syncVirtualReelDOM(true);
  }

  // =========================================================================
  // 6. Favorites & Windowed Lightbox
  // =========================================================================

  function togglePhotoFavorite(photoId) {
    const photo = state.photoById.get(photoId);
    if (!photo) return;

    if (state.favorites.has(photoId)) {
      state.favorites.delete(photoId);
    } else {
      state.favorites.add(photoId);
    }
    saveFavorites();
    syncCardFavoriteButton(photoId);

    if (state.filter === "favorites") {
      renderGallery();
      syncUrlParams(false);
    } else {
      updateToolbarCounts();
      syncNavHeight();
    }

    if (state.lightboxOpen) syncLightboxControls();
  }

  function openLightboxByPhotoId(
    photoId,
    explicitList = null,
    { pushHistory = true, syncUrl = true } = {}
  ) {
    const wasOpen = state.lightboxOpen;
    const baseList = explicitList || getReelPhotos();
    const list = baseList.length > 0 ? baseList : state.photos;
    let idx = list.findIndex((p) => p.id === photoId);
    if (idx === -1) {
      idx = state.photos.findIndex((p) => p.id === photoId);
      if (idx === -1) return;
      state.lightboxList = state.photos;
    } else {
      state.lightboxList = list;
    }

    state.lightboxIdx = idx;
    state.lightboxOpen = true;
    state.filmstripStart = -1;
    state.filmstripEnd = -1;
    setLightboxZoom(false);

    dom.lightbox.classList.add("is-open");
    document.body.style.overflow = "hidden";

    updateLightboxSlide({ syncUrl: false });

    if (syncUrl) {
      if (!wasOpen && pushHistory) {
        lightboxPushedHistory = true;
        syncUrlParams(true, { includeScrollPosition: false });
      } else {
        syncUrlParams(false, { includeScrollPosition: false });
      }
    }
  }

  function closeLightbox({ fromPopstate = false } = {}) {
    if (!state.lightboxOpen) return;
    state.lightboxOpen = false;
    setLightboxZoom(false);
    dom.lightbox.classList.remove("is-open");
    document.body.style.overflow = "";

    if (fromPopstate) {
      lightboxPushedHistory = false;
      return;
    }

    if (lightboxPushedHistory) {
      lightboxPushedHistory = false;
      closingLightboxViaBack = true;
      window.history.back();
    } else {
      syncUrlParams(false, { includeScrollPosition: true });
    }
  }

  function stepLightbox(delta) {
    if (!state.lightboxList.length) return;
    setLightboxZoom(false);
    state.lightboxIdx =
      (state.lightboxIdx + delta + state.lightboxList.length) % state.lightboxList.length;
    updateLightboxSlide();
  }

  function setLightboxZoom(zoomed) {
    state.lightboxZoomed = Boolean(zoomed);
    dom.lbImgWrap.classList.toggle("is-zoomed", state.lightboxZoomed);
    dom.lbBtnZoom.classList.toggle("is-active", state.lightboxZoomed);
    dom.lbBtnZoom.innerHTML = state.lightboxZoomed
      ? '<span aria-hidden="true">⊖</span><span class="lb-btn-label">Fit</span>'
      : '<span aria-hidden="true">⊕</span><span class="lb-btn-label">Zoom</span>';
    if (!state.lightboxZoomed) {
      dom.lbImg.style.transformOrigin = "center center";
    }
  }

  function preloadNeighborLightboxSlides() {
    const len = state.lightboxList.length;
    if (len <= 1) return;
    for (const delta of [1, -1]) {
      const neighbor = state.lightboxList[(state.lightboxIdx + delta + len) % len];
      if (neighbor && !state.hydratedIds.has(neighbor.id)) {
        const pre = new Image();
        pre.decoding = "async";
        pre.src = resolvePhotoUrl(neighbor);
      }
    }
  }

  function syncLightboxFilmstripWindow() {
    const len = state.lightboxList.length;
    if (!len) {
      dom.lbFilmstrip.replaceChildren();
      return;
    }

    const totalWindow = FILMSTRIP_HALF_WINDOW * 2 + 1;
    let wantStart = 0;
    let wantEnd = len - 1;
    if (len > totalWindow) {
      wantStart = Math.max(
        0,
        Math.min(len - totalWindow, state.lightboxIdx - FILMSTRIP_HALF_WINDOW)
      );
      wantEnd = wantStart + totalWindow - 1;
    }

    const needsRebuild =
      state.filmstripStart === -1 ||
      (len <= totalWindow && (state.filmstripStart !== 0 || state.filmstripEnd !== len - 1)) ||
      (len > totalWindow &&
        (state.lightboxIdx < state.filmstripStart + 8 ||
          state.lightboxIdx > state.filmstripEnd - 8));

    if (needsRebuild) {
      state.filmstripStart = wantStart;
      state.filmstripEnd = wantEnd;
      dom.lbFilmstrip.replaceChildren();

      for (let idx = wantStart; idx <= wantEnd; idx++) {
        const photo = state.lightboxList[idx];
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `lb-thumb${idx === state.lightboxIdx ? " is-active" : ""}`;
        btn.dataset.lbIdx = String(idx);
        const img = document.createElement("img");
        img.src = photo.lqip || resolveThumbUrl(photo);
        img.alt = photo.filename;
        btn.appendChild(img);
        btn.addEventListener("click", () => {
          setLightboxZoom(false);
          state.lightboxIdx = idx;
          updateLightboxSlide();
        });
        dom.lbFilmstrip.appendChild(btn);
      }
    }

    let activeThumb = null;
    for (const el of dom.lbFilmstrip.children) {
      const isCurrent = Number(el.dataset.lbIdx) === state.lightboxIdx;
      el.classList.toggle("is-active", isCurrent);
      if (isCurrent) activeThumb = el;
    }

    if (activeThumb) {
      const targetLeft =
        activeThumb.offsetLeft -
        (dom.lbFilmstrip.clientWidth - activeThumb.offsetWidth) * 0.5;
      dom.lbFilmstrip.scrollTo({
        left: Math.max(0, targetLeft),
        behavior: needsRebuild ? "instant" : "smooth",
      });
    }
  }

  function updateLightboxSlide({ syncUrl = true } = {}) {
    const photo = state.lightboxList[state.lightboxIdx];
    if (!photo) return;

    const url = resolvePhotoUrl(photo);
    dom.lbImg.src = url;
    dom.lbImg.alt = photo.filename;
    state.hydratedIds.add(photo.id);

    dom.lbCounter.textContent = `${formatCount(state.lightboxIdx + 1)} / ${formatCount(state.lightboxList.length)}`;
    dom.lbTitle.textContent = photo.filename;

    dom.lbBtnDownload.href = url;
    dom.lbBtnDownload.download = photo.filename;

    syncLightboxControls();
    preloadNeighborLightboxSlides();
    syncLightboxFilmstripWindow();

    if (syncUrl && state.lightboxOpen) {
      syncUrlParams(false, { includeScrollPosition: false });
    }
  }

  function syncLightboxControls() {
    const photo = state.lightboxList[state.lightboxIdx];
    if (!photo) return;
    const isFav = state.favorites.has(photo.id);
    dom.lbBtnFav.classList.toggle("is-active", isFav);
    dom.lbBtnFav.innerHTML = isFav
      ? '<span aria-hidden="true">♥</span><span class="lb-btn-label">Favorited</span>'
      : '<span aria-hidden="true">♡</span><span class="lb-btn-label">Favorite</span>';
  }

  // =========================================================================
  // 7. Deep-Link Scroll Restoration & Event Listeners
  // =========================================================================

  function scrollToGalleryMainInstant() {
    if (!dom.galleryMain) return;
    const navH = syncNavHeight();
    const mainTop = window.scrollY + dom.galleryMain.getBoundingClientRect().top - navH + 4;
    if (mainTop > 0) {
      suppressScrollObserversUntil = performance.now() + 260;
      window.scrollTo({ top: Math.max(0, mainTop), behavior: "instant" });
      syncScrubberVisibility();
      syncVirtualReelDOM(true);
      schedulePumpHydration();
    }
  }

  function scrollToPhotoInstant(photoId) {
    const photo = state.photoById.get(photoId);
    if (!photo || !reelWrapEl || !state.photoTopById.has(photoId)) return false;
    const navH = syncNavHeight();
    const reelOriginTop = window.scrollY + reelWrapEl.getBoundingClientRect().top;
    const offsetY = state.photoTopById.get(photoId);
    suppressScrollObserversUntil = performance.now() + 320;
    window.scrollTo({
      top: Math.max(0, reelOriginTop + offsetY - navH - 14),
      behavior: "instant",
    });
    if (photo.date && !getActiveShoot()) {
      state.activeDate = photo.date;
      highlightActiveDateUI(photo.date, true);
    }
    syncScrubberVisibility();
    syncVirtualReelDOM(true);
    schedulePumpHydration();
    return true;
  }

  function scrollToDateInstant(dateKey) {
    if (!dateKey) return false;
    if (isShootsIndexMode()) {
      const cards = Array.from(dom.chaptersContainer.querySelectorAll(".shoot-card"));
      const targetCard =
        cards.find((el) => {
          const shoot = state.shootById.get(el.dataset.shootId);
          return shoot && shoot.datesSet.has(dateKey);
        }) ||
        cards.find((el) => {
          const shoot = state.shootById.get(el.dataset.shootId);
          return shoot && shoot.newestDate <= dateKey;
        });
      if (!targetCard) return false;
      const navH = syncNavHeight();
      const targetTop = window.scrollY + targetCard.getBoundingClientRect().top - navH - 14;
      suppressScrollObserversUntil = performance.now() + 320;
      state.activeDate = dateKey;
      highlightActiveDateUI(dateKey, true);
      window.scrollTo({ top: Math.max(0, targetTop), behavior: "instant" });
      syncScrubberVisibility();
      schedulePumpHydration();
      return true;
    }

    const reelPhotos = getReelPhotos();
    const targetPhoto = reelPhotos.find((p) => p.date === dateKey);
    if (targetPhoto && scrollToPhotoInstant(targetPhoto.id)) {
      return true;
    }
    return false;
  }

  function scrollToUrlPositionInstant() {
    if (state.urlAnchorId && scrollToPhotoInstant(state.urlAnchorId)) {
      return;
    }
    if (state.urlDate && scrollToDateInstant(state.urlDate)) {
      return;
    }
    if (state.hasExplicitUrlView) {
      scrollToGalleryMainInstant();
    }
  }

  function bindHorizontalSwipe(el, onSwipeLeft, onSwipeRight) {
    let startX = 0;
    let startY = 0;
    let tracking = false;

    el.addEventListener(
      "touchstart",
      (ev) => {
        if (
          ev.touches.length !== 1 ||
          (ev.target && ev.target.closest && ev.target.closest(".hero-controls-bar"))
        ) {
          tracking = false;
          return;
        }
        startX = ev.touches[0].clientX;
        startY = ev.touches[0].clientY;
        tracking = true;
      },
      { passive: true }
    );

    el.addEventListener(
      "touchend",
      (ev) => {
        if (!tracking || ev.changedTouches.length !== 1) return;
        tracking = false;
        const dx = ev.changedTouches[0].clientX - startX;
        const dy = ev.changedTouches[0].clientY - startY;
        if (Math.abs(dx) > 42 && Math.abs(dx) > Math.abs(dy) * 1.35) {
          if (dx < 0) onSwipeLeft();
          else onSwipeRight();
        }
      },
      { passive: true }
    );
  }

  function toggleDensityMode() {
    const anchorPhotoId = !isShootsIndexMode() ? captureViewportAnchorPhotoId() : null;
    state.density = state.density === "compact" ? "editorial" : "compact";
    try {
      localStorage.setItem(STORAGE_KEYS.density, state.density);
    } catch (_) {}

    syncDensityUI();

    if (isShootsIndexMode()) return;

    renderGallery(false);

    if (anchorPhotoId && reelWrapEl && state.photoTopById.has(anchorPhotoId)) {
      const navH = syncNavHeight();
      const reelOriginTop = window.scrollY + reelWrapEl.getBoundingClientRect().top;
      const nextOffset = state.photoTopById.get(anchorPhotoId);
      suppressScrollObserversUntil = performance.now() + 260;
      window.scrollTo({
        top: Math.max(0, reelOriginTop + nextOffset - navH - 18),
        behavior: "instant",
      });
      syncVirtualReelDOM(true);
    }
  }

  function bindEvents() {
    dom.btnExplore.addEventListener("click", () => {
      const targetTop = dom.heroStage ? dom.heroStage.offsetHeight : 0;
      window.scrollTo({ top: targetTop, behavior: "smooth" });
    });

    [dom.filterHighlights, dom.filterShoots, dom.filterArchive, dom.filterFavorites].forEach(
      (btn) => {
        if (!btn) return;
        btn.addEventListener("click", () => {
          const nextFilter = btn.dataset.filter;
          if (state.filter === nextFilter) {
            if (nextFilter === "shoots" && state.activeShootId) {
              closeShootDetail(true);
            }
            return;
          }
          const wasInGallery = isScrolledIntoGallery();
          state.filter = nextFilter;
          state.activeShootId = null;
          state.activeDate = null;
          syncUrlParams(true, { includeScrollPosition: false });
          renderGallery(true);
          if (wasInGallery) {
            scrollToGalleryMainInstant();
          }
        });
      }
    );

    window.addEventListener("popstate", () => {
      const prevFilter = state.filter;
      const prevShootId = state.activeShootId;
      parseUrlViewState();

      if (prevFilter !== state.filter || prevShootId !== state.activeShootId) {
        state.activeDate = null;
        renderGallery(true);
      }

      if (state.urlPhotoId && state.photoById.has(state.urlPhotoId)) {
        openLightboxByPhotoId(state.urlPhotoId, null, {
          pushHistory: false,
          syncUrl: false,
        });
        return;
      }

      if (closingLightboxViaBack) {
        closingLightboxViaBack = false;
        return;
      }

      if (state.lightboxOpen) {
        closeLightbox({ fromPopstate: true });
        return;
      }

      if (state.urlAnchorId || state.urlDate) {
        scrollToUrlPositionInstant();
      }
    });

    if (dom.btnShareView) {
      dom.btnShareView.addEventListener("click", () => shareCurrentLocation(dom.btnShareView));
    }

    if (dom.btnDensityToggle) {
      dom.btnDensityToggle.addEventListener("click", toggleDensityMode);
    }

    dom.btnThemeToggle.addEventListener("click", () => {
      const next = dom.html.getAttribute("data-theme") === "dark" ? "light" : "dark";
      dom.html.setAttribute("data-theme", next);
      try {
        localStorage.setItem(STORAGE_KEYS.theme, next);
      } catch (_) {}
    });

    dom.btnBackTop.addEventListener("click", () => {
      suppressScrollObserversUntil = performance.now() + 750;
      if (state.chapters.length > 0) {
        state.activeDate = state.chapters[0].date;
        highlightActiveDateUI(state.activeDate, true);
      }
      window.scrollTo({ top: 0, behavior: "smooth" });
      scheduleHydrationAfterJump(500);
    });

    dom.heroStage.addEventListener("pointermove", (ev) => {
      if (ev.pointerType && ev.pointerType !== "mouse") return;
      const x = ev.clientX;
      const y = ev.clientY;
      if (proximityRaf) cancelAnimationFrame(proximityRaf);
      proximityRaf = requestAnimationFrame(() => updateHeroDotsProximity(x, y));
    });

    dom.heroStage.addEventListener("pointerleave", () => {
      if (proximityRaf) cancelAnimationFrame(proximityRaf);
      resetHeroDotsProximity();
    });

    let activeDotsPointerId = null;

    dom.heroDots.addEventListener("pointerdown", (ev) => {
      if (ev.pointerType === "mouse") return;
      ev.stopPropagation();
      if (ev.cancelable) ev.preventDefault();
      activeDotsPointerId = ev.pointerId;
      lastHeroDotsTouchTime = performance.now();
      try {
        dom.heroDots.setPointerCapture(ev.pointerId);
      } catch (_) {}
      selectHeroDotAtTouchX(ev.clientX);
    });

    dom.heroDots.addEventListener("pointermove", (ev) => {
      if (ev.pointerId !== activeDotsPointerId || ev.pointerType === "mouse") return;
      lastHeroDotsTouchTime = performance.now();
      selectHeroDotAtTouchX(ev.clientX);
    });

    const endDotsTouch = (ev) => {
      if (ev.pointerId !== activeDotsPointerId) return;
      activeDotsPointerId = null;
      lastHeroDotsTouchTime = performance.now();
      resetHeroDotsProximity();
    };
    dom.heroDots.addEventListener("pointerup", endDotsTouch);
    dom.heroDots.addEventListener("pointercancel", endDotsTouch);

    bindHorizontalSwipe(
      dom.heroShowcase,
      () => {
        lastHeroSwipeTime = performance.now();
        setActiveHeroSlide(state.heroSlideIdx + 1);
        restartHeroSlideshow();
      },
      () => {
        lastHeroSwipeTime = performance.now();
        setActiveHeroSlide(state.heroSlideIdx - 1);
        restartHeroSlideshow();
      }
    );

    dom.lbBtnClose.addEventListener("click", () => closeLightbox());
    dom.lbPrev.addEventListener("click", () => stepLightbox(-1));
    dom.lbNext.addEventListener("click", () => stepLightbox(1));

    dom.lbBtnZoom.addEventListener("click", () => setLightboxZoom(!state.lightboxZoomed));
    dom.lbImgWrap.addEventListener("click", (ev) => {
      const nextZoom = !state.lightboxZoomed;
      if (nextZoom) {
        const rect = dom.lbImg.getBoundingClientRect();
        const xPct = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * 100;
        const yPct = ((ev.clientY - rect.top) / Math.max(1, rect.height)) * 100;
        dom.lbImg.style.transformOrigin = `${xPct.toFixed(1)}% ${yPct.toFixed(1)}%`;
      }
      setLightboxZoom(nextZoom);
    });

    dom.lbImgWrap.addEventListener("mousemove", (ev) => {
      if (!state.lightboxZoomed) return;
      const rect = dom.lbImgWrap.getBoundingClientRect();
      const xPct = Math.min(
        100,
        Math.max(0, ((ev.clientX - rect.left) / Math.max(1, rect.width)) * 100)
      );
      const yPct = Math.min(
        100,
        Math.max(0, ((ev.clientY - rect.top) / Math.max(1, rect.height)) * 100)
      );
      dom.lbImg.style.transformOrigin = `${xPct.toFixed(1)}% ${yPct.toFixed(1)}%`;
    });

    bindHorizontalSwipe(
      dom.lbStage,
      () => {
        if (!state.lightboxZoomed) stepLightbox(1);
      },
      () => {
        if (!state.lightboxZoomed) stepLightbox(-1);
      }
    );

    dom.lbBtnFav.addEventListener("click", () => {
      const photo = state.lightboxList[state.lightboxIdx];
      if (photo) togglePhotoFavorite(photo.id);
    });

    if (dom.lbBtnShare) {
      dom.lbBtnShare.addEventListener("click", () => {
        const photo = state.lightboxList[state.lightboxIdx];
        if (photo) sharePhotoById(photo.id, dom.lbBtnShare);
      });
    }

    dom.lbStage.addEventListener("click", (ev) => {
      if (ev.target === dom.lbStage) closeLightbox();
    });

    window.addEventListener("keydown", (ev) => {
      if (!state.lightboxOpen) return;
      if (ev.key === "Escape") closeLightbox();
      else if (ev.key === "ArrowLeft") stepLightbox(-1);
      else if (ev.key === "ArrowRight") stepLightbox(1);
      else if (ev.key === "z" || ev.key === "Z") setLightboxZoom(!state.lightboxZoomed);
      else if (ev.key === "f" || ev.key === "F") {
        const p = state.lightboxList[state.lightboxIdx];
        if (p) togglePhotoFavorite(p.id);
      } else if (ev.key === "s" || ev.key === "S") {
        const p = state.lightboxList[state.lightboxIdx];
        if (p) sharePhotoById(p.id, dom.lbBtnShare);
      }
    });

    window.addEventListener(
      "scroll",
      () => {
        if (scrollRaf) return;
        scrollRaf = requestAnimationFrame(() => {
          scrollRaf = 0;
          syncScrubberVisibility();
          syncVirtualReelDOM();
          updateActiveChapterFromScroll();
          schedulePumpHydration();
          scheduleScrollUrlSync();
        });
      },
      { passive: true }
    );

    const galleryRo = new ResizeObserver(() => {
      syncScrubberVisibility();
      if (!state.photos.length) return;
      const nextOrient = getDesiredHeroOrientation();
      if (lastHeroOrientation && nextOrient !== lastHeroOrientation) {
        state.heroSlideIdx = 0;
        renderHeroCover();
      }
      const w = getContainerInnerWidth();
      if (!isShootsIndexMode() && Math.abs(w - lastContainerWidth) > 2) {
        renderGallery(false);
      }
    });
    galleryRo.observe(dom.galleryMain);
    if (dom.heroStage) galleryRo.observe(dom.heroStage);

    if (dom.galleryNav) {
      const navRo = new ResizeObserver(() => {
        syncNavHeight();
      });
      navRo.observe(dom.galleryNav);
    }
  }

  // =========================================================================
  // Bootstrap
  // =========================================================================

  function applyCollectionHeader(collection) {
    if (!collection) return;
    const hasTitle = Boolean(collection.title);
    const hasSub = Boolean(collection.subtitle);
    const hasCurator = Boolean(collection.curator);

    if (hasTitle) {
      document.title = collection.title;
      dom.collectionTitle.textContent = collection.title;
      dom.collectionTitle.hidden = false;
    }
    if (hasSub) {
      dom.collectionSubtitle.textContent = collection.subtitle;
      dom.collectionSubtitle.hidden = false;
    }
    if (hasCurator) {
      dom.collectionEyebrow.textContent = collection.curator;
      dom.collectionEyebrow.hidden = false;
      dom.footerCopyright.textContent = `© ${collection.curator}`;
      dom.footerCopyright.hidden = false;
      dom.footer.classList.add("has-credit");
    }

    if (hasTitle || hasSub || hasCurator) {
      dom.heroCopy.hidden = false;
      dom.heroStage.classList.add("has-copy");
    }
  }

  async function loadManifest() {
    if (window.__EMBEDDED_MANIFEST__) {
      return window.__EMBEDDED_MANIFEST__;
    }
    const params = new URLSearchParams(window.location.search);
    const preferLocal = params.get("manifest") === "local";
    const remoteUrl =
      (window.__GALLERY_CONFIG__ && window.__GALLERY_CONFIG__.remoteManifestUrl) ||
      REMOTE_MANIFEST_URL;

    if (!preferLocal && remoteUrl) {
      try {
        const remoteRes = await fetch(remoteUrl, { cache: "no-cache" });
        if (remoteRes.ok) {
          return await remoteRes.json();
        }
      } catch (_) {}
    }

    const localRes = await fetch("./manifest.json", { cache: "no-cache" });
    if (!localRes.ok) {
      throw new Error(`Failed to fetch manifest (${localRes.status})`);
    }
    return await localRes.json();
  }

  async function init() {
    loadPersistedState();
    setupObservers();
    bindEvents();

    try {
      const manifest = await loadManifest();
      state.manifest = manifest;
      state.photos = [...(manifest.photos || [])].sort(
        (a, b) =>
          String(b.timestamp || "").localeCompare(String(a.timestamp || "")) ||
          String(b.id || "").localeCompare(String(a.id || ""))
      );
      state.photoById = new Map(state.photos.map((p) => [p.id, p]));
      let rawChapters = Array.isArray(manifest.chapters) ? manifest.chapters : [];
      if (!rawChapters.length && state.photos.length) {
        const seenDates = new Map();
        for (const p of state.photos) {
          if (p.date) seenDates.set(p.date, (seenDates.get(p.date) || 0) + 1);
        }
        const multiYear = new Set([...seenDates.keys()].map((d) => d.slice(0, 4))).size > 1;
        rawChapters = [...seenDates.entries()].map(([dKey, cnt]) => {
          const p = parseYmdParts(dKey);
          const label = p
            ? `${SHORT_MONTHS[p.m - 1]} ${String(p.d).padStart(2, "0")}${multiYear ? `, '${String(p.y).slice(-2)}` : ""}`
            : dKey;
          const fullDate = p ? `${LONG_MONTHS[p.m - 1]} ${p.d}, ${p.y}` : dKey;
          return { date: dKey, label, fullDate, count: cnt };
        });
      }
      state.chapters = [...rawChapters].sort((a, b) =>
        String(b.date || "").localeCompare(String(a.date || ""))
      );
      state.assetBaseUrl =
        (manifest.collection && manifest.collection.assetBaseUrl) || "./3k_exports";
      state.thumbBaseUrl =
        (manifest.collection && manifest.collection.thumbBaseUrl) || "";

      buildShootsFromPhotos(state.photos);

      // If deep-linking directly to a non-highlight photo or anchor without an explicit ?view=,
      // switch the background reel to Archive so the target photo is visible in the grid.
      const deepTargetId = state.urlPhotoId || state.urlAnchorId;
      const deepTargetPhoto = deepTargetId ? state.photoById.get(deepTargetId) : null;
      if (
        state.filter === "highlights" &&
        deepTargetPhoto &&
        !deepTargetPhoto.hero &&
        !new URLSearchParams(window.location.search).get("view")
      ) {
        state.filter = "archive";
      } else if (
        state.filter === "highlights" &&
        !state.hasExplicitUrlView &&
        !state.photos.some((p) => p.hero)
      ) {
        state.filter = "archive";
      }

      applyCollectionHeader(manifest.collection);
      renderHeroCover();
      renderGallery(true);

      requestAnimationFrame(() => {
        if (state.urlPhotoId && state.photoById.has(state.urlPhotoId)) {
          scrollToPhotoInstant(state.urlPhotoId);
          openLightboxByPhotoId(state.urlPhotoId, null, {
            pushHistory: false,
            syncUrl: false,
          });
        } else {
          scrollToUrlPositionInstant();
        }
      });
    } catch (_) {
      dom.chaptersContainer.innerHTML = `
        <div class="empty-state">
          <h3>Gallery unavailable</h3>
          <p>Unable to load the photograph manifest.</p>
        </div>
      `;
    }
  }

  init();
})();
