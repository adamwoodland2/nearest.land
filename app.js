// Across the Water — click a coastline, see what lies over the sea in every direction.
// Everything runs client-side: Natural Earth country polygons are rasterised to an
// equirectangular index map once, then each of 360 bearings is walked along its
// great circle until the first land cell.
import * as THREE from './lib/three.module.js';
import { OrbitControls } from './lib/jsm/controls/OrbitControls.js';

const W = 4096, H = 2048;         // index raster (about 9.8 km per cell at the equator)
const R_EARTH = 6371;             // km
const MAX_KM = 40030;             // a full great circle: you always hit land (your own shore at worst)
const ANTIPODE_KM = 20015;
const BLOCK_KM = 20;              // land this close in a direction = "land in view"
const DEG = Math.PI / 180;

const $ = (s) => document.querySelector(s);

// ---------------------------------------------------------------- data + raster

// Loading is staged so the progress bar can move: download (byte-counted), decode, raster,
// texture, borders. Each stage yields to the browser once so the bar actually repaints.
const bar = $('#bar'), loadmsg = $('#loadmsg'), progressEl = $('#progress');
async function progress(pct, msg) {
  bar.style.width = `${pct}%`;
  progressEl.setAttribute('aria-valuenow', String(Math.round(pct)));
  if (msg) loadmsg.textContent = msg;
  await new Promise((r) => setTimeout(r, 0));
}
async function fetchWithProgress(url, from, to) {
  const resp = await fetch(url);
  const total = Number(resp.headers.get('content-length')) || 3.7e6;
  const reader = resp.body.getReader();
  const chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    bar.style.width = `${from + (to - from) * Math.min(1, got / total)}%`;
  }
  const buf = new Uint8Array(got); let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.length; }
  return JSON.parse(new TextDecoder().decode(buf));
}
await progress(2, 'Downloading the world (3.7 MB)…');
const topo = await fetchWithProgress('data/countries-10m.json', 2, 45);
await progress(46, 'Decoding countries…');
const features = topojson.feature(topo, topo.objects.countries).features;
const names = ['Open ocean', ...features.map((f) => f.properties.name)];
// Natural Earth's Antarctica polygon stops at about 85.2°S (no coastline data further south),
// which would leave a hole at the pole. Everything south of that edge is painted as Antarctica.
const ANT_ID = names.indexOf('Antarctica');
const ANT_EDGE = -84.3; // the dataset's artificial polar edge lies between 84.5°S and 85.2°S
const POLE_LAT = -89.95;  // just above the canvas edge: Firefox mis-fills paths that touch it

// Antarctica's mainland ring carries that artificial edge. Rebuild it as a clean ring: the real
// coast in its original order (rotated to start just after the edge), closed by two points near
// the pole. One simple polygon, no self-crossing, no edge contact.
let polarRing = null;

// Even-odd scanline fill of the (unwrapped, lon-increasing) polar ring at `scale` × the map
// size. Returns the covered rows as a mask: { y0, rows: Uint8Array(rows * width) }.
function rasterPolar(ring, scale) {
  const width = W * scale, height = H * scale;
  const pts = ring.map(([lon, lat]) => [(lon + 180) / 360 * width, (90 - lat) / 180 * height]);
  let yMin = Infinity, yMax = -Infinity;
  for (const [, y] of pts) { if (y < yMin) yMin = y; if (y > yMax) yMax = y; }
  const y0 = Math.max(0, Math.floor(yMin)), y1 = Math.min(height - 1, Math.ceil(yMax));
  const rows = y1 - y0 + 1;
  const mask = new Uint8Array(rows * width);
  const xs = [];
  for (let row = 0; row < rows; row++) {
    const yc = y0 + row + 0.5;
    xs.length = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xa, ya] = pts[j], [xb, yb] = pts[i];
      if ((ya <= yc) !== (yb <= yc)) xs.push(xa + (yc - ya) * (xb - xa) / (yb - ya));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.round(xs[k]), to = Math.round(xs[k + 1]);
      for (let x = from; x < to; x++) mask[row * width + ((x % width) + width) % width] = 1;
    }
  }
  return { y0, rows, mask };
}

function cleanPolarRing(ring) {
  const isEdge = ([, lat]) => lat <= ANT_EDGE;
  if (!ring.some(isEdge)) return ring;
  const n = ring.length;
  let start = ring.findIndex((pt, i) => !isEdge(pt) && isEdge(ring[(i - 1 + n) % n]));
  if (start < 0) return ring;
  const coast = [];
  for (let i = 0; i < n; i++) {
    const pt = ring[(start + i) % n];
    if (isEdge(pt)) break;
    coast.push(pt);
  }
  if (coast.length < 3) return ring;
  const u = unwrap(coast).ring;
  return [...u, [u[u.length - 1][0], POLE_LAT], [u[0][0], POLE_LAT]];
}

