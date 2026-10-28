import { extractPhotoMetadata, orientationLabel, technicalSummary } from "./metadata.js";
import { groupPhotosByProvince, photoCountColor, projectPoint, geometryPath } from "./geography.js";
import { api, blobBase64 } from "./api.js";

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
    location: "东海岸 · 35.621°N",
    device: "Leica Q3",
    lens: "Summilux 28mm",
    focalLength: "28mm",
    aperture: "f/4",
    shutter: "1/320s",
    iso: "ISO 100",
    capturedAt: "2026-08-18 18:42:00",
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
    location: "沪昆线",
    device: "Fujifilm X-T5",
    lens: "XF 35mm F1.4",
    focalLength: "35mm",
    aperture: "f/1.8",
    shutter: "1/125s",
    iso: "ISO 800",
    capturedAt: "2026-04-07 16:28:00",
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
    location: "上海",
    device: "Sony α7C II",
    lens: "FE 50mm F1.4 GM",
    focalLength: "50mm",
    aperture: "f/2.8",
    shutter: "1/160s",
    iso: "ISO 200",
    capturedAt: "2026-03-12 09:17:00",
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
    location: "上海 · 静安",
    device: "Ricoh GR IIIx",
    lens: "GR 26.1mm F2.8",
    focalLength: "40mm",
    aperture: "f/2.8",
    shutter: "1/60s",
    iso: "ISO 1600",
    capturedAt: "2026-06-03 22:06:00",
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
    location: "阿尔卑斯山",
    device: "Nikon Z8",
    lens: "NIKKOR Z 24-70mm f/2.8 S",
    focalLength: "35mm",
    aperture: "f/8",
    shutter: "1/4s",
    iso: "ISO 64",
    capturedAt: "2026-09-21 05:46:00",
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
const PHOTO_LIMIT = 500;
const MAX_FILE_SIZE = 12 * 1024 * 1024;
const DISPLAY_MAX_EDGE = 2560;
const THUMB_MAX_EDGE = 560;
const DECODE_TARGET_WIDTH = 1920;
const MAX_DECODED_PIXELS = 16_000_000;
const HERO_INTERVAL = 6500;

let database;
let uploadedPhotos = [];
let activePhotos = [];
let displayedPhotos = [];
let canManage = false;
let sessionUser = null;
let libraryOwner = null;
const requestedUser = new URLSearchParams(location.search).get('user')?.toLowerCase() || '';
const libraryEndpoint = `/api/library${requestedUser ? `?user=${encodeURIComponent(requestedUser)}` : ''}`;
let sharedProfile = { ...defaultProfile };
let sharedAvatar = null;
const portfolioFilters = {
  category: "全部",
  year: "全部",
  device: "全部",
  orientation: "全部",
};
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
const heroMeta = $("#heroMeta");
const heroCounter = $("#heroCounter");
const heroProgress = $("#heroProgress");
const galleryGrid = $("#galleryGrid");
const galleryTemplate = $("#galleryCardTemplate");
const filterPanel = $("#filterPanel");
const libraryStatus = $("#libraryStatus");
const emptyGallery = $("#emptyGallery");
const studio = $("#studio");
const lightbox = $("#lightbox");
const photoInput = $("#photoInput");
const avatarInput = $("#avatarInput");
const uploadMessage = $("#uploadMessage");
const uploadZone = $("#uploadZone");
const profileForm = $("#profileForm");
const provinceMap = $("#provinceMap");
const mapStatus = $("#mapStatus");
const mapProvinceTitle = $("#mapProvinceTitle");
const mapProvinceCount = $("#mapProvinceCount");
const mapPhotoList = $("#mapPhotoList");
const mapTooltip = $("#mapTooltip");

let provinceGeoData = null;
let provincePhotoGroups = new Map();
let selectedProvinceName = "";

function setManagementMode() {
  const value = !!sessionUser && !!libraryOwner && sessionUser.id === libraryOwner.id;
  canManage = value;
  document.body.classList.toggle('is-owner', value);
  $$('[data-owner-only]').forEach(element => { element.hidden = !value; });
  // Legacy browser storage belongs to the original site owner, not every account on this device.
  if ($('#importLegacy')) $('#importLegacy').hidden = !value || sessionUser?.role !== 'admin';
  $$('[data-account-link]').forEach(link => {
    link.setAttribute('aria-label', sessionUser ? '我的账号' : '登录或注册账号');
    const label = $('[data-account-label]', link);
    if (label) label.textContent = sessionUser ? '我的账号' : '登录 / 注册';
  });
  const avatar = $('#avatarButton');
  if (avatar) {
    avatar.disabled = !value;
    avatar.setAttribute('aria-label', value ? '更换个人头像' : '个人头像');
  }
  if (!value && studio?.open) closeStudio();
}

