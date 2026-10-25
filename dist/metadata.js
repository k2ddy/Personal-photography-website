const TYPE_SIZE = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  7: 1,
  9: 4,
  10: 8,
};

function inBounds(view, offset, length = 1) {
  return offset >= 0 && offset + length <= view.byteLength;
}

function readAscii(view, offset, count) {
  if (!inBounds(view, offset, count)) return "";
  let result = "";
  for (let index = 0; index < count; index += 1) {
    const code = view.getUint8(offset + index);
    if (!code) break;
    result += String.fromCharCode(code);
  }
  return result.trim();
}

function readRational(view, offset, littleEndian, signed = false) {
  if (!inBounds(view, offset, 8)) return null;
  const numerator = signed
    ? view.getInt32(offset, littleEndian)
    : view.getUint32(offset, littleEndian);
  const denominator = signed
    ? view.getInt32(offset + 4, littleEndian)
    : view.getUint32(offset + 4, littleEndian);
  return denominator ? numerator / denominator : null;
}

function readEntryValue(view, tiffStart, entryOffset, type, count, littleEndian) {
  const unitSize = TYPE_SIZE[type];
  if (!unitSize || count < 1) return null;
  const byteLength = unitSize * count;
  const valueOffset = byteLength <= 4
    ? entryOffset + 8
    : tiffStart + view.getUint32(entryOffset + 8, littleEndian);
  if (!inBounds(view, valueOffset, byteLength)) return null;

  if (type === 2) return readAscii(view, valueOffset, count);

  const values = [];
  for (let index = 0; index < count; index += 1) {
    const offset = valueOffset + index * unitSize;
    if (type === 1 || type === 7) values.push(view.getUint8(offset));
    if (type === 3) values.push(view.getUint16(offset, littleEndian));
    if (type === 4) values.push(view.getUint32(offset, littleEndian));
    if (type === 5) values.push(readRational(view, offset, littleEndian));
    if (type === 9) values.push(view.getInt32(offset, littleEndian));
    if (type === 10) values.push(readRational(view, offset, littleEndian, true));
  }
  return count === 1 ? values[0] : values;
}

function readIfd(view, tiffStart, relativeOffset, littleEndian) {
  const tags = new Map();
  const ifdOffset = tiffStart + relativeOffset;
  if (!inBounds(view, ifdOffset, 2)) return tags;
  const count = Math.min(view.getUint16(ifdOffset, littleEndian), 512);

  for (let index = 0; index < count; index += 1) {
    const entryOffset = ifdOffset + 2 + index * 12;
    if (!inBounds(view, entryOffset, 12)) break;
    const tag = view.getUint16(entryOffset, littleEndian);
    const type = view.getUint16(entryOffset + 2, littleEndian);
    const valueCount = view.getUint32(entryOffset + 4, littleEndian);
    const value = readEntryValue(view, tiffStart, entryOffset, type, valueCount, littleEndian);
    if (value !== null && value !== "") tags.set(tag, value);
  }
  return tags;
}

function parseExifSegment(view, tiffStart) {
  if (!inBounds(view, tiffStart, 8)) return null;
  const byteOrder = view.getUint16(tiffStart, false);
  const littleEndian = byteOrder === 0x4949;
  if (!littleEndian && byteOrder !== 0x4d4d) return null;
  if (view.getUint16(tiffStart + 2, littleEndian) !== 42) return null;

  const root = readIfd(view, tiffStart, view.getUint32(tiffStart + 4, littleEndian), littleEndian);
  const exifPointer = root.get(0x8769);
  const gpsPointer = root.get(0x8825);
  const exif = Number.isFinite(exifPointer)
    ? readIfd(view, tiffStart, exifPointer, littleEndian)
    : new Map();
  const gps = Number.isFinite(gpsPointer)
    ? readIfd(view, tiffStart, gpsPointer, littleEndian)
    : new Map();
  return { root, exif, gps };
}

