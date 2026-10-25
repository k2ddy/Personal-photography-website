// Local point-in-polygon matching. Coordinates use [longitude, latitude].
export function hasCoordinates(photo) {
  return Number.isFinite(photo.longitude) && Number.isFinite(photo.latitude)
    && Math.abs(photo.longitude) <= 180 && Math.abs(photo.latitude) <= 90;
}

function inRing(point, ring) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const cross = (x - xi) * (yj - yi) - (y - yi) * (xj - xi);
    if (Math.abs(cross) < 1e-10 && x >= Math.min(xi, xj) && x <= Math.max(xi, xj)
      && y >= Math.min(yi, yj) && y <= Math.max(yi, yj)) return true;
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function containsPoint(geometry, point) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates]
    : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  return polygons.some(rings => inRing(point, rings[0]) && !rings.slice(1).some(ring => inRing(point, ring)));
}

export function groupPhotosByProvince(photos, features) {
  const groups = new Map(features.filter(f => f.properties.name).map(f => [f.properties.name, []]));
  let missing = 0;
  let unmatched = 0;
  for (const photo of photos) {
    if (!hasCoordinates(photo)) { missing++; continue; }
    const province = features.find(f => f.properties.name && containsPoint(f.geometry, [photo.longitude, photo.latitude]));
    if (province) groups.get(province.properties.name).push(photo);
    else unmatched++;
  }
  return { groups, missing, unmatched };
}

export function photoCountColor(count, max) {
  if (!count) return '#102638';
  const t = max > 1 ? (count - 1) / (max - 1) : 0;
  return `hsl(210 76% ${66 - t * 38}%)`;
}

export function projectPoint([longitude, latitude]) {
  return [longitude, -Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360)) * 180 / Math.PI];
}

export function geometryPath(geometry, project) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polygons.map(rings => rings.map(ring => ring.map((point, i) => {
    const [x, y] = project(point);
    return `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join('') + 'Z').join('')).join('');
}