// Colour per country for the globe texture and the chart: spread hues, muted.
const palette = names.map((_, i) => (i === 0 ? '#9aa3b2' : `hsl(${Math.round((i * 137.508) % 360)}, 42%, 58%)`));

// Unwrap a ring so consecutive longitudes never jump by more than 180 degrees; a ring that
// crosses the antimeridian then extends beyond [-180, 180] and is drawn at three horizontal
// offsets, letting the canvas clip each copy — otherwise the fill smears across the map.
function unwrap(ring) {
  const out = []; let prev = ring[0][0], shift = 0, crosses = false;
  for (const [lon, lat] of ring) {
    let l = lon + shift;
    if (l - prev > 180) { shift -= 360; l -= 360; crosses = true; }
    else if (l - prev < -180) { shift += 360; l += 360; crosses = true; }
    out.push([l, lat]); prev = l;
  }
  return { ring: out, crosses };
}
// sx scales W×H map units to the target canvas (2 for the 8192-wide texture). Done here rather
// than with ctx.scale(): Firefox's canvas rasteriser fills Antarctica's huge path as a solid
// band when a transform is active.
function projectRing(ctx, ring, dx = 0, sx = 1) {
  ring.forEach(([lon, lat], k) => {
    const x = ((lon + 180) / 360 * W + dx) * sx, y = (90 - lat) / 180 * H * sx;
    k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.closePath();
}
function polygonsOf(f) {
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  const polar = f.properties.name === 'Antarctica';
  return polys.filter((poly) => {
    // The mainland (the polygon carrying the artificial polar edge) is rasterised in JS —
    // see rasterPolar — because Firefox's GPU canvas mis-fills it. Islands stay here.
    if (polar && poly[0].some(([, lat]) => lat <= ANT_EDGE)) { polarRing = cleanPolarRing(poly[0]); return false; }
    return true;
  }).map((poly) => {
    const rings = poly.map(unwrap);
    return { rings: rings.map((r) => r.ring), offsets: rings.some((r) => r.crosses) ? [0, -W, W] : [0] };
  });
}
function drawFeature(ctx, f, sx = 1) {
  for (const poly of polygonsOf(f)) {
    for (const dx of poly.offsets) {
      ctx.beginPath();
      for (const ring of poly.rings) projectRing(ctx, ring, dx, sx);
      ctx.fill('evenodd');
    }
  }
}

// Label anchor + size per country: centroid and area (shoelace, lon-unwrapped) of its
// largest polygon. Area is in deg² scaled by cos(lat) — only used for ranking.
const labelInfo = features.map((f) => {
  let best = null;
  for (const poly of polygonsOf(f)) {
    const ring = poly.rings[0];
    let a = 0, cx = 0, cy = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x0, y0] = ring[j], [x1, y1] = ring[i];
      const cross = x0 * y1 - x1 * y0;
      a += cross; cx += (x0 + x1) * cross; cy += (y0 + y1) * cross;
    }
    if (Math.abs(a) < 1e-9) continue;
    const lon = cx / (3 * a), lat = cy / (3 * a);
    const area = Math.abs(a) / 2 * Math.cos(lat * DEG);
    if (!best || area > best.area) best = { lat, lon: ((lon + 540) % 360) - 180, area };
  }
  return best || { lat: 0, lon: 0, area: 0 };
});

// Index raster: each country drawn in an id-encoded colour. Canvas anti-aliasing blends
// boundary pixels, so the encoding carries a checksum channel; pixels that fail it are
// resolved from their exact-decoded neighbours.
function buildIndex() {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  features.forEach((f, i) => {
    const id = i + 1;
    ctx.fillStyle = `rgb(${id},${(id * 97 + 31) & 255},255)`;
    drawFeature(ctx, f);
  });
  const px = ctx.getImageData(0, 0, W, H).data;
  const idx = new Uint16Array(W * H);
  const ok = new Uint8Array(W * H);
  const polar = polarRing ? rasterPolar(polarRing, 1) : null;
  for (let p = 0, q = 0; p < W * H; p++, q += 4) {
    const r = px[q], g = px[q + 1], b = px[q + 2];
    if (b === 0 && r === 0 && g === 0) { ok[p] = 1; idx[p] = 0; continue; }            // water
    if (b === 255 && g === ((r * 97 + 31) & 255)) { ok[p] = 1; idx[p] = r; }             // exact
  }
  if (polar) for (let i = 0; i < polar.rows * W; i++) if (polar.mask[i]) { const p = (polar.y0) * W + i; idx[p] = ANT_ID; ok[p] = 1; }
  const counts = new Map();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x;
    if (ok[p]) continue;
    counts.clear();
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const yy = y + dy; if (yy < 0 || yy >= H) continue;
      const n = yy * W + ((x + dx + W) % W);
      if (ok[n]) counts.set(idx[n], (counts.get(idx[n]) || 0) + 1);
    }
    let best = 0, bestN = -1;
    for (const [k, n] of counts) if (n > bestN) { best = k; bestN = n; }
    idx[p] = best;
  }
  return idx;
}