function locateExif(view) {
  if (!inBounds(view, 0, 4) || view.getUint16(0, false) !== 0xffd8) return null;
  let offset = 2;

  while (inBounds(view, offset, 4)) {
    if (view.getUint8(offset) !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = view.getUint8(offset + 1);
    offset += 2;
    if (marker === 0xda || marker === 0xd9) break;
    if (!inBounds(view, offset, 2)) break;
    const segmentLength = view.getUint16(offset, false);
    const dataOffset = offset + 2;
    if (segmentLength < 2 || !inBounds(view, offset, segmentLength)) break;
    const isExif = marker === 0xe1
      && readAscii(view, dataOffset, 4) === "Exif"
      && view.getUint16(dataOffset + 4, false) === 0;
    if (isExif) return parseExifSegment(view, dataOffset + 6);
    offset += segmentLength;
  }
  return null;
}

function cleanText(value) {
  return typeof value === "string" ? value.replace(/\0/g, "").trim() : "";
}

function cameraName(make, model) {
  const maker = cleanText(make);
  const camera = cleanText(model);
  if (!camera) return maker;
  if (maker && !camera.toLowerCase().includes(maker.toLowerCase())) return `${maker} ${camera}`;
  return camera;
}

function exifDate(value) {
  const text = cleanText(value);
  const match = text.match(/^(\d{4}):(\d{2}):(\d{2})(?:\s+(\d{2}):(\d{2}):(\d{2}))?/);
  if (!match) return { capturedAt: text, year: text.slice(0, 4) };
  const [, year, month, day, hour = "00", minute = "00", second = "00"] = match;
  return {
    capturedAt: `${year}-${month}-${day} ${hour}:${minute}:${second}`,
    year,
  };
}

function gpsCoordinate(values, reference) {
  if (!Array.isArray(values) || values.length < 3) return null;
  const [degrees, minutes, seconds] = values.map(Number);
  if (![degrees, minutes, seconds].every(Number.isFinite)) return null;
  const sign = ["S", "W"].includes(cleanText(reference).toUpperCase()) ? -1 : 1;
  return sign * (degrees + minutes / 60 + seconds / 3600);
}

function shutterLabel(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value >= 1) return `${Number(value.toFixed(1))}s`;
  return `1/${Math.max(1, Math.round(1 / value))}s`;
}

function numberLabel(value, suffix = "") {
  const number = Number(value);
  return Number.isFinite(number) ? `${Number(number.toFixed(1))}${suffix}` : "";
}

export async function extractPhotoMetadata(file) {
  const fallback = {
    capturedAt: "",
    year: "",
    device: "",
    lens: "",
    aperture: "",
    shutter: "",
    iso: "",
    focalLength: "",
    location: "",
    latitude: null,
    longitude: null,
  };

  if (!file || !/jpe?g/i.test(file.type || file.name || "")) return fallback;

  try {
    const parsed = locateExif(new DataView(await file.arrayBuffer()));
    if (!parsed) return fallback;
    const { root, exif, gps } = parsed;
    const date = exifDate(exif.get(0x9003) || exif.get(0x9004) || root.get(0x0132));
    const latitude = gpsCoordinate(gps.get(0x0002), gps.get(0x0001));
    const longitude = gpsCoordinate(gps.get(0x0004), gps.get(0x0003));
    const isoValue = exif.get(0x8827) || exif.get(0x8833);
    const device = cameraName(root.get(0x010f), root.get(0x0110));

    return {
      ...fallback,
      ...date,
      device,
      lens: cleanText(exif.get(0xa434)),
      aperture: exif.get(0x829d) ? `f/${numberLabel(exif.get(0x829d))}` : "",
      shutter: shutterLabel(exif.get(0x829a)),
      iso: Number.isFinite(Number(isoValue)) ? `ISO ${Number(isoValue)}` : "",
      focalLength: exif.get(0x920a) ? numberLabel(exif.get(0x920a), "mm") : "",
      latitude,
      longitude,
      location: Number.isFinite(latitude) && Number.isFinite(longitude)
        ? `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`
        : "",
    };
  } catch {
    return fallback;
  }
}

export function orientationLabel(shape) {
  if (shape === "wide") return "横幅";
  if (shape === "tall") return "竖幅";
  return "方形";
}

export function technicalSummary(photo, limit = 4) {
  return [photo.device, photo.focalLength, photo.aperture, photo.shutter, photo.iso]
    .filter(Boolean)
    .slice(0, limit)
    .join(" · ");
}