async function checkSession() {
  try { sessionUser = (await api('/api/session')).user; }
  catch { sessionUser = null; }
  setManagementMode();
}

function scopePageLinks() {
  if (!requestedUser) return;
  const pages = new Set(['/index.html', '/portfolio.html', '/map.html', '/about.html']);
  $$('a[href]').forEach(link => {
    if (link.getAttribute('href').startsWith('#')) return;
    const url = new URL(link.getAttribute('href'), location.href);
    if (url.origin !== location.origin || !pages.has(url.pathname)) return;
    url.searchParams.set('user', requestedUser);
    link.href = `${url.pathname}${url.search}${url.hash}`;
  });
}

async function publishPhoto(record) {
  const { blob, thumbnail, ...metadata } = record;
  return api('/api/photos', { method:'POST', owner: libraryOwner.id, body: {
    image: await blobBase64(blob), thumbnail: await blobBase64(thumbnail || blob), metadata,
  } });
}

async function importLegacyPhotos() {
  if (!canManage || sessionUser?.role !== 'admin' || uploadBusy) return;
  uploadBusy = true;
  const button = $('#importLegacy'); button.disabled = true;
  let imported = 0;
  try {
    database ||= await openDatabase();
    const transaction = database.transaction('photos', 'readonly');
    const records = await requestToPromise(transaction.objectStore('photos').getAll());
    const migrated = new Set(JSON.parse(localStorage.getItem('still-light-migrated') || '[]'));
    for (const record of records.filter(record => !migrated.has(record.id))) {
      await publishPhoto(record);
      migrated.add(record.id); imported++;
      localStorage.setItem('still-light-migrated', JSON.stringify([...migrated]));
    }
    await refreshLibrary({ resetHero: true });
    uploadMessage.textContent = imported ? `已导入 ${imported} 张旧作品，原浏览器数据仍保留。` : '当前浏览器没有尚未导入的旧作品。';
  } catch (error) { uploadMessage.textContent = `已导入 ${imported} 张。${error.message}`; }
  finally { uploadBusy = false; button.disabled = false; }
}

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
  const data = await api(libraryEndpoint);
  libraryOwner = data.owner;
  const defaults = libraryOwner.id === 'admin' ? defaultProfile : { name: libraryOwner.name || libraryOwner.username, role: '', bio: '', location: '', email: '' };
  sharedProfile = { ...defaults, ...data.profile };
  sharedAvatar = data.avatar;
  setManagementMode();
  applyProfile(sharedProfile);
  const pageName = $('.nav-link.is-active')?.textContent || '摄影作品';
  document.title = `${sharedProfile.name} · ${pageName} · 留光`;
  await loadAvatar();
  return data.photos;
}

async function getStoredPhotoCount() {
  return (await api(libraryEndpoint)).photos.length;
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
    src: record.src,
    thumbnailSrc: record.thumbnailSrc,
    category: record.category || "未分类",
    categoryEn: "PERSONAL WORK",
    year: String(record.year || new Date().getFullYear()),
    alt: record.alt || `${record.title || "摄影作品"}，摄影：${sharedProfile.name}`,
    isUploaded: true,
  };
}

async function refreshLibrary({ resetHero = false } = {}) {
  const records = await getStoredPhotos();
  revokePhotoObjectUrls();
  uploadedPhotos = records.map(storedRecordToPhoto);
  activePhotos = uploadedPhotos;
  updateAboutPage();

  if (resetHero || heroIndex >= activePhotos.length) heroIndex = 0;
  renderFilterControls();
  if (galleryGrid) renderGallery();
  renderUploadedList();
  updateLibraryStatus();
  if (provinceMap) await renderProvinceMap();
  if (heroImageA) {
    heroImageA.hidden = !activePhotos.length;
    heroImageB.hidden = !activePhotos.length;
    $("#heroPrev").hidden = !activePhotos.length;
    $("#heroNext").hidden = !activePhotos.length;
    if (!activePhotos.length) {
      heroTitle.textContent = '作品准备中';
      heroCategory.textContent = 'PHOTOGRAPHY';
      heroMeta.textContent = '新的光影，即将抵达。';
      heroCounter.textContent = '00 / 00';
    }
    await showHero(heroIndex, true);
    scheduleHero();
  }
}

