const demoPhotos = [
  {
    id: "demo-coast",
    src: "./assets/demo/coast-hero.webp",
    title: "潮汐之上",
    category: "风景",
    categoryEn: "LANDSCAPE",
    year: "2026",
    shape: "wide",
    alt: "暮色海岸与层叠山峦之间，一位行者沿山脊前行",
  },
  {
    id: "demo-train",
    src: "./assets/demo/train-window.webp",
    title: "向远处去",
    category: "人物",
    categoryEn: "PORTRAIT",
    year: "2026",
    shape: "tall",
    alt: "列车窗边的侧影与玻璃上的微弱倒影",
  },
  {
    id: "demo-room",
    src: "./assets/demo/morning-room.webp",
    title: "上午九点十七分",
    category: "静物",
    categoryEn: "STILL LIFE",
    year: "2026",
    shape: "tall",
    alt: "晨光穿过亚麻窗帘，在旧墙、木地板与椅子上投下长影",
  },
  {
    id: "demo-city",
    src: "./assets/demo/rain-city.webp",
    title: "雨停以前",
    category: "城市",
    categoryEn: "STREET",
    year: "2026",
    shape: "wide",
    alt: "雨夜城市路口，一位骑车人穿过潮湿路面的灯光倒影",
  },
  {
    id: "demo-lake",
    src: "./assets/demo/alpine-lake.webp",
    title: "静水来信",
    category: "风景",
    categoryEn: "LANDSCAPE",
    year: "2026",
    shape: "wide",
    alt: "黎明前的高山湖面与岸边一只红色独木舟",
  },
];

const defaultProfile = {
  name: "你的名字",
  role: "独立摄影 / 视觉叙事",
  bio: "在城市、自然与日常之间，记录光线短暂停留的方式。",
  location: "Shanghai · Available worldwide",
  email: "",
};

const DB_NAME = "still-light-portfolio";
const DB_VERSION = 1;
const PHOTO_LIMIT = 24;
const MAX_FILE_SIZE = 12 * 1024 * 1024;
const DISPLAY_MAX_EDGE = 2560;
const THUMB_MAX_EDGE = 560;
const DECODE_TARGET_WIDTH = 1920;
const MAX_DECODED_PIXELS = 16_000_000;
const HERO_INTERVAL = 6500;

let database;
let uploadedPhotos = [];
let activePhotos = [...demoPhotos];
let displayedPhotos = [...demoPhotos];
let currentFilter = "全部";
let heroIndex = 0;
let heroTimer;
let activeHeroNode = "a";
let heroTransitionToken = 0;
let heroPaused = false;
let lightboxIndex = 0;
let lastFocusedElement = null;
let touchStartX = 0;
let uploadBusy = false;
const photoObjectUrls = new Set();
let avatarObjectUrl = null;
const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const heroImageA = $("#heroImageA");
const heroImageB = $("#heroImageB");
const heroTitle = $("#heroTitle");
const heroCategory = $("#heroCategory");
const heroCounter = $("#heroCounter");
const heroProgress = $("#heroProgress");
const galleryGrid = $("#galleryGrid");
const galleryTemplate = $("#galleryCardTemplate");
const libraryStatus = $("#libraryStatus");
const emptyGallery = $("#emptyGallery");
const studio = $("#studio");
const lightbox = $("#lightbox");
const photoInput = $("#photoInput");
const avatarInput = $("#avatarInput");
const uploadMessage = $("#uploadMessage");
const uploadZone = $("#uploadZone");
const profileForm = $("#profileForm");

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("photos")) {
        db.createObjectStore("photos", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("profileAssets")) {
        db.createObjectStore("profileAssets", { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

async function getStoredPhotos() {
  if (!database) return [];
  const transaction = database.transaction("photos", "readonly");
  const records = await requestToPromise(transaction.objectStore("photos").getAll());
  return records.sort((a, b) => b.createdAt - a.createdAt);
}

async function getStoredPhotoCount() {
  if (!database) return 0;
  const transaction = database.transaction("photos", "readonly");
  return requestToPromise(transaction.objectStore("photos").count());
}

async function getProfileAsset(id) {
  if (!database) return null;
  const transaction = database.transaction("profileAssets", "readonly");
  return requestToPromise(transaction.objectStore("profileAssets").get(id));
}

function makePhotoObjectUrl(blob) {
  const url = URL.createObjectURL(blob);
  photoObjectUrls.add(url);
  return url;
}

function revokePhotoObjectUrls() {
  photoObjectUrls.forEach((url) => URL.revokeObjectURL(url));
  photoObjectUrls.clear();
}

function shapeFromDimensions(width, height) {
  const ratio = width / height;
  if (ratio >= 1.22) return "wide";
  if (ratio <= 0.82) return "tall";
  return "square";
}

function cleanFileName(name) {
  const withoutExtension = name.replace(/\.[^.]+$/, "");
  const cleaned = withoutExtension.replace(/[-_]+/g, " ").trim();
  return cleaned || "未命名作品";
}

async function loadLocalImage(file) {
  if (typeof window.createImageBitmap === "function") {
    try {
      const bitmap = await window.createImageBitmap(file, {
        imageOrientation: "from-image",
        resizeWidth: DECODE_TARGET_WIDTH,
        resizeQuality: "high",
      });
      return {
        image: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => bitmap.close(),
      };
    } catch {
      // Fall back to an image element for formats not handled by ImageBitmap.
    }
  }

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => resolve({
      image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      release: () => URL.revokeObjectURL(url),
    });
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("无法读取图片"));
    };
    image.src = url;
  });
}