function hslToRgb(h, s, l) {
  const f = (n) => { const k = (n + h / 30) % 12; const a = s * Math.min(l, 1 - l); return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return [f(0), f(8), f(4)];
}

function buildTexture(tw) {
  const k = tw / W;
  const c = document.createElement('canvas');
  c.width = tw; c.height = tw / 2;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0e2a47';
  ctx.fillRect(0, 0, c.width, c.height);
  features.forEach((f, i) => { ctx.fillStyle = palette[i + 1]; drawFeature(ctx, f, k); });
  if (polarRing) {
    const polar = rasterPolar(polarRing, k);
    const img = ctx.createImageData(c.width, polar.rows);
    const m = /hsl\((\d+), (\d+)%, (\d+)%\)/.exec(palette[ANT_ID]);
    const [cr, cg, cb] = hslToRgb(+m[1], +m[2] / 100, +m[3] / 100);
    for (let i = 0; i < polar.rows * c.width; i++) if (polar.mask[i]) { const q = i * 4; img.data[q] = cr; img.data[q + 1] = cg; img.data[q + 2] = cb; img.data[q + 3] = 255; }
    // Composite through a temporary canvas: putImageData would replace the water with transparent black.
    const tmpC = document.createElement('canvas');
    tmpC.width = c.width; tmpC.height = polar.rows;
    tmpC.getContext('2d').putImageData(img, 0, 0);
    ctx.drawImage(tmpC, 0, polar.y0);
  }
  return c;
}

await progress(55, 'Rasterising the analysis grid…');
const index = buildIndex();
await progress(72, 'Painting the globe…');

// ---------------------------------------------------------------- geometry helpers

const cell = (lat, lon) => {
  const x = Math.floor((((lon + 180) % 360 + 360) % 360) / 360 * W);
  const y = Math.min(H - 1, Math.max(0, Math.floor((90 - lat) / 180 * H)));
  return y * W + x;
};
const landAt = (lat, lon) => index[cell(lat, lon)];
const cellCentre = (p) => ({ lat: 90 - (Math.floor(p / W) + 0.5) / H * 180, lon: (p % W + 0.5) / W * 360 - 180 });

function destination(lat, lon, bearing, d) {
  const p1 = lat * DEG, l1 = lon * DEG, th = bearing * DEG, dl = d / R_EARTH;
  const sp1 = Math.sin(p1), cp1 = Math.cos(p1), sd = Math.sin(dl), cd = Math.cos(dl);
  const sp2 = sp1 * cd + cp1 * sd * Math.cos(th);
  const p2 = Math.asin(sp2);
  const l2 = l1 + Math.atan2(Math.sin(th) * sd * cp1, cd - sp1 * sp2);
  return { lat: p2 / DEG, lon: ((l2 / DEG + 540) % 360) - 180 };
}

// Walk one bearing to first landfall. null = land in view (blocked).
function march(lat, lon, bearing) {
  const p1 = lat * DEG, l1 = lon * DEG, th = bearing * DEG;
  const sp1 = Math.sin(p1), cp1 = Math.cos(p1), sth = Math.sin(th), cth = Math.cos(th);
  for (let d = 3; d <= MAX_KM; d += d < 400 ? 3 : 8) {
    const dl = d / R_EARTH, sd = Math.sin(dl), cd = Math.cos(dl);
    const sp2 = sp1 * cd + cp1 * sd * cth;
    const p2 = Math.asin(sp2);
    const l2 = l1 + Math.atan2(sth * sd * cp1, cd - sp1 * sp2);
    const id = landAt(p2 / DEG, l2 / DEG);
    if (id) return d <= BLOCK_KM ? null : { id, km: d };
  }
  return { id: 0, km: MAX_KM }; // unreachable in practice: the circle returns to the shore you stand on
}

// Nearest water cell that touches land: standing at the water's edge.
function snapToShore(lat, lon) {
  const p0 = cell(lat, lon), x0 = p0 % W, y0 = Math.floor(p0 / W);
  const isShore = (x, y) => {
    if (y < 0 || y >= H) return false;
    const xw = (x + W) % W;
    if (index[y * W + xw]) return false;
    return index[y * W + ((xw + 1) % W)] || index[y * W + ((xw - 1 + W) % W)] ||
      (y > 0 && index[(y - 1) * W + xw]) || (y < H - 1 && index[(y + 1) * W + xw]);
  };
  for (let r = 0; r < 120; r++) {
    let best = null, bestD = Infinity;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      if (isShore(x0 + dx, y0 + dy)) {
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = [x0 + dx, y0 + dy]; }
      }
    }
    if (best) return best[1] * W + ((best[0] + W) % W);
  }
  return null;
}
function homeCountry(p) {
  const x = p % W, y = Math.floor(p / W), counts = new Map();
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const yy = y + dy; if (yy < 0 || yy >= H) continue;
    const id = index[yy * W + ((x + dx + W) % W)];
    if (id) counts.set(id, (counts.get(id) || 0) + 1);
  }
  let best = 0, n = -1;
  for (const [k, v] of counts) if (v > n) { best = k; n = v; }
  return best;
}