function svgElement(tag, attributes = {}) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
  return element;
}

function mapProjection(bounds, box) {
  const a = projectPoint([bounds[0], bounds[3]]);
  const b = projectPoint([bounds[2], bounds[1]]);
  const scale = Math.min(box[2] / (b[0] - a[0]), box[3] / (b[1] - a[1]));
  const offsetX = box[0] + (box[2] - (b[0] - a[0]) * scale) / 2;
  const offsetY = box[1] + (box[3] - (b[1] - a[1]) * scale) / 2;
  return point => {
    const projected = projectPoint(point);
    return [offsetX + (projected[0] - a[0]) * scale, offsetY + (projected[1] - a[1]) * scale];
  };
}

async function renderProvinceMap() {
  try {
    if (!provinceGeoData) {
      const response = await fetch("./assets/china-provinces.geojson");
      if (!response.ok) throw new Error("Map data unavailable");
      provinceGeoData = await response.json();
    }
    const { groups, missing, unmatched } = groupPhotosByProvince(uploadedPhotos, provinceGeoData.features);
    provincePhotoGroups = groups;
    const counts = [...groups.values()].map(photos => photos.length);
    const total = counts.reduce((sum, count) => sum + count, 0);
    const visited = counts.filter(Boolean).length;
    const max = Math.max(0, ...counts);
    mapStatus.textContent = `${visited} 个省级地区 · ${total} 张已归属 · ${missing} 张无 GPS · ${unmatched} 张未匹配`;
    $("#mapLegendMax").textContent = max ? `最多 ${max} 张` : "等待你的第一处足迹";
    const select = $("#provinceSelect");
    select.replaceChildren(new Option(`所有足迹 · ${total} 张`, ""), ...[...groups].map(([name, photos]) => new Option(`${name} · ${photos.length} 张`, name)));
    select.value = selectedProvinceName;
    provinceMap.replaceChildren();
    const defs = svgElement("defs");
    for (const [id, x, y, width, height] of [["mainMapClip", 15, 20, 970, 605], ["southMapClip", 820, 450, 150, 205]]) {
      const clip = svgElement("clipPath", { id });
      clip.append(svgElement("rect", { x, y, width, height }));
      defs.append(clip);
    }
    provinceMap.append(defs);
    const main = svgElement("g", { "clip-path": "url(#mainMapClip)" });
    const inset = svgElement("g", { "clip-path": "url(#southMapClip)" });
    const project = mapProjection([73, 18, 136, 54], [20, 25, 950, 595]);
    const projectSouth = mapProjection([106, 3, 124, 25], [820, 450, 150, 205]);
    for (const feature of provinceGeoData.features) {
      const name = feature.properties.name;
      const count = groups.get(name)?.length || 0;
      const path = svgElement("path", {
        d: geometryPath(feature.geometry, project),
        class: name ? "province-shape" : "map-boundary",
        fill: photoCountColor(count, max),
        "fill-rule": "evenodd",
      });
      if (name) {
        path.dataset.province = name;
        path.setAttribute("role", "button");
        path.setAttribute("tabindex", "0");
        path.setAttribute("aria-label", `${name}，${count} 张照片`);
        path.setAttribute("aria-pressed", String(name === selectedProvinceName));
        const title = svgElement("title");
        title.textContent = `${name} · ${count} 张照片`;
        path.append(title);
        path.addEventListener("click", () => selectProvince(name));
        path.addEventListener("keydown", event => {
          if (["Enter", " "].includes(event.key)) { event.preventDefault(); selectProvince(name); }
        });
        const hint = () => { mapTooltip.textContent = `${name} · ${count} 张照片，点击查看`; };
        path.addEventListener("pointerenter", hint);
        path.addEventListener("focus", hint);
      }
      main.append(path);
      const southPath = svgElement("path", {
        d: geometryPath(feature.geometry, projectSouth),
        class: "map-inset-shape", fill: photoCountColor(count, max), "fill-rule": "evenodd",
      });
      inset.append(southPath);
    }
    provinceMap.append(main);
    // Labels use the data's administrative centers; tiny regions remain accessible via the selector.
    for (const feature of provinceGeoData.features) {
      const name = feature.properties.name;
      const center = feature.properties.centroid || feature.properties.center;
      if (!name || !center || ["香港特别行政区", "澳门特别行政区", "天津市"].includes(name)) continue;
      const [x, y] = project(center);
      const label = svgElement("text", { x, y, class: "province-label", "aria-hidden": "true" });
      label.textContent = name.replace(/维吾尔自治区|壮族自治区|回族自治区|自治区|特别行政区|省|市/g, "");
      provinceMap.append(label);
    }
    provinceMap.append(svgElement("rect", { x: 820, y: 450, width: 150, height: 205, class: "map-inset-frame" }), inset);
    const insetTitle = svgElement("text", { x: 895, y: 677, class: "province-label" });
    insetTitle.textContent = "南海诸岛";
    provinceMap.append(insetTitle);
    selectProvince(selectedProvinceName);
  } catch (error) {
    console.warn("Could not render province map:", error);
    mapStatus.textContent = "地图暂时未能加载，请刷新重试。";
    mapPhotoList.textContent = "请通过本地预览服务器打开网页，以读取地图数据。";
  }
}