function fitWithin(width, height, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function renderImageBlob(image, width, height, quality) {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) {
      reject(new Error("浏览器无法处理这张图片"));
      return;
    }
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, width, height);
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("图片优化失败")),
      "image/webp",
      quality,
    );
  });
}

async function optimizePhoto(file) {
  const { image, width: sourceWidth, height: sourceHeight, release } = await loadLocalImage(file);
  try {
    if (!sourceWidth || !sourceHeight || sourceWidth * sourceHeight > MAX_DECODED_PIXELS) {
      throw new Error("图片尺寸过大");
    }

    const displaySize = fitWithin(sourceWidth, sourceHeight, DISPLAY_MAX_EDGE);
    const thumbnailSize = fitWithin(sourceWidth, sourceHeight, THUMB_MAX_EDGE);
    const [blob, thumbnail] = await Promise.all([
      renderImageBlob(image, displaySize.width, displaySize.height, 0.86),
      renderImageBlob(image, thumbnailSize.width, thumbnailSize.height, 0.76),
    ]);

    return {
      blob,
      thumbnail,
      width: displaySize.width,
      height: displaySize.height,
      sourceWidth,
      sourceHeight,
    };
  } finally {
    release();
  }
}

function storedRecordToPhoto(record) {
  return {
    ...record,
    src: makePhotoObjectUrl(record.blob),
    thumbnailSrc: record.thumbnail ? makePhotoObjectUrl(record.thumbnail) : null,
    category: record.category || "我的作品",
    categoryEn: "MY WORK",
    year: String(record.year || new Date().getFullYear()),
    alt: record.alt || `${record.title || "摄影作品"}，由站点所有者上传`,
    isUploaded: true,
  };
}

async function refreshLibrary({ resetHero = false } = {}) {
  const records = await getStoredPhotos();
  revokePhotoObjectUrls();
  uploadedPhotos = records.map(storedRecordToPhoto);
  activePhotos = uploadedPhotos.length ? uploadedPhotos : [...demoPhotos];

  if (resetHero || heroIndex >= activePhotos.length) heroIndex = 0;
  updateFilterVisibility();
  renderGallery();
  renderUploadedList();
  updateLibraryStatus();
  await showHero(heroIndex, true);
  scheduleHero();
}