// ---------------------------------------------------------------- analysis

const runWidth = (run) => (run.wrap ? 360 - run.start + run.end + 1 : run.end - run.start + 1);

function analyze(lat, lon) {
  const p = snapToShore(lat, lon);
  if (p === null) return null;
  const at = cellCentre(p);
  const home = homeCountry(p);
  const antipode = { lat: -at.lat, lon: ((at.lon + 360) % 360) - 180 };
  antipode.id = landAt(antipode.lat, antipode.lon);
  const view = new Array(360);
  for (let b = 0; b < 360; b++) view[b] = march(at.lat, at.lon, b);
  // Contiguous runs of the same destination.
  const runs = [];
  for (let b = 0; b < 360; b++) {
    const v = view[b];
    if (!v) continue;
    const last = runs[runs.length - 1];
    if (last && last.id === v.id && last.end === b - 1) { last.end = b; last.km = Math.min(last.km, v.km); }
    else runs.push({ id: v.id, start: b, end: b, km: v.km, wrap: false });
  }
  // Join a run that wraps through 359 -> 0, then order clockwise from north (the wrapping
  // run contains north, so it goes first).
  if (runs.length > 1 && runs[0].start === 0 && runs[runs.length - 1].end === 359 && runs[0].id === runs[runs.length - 1].id) {
    const last = runs.pop();
    runs[0].start = last.start; runs[0].wrap = true; runs[0].km = Math.min(runs[0].km, last.km);
  }
  runs.sort((a, b) => (a.wrap ? -1 : a.start) - (b.wrap ? -1 : b.start));
  runs.forEach((r, i) => { r.i = i; });
  return { at, home, antipode, view, runs };
}

// ---------------------------------------------------------------- globe

const canvas = $('#globe');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0f1a);
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
camera.position.set(2.9, 0, 0); // facing 0°N 0°E (toVec(0, 0) is the +x axis)
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true; controls.dampingFactor = 0.08;
controls.minDistance = 1.15; controls.maxDistance = 6; controls.enablePan = false;
controls.rotateSpeed = 0.6;
// Mouse: left = pick, right-drag = rotate, wheel/middle = zoom. Touch keeps the defaults
// (one finger rotates, two fingers pinch-zoom); a tap without movement picks.
controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };

// Display texture: 8192 wide where the GPU and memory allow (about 130 MB), else 4096.
const lowMem = (navigator.deviceMemory && navigator.deviceMemory < 4) || /Mobi|Android/i.test(navigator.userAgent);
const forcedTex = parseInt(new URLSearchParams(location.search).get('tex') || '', 10);
const TEX_W = forcedTex === 4096 || forcedTex === 8192 ? forcedTex : (renderer.capabilities.maxTextureSize >= 8192 && !lowMem ? 8192 : 4096);
const texture = new THREE.CanvasTexture(buildTexture(TEX_W));
texture.colorSpace = THREE.SRGBColorSpace;
const maxAniso = renderer.capabilities.getMaxAnisotropy();
texture.anisotropy = maxAniso;
// Near the poles one sphere triangle spans a whole texture row, so mipmapping picks a very
// coarse level there; without anisotropic filtering that renders the polar cap as a flat disc
// (seen in Firefox on some Windows GPU stacks). If anisotropy is unavailable, skip mipmaps.
const qs = new URLSearchParams(location.search);
const noMip = qs.has('nomip') || maxAniso < 4;
if (noMip) {
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
}
if (qs.has('debug')) {
  const dbg = document.createElement('p');
  dbg.className = 'sub';
  dbg.textContent = `debug: texture ${TEX_W}px · anisotropy ${maxAniso} · mipmaps ${!noMip} · maxTexture ${renderer.capabilities.maxTextureSize} · ${navigator.userAgent}`;
  document.querySelector('.top').appendChild(dbg);
  // Raw texture rows for the southern band (55°S to the pole), straight from the 2D canvas —
  // separates a canvas-fill problem from a WebGL-sampling problem.
  const src = texture.image, th = src.height, y0 = Math.floor((90 + 55) / 180 * th);
  const strip = document.createElement('canvas');
  strip.width = 1200; strip.height = Math.round((th - y0) * 1200 / src.width);
  strip.getContext('2d').drawImage(src, 0, y0, src.width, th - y0, 0, 0, strip.width, strip.height);
  strip.className = 'debug-strip';
  document.querySelector('.top').appendChild(strip);
}
const globe = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 96), new THREE.MeshBasicMaterial({ map: texture }));
scene.add(globe);
await progress(88, 'Drawing coastlines and borders…');