function selectProvince(name) {
  selectedProvinceName = provincePhotoGroups.has(name) ? name : "";
  $("#provinceSelect").value = selectedProvinceName;
  $$(".province-shape", provinceMap).forEach(path => {
    const active = path.dataset.province === selectedProvinceName;
    path.classList.toggle("is-selected", active);
    path.setAttribute("aria-pressed", String(active));
  });
  displayedPhotos = selectedProvinceName ? provincePhotoGroups.get(selectedProvinceName)
    : [...provincePhotoGroups.values()].flat();
  mapProvinceTitle.textContent = selectedProvinceName || "所有足迹";
  mapProvinceCount.textContent = `${displayedPhotos.length} 张`;
  mapTooltip.textContent = selectedProvinceName ? `${selectedProvinceName} · ${displayedPhotos.length} 张照片` : "选择一个省份，查看在那里拍下的照片";
  mapPhotoList.replaceChildren();
  if (!displayedPhotos.length) {
    const empty = document.createElement("p");
    empty.className = "map-empty";
    empty.textContent = selectedProvinceName ? "这里还没有留下照片。下一次出发，也许就是这里。" : "还没有带位置信息的作品，新的足迹正在路上。";
    mapPhotoList.append(empty);
  }
  displayedPhotos.forEach((photo, index) => {
    const button = document.createElement("button");
    button.className = "map-photo";
    button.type = "button";
    const image = document.createElement("img");
    image.src = photo.thumbnailSrc || photo.src;
    image.alt = photo.alt;
    image.loading = "lazy";
    const title = document.createElement("span");
    title.textContent = photo.title;
    button.append(image, title);
    button.setAttribute("aria-label", `放大查看：${photo.title}`);
    button.addEventListener("click", () => openLightbox(index));
    mapPhotoList.append(button);
  });
}

function updateLibraryStatus() {
  if (!libraryStatus) return;
  if (uploadedPhotos.length) {
    libraryStatus.innerHTML = `<i></i> 摄影作品 · ${String(uploadedPhotos.length).padStart(2, "0")} 张`;
  } else {
    libraryStatus.innerHTML = "<i></i> 作品正在整理";
  }
}

function setSelectOptions(select, values, currentValue) {
  if (!select) return;
  const available = ["全部", ...new Set(values.filter(Boolean))];
  select.replaceChildren(...available.map((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    return option;
  }));
  const nextValue = available.includes(currentValue) ? currentValue : "全部";
  select.value = nextValue;
  portfolioFilters[select.dataset.filter] = nextValue;
}

function renderFilterControls() {
  if (!filterPanel) return;
  setSelectOptions($("#filterCategory"), activePhotos.map((photo) => photo.category), portfolioFilters.category);
  setSelectOptions($("#filterYear"), activePhotos.map((photo) => String(photo.year)), portfolioFilters.year);
  setSelectOptions($("#filterDevice"), activePhotos.map((photo) => photo.device || "设备未记录"), portfolioFilters.device);
  setSelectOptions($("#filterOrientation"), activePhotos.map((photo) => orientationLabel(photo.shape)), portfolioFilters.orientation);
}