function updateLibraryStatus() {
  if (uploadedPhotos.length) {
    libraryStatus.innerHTML = `<i></i> 本机作品 · ${String(uploadedPhotos.length).padStart(2, "0")} 张`;
  } else {
    libraryStatus.innerHTML = "<i></i> 演示作品 · 上传后自动替换";
  }
}

function updateFilterVisibility() {
  const categories = new Set(activePhotos.map((photo) => photo.category));
  $$(".filter-button", $("#filterList")).forEach((button) => {
    const shouldShow = button.dataset.filter === "全部" || categories.has(button.dataset.filter);
    button.hidden = !shouldShow;
  });

  if (uploadedPhotos.length && !$("[data-filter='我的作品']", $("#filterList"))) {
    const button = document.createElement("button");
    button.className = "filter-button";
    button.type = "button";
    button.dataset.filter = "我的作品";
    button.textContent = "我的作品";
    $("#filterList").append(button);
  }

  if (!uploadedPhotos.length) {
    $("[data-filter='我的作品']", $("#filterList"))?.remove();
  }

  if (currentFilter !== "全部" && !categories.has(currentFilter)) currentFilter = "全部";
  syncFilterButtons();
}

function syncFilterButtons() {
  $$(".filter-button", $("#filterList")).forEach((button) => {
    const active = button.dataset.filter === currentFilter;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function renderGallery() {
  displayedPhotos = currentFilter === "全部"
    ? [...activePhotos]
    : activePhotos.filter((photo) => photo.category === currentFilter);

  galleryGrid.replaceChildren();
  emptyGallery.hidden = displayedPhotos.length > 0;

  displayedPhotos.forEach((photo, index) => {
    const fragment = galleryTemplate.content.cloneNode(true);
    const card = $(".gallery-card", fragment);
    const button = $(".gallery-open", fragment);
    const image = $("img", fragment);

    card.classList.add(`shape-${photo.shape || "square"}`);
    card.dataset.photoId = photo.id;
    image.src = photo.src;
    image.alt = photo.alt;
    $(".gallery-index", fragment).textContent = String(index + 1).padStart(2, "0");
    $("h3", fragment).textContent = photo.title;
    $("footer p", fragment).textContent = `${photo.categoryEn || photo.category} · ${photo.year}`;
    button.setAttribute("aria-label", `放大查看：${photo.title}`);
    button.addEventListener("click", () => openLightbox(index));
    image.addEventListener("load", layoutMasonry, { once: true });
    galleryGrid.append(fragment);
  });

  requestAnimationFrame(() => {
    layoutMasonry();
    observeReveals($$(".gallery-card", galleryGrid));
  });
}

function layoutMasonry() {
  if (!galleryGrid.children.length) return;
  const styles = getComputedStyle(galleryGrid);
  const rowHeight = Number.parseFloat(styles.gridAutoRows) || 8;
  const rowGap = Number.parseFloat(styles.rowGap) || 0;

  $$(".gallery-card", galleryGrid).forEach((card) => {
    card.style.gridRowEnd = "auto";
    const height = card.getBoundingClientRect().height;
    const span = Math.ceil((height + rowGap) / (rowHeight + rowGap));
    card.style.gridRowEnd = `span ${span}`;
  });
}

let revealObserver;

function createRevealObserver() {
  revealObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        revealObserver.unobserve(entry.target);
      });
    },
    { threshold: 0.12, rootMargin: "0px 0px -6%" },
  );
}

function observeReveals(elements) {
  elements.forEach((element, index) => {
    element.style.transitionDelay = `${Math.min(index % 5, 4) * 55}ms`;
    revealObserver.observe(element);
  });
}

function setImageSource(image, src, immediate = false) {
  if (immediate && (image.getAttribute("src") === src || image.src === src)) return Promise.resolve();
  image.src = src;
  return image.decode?.().catch(() => {}) || Promise.resolve();
}