let borders;
// Borders and coastlines as real lines on the sphere — crisp at any zoom, unlike the fill.
{
  const mesh = topojson.mesh(topo, topo.objects.countries);
  const pos = [];
  for (const line of mesh.coordinates) {
    for (let i = 1; i < line.length; i++) {
      if (line[i - 1][1] <= ANT_EDGE && line[i][1] <= ANT_EDGE) continue; // the dataset's artificial polar edge
      const a = toVec(line[i - 1][1], line[i - 1][0], 1.0015), b = toVec(line[i][1], line[i][0], 1.0015);
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  borders = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x0a0f1a, transparent: true, opacity: 0.55 }));
  scene.add(borders);
}

// lon/lat -> position, matching three's SphereGeometry UV layout for an equirectangular map.
function toVec(lat, lon, r = 1) {
  const p = lat * DEG, l = lon * DEG;
  return new THREE.Vector3(r * Math.cos(p) * Math.cos(l), r * Math.sin(p), -r * Math.cos(p) * Math.sin(l));
}
function fromVec(v) {
  const n = v.clone().normalize();
  return { lat: Math.asin(n.y) / DEG, lon: Math.atan2(-n.z, n.x) / DEG };
}

// Markers keep a constant on-screen size: scaled each frame by camera distance.
const marker = new THREE.Mesh(new THREE.SphereGeometry(0.012, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffc857 }));
marker.visible = false;
scene.add(marker);
const gpsDot = new THREE.Mesh(new THREE.SphereGeometry(0.012, 16, 12), new THREE.MeshBasicMaterial({ color: 0x3b82f6 }));
gpsDot.visible = false;
scene.add(gpsDot);
const gpsRing = new THREE.Mesh(new THREE.RingGeometry(0.018, 0.024, 32), new THREE.MeshBasicMaterial({ color: 0x93c5fd, side: THREE.DoubleSide, transparent: true, opacity: 0.8 }));
gpsRing.visible = false;
scene.add(gpsRing);
const antiMarker = new THREE.Mesh(new THREE.RingGeometry(0.008, 0.016, 24), new THREE.MeshBasicMaterial({ color: 0xc084fc, side: THREE.DoubleSide }));
antiMarker.visible = false;
scene.add(antiMarker);
const linesGroup = new THREE.Group();
scene.add(linesGroup);

// Country labels: one absolutely-positioned div each, projected every frame and decluttered.
const labelsBox = $('#labels');
const labels = features.map((f, i) => {
  const d = document.createElement('div');
  d.className = 'label' + (labelInfo[i].area > 150 ? ' big' : '');
  d.textContent = f.properties.name;
  d.hidden = true;
  labelsBox.appendChild(d);
  return { el: d, v: toVec(labelInfo[i].lat, labelInfo[i].lon, 1.0), area: labelInfo[i].area, w: f.properties.name.length * 6.4 + 10 };
});
const labelOrder = labels.map((l, i) => i).sort((a, b) => labels[b].area - labels[a].area);

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