function renderGallery() {
  if (!galleryGrid || !galleryTemplate) return;
  displayedPhotos = activePhotos.filter((photo) => {
    const values = {
      category: photo.category,
      year: String(photo.year),
      device: photo.device || "设备未记录",
      orientation: orientationLabel(photo.shape),
    };
    return Object.entries(portfolioFilters)
      .every(([key, filterValue]) => filterValue === "全部" || values[key] === filterValue);
  });

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
    $(".gallery-place", fragment).textContent = photo.location || "位置未记录";
    $(".gallery-tech", fragment).textContent = technicalSummary(photo, 3) || `${photo.category} · ${photo.year}`;
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
  if (!galleryGrid?.children.length) return;
  const cards = $$(".gallery-card", galleryGrid);
  const perRow = window.innerWidth <= 620 ? 3 : window.innerWidth <= 900 ? 4 : 5;
  const previousSpans = new Map();
  const widths = [];
  const shapeOf = card => card.classList.contains("shape-wide") ? "wide" : card.classList.contains("shape-tall") ? "tall" : "square";
  const defaultSpans = perRow === 3 ? { wide: 10, tall: 5, square: 6 } : perRow === 4 ? { wide: 8, tall: 4, square: 5 } : { wide: 5, tall: 3, square: 4 };
  for (let start = 0; start < cards.length; start += perRow) {
    const row = cards.slice(start, start + perRow);
    if (row.length < perRow) {
      row.forEach(card => widths.push(previousSpans.get(shapeOf(card)) || defaultSpans[shapeOf(card)]));
      continue;
    }
    const weights = row.map(card => card.classList.contains("shape-wide") ? 1.6 : card.classList.contains("shape-tall") ? (perRow === 3 ? 0.8 : 0.67) : 1);
    const total = weights.reduce((sum, value) => sum + value, 0);
    let remaining = 20;
    row.forEach((card, index) => {
      const span = index === row.length - 1 ? remaining : Math.max(2, Math.round(weights[index] / total * 20));
      widths.push(span);
      previousSpans.set(shapeOf(card), span);
      remaining -= span;
    });
  }
  const styles = getComputedStyle(galleryGrid);
  const rowHeight = Number.parseFloat(styles.gridAutoRows) || 8;
  const rowGap = Number.parseFloat(styles.rowGap) || 0;

  let column = 1;
  let rowStart = 1;
  let nextRow = 1;
  cards.forEach((card, index) => {
    const width = widths[index];
    if (column + width > 21 || (index > 0 && index % perRow === 0)) {
      column = 1;
      rowStart = nextRow;
    }
    card.style.gridColumn = `${column} / span ${width}`;
    card.style.gridRow = "auto";
    const height = card.offsetHeight;
    const span = Math.ceil((height + rowGap) / (rowHeight + rowGap));
    card.style.gridRow = `${rowStart} / span ${span}`;
    nextRow = Math.max(nextRow, rowStart + span);
    column += width;
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
  if (heroMeta) {
    heroMeta.textContent = [photo.location, technicalSummary(photo, 3)].filter(Boolean).join("  ·  ") || "拍摄信息未记录";
  }
  heroCounter.textContent = `${String(index + 1).padStart(2, "0")} / ${String(activePhotos.length).padStart(2, "0")}`;
  if (announce) $("#heroAnnouncement").textContent = `${photo.title}。${photo.alt}`;
}

async function showHero(index, immediate = false, announce = false) {
  if (!heroImageA || !heroImageB || !activePhotos.length) return false;
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
  if (!heroProgress) return;
  heroProgress.classList.remove("is-running");
  void heroProgress.offsetWidth;
  if (activePhotos.length > 1 && !heroPaused && !document.hidden) {
    heroProgress.classList.add("is-running");
  }
}

function scheduleHero() {
  window.clearTimeout(heroTimer);
  restartHeroProgress();
  if (!heroImageA || $("#home")?.hidden || activePhotos.length <= 1 || document.hidden || heroPaused) return;
  heroTimer = window.setTimeout(async () => {
    const changed = await showHero(heroIndex + 1);
    if (changed) scheduleHero();
  }, HERO_INTERVAL);
}

async function stepHero(direction = 1) {
  window.clearTimeout(heroTimer);
  const changed = await showHero(heroIndex + direction, false, true);
  if (changed) scheduleHero();
}

function openLightbox(index) {
  if (!lightbox || !displayedPhotos.length) return;
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
  const blurImage = $("#lightboxBlur");
  if (blurImage) blurImage.src = photo.src;
  $("#lightboxTitle").textContent = photo.title;
  $("#lightboxCategory").textContent = `${photo.category} · ${photo.year}`;
  $("#lightboxCounter").textContent = `${String(lightboxIndex + 1).padStart(2, "0")} / ${String(displayedPhotos.length).padStart(2, "0")}`;
  const metadata = $("#lightboxMeta");
  if (metadata) {
    const items = [
      ["位置", photo.location || "未记录"],
      ["设备", photo.device || "未记录"],
      ["镜头", photo.lens || "未记录"],
      ["参数", [photo.focalLength, photo.aperture, photo.shutter, photo.iso].filter(Boolean).join(" · ") || "未记录"],
      ["时间", photo.capturedAt || String(photo.year)],
    ];
    metadata.replaceChildren(...items.map(([label, value]) => {
      const group = document.createElement("div");
      const term = document.createElement("dt");
      const description = document.createElement("dd");
      term.textContent = label;
      description.textContent = value;
      group.append(term, description);
      return group;
    }));
  }
  $("#lightboxPrev").hidden = displayedPhotos.length < 2;
  $("#lightboxNext").hidden = displayedPhotos.length < 2;

  const nextPhoto = displayedPhotos[(lightboxIndex + 1) % displayedPhotos.length];
  if (nextPhoto && displayedPhotos.length > 1) {
    const preload = new Image();
    preload.src = nextPhoto.src;
  }
}

function stepLightbox(direction) {
  if (!displayedPhotos.length) return;
  lightboxIndex = (lightboxIndex + direction + displayedPhotos.length) % displayedPhotos.length;
  renderLightbox();
}

function closeLightbox() {
  if (lightbox?.open) lightbox.close();
}

function openStudio(tab = "photos") {
  if (!canManage) return;
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
  if (!studio?.open && !lightbox?.open) document.body.classList.remove("is-locked");
  lastFocusedElement?.focus?.({ preventScroll: true });
}

async function handlePhotoFiles(fileList) {
  const incoming = [...fileList];
  if (!incoming.length || !canManage || uploadBusy) return;

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
    const files = incoming.slice(0, Math.min(availableSlots, 24));
    skipped = incoming.length - files.length;
    const records = [];

    for (const file of files) {
      if (!file.type.startsWith("image/") || file.size > MAX_FILE_SIZE) {
        skipped += 1;
        continue;
      }

      try {
        const metadata = await extractPhotoMetadata(file);
        const optimized = await optimizePhoto(file);
        const shape = shapeFromDimensions(optimized.width, optimized.height);
        records.push({
          id: crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          blob: optimized.blob,
          thumbnail: optimized.thumbnail,
          title: cleanFileName(file.name),
          category: "未分类",
          ...metadata,
          year: metadata.year || new Date(file.lastModified || Date.now()).getFullYear(),
          shape,
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
      for (const record of records) {
        await publishPhoto(record);
        imported++;
      }
      await refreshLibrary({ resetHero: true });
    }

    uploadMessage.textContent = imported
      ? `已加入 ${imported} 张照片${skipped ? `，跳过 ${skipped} 张` : ""}。`
      : "没有可加入的照片，请检查格式、尺寸与文件大小。";
  } catch (error) {
    uploadMessage.textContent = `已保存 ${imported} 张。${error.message}`;
    if (imported) await refreshLibrary({ resetHero: true }).catch(() => {});
  } finally {
    uploadBusy = false;
    photoInput.disabled = false;
    photoInput.value = "";
    uploadZone.classList.remove("is-busy");
    uploadZone.removeAttribute("aria-busy");
  }
}

async function deletePhoto(id) {
  if (!canManage || !window.confirm("从你的公开图库中移除这张照片？访客将不再看到它。")) return;
  try {
    await api(`/api/photos/${encodeURIComponent(id)}`, { method: 'DELETE', owner: libraryOwner.id });
    await refreshLibrary({ resetHero: true });
  } catch (error) { uploadMessage.textContent = error.message; }
}

function renderUploadedList() {
  const list = $("#uploadedList");
  if (!list) return;
  list.replaceChildren();

  if (!uploadedPhotos.length) {
    const empty = document.createElement("p");
    empty.className = "uploaded-empty";
    empty.textContent = "尚未添加作品。上传后会展示在你的公开主页。";
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
    const details = [photo.device, photo.aperture, photo.shutter, photo.iso].filter(Boolean).join(" · ");
    meta.textContent = details || [photo.width && photo.height ? `${photo.width} × ${photo.height}` : '', formatFileSize(photo.size)].filter(Boolean).join(' · ');
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
  return sharedProfile;
}

function initialsForName(name) {
  const cleaned = name.trim();
  if (!cleaned || cleaned === defaultProfile.name) return "YN";
  if (/^[\u3400-\u9fff]/.test(cleaned)) return cleaned.slice(0, 2);
  const words = cleaned.split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((word) => word[0]).join("").toUpperCase();
}

function applyProfile(profile) {
  if ($("#profileName")) $("#profileName").textContent = profile.name;
  if ($("#profileRole")) $("#profileRole").textContent = profile.role;
  if ($("#profileBio")) $("#profileBio").textContent = profile.bio;
  if ($("#profileLocation")) $("#profileLocation").lastChild.textContent = ` ${profile.location}`;
  if ($("#aboutLocation")) $("#aboutLocation").textContent = profile.location;
  if ($("#footerName")) $("#footerName").textContent = profile.name;
  if ($("#avatarFallback")) $("#avatarFallback").textContent = initialsForName(profile.name);
  for (const [selector, key] of [['#profileRole', 'role'], ['#profileBio', 'bio'], ['#profileLocation', 'location']]) {
    if ($(selector)) $(selector).hidden = !profile[key];
  }

  const contact = $("#contactButton");
  if (contact) {
    const contactMeta = $("small", contact);
    contact.disabled = !profile.email;
    contactMeta.textContent = profile.email || "邮箱待补充";
    contact.onclick = profile.email ? () => { window.location.href = `mailto:${profile.email}`; } : null;
  }

  for (const [key, value] of Object.entries(profile)) {
    const field = profileForm?.elements.namedItem(key);
    if (field) field.value = value;
  }
  updateAboutPage();
}

function updateAboutPage() {
  if (!$('#aboutTitle') || !libraryOwner || libraryOwner.id === 'admin') return;
  $('#aboutTitle').textContent = sharedProfile.name;
  $('.about-lead').textContent = sharedProfile.bio || '关于创作的故事，正在慢慢写下。';
  $('.about-note').textContent = sharedProfile.role || '摄影，让日常留下痕迹。';
  $('#aboutLocation').textContent = sharedProfile.location || '未填写';
  $$('.about-details > div').forEach(row => { row.hidden = !row.contains($('#aboutLocation')); });
  const photo = uploadedPhotos[0];
  const wrap = $('.about-image-wrap');
  const image = $('img', wrap);
  image.hidden = !photo;
  wrap.classList.toggle('is-empty', !photo);
  if (photo) { image.src = photo.src; image.alt = photo.alt; }
  $('p', wrap).textContent = photo ? photo.title : 'STILL LIGHT / PERSONAL SPACE';
}

async function loadAvatar() {
  try {
    const image = $("#profileAvatar");
    if (!image) return;
    if (sharedAvatar) image.src = sharedAvatar;
    image.hidden = !sharedAvatar;
    if ($("#avatarFallback")) $("#avatarFallback").hidden = !!sharedAvatar;
  } catch {
    // Keep the initials fallback when private storage is unavailable.
  }
}

async function saveAvatar(file) {
  const message = $("#profileMessage");
  if (!file || !canManage || !file.type.startsWith("image/") || file.size > MAX_FILE_SIZE) {
    message.textContent = "头像需要是 12 MB 以内的图片。";
    return;
  }

  message.textContent = "正在优化头像…";
  try {
    const optimized = await optimizePhoto(file);
    const result = await api('/api/avatar', { method:'PUT', owner: libraryOwner.id, body:{ image: await blobBase64(optimized.thumbnail) } });
    sharedAvatar = result.avatar;
    await loadAvatar();
    message.textContent = "头像已更新。";
  } catch (error) {
    console.warn("Could not save avatar:", error);
    message.textContent = "头像处理失败，请换一张图片重试。";
  } finally {
    avatarInput.value = "";
  }
}

async function saveProfile(event) {
  event.preventDefault();
  if (!canManage) return;
  const formData = new FormData(profileForm);
  const profile = {
    name: String(formData.get("name") || "").trim() || sharedProfile.name,
    role: String(formData.get("role") || "").trim(),
    bio: String(formData.get("bio") || "").trim(),
    location: String(formData.get("location") || "").trim(),
    email: String(formData.get("email") || "").trim(),
  };
  const button = $(".save-profile", profileForm);
  const original = button.textContent;
  button.disabled = true;
  try {
    sharedProfile = await api('/api/profile', { method:'PUT', owner: libraryOwner.id, body: profile });
    applyProfile(sharedProfile);
    $("#profileMessage").textContent = '资料已保存，访客将看到更新后的内容。';
  } catch (error) { $("#profileMessage").textContent = error.message; }
  finally { button.disabled = false; button.textContent = original; }
}

function updateNavIndicator(activeLink = $(".nav-link.is-active")) {
  if (!activeLink) return;
  const nav = $(".glass-nav");
  const liquid = $(".nav-liquid");
  if (!nav || !liquid) return;
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
  if (!galleryGrid) return;
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
  window.addEventListener('account-session-expired', () => { sessionUser = null; setManagementMode(); });
  window.addEventListener('focus', checkSession);
  window.addEventListener('pageshow', event => { if (event.persisted) checkSession(); });
  $('#importLegacy')?.addEventListener('click', importLegacyPhotos);
  $('#studioLogout')?.addEventListener('click', async () => {
    try { await api('/api/logout', { method:'POST' }); sessionUser = null; setManagementMode(); }
    catch (error) { uploadMessage.textContent = error.message; }
  });
  $("#provinceSelect")?.addEventListener("change", event => selectProvince(event.target.value));
  $("#heroNext")?.addEventListener("click", () => stepHero(1));
  $("#heroPrev")?.addEventListener("click", () => stepHero(-1));
  $("#studioTrigger")?.addEventListener("click", () => openStudio(document.body.classList.contains('about-page') ? 'profile' : 'photos'));
  $$('[data-open-studio]').forEach((button) => button.addEventListener("click", () => openStudio("photos")));
  $("#avatarButton")?.addEventListener("click", () => openStudio("profile"));
  $$('[data-close-studio]').forEach((element) => element.addEventListener("click", closeStudio));
  $$('[data-close-lightbox]').forEach((element) => element.addEventListener("click", closeLightbox));
  $("#lightboxPrev")?.addEventListener("click", () => stepLightbox(-1));
  $("#lightboxNext")?.addEventListener("click", () => stepLightbox(1));
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

  filterPanel?.addEventListener("change", (event) => {
    const select = event.target.closest("select[data-filter]");
    if (!select) return;
    portfolioFilters[select.dataset.filter] = select.value;
    renderGallery();
  });
  $("#clearFilters")?.addEventListener("click", () => {
    Object.keys(portfolioFilters).forEach((key) => { portfolioFilters[key] = "全部"; });
    renderFilterControls();
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

  lightbox?.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") stepLightbox(-1);
    if (event.key === "ArrowRight") stepLightbox(1);
  });
  lightbox?.addEventListener("touchstart", (event) => {
    touchStartX = event.changedTouches[0]?.clientX || 0;
  }, { passive: true });
  lightbox?.addEventListener("touchend", (event) => {
    const distance = (event.changedTouches[0]?.clientX || 0) - touchStartX;
    if (Math.abs(distance) > 55) stepLightbox(distance > 0 ? -1 : 1);
  }, { passive: true });

  lightbox?.addEventListener("close", unlockAfterDialog);
  studio.addEventListener("close", unlockAfterDialog);
  lightbox?.addEventListener("cancel", () => window.setTimeout(unlockAfterDialog));
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
    scheduleHero();
  });
  window.addEventListener("beforeunload", () => {
    revokePhotoObjectUrls();
    if (avatarObjectUrl) URL.revokeObjectURL(avatarObjectUrl);
  });
}

async function init() {
  scopePageLinks();
  createRevealObserver();
  bindEvents();
  setupDockEffect();
  setupSectionNavigation();
  observeReveals($$(".reveal"));
  applyProfile(loadProfile());
  heroPaused = motionPreference.matches;
  if ($("#currentYear")) $("#currentYear").textContent = String(new Date().getFullYear());

  try {
    await checkSession();
    await refreshLibrary({ resetHero: true });
    const manage = new URLSearchParams(location.search).get('manage');
    if (canManage && manage) openStudio(manage === 'profile' ? 'profile' : 'photos');
  } catch (error) {
    libraryOwner = null;
    setManagementMode();
    const description = error.status === 404 ? '这位摄影师的主页不存在。' : '图库暂时无法加载，请稍后刷新。';
    const notice = document.createElement('p');
    notice.className = 'library-error'; notice.setAttribute('role', 'alert'); notice.textContent = description;
    $('main').prepend(notice);
    if (libraryStatus) libraryStatus.textContent = description;
    if (heroTitle) heroTitle.textContent = error.status === 404 ? '主页不存在' : '图库暂时无法加载';
    if (heroMeta) heroMeta.textContent = description;
    uploadMessage.textContent = error.message;
    renderGallery();
    if (provinceMap) await renderProvinceMap();
  }

  requestAnimationFrame(() => updateNavIndicator());
}

init();