function updateHeroMetadata(photo, index, announce) {
  heroTitle.textContent = photo.title;
  heroCategory.textContent = `${photo.category} · ${photo.categoryEn || "PHOTOGRAPH"}`;
  heroCounter.textContent = `${String(index + 1).padStart(2, "0")} / ${String(activePhotos.length).padStart(2, "0")}`;
  if (announce) $("#heroAnnouncement").textContent = `${photo.title}。${photo.alt}`;
}

async function showHero(index, immediate = false, announce = false) {
  if (!activePhotos.length) return false;
  const transitionToken = ++heroTransitionToken;
  const nextIndex = ((index % activePhotos.length) + activePhotos.length) % activePhotos.length;
  const photo = activePhotos[nextIndex];
  const current = activeHeroNode === "a" ? heroImageA : heroImageB;
  const incoming = activeHeroNode === "a" ? heroImageB : heroImageA;

  if (immediate) {
    await setImageSource(current, photo.src, true);
    if (transitionToken !== heroTransitionToken) return false;
    heroIndex = nextIndex;
    updateHeroMetadata(photo, heroIndex, announce);
    current.classList.add("is-active");
    incoming.classList.remove("is-active");
    return true;
  }

  await setImageSource(incoming, photo.src);
  if (transitionToken !== heroTransitionToken) return false;
  heroIndex = nextIndex;
  updateHeroMetadata(photo, heroIndex, announce);
  incoming.classList.add("is-active");
  current.classList.remove("is-active");
  activeHeroNode = activeHeroNode === "a" ? "b" : "a";
  return true;
}

function restartHeroProgress() {
  heroProgress.classList.remove("is-running");
  void heroProgress.offsetWidth;
  if (activePhotos.length > 1 && !heroPaused && !document.hidden) {
    heroProgress.classList.add("is-running");
  }
}

function updateHeroPauseButton() {
  const button = $("#heroPause");
  button.setAttribute("aria-pressed", String(heroPaused));
  button.setAttribute("aria-label", heroPaused ? "播放轮播" : "暂停轮播");
  $(".pause-icon", button).hidden = heroPaused;
  $(".play-icon", button).hidden = !heroPaused;
}

function toggleHeroPause() {
  heroPaused = !heroPaused;
  updateHeroPauseButton();
  if (heroPaused) {
    window.clearTimeout(heroTimer);
    restartHeroProgress();
  } else {
    scheduleHero();
  }
}

function scheduleHero() {
  window.clearTimeout(heroTimer);
  restartHeroProgress();
  if (activePhotos.length <= 1 || document.hidden || heroPaused) return;
  heroTimer = window.setTimeout(async () => {
    const changed = await showHero(heroIndex + 1);
    if (changed) scheduleHero();
  }, HERO_INTERVAL);
}

async function stepHero() {
  const changed = await showHero(heroIndex + 1, false, true);
  if (changed) scheduleHero();
}

function openLightbox(index) {
  if (!displayedPhotos.length) return;
  lightboxIndex = ((index % displayedPhotos.length) + displayedPhotos.length) % displayedPhotos.length;
  lastFocusedElement = document.activeElement;
  renderLightbox();
  if (!lightbox.open) lightbox.showModal();
  document.body.classList.add("is-locked");
}

function renderLightbox() {
  const photo = displayedPhotos[lightboxIndex];
  const image = $("#lightboxImage");
  image.src = photo.src;
  image.alt = photo.alt;
  $("#lightboxTitle").textContent = photo.title;
  $("#lightboxCategory").textContent = `${photo.category} · ${photo.year}`;
  $("#lightboxCounter").textContent = `${String(lightboxIndex + 1).padStart(2, "0")} / ${String(displayedPhotos.length).padStart(2, "0")}`;
  $("#lightboxPrev").hidden = displayedPhotos.length < 2;
  $("#lightboxNext").hidden = displayedPhotos.length < 2;

  const nextPhoto = displayedPhotos[(lightboxIndex + 1) % displayedPhotos.length];
  if (nextPhoto && displayedPhotos.length > 1) {
    const preload = new Image();
    preload.src = nextPhoto.src;
  }
}