const tmp = new THREE.Vector3();
function updateLabels() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const dist = camera.position.length();
  const camDir = camera.position.clone().normalize();
  // Bigger countries appear first; smaller ones only as you zoom in.
  const minArea = 110 * Math.pow(Math.max(0, dist - 1.15) / 4.85, 1.5);
  const placed = [];
  for (const i of labelOrder) {
    const L = labels[i];
    let show = L.area >= minArea && L.v.dot(camDir) > 0.12;
    let x = 0, y = 0;
    if (show) {
      tmp.copy(L.v).project(camera);
      x = (tmp.x + 1) / 2 * w; y = (1 - tmp.y) / 2 * h;
      show = x > -40 && x < w + 40 && y > -20 && y < h + 20;
    }
    if (show) {
      for (const p of placed) {
        if (Math.abs(p.x - x) < (p.w + L.w) / 2 && Math.abs(p.y - y) < 16) { show = false; break; }
      }
    }
    if (show) {
      placed.push({ x, y, w: L.w });
      L.el.hidden = false;
      L.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`;
    } else if (!L.el.hidden) {
      L.el.hidden = true;
    }
  }
}

function frame() {
  controls.update();
  const s = Math.max(0.05, (camera.position.length() - 1) / 1.9);
  marker.scale.setScalar(s);
  antiMarker.scale.setScalar(s);
  gpsDot.scale.setScalar(s);
  // Drag rotation slows down as you zoom in, so the globe moves under the cursor at the same pace.
  controls.rotateSpeed = Math.min(0.6, Math.max(0.03, 0.6 * (camera.position.length() - 1) / 1.9));
  gpsRing.scale.setScalar(s);
  updateLabels();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Click (not drag) -> pick. Pointer move -> tooltip on the great-circle paths.
const raycaster = new THREE.Raycaster();
raycaster.params.Line.threshold = 0.012;
const tip = $('#tip');
let down = null;
function ndcOf(e) {
  const rect = canvas.getBoundingClientRect();
  return new THREE.Vector2((e.clientX - rect.left) / rect.width * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
}
canvas.addEventListener('pointerdown', (e) => { down = e.button === 0 ? [e.clientX, e.clientY] : null; });
canvas.addEventListener('pointerup', (e) => {
  if (!down || e.button !== 0) { down = null; return; }
  const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]);
  down = null;
  if (moved > (e.pointerType === 'touch' ? 12 : 5)) return;
  raycaster.setFromCamera(ndcOf(e), camera);
  const hit = raycaster.intersectObject(globe)[0];
  if (!hit) { clearPick(); return; } // clicked off the globe: clear the selection
  const { lat, lon } = fromVec(hit.point);
  pick(lat, lon);
});

function clearPick() {
  if (!marker.visible) return;
  marker.visible = antiMarker.visible = false;
  linesGroup.clear();
  svg.replaceChildren();
  $('#legend').replaceChildren();
  hlRun = -1;
  const place = $('#place');
  place.replaceChildren();
  const hint = document.createElement('p'); hint.className = 'hint';
  hint.textContent = 'Nothing picked. Click a coastline on the globe, or try one of the places under it.';
  place.appendChild(hint);
  history.replaceState(null, '', location.pathname);
}
canvas.addEventListener('pointermove', (e) => {
  if (down || !linesGroup.children.length) { tip.hidden = true; return; }
  raycaster.setFromCamera(ndcOf(e), camera);
  const hits = raycaster.intersectObjects(linesGroup.children, false);
  // Only accept a hit on the near side of the globe.
  const hit = hits.find((h) => h.point.length() > 0.999 && h.point.dot(camera.position) > 0);
  if (!hit) { tip.hidden = true; highlightRun(-1); return; }
  const u = hit.object.userData;
  tip.replaceChildren();
  const c = document.createElement('span'); c.className = 'tip-country'; c.textContent = names[u.id];
  const m = document.createElement('span'); m.className = 'tip-meta'; m.textContent = ` · ${u.bearing}° · ${fmtKm(u.km)}`;
  tip.append(c, m);
  const rect = canvas.getBoundingClientRect();
  tip.style.left = `${e.clientX - rect.left}px`;
  tip.style.top = `${e.clientY - rect.top}px`;
  tip.hidden = false;
  highlightRun(u.run);
});
canvas.addEventListener('pointerleave', () => { tip.hidden = true; highlightRun(-1); });

function drawLines(res) {
  linesGroup.clear();
  for (const run of res.runs) {
    // One path per ~4 degrees of a run plus its edges, so wide sectors show their spread.
    const width = runWidth(run);
    const n = Math.max(1, Math.round(width / 4));
    for (let k = 0; k <= n; k++) {
      const b = Math.round(run.start + (width - 1) * (k / n)) % 360;
      const v = res.view[b];
      if (!v) continue;
      const pts = [];
      const steps = Math.max(8, Math.round(v.km / 150));
      for (let s = 0; s <= steps; s++) {
        const q = destination(res.at.lat, res.at.lon, b, v.km * s / steps);
        pts.push(toVec(q.lat, q.lon, 1.006));
      }
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: new THREE.Color(palette[v.id]), transparent: true, opacity: 0.85 }));
      line.userData = { id: v.id, bearing: b, km: v.km, run: run.i };
      linesGroup.add(line);
    }
  }
}

// ---------------------------------------------------------------- chart + legend

const NS = 'http://www.w3.org/2000/svg';
const svg = $('#chart');
function el(name, attrs, text) {
  const e = document.createElementNS(NS, name);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (text != null) e.textContent = text;
  return e;
}
function wedgePath(cx, cy, r0, r1, a0, a1) {
  const p = (r, a) => [cx + r * Math.sin(a * DEG), cy - r * Math.cos(a * DEG)];
  const [x0, y0] = p(r1, a0), [x1, y1] = p(r1, a1), [x2, y2] = p(r0, a1), [x3, y3] = p(r0, a0);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r1} ${r1} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} L${x2.toFixed(2)} ${y2.toFixed(2)} A${r0} ${r0} 0 ${large} 0 ${x3.toFixed(2)} ${y3.toFixed(2)} Z`;
}
const fmtKm = (km) => `${Math.round(km).toLocaleString('en-GB')} km`;
const bearingLabel = (run) => (run.start === run.end ? `${run.start}°` : `${run.start}°–${run.end}°`);

// Hover linking: wedge <-> legend row <-> globe paths, all keyed by run index.
let hlRun = -1;
function highlightRun(i, scroll = false) {
  if (i === hlRun) return;
  hlRun = i;
  for (const w of svg.querySelectorAll('.wedge')) w.classList.toggle('hl', +w.dataset.run === i);
  for (const li of $('#legend').querySelectorAll('li[data-run]')) {
    const on = +li.dataset.run === i;
    li.classList.toggle('hl', on);
    if (on && scroll) li.scrollIntoView({ block: 'nearest' });
  }
  for (const line of linesGroup.children) line.material.opacity = i < 0 ? 0.85 : (line.userData.run === i ? 1 : 0.25);
}

function drawChart(res) {
  svg.replaceChildren();
  const cx = 180, cy = 180, r0 = 46, r1 = 160;
  for (const run of res.runs) {
    const a0 = run.start - 0.5, a1 = (run.wrap ? run.end + 360 : run.end) + 0.5;
    const path = el('path', { d: wedgePath(cx, cy, r0, r1, a0, a1), fill: palette[run.id], class: 'wedge', 'data-run': run.i });
    path.appendChild(el('title', {}, `${names[run.id]} · ${bearingLabel(run)} · nearest ${fmtKm(run.km)}`));
    path.addEventListener('pointerenter', () => highlightRun(run.i, true));
    path.addEventListener('pointerleave', () => highlightRun(-1));
    svg.appendChild(path);
  }
  svg.appendChild(el('circle', { cx, cy, r: r1, class: 'ring' }));
  svg.appendChild(el('circle', { cx, cy, r: r0, class: 'ring' }));
  for (let a = 0; a < 360; a += 30) {
    const s = Math.sin(a * DEG), c = Math.cos(a * DEG);
    svg.appendChild(el('line', { x1: cx + (r1 + 3) * s, y1: cy - (r1 + 3) * c, x2: cx + (r1 + 9) * s, y2: cy - (r1 + 9) * c, class: 'tick' }));
  }
  for (const [a, t] of [[0, 'N'], [90, 'E'], [180, 'S'], [270, 'W']]) {
    svg.appendChild(el('text', { x: cx + (r1 + 17) * Math.sin(a * DEG), y: cy - (r1 + 17) * Math.cos(a * DEG) + 4, class: 'tick-label' }, t));
  }
  svg.appendChild(el('circle', { cx, cy, r: 5, class: 'you' }));
}

function drawLegend(res) {
  const legend = $('#legend');
  legend.replaceChildren();
  // One row per sector, clockwise from north — the same order as the chart.
  for (const run of res.runs) {
    const li = document.createElement('li');
    li.dataset.run = run.i;
    if (run.id === res.home) li.className = 'home';
    const sw = document.createElement('span'); sw.className = 'swatch'; sw.style.background = palette[run.id];
    const name = document.createElement('span'); name.className = 'country'; name.textContent = names[run.id];
    const sm = document.createElement('small');
    sm.textContent = (run.km > ANTIPODE_KM ? 'beyond the antipode · ' : '') + `nearest ${fmtKm(run.km)}`;
    name.appendChild(sm);
    const rg = document.createElement('span'); rg.className = 'ranges';
    rg.textContent = `${bearingLabel(run)} · ${runWidth(run)}°`;
    li.append(sw, name, rg);
    li.addEventListener('pointerenter', () => highlightRun(run.i));
    li.addEventListener('pointerleave', () => highlightRun(-1));
    legend.appendChild(li);
  }
  const blocked = res.view.filter((v) => !v).length;
  const li = document.createElement('li');
  li.className = 'blocked';
  const sw = document.createElement('span'); sw.className = 'swatch'; sw.style.border = '1px dashed #4b5563';
  const name = document.createElement('span'); name.textContent = `Land in view for the other ${blocked}° — blank on the chart`;
  li.append(sw, name, document.createElement('span'));
  legend.appendChild(li);
}

function pick(lat, lon) {
  const t0 = performance.now();
  const res = analyze(lat, lon);
  if (!res) return null;
  marker.position.copy(toVec(res.at.lat, res.at.lon, 1.008));
  marker.visible = true;
  antiMarker.position.copy(toVec(res.antipode.lat, res.antipode.lon, 1.009));
  antiMarker.lookAt(0, 0, 0);
  antiMarker.visible = true;
  hlRun = -1;
  drawLines(res);
  drawChart(res);
  drawLegend(res);
  const open = res.view.filter((v) => v).length;
  const place = $('#place');
  place.replaceChildren();
  const nm = document.createElement('p'); nm.className = 'name';
  nm.textContent = `${names[res.home]} — ${open}° of open water`;
  const co = document.createElement('p'); co.className = 'coords';
  co.textContent = `${Math.abs(res.at.lat).toFixed(2)}°${res.at.lat >= 0 ? 'N' : 'S'}, ${Math.abs(res.at.lon).toFixed(2)}°${res.at.lon >= 0 ? 'E' : 'W'} · computed in ${Math.round(performance.now() - t0)} ms`;
  const an = document.createElement('p'); an.className = 'coords';
  const fmtLL = (q) => `${Math.abs(q.lat).toFixed(2)}°${q.lat >= 0 ? 'N' : 'S'}, ${Math.abs(q.lon).toFixed(2)}°${q.lon >= 0 ? 'E' : 'W'}`;
  an.textContent = `Antipode: ${fmtLL(res.antipode)} — ${res.antipode.id ? names[res.antipode.id] : 'open ocean'} (purple ring on the globe)`;
  const share = document.createElement('button');
  share.type = 'button'; share.className = 'share'; share.id = 'share'; share.textContent = 'Share this view';
  share.addEventListener('click', shareView);
  const shareStatus = document.createElement('span'); shareStatus.className = 'share-status'; shareStatus.id = 'shareStatus';
  const row = document.createElement('p'); row.className = 'share-row'; row.append(share, shareStatus);
  place.append(nm, co, an, row);
  // The address bar always holds a link to exactly this view.
  history.replaceState(null, '', `?at=${res.at.lat.toFixed(3)},${res.at.lon.toFixed(3)}`);
  // On a stacked (phone) layout the results are below the globe — bring them into view.
  if (window.innerWidth < 860) document.querySelector('.panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  return res;
}

function flyTo(lat, lon) {
  camera.position.copy(toVec(lat, lon, camera.position.length()));
  controls.update();
}

async function shareView() {
  const url = location.href;
  const status = $('#shareStatus');
  const title = document.title;
  const text = ($('#place .name') || {}).textContent || 'Nearest Land';
  if (navigator.share) {
    try { await navigator.share({ title, text, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  try {
    await navigator.clipboard.writeText(url);
    status.textContent = 'Link copied';
  } catch (e) {
    status.textContent = url;
  }
  setTimeout(() => { if (status.textContent === 'Link copied') status.textContent = ''; }, 2500);
}

// A shared link (?at=lat,lon) reopens the same view.
function pickFromUrl() {
  // An installed app launches with whatever URL was on screen when it was added — replaying a
  // pick every launch (and scrolling to it) is not what anyone wants, so standalone ignores ?at.
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (standalone) { if (location.search) history.replaceState(null, '', location.pathname); return false; }
  const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(new URLSearchParams(location.search).get('at') || '');
  if (!m) return false;
  const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
  pick(lat, lon);
  flyTo(lat, lon);
  return true;
}

for (const b of document.querySelectorAll('#presets button[data-lat]')) {
  b.addEventListener('click', () => {
    const lat = parseFloat(b.dataset.lat), lon = parseFloat(b.dataset.lon);
    pick(lat, lon);
    flyTo(lat, lon);
  });
}

// ---------------------------------------------------------------- device location

const locateBtn = $('#locate');
function showGps(lat, lon) {
  gpsDot.position.copy(toVec(lat, lon, 1.008));
  gpsRing.position.copy(toVec(lat, lon, 1.009));
  gpsRing.lookAt(0, 0, 0);
  gpsDot.visible = gpsRing.visible = true;
  locateBtn.classList.add('on');
  locateBtn.textContent = 'My location';
}
function requestGps(fly) {
  if (!navigator.geolocation) { locateBtn.textContent = 'No location'; return; }
  locateBtn.textContent = 'Locating…';
  navigator.geolocation.getCurrentPosition(
    (pos) => { showGps(pos.coords.latitude, pos.coords.longitude); if (fly) flyTo(pos.coords.latitude, pos.coords.longitude); },
    () => { locateBtn.textContent = 'Location unavailable'; },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 }
  );
}
locateBtn.addEventListener('click', () => {
  if (gpsDot.visible) { flyTo(...Object.values(fromVec(gpsDot.position))); return; }
  requestGps(true);
});
// Show the blue dot without asking if permission was already granted earlier.
if (navigator.permissions && navigator.permissions.query) {
  navigator.permissions.query({ name: 'geolocation' }).then((p) => { if (p.state === 'granted') requestGps(false); }).catch(() => {});
}

await progress(100, 'Ready');
$('#loading').hidden = true;
pickFromUrl();

// PWA: offline cache + installability (sw.js). Registered only where service workers exist;
// localhost is allowed for testing.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* PWA is optional */ });
}

// Read-only test hook.
window.__ATW = { analyze, pick, names, landAt, texW: TEX_W, cam: () => camera.position, borders: () => borders, globe, tex: () => texture.image, aniso: maxAniso, mipmaps: texture.generateMipmaps, labels: () => labels.filter((l) => !l.el.hidden).map((l) => l.el.textContent), showGps, highlightRun };
