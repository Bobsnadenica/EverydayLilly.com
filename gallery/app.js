(function () {
  const ROUTES = {
    months: "/gallery/months/",
    test: "/gallery/test/",
  };

  const FILTERS = [
    { id: "all", label: "Everything" },
    { id: "picture", label: "Pictures" },
    { id: "gif", label: "GIFs" },
    { id: "movie", label: "Movies" },
  ];

  const MEDIA_LABELS = {
    all: "everything",
    picture: "pictures",
    gif: "GIFs",
    movie: "movies",
  };

  const MONTHS_PER_YEAR = 12;
  const GALLERY_YEAR_COUNT = 5;
  const GALLERY_MONTH_COUNT = MONTHS_PER_YEAR * GALLERY_YEAR_COUNT;

  // Keep manifests in this authorized page only. Month changes reuse state.manifest;
  // every new visit validates access with the backend instead of trusting a disk cache.
  function getAccountKey(session) {
    return `${session?.claims?.iss || ""}:${session?.claims?.sub || ""}`;
  }

  function getInitialMonth(manifest, session) {
    const query = new URLSearchParams(window.location.search).get("month");
    if (/^\d+$/.test(query || "")) {
      const month = parseGalleryMonth(Number(query) - 1);
      if (month !== null) return month;
    }
    try {
      const saved = parseGalleryMonth(localStorage.getItem(`lilly.album.month.${getAccountKey(session)}`));
      if (saved !== null) return saved;
    } catch (error) {}
    const months = [...(manifest.photos || []).map(getMonthBucket), ...(manifest.heroPhotos || []).map(getHeroMonthBucket)]
      .filter(month => Number.isInteger(month) && month >= 0 && month < GALLERY_MONTH_COUNT);
    return months.length ? Math.max(...months) : 0;
  }

  function rememberMonth(month, session) {
    try { localStorage.setItem(`lilly.album.month.${getAccountKey(session)}`, String(month)); } catch (error) {}
    const url = new URL(window.location.href);
    url.searchParams.set("month", String(month + 1));
    window.history.replaceState(null, "", url);
  }

  function normalizeCollection(value) {
    return value === "test" ? "test" : "months";
  }

  function getRequestedCollection() {
    return normalizeCollection(document.body.dataset.galleryMode || "months");
  }

  function getManifestUrl() {
    const baseDomain = document.body.dataset.galleryDomain || "";
    return `${baseDomain.replace(/\/+$/, "")}/api/gallery/manifest`;
  }

  function getUploadUrl() {
    const baseDomain = document.body.dataset.galleryDomain || "";
    return `${baseDomain.replace(/\/+$/, "")}/api/gallery/upload-url`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeCssUrl(value) {
    return String(value ?? "")
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"');
  }

  function getPhotoStem(photo) {
    if (photo?.label) {
      return String(photo.label);
    }

    const key = String(photo?.key || "");
    const filename = key.split("/").pop() || key;
    return filename.replace(/\.[^.]+$/, "");
  }

  function parseGalleryMonth(value) {
    if (!/^\d+$/.test(String(value ?? ""))) {
      return null;
    }

    const month = Number.parseInt(String(value), 10);
    return Number.isInteger(month) && month >= 0 && month < GALLERY_MONTH_COUNT ? month : null;
  }

  function getTimelineYear(month) {
    return Math.floor(month / MONTHS_PER_YEAR) + 1;
  }

  function getDisplayMonthNumber(month) {
    return month + 1;
  }

  function getMonthInYear(month) {
    return (month % MONTHS_PER_YEAR) + 1;
  }

  function getTimelineLabel(month) {
    return `Година ${getTimelineYear(month)} · Месец ${getMonthInYear(month)}`;
  }

  function getMonthBucket(photo) {
    const key = String(photo?.key || "");
    const nestedMonthMatch = key.match(/\/(\d{1,2})\/[^/]+$/);

    if (nestedMonthMatch) {
      return parseGalleryMonth(nestedMonthMatch[1]) ?? -1;
    }

    const stem = getPhotoStem(photo);
    const match = stem.match(/\d+/);
    return match ? parseGalleryMonth(match[0]) ?? -1 : -1;
  }

  function getHeroMonthBucket(photo) {
    const key = String(photo?.key || "");
    const nestedHeroMatch = key.match(/\/hero\/(\d{1,2})\/[^/]+$/);

    if (nestedHeroMatch) {
      return parseGalleryMonth(nestedHeroMatch[1]);
    }

    const stem = getPhotoStem(photo);
    const parsedMonth = parseGalleryMonth(stem);
    if (parsedMonth !== null) {
      return parsedMonth;
    }

    return null;
  }

  function canUploadToGallery(state) {
    return state.actualCollection === "months" && Boolean(state.manifest?.user?.canUpload);
  }

  function getMonthHero(state, month) {
    return (state.manifest?.heroPhotos || []).find((photo) => getHeroMonthBucket(photo) === month) || null;
  }

  function getMonthPhotos(state, month) {
    return (state.manifest?.photos || [])
      .filter((photo) => getMonthBucket(photo) === month)
      .sort(comparePhotosByDate);
  }

  function comparePhotoNames(left, right) {
    const leftStem = getPhotoStem(left);
    const rightStem = getPhotoStem(right);
    const leftNumber = Number.parseInt(leftStem, 10);
    const rightNumber = Number.parseInt(rightStem, 10);
    const leftIsNumber = Number.isFinite(leftNumber);
    const rightIsNumber = Number.isFinite(rightNumber);

    if (leftIsNumber && rightIsNumber && leftNumber !== rightNumber) {
      return leftNumber - rightNumber;
    }

    return leftStem.localeCompare(rightStem, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  }

  function getPhotoTimestamp(photo) {
    // Backup exports name photos by the day taken; S3 modification dates are upload dates.
    const taken = getPhotoStem(photo).match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[T_ -])/);
    if (taken) {
      const date = new Date(`${taken[1]}-${taken[2]}-${taken[3]}T00:00:00Z`);
      if (date.getUTCFullYear() === Number(taken[1]) && date.getUTCMonth() + 1 === Number(taken[2]) && date.getUTCDate() === Number(taken[3])) return date.getTime();
    }
    const timestamp = Date.parse(photo?.lastModified || "");
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  function comparePhotosByDate(left, right) {
    const leftTimestamp = getPhotoTimestamp(left);
    const rightTimestamp = getPhotoTimestamp(right);

    if (leftTimestamp !== null && rightTimestamp !== null && leftTimestamp !== rightTimestamp) {
      return leftTimestamp - rightTimestamp;
    }

    if (leftTimestamp !== null || rightTimestamp !== null) {
      return leftTimestamp !== null ? -1 : 1;
    }

    return comparePhotoNames(left, right);
  }

  function pickTestCardStyle(index) {
    const palette = [
      { col: 6, row: 2, tilt: -2.5, wash: "rgba(129, 140, 248, 0.2)" },
      { col: 4, row: 2, tilt: 1.8, wash: "rgba(167, 139, 250, 0.18)" },
      { col: 5, row: 1, tilt: -1.2, wash: "rgba(192, 132, 252, 0.16)" },
      { col: 3, row: 1, tilt: 2.2, wash: "rgba(96, 165, 250, 0.16)" },
      { col: 6, row: 2, tilt: -1.5, wash: "rgba(45, 212, 191, 0.16)" },
      { col: 5, row: 2, tilt: 1.1, wash: "rgba(244, 114, 182, 0.14)" },
    ];

    return palette[index % palette.length];
  }

  function isKnownMediaKind(value) {
    return value === "picture" || value === "gif" || value === "movie";
  }

  function normalizeFilterKind(value) {
    return isKnownMediaKind(value) ? value : "all";
  }

  function inferMediaKindFromKey(key) {
    if (/\.gif$/i.test(key)) {
      return "gif";
    }

    if (/\.(m4v|mov|mp4|webm)$/i.test(key)) {
      return "movie";
    }

    return "picture";
  }

  function getMediaKind(photo) {
    const explicit = String(photo?.kind || "").trim().toLowerCase();
    return isKnownMediaKind(explicit) ? explicit : inferMediaKindFromKey(photo?.key || "");
  }

  function isBackgroundCandidate(photo) {
    return Boolean(photo?.url) && getMediaKind(photo) !== "movie";
  }

  function pickGalleryBackgroundPhoto(manifest) {
    const heroPhotos = Array.isArray(manifest?.heroPhotos) ? manifest.heroPhotos.filter(isBackgroundCandidate) : [];
    const photos = Array.isArray(manifest?.photos) ? manifest.photos.filter(isBackgroundCandidate) : [];
    const candidates = heroPhotos.length ? heroPhotos : photos;

    if (!candidates.length) {
      return null;
    }

    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  function preloadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(src);
      image.onerror = reject;
      image.src = src;
    });
  }

  function applyGalleryBackground(manifest) {
    const photo = pickGalleryBackgroundPhoto(manifest);

    if (!photo?.url) {
      document.body.classList.remove("has-vault-background");
      document.body.style.removeProperty("--vault-bg-image");
      return;
    }

    preloadImage(photo.url)
      .then(() => {
        document.body.style.setProperty("--vault-bg-image", `url("${escapeCssUrl(photo.url)}")`);
        document.body.classList.add("has-vault-background");
      })
      .catch(() => {});
  }

  function getGalleryTotal(manifest) {
    const photoCount = Array.isArray(manifest?.photos) ? manifest.photos.length : 0;
    const heroCount = Array.isArray(manifest?.heroPhotos) ? manifest.heroPhotos.length : 0;
    return photoCount + heroCount;
  }

  function pluralizeBg(count, one, many) {
    return count === 1 ? one : many;
  }

  function setText(id, value) {
    const element = document.getElementById(id);
    if (element) {
      element.textContent = value;
    }
  }

  function updateGalleryChrome(collection, manifest, session) {
    const isBg = document.documentElement.lang === "bg";
    const total = getGalleryTotal(manifest);
    const adminLabel = manifest?.user?.canUpload
      ? (isBg ? "Администратор" : "Admin")
      : (isBg ? "Преглед" : "Viewer");
    const totalLabel = isBg
      ? `${total} ${pluralizeBg(total, "спомен", "спомена")}`
      : `${total} ${pluralizeBg(total, "memory", "memories")}`;
    const cacheLabel = isBg
      ? "Случаен фон от защитената галерия"
      : "Random signed gallery background";

    setText("gallery-user", collection === "months" ? "Само за семейството" : adminLabel);
    setText("gallery-total", totalLabel);
    setText("gallery-cache", collection === "months" ? "Пет години малки чудеса" : cacheLabel);

    if (collection === "test") {
      setText("gallery-prefix", "Collection prefix: test/");
    }
  }


  function buildMediaCounts(photos) {
    return photos.reduce(
      (counts, photo) => {
        const kind = getMediaKind(photo);
        counts.all += 1;
        counts[kind] += 1;
        return counts;
      },
      { all: 0, picture: 0, gif: 0, movie: 0 }
    );
  }

  function ensureAvailableFilter(filter, photos) {
    const counts = buildMediaCounts(photos);
    return filter === "all" || counts[filter] > 0 ? filter : "all";
  }

  function filterPhotos(photos, filter) {
    const activeFilter = normalizeFilterKind(filter);

    if (activeFilter === "all") {
      return [...photos];
    }

    return photos.filter((photo) => getMediaKind(photo) === activeFilter);
  }

  function buildMediaMarkup(photo, title, priority) {
    const kind = getMediaKind(photo);

    if (kind === "movie") {
      return `
        <div class="media-shell media-shell-video">
          ${photo.thumbnailUrl ? `<img src="${escapeHtml(photo.thumbnailUrl)}" alt="${escapeHtml(title)}" loading="lazy" decoding="async">` : ""}
          <span class="video-preview-label">Видео</span>
          <span class="photo-play" aria-hidden="true">&#9654;</span>
        </div>
      `;
    }

    const fetchPriority = priority ? ' fetchpriority="high"' : ' fetchpriority="low"';
    const loading = priority ? ' loading="eager"' : ' loading="lazy"';

    return `
      <div class="media-shell">
        <img src="${escapeHtml(photo.thumbnailUrl || photo.url)}" alt="${escapeHtml(title)}"${loading} decoding="async"${fetchPriority}>
      </div>
    `;
  }

  function buildPhotoCardMarkup(photo, options = {}) {
    const title = options.title || `Photo ${getPhotoStem(photo)}`;
    const caption = options.caption || photo.key;
    const showMeta = options.showMeta !== false;
    const kind = getMediaKind(photo);

    return `
      <article class="${escapeHtml(options.cardClass || "photo-card")}" style="${escapeHtml(options.style || "")}">
        <a
          class="photo-link"
          href="${escapeHtml(photo.url)}"
          data-photo-trigger
          data-photo-kind="${escapeHtml(kind)}"
          data-photo-label="${escapeHtml(title)}"

          data-photo-src="${escapeHtml(photo.url)}"
          data-photo-backdrop="${escapeHtml(kind === "movie" ? "" : photo.url)}"
          aria-label="${escapeHtml(`Отвори ${title}`)}"
        >
          ${buildMediaMarkup(photo, title, options.priority)}
        </a>
        ${showMeta ? `
          <div class="photo-meta">
            <p class="photo-label">${escapeHtml(title)}</p>
            <p class="photo-caption">${escapeHtml(caption)}</p>
          </div>
        ` : ""}
      </article>
    `;
  }

  function getMonthItems(state, month) {
    const hero = getMonthHero(state, month);
    const photos = getMonthPhotos(state, month);
    return hero ? [hero, ...photos.filter(photo => photo.key !== hero.key)] : photos;
  }

  function getGrowthPhotos(state) {
    const seen = new Set();
    return Array.from({ length: GALLERY_MONTH_COUNT }, (_, month) =>
      getMonthItems(state, month).filter(photo => getMediaKind(photo) !== "movie")
        .sort(comparePhotosByDate).map(photo => ({ photo, month }))
    ).flat().filter(({ photo }) => {
      if (seen.has(photo.key)) return false;
      seen.add(photo.key);
      return true;
    });
  }

  function buildGrowthWheel(state) {
    const photos = getGrowthPhotos(state);
    if (!photos.length) return "";
    return `<section class="growth-wheel" aria-label="Лили расте — от първата до последната снимка">
      <div class="growth-heading"><div class="growth-intro"><span class="section-kicker">Лили расте <span class="growth-wish" aria-hidden="true">✧</span></span><span class="growth-caption">Малко вълшебство, ден след ден.</span></div><div class="growth-controls">
        <button type="button" data-growth-step="-1" aria-label="По-ранни снимки">←</button>
        <button type="button" data-growth-step="1" aria-label="По-нови снимки">→</button>
      </div></div>
      <div class="growth-stage">
      <div class="growth-stardust" aria-hidden="true"><i>✦</i><i>✧</i><i>✦</i><i>✧</i><i>✦</i><i>✧</i></div>
      <div class="growth-track" tabindex="0" aria-label="Плъзни за още спомени; използвай стрелките за навигация">
        ${photos.map(({ photo, month }, index) => `<button type="button" class="growth-frame" data-growth-index="${index}" data-growth-month="${month}"
          data-photo-trigger data-photo-group="growth" data-photo-kind="${getMediaKind(photo)}"
          data-photo-src="${escapeHtml(photo.url)}" data-photo-label="Месец ${month + 1} · Спомен ${index + 1}"
          aria-label="Отвори Месец ${month + 1} · Спомен ${index + 1}">
          <img src="${escapeHtml(photo.thumbnailUrl || photo.url)}" alt="" loading="lazy" decoding="async" width="80" height="96">
          <span>Месец ${month + 1}</span></button>`).join("")}
      </div></div>
    </section>`;
  }

  function setupGrowthWheel(content, state) {
    const wheel = content.querySelector(".growth-wheel");
    if (!wheel) return () => {};
    const track = wheel.querySelector(".growth-track");
    const frames = [...track.querySelectorAll(".growth-frame")];
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const listeners = new AbortController();
    const listen = (node, name, callback, options = {}) => node.addEventListener(name, callback, { ...options, signal: listeners.signal });
    const step = () => frames.length > 1 ? frames[1].offsetLeft - frames[0].offsetLeft : 92;
    state.growthDirection ??= 1;
    frames.forEach(frame => { frame.tabIndex = -1; });
    let current = -1, animation = 0, resumeTimer = 0, lastTime = 0;
    let visible = false, hovered = false, pressed = false, disposed = false, restingUntil = 0, manualUntil = 0, driftPosition = 0;

    function update() {
      const next = Math.max(0, Math.min(frames.length - 1, Math.round(track.scrollLeft / step())));
      if (next === current) return;
      if (current >= 0) { frames[current].classList.remove("is-current"); frames[current].tabIndex = -1; }
      frames[next].classList.add("is-current");
      frames[next].tabIndex = 0;
      current = next;
      state.growthIndex = next;
      wheel.querySelector('[data-growth-step="-1"]').disabled = next === 0;
      wheel.querySelector('[data-growth-step="1"]').disabled = next === frames.length - 1;
    }

    function syncMotion() {
      if (disposed) return;
      cancelAnimationFrame(animation);
      animation = 0;
      lastTime = 0;
      // Keep snapping disabled even while hovering, so pausing freezes the exact position.
      wheel.classList.toggle("has-auto-scroll", !motion.matches && frames.length > 1);
      const playing = !motion.matches && frames.length > 1 && visible && !document.hidden && !hovered && !pressed &&
        !state.uploading && !state.uploadQueue.length && !document.querySelector(".viewer:not([hidden])") && performance.now() >= manualUntil;
      wheel.classList.toggle("is-drifting", Boolean(playing));
      if (playing) {
        track.scrollTo({ left: track.scrollLeft, behavior: "instant" });
        driftPosition = track.scrollLeft;
        animation = requestAnimationFrame(drift);
      }
    }

    function drift(now) {
      // A small capped delta avoids a jump after a suspended/background frame.
      const delta = lastTime ? Math.min(now - lastTime, 50) : 0;
      lastTime = now;
      if (now >= restingUntil) {
        const end = (frames.length - 1) * step();
        const next = driftPosition + state.growthDirection * delta * 0.096;
        driftPosition = Math.max(0, Math.min(end, next));
        track.scrollLeft = driftPosition;
        if ((state.growthDirection > 0 && next >= end) || (state.growthDirection < 0 && next <= 0)) {
          state.growthDirection *= -1;
          restingUntil = now + 600;
        }
        update();
      }
      animation = requestAnimationFrame(drift);
    }

    function pauseForInteraction() {
      manualUntil = performance.now() + 900;
      clearTimeout(resumeTimer);
      syncMotion();
      resumeTimer = setTimeout(syncMotion, 950);
    }
    function move(delta) {
      pauseForInteraction();
      track.scrollTo({ left: Math.max(0, Math.min(frames.length - 1, current + delta)) * step(), behavior: motion.matches ? "instant" : "smooth" });
    }
    wheel.querySelectorAll("[data-growth-step]").forEach(button => {
      listen(button, "click", () => move(Number(button.dataset.growthStep) * 3));
    });
    listen(track, "scroll", update, { passive: true });
    // Listen on the whole wheel: crossing between photos or controls is still a hover.
    listen(wheel, "pointerenter", event => {
      if (event.pointerType === "touch") return;
      hovered = true;
      syncMotion();
    });
    listen(wheel, "pointerleave", event => {
      if (event.pointerType === "touch") return;
      hovered = false;
      manualUntil = 0;
      restingUntil = 0;
      clearTimeout(resumeTimer);
      syncMotion();
    });
    listen(track, "pointerdown", () => { pressed = true; pauseForInteraction(); }, { passive: true });
    ["pointerup", "pointercancel"].forEach(name => listen(window, name, () => {
      if (pressed) { pressed = false; pauseForInteraction(); }
    }, { passive: true }));
    listen(track, "keydown", event => {
      if (["Enter", " "].includes(event.key) && event.target === track) { event.preventDefault(); frames[current].click(); return; }
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      track.focus({ preventScroll: true });
      move(event.key === "Home" ? -frames.length : event.key === "End" ? frames.length : event.key === "ArrowRight" ? 1 : -1);
    });
    listen(track, "wheel", event => {
      pauseForInteraction();
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const end = track.scrollWidth - track.clientWidth;
      if ((event.deltaY < 0 && track.scrollLeft <= 0) || (event.deltaY > 0 && track.scrollLeft >= end - 1)) return;
      event.preventDefault();
      track.scrollLeft += event.deltaY;
    }, { passive: false });
    listen(document, "visibilitychange", syncMotion);
    listen(window, "lilly:viewer-change", syncMotion);
    listen(motion, "change", syncMotion);
    const observer = new IntersectionObserver(entries => { visible = entries[0].intersectionRatio >= 0.25; syncMotion(); }, { threshold: 0.25 });
    observer.observe(wheel);
    track.scrollLeft = (state.growthIndex || 0) * step();
    update();
    syncMotion();
    return () => {
      disposed = true;
      listeners.abort();
      observer.disconnect();
      cancelAnimationFrame(animation);
      clearTimeout(resumeTimer);
    };
  }

  function getMonthDateRange(manifest, month) {
    const value = manifest?.timelineStartDate || "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isInteger(month) || month < 0 || month >= GALLERY_MONTH_COUNT) return "";
    const [year, calendarMonth, day] = value.split("-").map(Number);
    const anchor = new Date(`${value}T00:00:00Z`);
    if (anchor.getUTCFullYear() !== year || anchor.getUTCMonth() + 1 !== calendarMonth || anchor.getUTCDate() !== day) return "";
    const anniversary = offset => new Date(Date.UTC(year, calendarMonth - 1 + offset,
      Math.min(day, new Date(Date.UTC(year, calendarMonth + offset, 0)).getUTCDate())));
    const start = anniversary(month);
    const end = anniversary(month + 1);
    end.setUTCDate(end.getUTCDate() - 1);
    const format = new Intl.DateTimeFormat("bg-BG", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
    return format.formatRange ? format.formatRange(start, end) : `${format.format(start)} – ${format.format(end)}`;
  }

  function renderMonthDetail(content, state) {
    const month = state.selectedMonth;
    const items = getMonthItems(state, month);
    const dateRange = getMonthDateRange(state.manifest, month);
    const year = getTimelineYear(month);
    const locked = state.uploading || state.uploadQueue.length > 0;
    const monthsWithPhotos = Array.from({ length: GALLERY_MONTH_COUNT }, (_, i) => getMonthItems(state, i).length).filter(Boolean).length;
    content.className = "month-workspace";
    content.innerHTML = `
      <nav class="month-navigation" aria-label="Месеци от живота на Лили">
        <div class="timeline-heading">
          <div><span class="section-kicker">НЕЙНАТА ИСТОРИЯ</span><p>${monthsWithPhotos} от 60 месеца със спомени</p></div>
          <label class="year-control">Година
            <select id="gallery-year" ${locked ? "disabled" : ""}>
              ${Array.from({ length: GALLERY_YEAR_COUNT }, (_, i) => `<option value="${i}" ${i + 1 === year ? "selected" : ""}>${i + 1} · Месеци ${i * 12 + 1}–${i * 12 + 12}</option>`).join("")}
            </select>
          </label>
        </div>
        <div class="month-strip">
          ${Array.from({ length: 12 }, (_, i) => {
            const m = (year - 1) * 12 + i;
            const count = getMonthItems(state, m).length;
            return `<button type="button" class="month-tab${m === month ? " is-selected" : ""}${count ? "" : " is-empty"}" data-month-trigger="${m}" aria-pressed="${m === month}" aria-label="Месец ${m + 1}, ${count ? `${count} ${count === 1 ? "спомен" : "спомена"}` : "няма снимки"}" title="${count ? `${count} спомена` : "Още няма снимки"}" ${locked ? "disabled" : ""}>
              <span class="month-tab-label">МЕСЕЦ</span><strong>${String(m + 1).padStart(2, "0")}</strong>
              <span class="month-dot${count ? " has-memories" : ""}" aria-hidden="true"></span>
            </button>`;
          }).join("")}
        </div>
      </nav>
      ${buildGrowthWheel(state)}
      <section class="month-album" aria-labelledby="month-title">
        <div class="album-heading">
          <div><p class="section-kicker">${getTimelineLabel(month)}</p><h2 id="month-title" tabindex="-1">Месец ${month + 1}<span class="heading-dot">.</span></h2>
          <p class="album-caption">${items.length ? `${items.length} ${items.length === 1 ? "малък миг, запазен" : "малки мига, запазени"} завинаги.` : "Още една страница от нейната история."}</p></div>
          <div class="month-stepper" aria-label="Смяна на месеца">
            <button type="button" class="btn btn-secondary" data-month-trigger="${month - 1}" aria-label="Предишен месец" ${month === 0 || locked ? "disabled" : ""}>←</button>
            <button type="button" class="btn btn-secondary" data-month-trigger="${month + 1}" aria-label="Следващ месец" ${month === 59 || locked ? "disabled" : ""}>→</button>
          </div>
        </div>
        ${canUploadToGallery(state) ? `
          <section class="album-upload" data-upload-drop-zone aria-label="Качване в Месец ${month + 1}">
            <div class="upload-intro"><span class="upload-symbol" aria-hidden="true">＋</span><div><h3>Добави спомени в Месец ${month + 1}${dateRange ? `<span class="upload-month-dates">${escapeHtml(dateRange)}</span>` : ""}</h3><p>Пусни снимките тук или ги избери от телефона.</p></div></div>
            <label class="btn btn-primary choose-files">Избери снимки<input class="upload-file-input" type="file" multiple accept=".jpg,.jpeg,.png,.webp,.avif,.gif,.mp4,.mov,.webm,.m4v" ${state.uploading ? "disabled" : ""}></label>
            <p class="upload-format-hint">JPG, PNG, WebP, AVIF, GIF или видео. За HEIC избери JPG при експортиране.</p>
            <div id="upload-queue" class="upload-queue"></div>
          </section>` : `<p class="viewer-note">Разглеждаш семейния албум. Снимки могат да добавят администраторите.</p>`}
        <p id="upload-notice" class="upload-notice" role="status" data-tone="${state.uploadNotice?.tone || ""}">${escapeHtml(state.uploadNotice?.message || "")}</p>
        ${items.length ? `<div class="month-grid">${items.map((photo, i) => buildPhotoCardMarkup(photo, {title: `Месец ${month + 1} · Спомен ${i + 1}`, showMeta: false, priority: i === 0, style: `--reveal-delay:${Math.min(i, 7) * 18}ms`})).join("")}</div>` : `
          <div class="album-empty"><span class="empty-flower" aria-hidden="true">✿</span><h3>Малките мигове започват тук.</h3><p>${canUploadToGallery(state) ? `Добави първите снимки за Месец ${month + 1}.<br>Те ще се появят само на тази страница.` : "Този месец още очаква своите първи снимки."}</p></div>`}
        <p class="album-footnote">Месец ${month + 1} от 60 <span aria-hidden="true">·</span> Малко по малко, цял един свят.</p>
      </section>`;
    renderUploadQueue(state);
  }

  function renderUploadQueue(state) {
    const queue = document.getElementById("upload-queue");
    if (!queue) return;
    queue.innerHTML = state.uploadQueue.length ? `
      <div class="queue-heading"><strong>${state.uploadQueue.length} ${state.uploadQueue.length === 1 ? "избран файл" : "избрани файла"} за Месец ${state.selectedMonth + 1}</strong><span>Първо качи или откажи избраните файлове, за да смениш месеца.</span></div>
      <ul class="queue-list">${state.uploadQueue.map(item => `<li class="queue-item" data-status="${item.status}">
        ${item.preview ? `<img src="${escapeHtml(item.preview)}" alt="" loading="lazy">` : `<span class="queue-file-icon" aria-hidden="true">▧</span>`}
        <span class="queue-filename">${escapeHtml(item.file.name)}</span><span class="queue-status">${escapeHtml(item.error || ({pending: "Готово за качване", uploading: "Качва се…", uploaded: "Качено", duplicate: "Вече е в албума", failed: "Неуспешно"}[item.status]))}</span>
      </li>`).join("")}</ul>
      ${state.uploading ? `<progress max="${state.uploadQueue.length}" value="${state.uploadQueue.filter(item => ["uploaded", "duplicate", "failed"].includes(item.status)).length}" aria-label="Качени файлове"></progress><p role="status">Качваме в Месец ${state.selectedMonth + 1}. Остави страницата отворена.</p>` : `<div class="queue-actions"><button class="btn btn-primary" data-upload-start type="button">Качи ${state.uploadQueue.length} в Месец ${state.selectedMonth + 1}</button><button class="btn btn-secondary" data-upload-cancel type="button">Откажи избраните</button></div>`}` : "";
  }

  function renderTestGallery(content, manifest, visiblePhotos) {
    const sortedPhotos = [...visiblePhotos].sort(comparePhotosByDate);

    content.className = "test-collage";
    content.innerHTML = sortedPhotos
      .map((photo, index) => {
        const style = pickTestCardStyle(index);

        return buildPhotoCardMarkup(photo, {
          cardClass: "test-card",
          title: `Test photo ${getPhotoStem(photo)}`,
          showMeta: false,
          style: `--col-span:${style.col}; --row-span:${style.row}; --tilt:${style.tilt}deg; --accent-wash:${style.wash};`,
          priority: index < 2,
        });
      })
      .join("");
  }

  function ensureViewer() {
    let viewer = document.getElementById("gallery-viewer");

    if (viewer) {
      return viewer;
    }

    viewer = document.createElement("div");
    viewer.id = "gallery-viewer";
    viewer.className = "viewer";
    viewer.hidden = true;
    viewer.setAttribute("role", "dialog");
    viewer.setAttribute("aria-modal", "true");
    viewer.setAttribute("aria-labelledby", "viewer-title");
    const isBg = document.documentElement.lang === "bg";
    viewer.innerHTML = `
      <div class="viewer-backdrop" data-viewer-close></div>
      <div class="viewer-card">
        <p id="viewer-title" class="viewer-title"></p>
        <button class="viewer-close" type="button" aria-label="${isBg ? "Затвори" : "Close"}" data-viewer-close>&times;</button>
        <button class="viewer-nav viewer-nav-prev" type="button" aria-label="${isBg ? "Предишна снимка" : "Previous"}" data-viewer-nav="-1">&#10094;</button>
        <button class="viewer-nav viewer-nav-next" type="button" aria-label="${isBg ? "Следваща снимка" : "Next"}" data-viewer-nav="1">&#10095;</button>
        <div class="viewer-frame">
          <div class="viewer-stage" id="viewer-stage">
            <div class="viewer-media">
              <img id="viewer-image" alt="" hidden>
              <video id="viewer-video" playsinline controls preload="metadata" hidden></video>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(viewer);
    return viewer;
  }

  function dismissViewer() {
    const viewer = document.getElementById("gallery-viewer");

    if (!viewer) {
      return;
    }

    const viewerImage = viewer.querySelector("#viewer-image");
    const viewerVideo = viewer.querySelector("#viewer-video");
    const viewerStage = viewer.querySelector("#viewer-stage");

    viewer.hidden = true;
    const shell = document.querySelector(".shell");
    if (shell) shell.inert = false;
    document.body.style.overflow = "";

    if (viewerImage) {
      viewerImage.removeAttribute("src");
      viewerImage.hidden = true;
    }

    if (viewerVideo) {
      viewerVideo.pause();
      viewerVideo.removeAttribute("src");
      viewerVideo.load();
      viewerVideo.hidden = true;
    }

    viewerStage?.style.removeProperty("--viewer-backdrop-image");
    window.dispatchEvent(new Event("lilly:viewer-change"));
  }

  function enableViewer(content) {
    if (content.dataset.viewerEnabled === "true") {
      return;
    }

    content.dataset.viewerEnabled = "true";

    const viewer = ensureViewer();
    const viewerStage = viewer.querySelector("#viewer-stage");
    const viewerImage = viewer.querySelector("#viewer-image");
    const viewerVideo = viewer.querySelector("#viewer-video");
    const viewerTitle = viewer.querySelector("#viewer-title");
    const viewerKey = viewer.querySelector("#viewer-key");
    const viewerOpenLink = viewer.querySelector("#viewer-open-link");
    const viewerFrame = viewer.querySelector(".viewer-frame");
    const viewerPrev = viewer.querySelector(".viewer-nav-prev");
    const viewerNext = viewer.querySelector(".viewer-nav-next");
    let lastTrigger = null;
    let currentIndex = -1;
    let activeGroup = "month";
    let touchStartX = 0;
    let touchStartY = 0;

    function getTriggers() {
      return [...content.querySelectorAll("[data-photo-trigger]")].filter(node => (node.dataset.photoGroup || "month") === activeGroup);
    }

    function updateViewerNavigation(total) {
      if (viewerPrev) {
        viewerPrev.disabled = currentIndex <= 0;
      }

      if (viewerNext) {
        viewerNext.disabled = currentIndex >= total - 1;
      }
    }

    function resetViewerVideo() {
      if (!viewerVideo) {
        return;
      }

      viewerVideo.pause();
      viewerVideo.removeAttribute("src");
      viewerVideo.load();
      viewerVideo.hidden = true;
    }

    function renderViewerAt(index) {
      const triggers = getTriggers();

      if (!triggers.length) {
        return;
      }

      currentIndex = Math.max(0, Math.min(index, triggers.length - 1));
      const trigger = triggers[currentIndex];
      const kind = normalizeFilterKind(trigger.dataset.photoKind);
      const src = trigger.dataset.photoSrc || trigger.href;
      const label = trigger.dataset.photoLabel || "Gallery item";
      const key = trigger.dataset.photoKey || "";
      const backdrop = trigger.dataset.photoBackdrop || src;
      lastTrigger = trigger;

      if (viewerTitle) {
        viewerTitle.textContent = label;
      }

      if (viewerKey) {
        viewerKey.textContent = key;
      }

      if (kind === "movie") {
        if (viewerImage) {
          viewerImage.hidden = true;
          viewerImage.removeAttribute("src");
        }

        viewerStage?.style.removeProperty("--viewer-backdrop-image");
        resetViewerVideo();

        if (viewerVideo) {
          viewerVideo.hidden = false;
          viewerVideo.src = src;
          viewerVideo.load();
          viewerVideo.play().catch(() => {});
        }
      } else {
        resetViewerVideo();

        if (viewerImage) {
          viewerImage.hidden = false;
          viewerImage.src = src;
          viewerImage.alt = label;
        }

        if (viewerStage) {
          viewerStage.style.setProperty("--viewer-backdrop-image", `url("${escapeCssUrl(backdrop)}")`);
        }
      }

      updateViewerNavigation(triggers.length);
    }

    function moveViewer(direction) {
      const triggers = getTriggers();
      const nextIndex = currentIndex + direction;

      if (nextIndex < 0 || nextIndex >= triggers.length) {
        return;
      }

      renderViewerAt(nextIndex);
    }

    function closeViewer() {
      dismissViewer();
      currentIndex = -1;
      lastTrigger?.focus?.();
    }

    function openViewer(trigger) {
      activeGroup = trigger.dataset.photoGroup || "month";
      const triggers = getTriggers();
      const index = triggers.indexOf(trigger);
      renderViewerAt(index >= 0 ? index : 0);
      viewer.hidden = false;
      window.dispatchEvent(new Event("lilly:viewer-change"));
      const shell = document.querySelector(".shell");
      if (shell) shell.inert = true;
      document.body.style.overflow = "hidden";
      viewer.querySelector(".viewer-close")?.focus();
    }

    content.addEventListener("click", (event) => {
      const trigger = event.target.closest("[data-photo-trigger]");

      if (!trigger) {
        return;
      }

      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
        return;
      }

      event.preventDefault();
      openViewer(trigger);
    });

    viewer.addEventListener("click", (event) => {
      if (event.target.closest("[data-viewer-close]")) {
        closeViewer();
        return;
      }

      const navButton = event.target.closest("[data-viewer-nav]");
      if (navButton) {
        moveViewer(Number.parseInt(navButton.dataset.viewerNav || "0", 10));
      }
    });

    viewerFrame?.addEventListener("touchstart", (event) => {
      const touch = event.changedTouches?.[0];
      if (!touch) {
        return;
      }

      touchStartX = touch.clientX;
      touchStartY = touch.clientY;
    }, { passive: true });

    viewerFrame?.addEventListener("touchend", (event) => {
      const touch = event.changedTouches?.[0];
      if (!touch) {
        return;
      }

      const deltaX = touch.clientX - touchStartX;
      const deltaY = touch.clientY - touchStartY;

      if (Math.abs(deltaX) < 40 || Math.abs(deltaX) <= Math.abs(deltaY) * 1.2) {
        return;
      }

      moveViewer(deltaX < 0 ? 1 : -1);
    }, { passive: true });

    document.addEventListener("keydown", (event) => {
      if (viewer.hidden) {
        return;
      }

      if (event.key === "Tab") {
        const controls = [...viewer.querySelectorAll("button:not(:disabled), video[controls]:not([hidden])")].filter(node => node.getClientRects().length);
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        return;
      }
      if (event.key === "Escape") {
        closeViewer();
        return;
      }

      if (event.key === "ArrowRight") {
        moveViewer(1);
        return;
      }

      if (event.key === "ArrowLeft") {
        moveViewer(-1);
      }
    });
  }

  async function fetchManifest(session) {
    // Refresh metadata without changing the version of immutable media URLs.
    const response = await fetch(getManifestUrl(), {
      headers: { Authorization: `Bearer ${session.tokens?.id_token || ""}` },
      cache: "no-store",
    });
    const manifest = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(response.status === 403
        ? "Този профил няма достъп до албума. След промяна на групата излез и влез отново."
        : response.status === 401 ? "Сесията изтече. Влез отново, за да отвориш албума."
        : "Албумът не се зареди. Опитай отново след малко.");
      error.status = response.status;
      throw error;
    }
    if (!manifest || !["months", "test"].includes(manifest.collection) || !Array.isArray(manifest.photos) || !Array.isArray(manifest.heroPhotos) || typeof manifest.user?.canUpload !== "boolean") {
      throw new Error("Получихме непълен албум. Опитай отново.");
    }
    return manifest;
  }

  async function requestUploadUrl(session, payload) {
    const response = await fetch(getUploadUrl(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.tokens?.id_token || ""}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    });

    const body = await response.json().catch(() => null);

    if (!response.ok) {
      const error = new Error(body?.error || "Unable to prepare this upload.");
      error.status = response.status;
      throw error;
    }

    return body;
  }

  async function uploadSingleFile(session, file, month, uploadKind) {
    const upload = await requestUploadUrl(session, {
      month,
      uploadKind,
      filename: file.name,
      contentType: file.type || "",
    });

    const uploadResponse = await fetch(upload.url, {
      method: "PUT",
      headers: upload.headers || {
        "Content-Type": upload.contentType || file.type || "application/octet-stream",
      },
      body: file,
    });

    if (!uploadResponse.ok) {
      const message = uploadResponse.status === 409 || uploadResponse.status === 412
        ? "Вече има файл с това име за избрания месец."
        : "S3 отказа качването. Опитай пак след малко.";
      const error = new Error(message);
      error.status = uploadResponse.status;
      throw error;
    }

    return upload;
  }

  function renderFilters(container, photos, activeFilter) {
    if (!container) {
      return;
    }

    const counts = buildMediaCounts(photos);
    const filters = FILTERS.filter((filter) => filter.id === "all" || counts[filter.id] > 0);

    container.innerHTML = filters
      .map((filter) => `
        <button
          class="filter-chip${filter.id === activeFilter ? " is-active" : ""}"
          type="button"
          data-gallery-filter="${escapeHtml(filter.id)}"
          aria-pressed="${filter.id === activeFilter ? "true" : "false"}"
        >
          <span>${escapeHtml(filter.label)}</span>
          <span class="filter-count">${counts[filter.id]}</span>
        </button>
      `)
      .join("");
  }

  function updateRefreshButton(button, isRefreshing) {
    if (!button) {
      return;
    }

    button.disabled = isRefreshing;
    button.textContent = isRefreshing ? "Обновяваме…" : "Обнови албума";
  }

  function renderGalleryState(content, status, state) {
    if (!content || !state.manifest) return;
    dismissViewer();

    if (state.actualCollection === "test") {
      const visiblePhotos = filterPhotos(state.manifest.photos || [], state.activeFilter);
      renderTestGallery(content, state.manifest, visiblePhotos);
      if (status) {
        status.textContent = `Показване на ${visiblePhotos.length} снимки.`;
      }
    } else {
      renderMonthDetail(content, state);
      if (status) status.textContent = `Спомени от Месец ${state.selectedMonth + 1}`;
    }
  }

  async function initGalleryPage() {
    const auth = window.EverydayLillyAuth;
    const requestedCollection = getRequestedCollection();
    const content = document.getElementById("gallery-content");
    const status = document.getElementById("gallery-status");
    const refreshButton = document.getElementById("gallery-refresh");
    const filterContainer = document.getElementById("gallery-media-filters");
    if (!auth || !content) return;
    let session = await auth.getSession();
    if (!session) { window.location.replace("/"); return; }
    const account = getAccountKey(session);
    const state = { requestedCollection, actualCollection: requestedCollection, selectedMonth: null, activeFilter: "all", manifest: null, uploadQueue: [], uploading: false, loading: false, uploadNotice: null };

    let thumbnailRefreshTimer;
    let stopGrowthWheel = () => {};

    function scheduleThumbnailRefresh(attempt = 0) {
      clearTimeout(thumbnailRefreshTimer);
      if (attempt >= 3 || !state.manifest?.photos.some(photo => !photo.thumbnailUrl)) return;
      thumbnailRefreshTimer = setTimeout(async () => {
        if (state.uploading || state.uploadQueue.length) return;
        await loadManifest();
        scheduleThumbnailRefresh(attempt + 1);
      }, 4000);
    }

    function clearQueue() {
      state.uploadQueue.forEach(item => { if (item.preview) URL.revokeObjectURL(item.preview); });
      state.uploadQueue = [];
    }

    async function currentSession() {
      const next = await auth.getSession();
      if (!next || getAccountKey(next) !== account) {
        clearTimeout(thumbnailRefreshTimer);
        stopGrowthWheel();
        clearQueue();
        dismissViewer();
        content.replaceChildren();
        window.location.replace("/");
        throw Object.assign(new Error("Сесията се промени. Влез отново."), { status: 401 });
      }
      session = next;
      return next;
    }

    function render() {
      stopGrowthWheel();
      renderGalleryState(content, status, state);
      stopGrowthWheel = setupGrowthWheel(content, state);
      if (refreshButton) refreshButton.disabled = state.uploading || state.loading || state.uploadQueue.length > 0;
    }

    function selectMonth(month, focus = false) {
      if (month === null || state.uploading || state.uploadQueue.length) return;
      state.selectedMonth = month;
      state.uploadNotice = null;
      rememberMonth(month, session);
      render();
      if (focus) document.getElementById("month-title")?.focus({ preventScroll: true });
    }

    document.getElementById("gallery-signout")?.addEventListener("click", () => {
      if (state.uploading) return;
      clearTimeout(thumbnailRefreshTimer);
      stopGrowthWheel();
      clearQueue();
      auth.signOut({ logoutUri: `${window.location.origin}/` });
    });

    // A remembered account change or logout in another tab must not leave media visible.
    window.addEventListener("storage", event => {
      if (event.key === null || event.key === "everydayLillyAuth:session" || event.key === "everydayLillyAuth:logout") {
        if (event.key === "everydayLillyAuth:session") {
          try {
            const stored = JSON.parse(localStorage.getItem("everydayLillyAuth:session") || "null");
            if (stored && getAccountKey(stored) === account) return;
          } catch (error) {}
        }
        clearTimeout(thumbnailRefreshTimer);
        stopGrowthWheel();
        clearQueue();
        dismissViewer();
        content.replaceChildren();
        window.location.replace("/");
      }
    });
    window.addEventListener("beforeunload", event => {
      if (state.uploading || state.uploadQueue.length) { event.preventDefault(); event.returnValue = ""; }
    });
    window.addEventListener("pagehide", () => { clearTimeout(thumbnailRefreshTimer); stopGrowthWheel(); });
    window.addEventListener("pageshow", event => { if (event.persisted) loadManifest(); });

    async function loadManifest() {
      if (state.loading) return;
      state.loading = true;
      updateRefreshButton(refreshButton, true);
      try {
        const manifest = await fetchManifest(await currentSession());
        await currentSession();
        state.manifest = manifest;
        state.actualCollection = manifest.collection;
        if (requestedCollection !== manifest.collection) { window.location.replace(ROUTES[manifest.collection]); return; }
        if (state.selectedMonth === null) {
          state.selectedMonth = getInitialMonth(manifest, session);
          if (manifest.collection === "months") rememberMonth(state.selectedMonth, session);
        }
        if (manifest.collection === "test") applyGalleryBackground(manifest);
        updateGalleryChrome(manifest.collection, manifest, session);
        if (filterContainer) {
          filterContainer.style.display = manifest.collection === "test" ? "" : "none";
          state.activeFilter = ensureAvailableFilter(state.activeFilter, manifest.photos);
          renderFilters(filterContainer, manifest.photos, state.activeFilter);
        }
        render();
        enableViewer(content);
      } catch (error) {
        if (error.status === 401 || error.status === 403 || !state.manifest) {
          state.manifest = null;
          stopGrowthWheel();
          clearQueue();
          dismissViewer();
          content.className = "loading-state";
          content.textContent = error.message || "Албумът не се зареди. Опитай отново.";
        }
        if (status) status.textContent = error.message || "Не успяхме да обновим албума. Опитай отново.";
      } finally {
        state.loading = false;
        updateRefreshButton(refreshButton, false);
        if (refreshButton) refreshButton.disabled = state.uploading || state.uploadQueue.length > 0;
      }
    }

    function stageFiles(files) {
      if (state.uploading || !canUploadToGallery(state)) return;
      const selected = Array.from(files || []);
      if (!selected.length) return;
      clearQueue();
      const supported = /\.(avif|gif|jpe?g|m4v|mov|mp4|png|webm|webp)$/i;
      let rejected = 0;
      for (const file of selected) {
        if (!file.size || !supported.test(file.name)) { rejected += 1; continue; }
        if (state.uploadQueue.some(item => item.file.name === file.name && item.file.size === file.size && item.file.lastModified === file.lastModified)) continue;
        state.uploadQueue.push({ file, status: "pending", preview: /^image\//.test(file.type) ? URL.createObjectURL(file) : "" });
      }
      state.uploadNotice = rejected ? {tone: "error", message: `${rejected} файла не са добавени. Избери JPG, PNG, WebP, AVIF, GIF или поддържано видео. За HEIC експортирай като JPG.`} : null;
      render();
    }

    async function uploadQueue() {
      if (state.uploading || !state.uploadQueue.length || !canUploadToGallery(state)) return;
      state.uploading = true;
      const month = state.selectedMonth;
      const signout = document.getElementById("gallery-signout");
      if (signout) signout.disabled = true;
      render();
      for (const item of state.uploadQueue) {
        item.status = "uploading";
        item.error = "";
        renderUploadQueue(state);
        try {
          await uploadSingleFile(await currentSession(), item.file, month, "photo");
          item.status = "uploaded";
        } catch (error) {
          item.status = [409, 412].includes(error.status) ? "duplicate" : "failed";
          item.error = item.status === "failed" ? "Неуспешно — опитай отново" : "";
          if (error.status === 401 || error.status === 403) {
            for (const pending of state.uploadQueue) {
              if (pending.status === "pending") pending.status = "failed";
              if (pending.status === "failed") pending.error = "Влез отново, за да продължиш";
            }
            break;
          }
        }
        renderUploadQueue(state);
      }
      const uploaded = state.uploadQueue.filter(item => item.status === "uploaded").length;
      const duplicate = state.uploadQueue.filter(item => item.status === "duplicate").length;
      const failed = state.uploadQueue.filter(item => item.status === "failed");
      state.uploadQueue.filter(item => item.status !== "failed").forEach(item => { if (item.preview) URL.revokeObjectURL(item.preview); });
      state.uploadQueue = failed;
      state.uploading = false;
      if (signout) signout.disabled = false;
      state.uploadNotice = { tone: failed.length ? "error" : "success", message: `${uploaded} ${uploaded === 1 ? "качен файл" : "качени файла"} в Месец ${month + 1}.${duplicate ? ` ${duplicate} вече са в албума.` : ""}${failed.length ? ` ${failed.length} ${failed.length === 1 ? "файл не успя" : "файла не успяха"}. Можеш да опиташ отново.` : ""}` };
      if (uploaded || duplicate) await loadManifest();
      if (uploaded) scheduleThumbnailRefresh();
      if (state.manifest) render();
    }

    content.addEventListener("click", event => {
      if (event.target.closest("[data-upload-start]")) { uploadQueue(); return; }
      if (event.target.closest("[data-upload-cancel]")) { if (!state.uploading) { clearQueue(); state.uploadNotice = null; render(); } return; }
      const month = event.target.closest("[data-month-trigger]");
      if (month) {
        selectMonth(parseGalleryMonth(month.dataset.monthTrigger));
        content.querySelector(`.month-tab[data-month-trigger="${state.selectedMonth}"]`)?.focus({ preventScroll: true });
      }
    });
    content.addEventListener("change", event => {
      if (event.target.matches("#gallery-year")) {
        selectMonth(Number(event.target.value) * 12 + state.selectedMonth % 12);
        document.getElementById("gallery-year")?.focus({ preventScroll: true });
      }
      if (event.target.matches(".upload-file-input")) stageFiles(event.target.files);
    });
    // Arrow keys move between months while focus is within the month selector.
    content.addEventListener("keydown", event => {
      if (!event.target.matches("[data-month-trigger]") || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? 59 : state.selectedMonth + (event.key === "ArrowRight" ? 1 : -1);
      selectMonth(parseGalleryMonth(next));
      content.querySelector(`.month-tab[data-month-trigger="${state.selectedMonth}"]`)?.focus();
    });
    for (const type of ["dragenter", "dragover", "dragleave", "drop"]) {
      content.addEventListener(type, event => {
        const zone = event.target.closest("[data-upload-drop-zone]");
        if (!zone) return;
        event.preventDefault();
        zone.classList.toggle("is-dragover", type === "dragenter" || type === "dragover");
        if (type === "drop") stageFiles(event.dataTransfer?.files);
      });
    }
    filterContainer?.addEventListener("click", event => {
      const button = event.target.closest("[data-gallery-filter]");
      if (!button || !state.manifest) return;
      state.activeFilter = ensureAvailableFilter(button.dataset.galleryFilter, state.manifest.photos);
      renderFilters(filterContainer, state.manifest.photos, state.activeFilter);
      render();
    });
    refreshButton?.addEventListener("click", () => { if (!state.uploading && !state.uploadQueue.length) loadManifest(); });
    await loadManifest();
  }

  document.addEventListener("DOMContentLoaded", () => {
    const atmosphere = document.querySelector(".album-atmosphere");
    if (atmosphere) {
      const syncAtmosphere = () => atmosphere.classList.toggle("is-sleeping", document.hidden);
      document.addEventListener("visibilitychange", syncAtmosphere);
      syncAtmosphere();
    }
    if (document.body.dataset.galleryMode) initGalleryPage();
  });
})();