function stepLightbox(direction) {
  lightboxIndex = (lightboxIndex + direction + displayedPhotos.length) % displayedPhotos.length;
  renderLightbox();
}

function closeLightbox() {
  if (lightbox.open) lightbox.close();
}

function openStudio(tab = "photos") {
  lastFocusedElement = document.activeElement;
  setStudioTab(tab);
  if (!studio.open) studio.showModal();
  document.body.classList.add("is-locked");
}

function closeStudio() {
  if (studio.open) studio.close();
}

function setStudioTab(tab) {
  const isPhotos = tab === "photos";
  $("#photosTab").classList.toggle("is-active", isPhotos);
  $("#photosTab").setAttribute("aria-selected", String(isPhotos));
  $("#photosTab").tabIndex = isPhotos ? 0 : -1;
  $("#profileTab").classList.toggle("is-active", !isPhotos);
  $("#profileTab").setAttribute("aria-selected", String(!isPhotos));
  $("#profileTab").tabIndex = isPhotos ? -1 : 0;
  $("#photosPanel").hidden = !isPhotos;
  $("#photosPanel").classList.toggle("is-active", isPhotos);
  $("#profilePanel").hidden = isPhotos;
  $("#profilePanel").classList.toggle("is-active", !isPhotos);
}

function unlockAfterDialog() {
  if (!studio.open && !lightbox.open) document.body.classList.remove("is-locked");
  lastFocusedElement?.focus?.({ preventScroll: true });
}

async function handlePhotoFiles(fileList) {
  const incoming = [...fileList];
  if (!incoming.length || !database || uploadBusy) return;

  uploadBusy = true;
  photoInput.disabled = true;
  uploadZone.classList.add("is-busy");
  uploadZone.setAttribute("aria-busy", "true");
  uploadMessage.textContent = "正在生成适合网页浏览的展示版本…";

  let imported = 0;
  let skipped = 0;
  try {
    const currentCount = await getStoredPhotoCount();
    const availableSlots = Math.max(0, PHOTO_LIMIT - currentCount);
    const files = incoming.slice(0, availableSlots);
    skipped = incoming.length - files.length;
    const records = [];

    for (const file of files) {
      if (!file.type.startsWith("image/") || file.size > MAX_FILE_SIZE) {
        skipped += 1;
        continue;
      }

      try {
        const optimized = await optimizePhoto(file);
        records.push({
          id: crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          blob: optimized.blob,
          thumbnail: optimized.thumbnail,
          title: cleanFileName(file.name),
          category: "我的作品",
          year: new Date().getFullYear(),
          shape: shapeFromDimensions(optimized.width, optimized.height),
          width: optimized.width,
          height: optimized.height,
          sourceWidth: optimized.sourceWidth,
          sourceHeight: optimized.sourceHeight,
          fileName: file.name,
          size: optimized.blob.size,
          sourceSize: file.size,
          createdAt: Date.now() + records.length,
        });
      } catch {
        skipped += 1;
      }
    }

    if (records.length) {
      const transaction = database.transaction("photos", "readwrite");
      const store = transaction.objectStore("photos");
      records.forEach((record) => store.put(record));
      await transactionDone(transaction);
      imported = records.length;
      await refreshLibrary({ resetHero: true });
    }

    uploadMessage.textContent = imported
      ? `已加入 ${imported} 张照片${skipped ? `，跳过 ${skipped} 张` : ""}。`
      : "没有可加入的照片，请检查格式、尺寸与文件大小。";
  } catch (error) {
    console.warn("Could not save local photos:", error);
    uploadMessage.textContent = "本机存储空间不足，照片没有写入。请移除部分作品后重试。";
  } finally {
    uploadBusy = false;
    photoInput.disabled = false;
    photoInput.value = "";
    uploadZone.classList.remove("is-busy");
    uploadZone.removeAttribute("aria-busy");
  }
}

async function deletePhoto(id) {
  if (!database || !window.confirm("从当前浏览器的图库中移除这张照片？")) return;
  const transaction = database.transaction("photos", "readwrite");
  transaction.objectStore("photos").delete(id);
  await transactionDone(transaction);
  await refreshLibrary({ resetHero: true });
}

function renderUploadedList() {
  const list = $("#uploadedList");
  list.replaceChildren();

  if (!uploadedPhotos.length) {
    const empty = document.createElement("p");
    empty.className = "uploaded-empty";
    empty.textContent = "尚未添加照片，当前站点使用演示作品。";
    list.append(empty);
    return;
  }

  uploadedPhotos.forEach((photo) => {
    const item = document.createElement("article");
    item.className = "uploaded-item";
    const image = document.createElement("img");
    image.src = photo.thumbnailSrc || photo.src;
    image.alt = "";
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = photo.title;
    const meta = document.createElement("small");
    meta.textContent = `${photo.width} × ${photo.height} · ${formatFileSize(photo.size)}`;
    copy.append(title, meta);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "移除";
    remove.addEventListener("click", () => deletePhoto(photo.id));
    item.append(image, copy, remove);
    list.append(item);
  });
}

function formatFileSize(bytes = 0) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function loadProfile() {
  try {
    return { ...defaultProfile, ...JSON.parse(localStorage.getItem("still-light-profile") || "{}") };
  } catch {
    return { ...defaultProfile };
  }
}

function initialsForName(name) {
  const cleaned = name.trim();
  if (!cleaned || cleaned === defaultProfile.name) return "YN";
  if (/^[\u3400-\u9fff]/.test(cleaned)) return cleaned.slice(0, 2);
  const words = cleaned.split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((word) => word[0]).join("").toUpperCase();
}

function applyProfile(profile) {
  $("#profileName").textContent = profile.name;
  $("#profileRole").textContent = profile.role;
  $("#profileBio").textContent = profile.bio;
  $("#profileLocation").lastChild.textContent = ` ${profile.location}`;
  $("#aboutLocation").textContent = profile.location;
  $("#footerName").textContent = profile.name;
  $("#avatarFallback").textContent = initialsForName(profile.name);

  const contact = $("#contactButton");
  const contactMeta = $("small", contact);
  contact.disabled = !profile.email;
  contactMeta.textContent = profile.email || "邮箱待补充";
  contact.onclick = profile.email ? () => { window.location.href = `mailto:${profile.email}`; } : null;

  for (const [key, value] of Object.entries(profile)) {
    const field = profileForm.elements.namedItem(key);
    if (field) field.value = value;
  }
}

async function loadAvatar() {
  try {
    const asset = await getProfileAsset("avatar");
    if (!asset?.blob) return;
    const image = $("#profileAvatar");
    if (avatarObjectUrl) URL.revokeObjectURL(avatarObjectUrl);
    avatarObjectUrl = URL.createObjectURL(asset.blob);
    image.src = avatarObjectUrl;
    image.hidden = false;
    $("#avatarFallback").hidden = true;
  } catch {
    // Keep the initials fallback when private storage is unavailable.
  }
}

async function saveAvatar(file) {
  const message = $("#profileMessage");
  if (!file || !database || !file.type.startsWith("image/") || file.size > MAX_FILE_SIZE) {
    message.textContent = "头像需要是 12 MB 以内的图片。";
    return;
  }

  message.textContent = "正在优化头像…";
  try {
    const optimized = await optimizePhoto(file);
    const transaction = database.transaction("profileAssets", "readwrite");
    transaction.objectStore("profileAssets").put({ id: "avatar", blob: optimized.thumbnail, updatedAt: Date.now() });
    await transactionDone(transaction);
    await loadAvatar();
    message.textContent = "头像已更新。";
  } catch (error) {
    console.warn("Could not save avatar:", error);
    message.textContent = "头像处理失败，请换一张图片重试。";
  } finally {
    avatarInput.value = "";
  }
}

function saveProfile(event) {
  event.preventDefault();
  const formData = new FormData(profileForm);
  const profile = {
    name: String(formData.get("name") || "").trim() || defaultProfile.name,
    role: String(formData.get("role") || "").trim() || defaultProfile.role,
    bio: String(formData.get("bio") || "").trim() || defaultProfile.bio,
    location: String(formData.get("location") || "").trim() || defaultProfile.location,
    email: String(formData.get("email") || "").trim(),
  };
  localStorage.setItem("still-light-profile", JSON.stringify(profile));
  applyProfile(profile);
  const button = $(".save-profile", profileForm);
  const original = button.textContent;
  button.textContent = "已保存";
  window.setTimeout(() => { button.textContent = original; }, 1200);
}

function updateNavIndicator(activeLink = $(".nav-link.is-active")) {
  if (!activeLink) return;
  const nav = $(".glass-nav");
  const liquid = $(".nav-liquid");
  const navRect = nav.getBoundingClientRect();
  const linkRect = activeLink.getBoundingClientRect();
  liquid.style.width = `${linkRect.width}px`;
  liquid.style.transform = `translateX(${linkRect.left - navRect.left - 5}px)`;
}

function setupSectionNavigation() {
  const links = $$(".nav-link");
  const sections = $$(".section-observe");

  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!visible) return;
      const active = links.find((link) => link.dataset.section === visible.target.id);
      if (!active) return;
      links.forEach((link) => {
        const isActive = link === active;
        link.classList.toggle("is-active", isActive);
        if (isActive) link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
      });
      updateNavIndicator(active);
    },
    { rootMargin: "-42% 0px -42%", threshold: 0 },
  );

  sections.forEach((section) => observer.observe(section));
  links.forEach((link) => link.addEventListener("click", () => {
    links.forEach((item) => {
      const isActive = item === link;
      item.classList.toggle("is-active", isActive);
      if (isActive) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    });
    updateNavIndicator(link);
  }));
}

function setupDockEffect() {
  const reset = () => {
    galleryGrid.classList.remove("is-docking");
    $$(".gallery-card", galleryGrid).forEach((card) => {
      card.classList.remove("is-focus", "is-near");
      card.style.setProperty("--dock-scale", "1");
      card.style.setProperty("--dock-lift", "0px");
    });
  };

  galleryGrid.addEventListener("pointermove", (event) => {
    if (event.pointerType !== "mouse") return;
    const focusCard = event.target.closest(".gallery-card");
    if (!focusCard) {
      reset();
      return;
    }

    galleryGrid.classList.add("is-docking");
    $$(".gallery-card", galleryGrid).forEach((card) => {
      const rect = card.getBoundingClientRect();
      const dx = event.clientX < rect.left ? rect.left - event.clientX : event.clientX > rect.right ? event.clientX - rect.right : 0;
      const dy = event.clientY < rect.top ? rect.top - event.clientY : event.clientY > rect.bottom ? event.clientY - rect.bottom : 0;
      const distance = Math.hypot(dx, dy);
      const influence = Math.max(0, 1 - distance / 190);
      const isFocus = card === focusCard;
      card.classList.toggle("is-focus", isFocus);
      card.classList.toggle("is-near", !isFocus && influence > 0.24);
      card.style.setProperty("--dock-scale", (1 + influence * 0.07).toFixed(3));
      card.style.setProperty("--dock-lift", `${(-influence * 13).toFixed(1)}px`);
    });
  });

  galleryGrid.addEventListener("pointerleave", reset);
}

function bindEvents() {
  $("#heroNext").addEventListener("click", stepHero);
  $("#heroPause").addEventListener("click", toggleHeroPause);
  $("#studioTrigger").addEventListener("click", () => openStudio("photos"));
  $$('[data-open-studio]').forEach((button) => button.addEventListener("click", () => openStudio("photos")));
  $("#avatarButton").addEventListener("click", () => openStudio("profile"));
  $$('[data-close-studio]').forEach((element) => element.addEventListener("click", closeStudio));
  $$('[data-close-lightbox]').forEach((element) => element.addEventListener("click", closeLightbox));
  $("#lightboxPrev").addEventListener("click", () => stepLightbox(-1));
  $("#lightboxNext").addEventListener("click", () => stepLightbox(1));
  $("#photosTab").addEventListener("click", () => setStudioTab("photos"));
  $("#profileTab").addEventListener("click", () => setStudioTab("profile"));
  const studioTabs = $$(".studio-tab");
  studioTabs.forEach((tab) => tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = studioTabs.indexOf(tab);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? studioTabs.length - 1
        : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + studioTabs.length) % studioTabs.length;
    const nextTab = studioTabs[nextIndex];
    setStudioTab(nextTab.id === "profileTab" ? "profile" : "photos");
    nextTab.focus();
  }));
  profileForm.addEventListener("submit", saveProfile);
  photoInput.addEventListener("change", () => handlePhotoFiles(photoInput.files));
  avatarInput.addEventListener("change", () => saveAvatar(avatarInput.files[0]));

  $("#filterList").addEventListener("click", (event) => {
    const button = event.target.closest(".filter-button");
    if (!button) return;
    currentFilter = button.dataset.filter;
    syncFilterButtons();
    renderGallery();
  });

  ["dragenter", "dragover"].forEach((eventName) => {
    uploadZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      uploadZone.classList.add("is-dragging");
    });
  });
  ["dragleave", "drop"].forEach((eventName) => {
    uploadZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      uploadZone.classList.remove("is-dragging");
    });
  });
  uploadZone.addEventListener("drop", (event) => handlePhotoFiles(event.dataTransfer.files));

  lightbox.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") stepLightbox(-1);
    if (event.key === "ArrowRight") stepLightbox(1);
  });
  lightbox.addEventListener("touchstart", (event) => {
    touchStartX = event.changedTouches[0]?.clientX || 0;
  }, { passive: true });
  lightbox.addEventListener("touchend", (event) => {
    const distance = (event.changedTouches[0]?.clientX || 0) - touchStartX;
    if (Math.abs(distance) > 55) stepLightbox(distance > 0 ? -1 : 1);
  }, { passive: true });

  lightbox.addEventListener("close", unlockAfterDialog);
  studio.addEventListener("close", unlockAfterDialog);
  lightbox.addEventListener("cancel", () => window.setTimeout(unlockAfterDialog));
  studio.addEventListener("cancel", () => window.setTimeout(unlockAfterDialog));

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) window.clearTimeout(heroTimer);
    else scheduleHero();
  });

  window.addEventListener("resize", () => {
    updateNavIndicator();
    layoutMasonry();
  });
  motionPreference.addEventListener("change", (event) => {
    heroPaused = event.matches;
    updateHeroPauseButton();
    scheduleHero();
  });
  window.addEventListener("beforeunload", () => {
    revokePhotoObjectUrls();
    if (avatarObjectUrl) URL.revokeObjectURL(avatarObjectUrl);
  });
}

async function init() {
  createRevealObserver();
  bindEvents();
  setupDockEffect();
  setupSectionNavigation();
  observeReveals($$(".reveal"));
  applyProfile(loadProfile());
  heroPaused = motionPreference.matches;
  updateHeroPauseButton();
  $("#currentYear").textContent = String(new Date().getFullYear());

  try {
    database = await openDatabase();
    await Promise.all([refreshLibrary({ resetHero: true }), loadAvatar()]);
  } catch (error) {
    console.warn("Private gallery storage is unavailable:", error);
    uploadMessage.textContent = "当前浏览器无法使用本机图库；演示作品仍可正常浏览。";
    renderGallery();
    updateLibraryStatus();
    await showHero(0, true);
    scheduleHero();
  }

  requestAnimationFrame(() => updateNavIndicator());
}

init();
