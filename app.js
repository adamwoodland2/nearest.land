// Across the Water — click a coastline, see what lies over the sea in every direction.
// Everything runs client-side: Natural Earth country polygons are rasterised to an
// equirectangular index map once, then each of 360 bearings is walked along its
// great circle until the first land cell.
import * as THREE from './lib/three.module.js';

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
// Natural Earth abbreviates the smaller names ("S. Geo. and the Is."); spell them out.
const FULL_NAMES = {
  'S. Sudan': 'South Sudan', 'W. Sahara': 'Western Sahara', 'Dem. Rep. Congo': 'Democratic Republic of the Congo',
  'St-Martin': 'Saint Martin', 'Central African Rep.': 'Central African Republic', 'Dominican Rep.': 'Dominican Republic',
  'Bosnia and Herz.': 'Bosnia and Herzegovina', 'Eq. Guinea': 'Equatorial Guinea', 'N. Cyprus': 'Northern Cyprus',
  'Cyprus U.N. Buffer Zone': 'Cyprus UN Buffer Zone', 'Turks and Caicos Is.': 'Turks and Caicos Islands',
  'St. Pierre and Miquelon': 'Saint Pierre and Miquelon', 'Pitcairn Is.': 'Pitcairn Islands', 'Fr. Polynesia': 'French Polynesia',
  'Fr. S. Antarctic Lands': 'French Southern and Antarctic Lands', 'Marshall Is.': 'Marshall Islands',
  'St. Vin. and Gren.': 'Saint Vincent and the Grenadines', 'U.S. Minor Outlying Is.': 'US Minor Outlying Islands',
  'Antigua and Barb.': 'Antigua and Barbuda', 'St. Kitts and Nevis': 'Saint Kitts and Nevis', 'St-Barthélemy': 'Saint Barthélemy',
  'U.S. Virgin Is.': 'US Virgin Islands', 'British Virgin Is.': 'British Virgin Islands', 'Cayman Is.': 'Cayman Islands',
  'Heard I. and McDonald Is.': 'Heard Island and McDonald Islands', 'Faeroe Is.': 'Faroe Islands',
  'Indian Ocean Ter.': 'Australian Indian Ocean Territories', 'Br. Indian Ocean Ter.': 'British Indian Ocean Territory',
  'Cook Is.': 'Cook Islands', 'Wallis and Futuna Is.': 'Wallis and Futuna', 'Solomon Is.': 'Solomon Islands',
  'S. Geo. and the Is.': 'South Georgia and the South Sandwich Islands', 'Falkland Is.': 'Falkland Islands',
  'N. Mariana Is.': 'Northern Mariana Islands', 'Coral Sea Is.': 'Coral Sea Islands', 'Spratly Is.': 'Spratly Islands',
  'Clipperton I.': 'Clipperton Island', 'Ashmore and Cartier Is.': 'Ashmore and Cartier Islands',
  'Dem. Rep. Korea': 'North Korea', 'eSwatini': 'Eswatini',
};
const fullName = (f) => FULL_NAMES[f.properties.name] || f.properties.name;
const names = ['Open ocean', ...features.map(fullName)];
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
  // Cover every row down to the pole: the ring closes just above it, and the last row or two
  // were coming out as "water", which made the South Pole itself an open-ocean cell.
  const y0 = Math.max(0, Math.floor(yMin)), y1 = height - 1;
  const rows = y1 - y0 + 1;
  const mask = new Uint8Array(rows * width);
  const xs = [];
  for (let row = 0; row < rows; row++) {
    const yc = y0 + row + 0.5;
    if (yc > yMax) { mask.fill(1, row * width, (row + 1) * width); continue; }
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
  // The coast run ends a few degrees short of a full circle (the artificial edge fills the
  // gap in the data). Bridge to the start point shifted by 360° so the ring covers all
  // longitudes, then close along the pole — otherwise a thin water wedge shows at the seam.
  const first = u[0], last = u[u.length - 1];
  const wrapLon = first[0] + (last[0] > first[0] ? 360 : -360);
  return [...u, [wrapLon, first[1]], [wrapLon, POLE_LAT], [first[0], POLE_LAT]];
}

// Colour per country for the globe texture and the chart: spread hues, muted.
// Colours: a graph colouring over land borders (topojson.neighbors = polygons sharing an
// arc), so no two countries that touch get the same or a similar hue. 24 swatches: 12 hues in
// two lightness/saturation variants; each country takes the swatch furthest in hue from every
// neighbour already coloured (neighbours with the most borders are coloured first).
const HUES = [0, 30, 55, 85, 120, 160, 190, 210, 240, 270, 300, 330];
const SWATCHES = [];
for (const h of HUES) SWATCHES.push({ h, css: `hsl(${h}, 46%, 58%)` });
for (const h of HUES) SWATCHES.push({ h, css: `hsl(${(h + 15) % 360}, 34%, 46%)` });
const palette = (() => {
  const geoms = topo.objects.countries.geometries;
  const nb = topojson.neighbors(geoms);              // index-aligned with `features`
  const order = geoms.map((_, i) => i).sort((a, b) => nb[b].length - nb[a].length || a - b);
  const pick = new Array(geoms.length).fill(-1);
  const hueGap = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };
  for (const i of order) {
    const used = nb[i].filter((j) => pick[j] >= 0).map((j) => SWATCHES[pick[j]]);
    let best = -1, bestScore = -Infinity;
    SWATCHES.forEach((sw, k) => {
      // Score: distance in hue from the nearest neighbour's colour; a small deterministic
      // spread (i * 7) breaks ties so unconnected countries don't all pick the same swatch.
      const gap = used.length ? Math.min(...used.map((u) => hueGap(u.h, sw.h))) : 999;
      const score = gap * 10 - ((k + i * 7) % SWATCHES.length) * 0.01 - used.some((u) => u.css === sw.css) * 1000;
      if (score > bestScore) { bestScore = score; best = k; }
    });
    pick[i] = best;
  }
  return ['#9aa3b2', ...pick.map((k) => SWATCHES[k].css)];
})();

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
      // Islands smaller than a cell (Tristan da Cunha, Bermuda, Easter Island, St Helena…) only
      // produce anti-aliased edge pixels, which the checksum then throws away — so they vanished
      // entirely. Stamp such polygons' vertex cells directly (integer fillRect = no anti-aliasing).
      const outer = poly.rings[0];
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const [lon, lat] of outer) {
        const x = ((lon + 180) / 360 * W + dx) * sx, y = (90 - lat) / 180 * H * sx;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      if (x1 - x0 < 3 * sx && y1 - y0 < 3 * sx) {
        // Small (under ~30 km): one cell at the centroid, so it exists without being inflated
        // into a blob of vertex cells (Kinmen was rendering as a cluster of squares).
        let a = 0, cx = 0, cy = 0;
        for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
          const [lx0, ly0] = outer[j], [lx1, ly1] = outer[i];
          const cr = lx0 * ly1 - lx1 * ly0;
          a += cr; cx += (lx0 + lx1) * cr; cy += (ly0 + ly1) * cr;
        }
        const [lon, lat] = Math.abs(a) > 1e-12 ? [cx / (3 * a), cy / (3 * a)] : outer[0];
        const x = ((lon + 180) / 360 * W + dx) * sx, y = (90 - lat) / 180 * H * sx;
        ctx.fillRect(Math.floor(x), Math.floor(y), sx, sx);
      } else if (x1 - x0 < 4 * sx || y1 - y0 < 4 * sx) {
        // Long but thin (atolls, barrier islands): stamp the vertex cells so it is not lost.
        for (const [lon, lat] of outer) {
          const x = ((lon + 180) / 360 * W + dx) * sx, y = (90 - lat) / 180 * H * sx;
          ctx.fillRect(Math.floor(x), Math.floor(y), sx, sx);
        }
      }
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

// Walk one bearing to the first land cell, ignoring `skipId` (the home country in 'any' mode).
// With `block`, land within BLOCK_KM returns null = "land in view".
function march(lat, lon, bearing, skipId = 0, block = true, landOnly = false) {
  const p1 = lat * DEG, l1 = lon * DEG, th = bearing * DEG;
  const sp1 = Math.sin(p1), cp1 = Math.cos(p1), sth = Math.sin(th), cth = Math.cos(th);
  for (let d = 3; d <= MAX_KM; d += d < 400 ? 3 : 8) {
    const dl = d / R_EARTH, sd = Math.sin(dl), cd = Math.cos(dl);
    const sp2 = sp1 * cd + cp1 * sd * cth;
    const p2 = Math.asin(sp2);
    const l2 = l1 + Math.atan2(sth * sd * cp1, cd - sp1 * sp2);
    const id = landAt(p2 / DEG, l2 / DEG);
    if (!id) { if (landOnly) return null; continue; }
    if (id === skipId) continue;
    return block && d <= BLOCK_KM ? null : { id, km: d };
  }
  return { id: 0, km: MAX_KM }; // only possible for a country a great circle never leaves — none exist
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
  // Search up to 120 rows (~1,300 km) either way; the longitude span of each row is widened
  // by 1/cos(lat) so the reach is the same distance at every latitude (a full row at the poles).
  const R = 120;
  let best = null, bestD = Infinity;
  for (let dy = -R; dy <= R; dy++) {
    const y = y0 + dy;
    if (y < 0 || y >= H) continue;
    const rowLat = (90 - (y + 0.5) / H * 180) * DEG;
    const hx = Math.min(W >> 1, Math.ceil(R / Math.max(Math.cos(rowLat), 1e-3)));
    for (let dx = -hx; dx <= hx; dx++) {
      if (!isShore(x0 + dx, y)) continue;
      const c = cellCentre(y * W + ((x0 + dx + W) % W));
      const d = distKm({ lat, lon }, c);
      if (d < bestD) { bestD = d; best = y * W + ((x0 + dx + W) % W); }
    }
  }
  return best;
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

// Bearing sampling step in degrees (1, 0.5 or 0.25). Finer steps catch narrower distant
// targets at proportionally more compute.
// Bearing sampling. Fixed at 0.25° (1,440 bearings): a pick still takes ~40 ms on a phone, so the
// coarser 1°/0.5° options that used to be offered were dropped (2026-08-31).
const STEP = 0.25;
// Mode: 'coast' snaps to the water's edge and walks to the first land (blank where land is in
// view); 'any' starts from the exact point, on land or sea, and walks to the first land that is
// not the country you are standing in.
// 'land' is like 'any' but only walks over land: the sea blocks the bearing.
const MODES = ['coast', 'any', 'land'];
let MODE = 'coast';
try { const m = localStorage.getItem('nl-mode'); if (MODES.includes(m)) MODE = m; } catch (e) { /* ignore */ }
{ const m = new URLSearchParams(location.search).get('mode'); if (MODES.includes(m)) MODE = m; }
const runWidth = (run) => run.count * STEP;                       // degrees
const fmtDeg = (d) => `${Number.isInteger(d) ? d : +d.toFixed(2)}°`;

function analyze(lat, lon) {
  let at, home, skip = 0, block = true, landOnly = false;
  if (MODE === 'coast') {
    const p = snapToShore(lat, lon);
    if (p === null) return null;
    at = cellCentre(p);
    home = homeCountry(p);
  } else {
    lat = Math.max(-89.9, Math.min(89.9, lat)); // at the pole itself every bearing is "south"
    at = { lat, lon };
    home = landAt(lat, lon);      // 0 at sea
    skip = home;
    block = false;
    landOnly = MODE === 'land';
  }
  const antipode = { lat: -at.lat, lon: ((at.lon + 360) % 360) - 180 };
  antipode.id = landAt(antipode.lat, antipode.lon);
  const N = Math.round(360 / STEP);
  const view = new Array(N);
  for (let i = 0; i < N; i++) view[i] = march(at.lat, at.lon, i * STEP, skip, block, landOnly);
  // Contiguous runs of the same destination. start/end are bearings in degrees; count is
  // the number of samples in the run.
  const runs = [];
  for (let i = 0; i < N; i++) {
    const v = view[i];
    if (!v) continue;
    const last = runs[runs.length - 1];
    if (last && last.id === v.id && last.endI === i - 1) { last.endI = i; last.count++; last.km = Math.min(last.km, v.km); }
    else runs.push({ id: v.id, startI: i, endI: i, count: 1, km: v.km, wrap: false });
  }
  // Join a run that wraps through north, then order clockwise from north (the wrapping run
  // contains north, so it goes first).
  if (runs.length > 1 && runs[0].startI === 0 && runs[runs.length - 1].endI === N - 1 && runs[0].id === runs[runs.length - 1].id) {
    const last = runs.pop();
    runs[0].startI = last.startI; runs[0].count += last.count; runs[0].wrap = true; runs[0].km = Math.min(runs[0].km, last.km);
  }
  for (const r of runs) { r.start = r.startI * STEP; r.end = r.endI * STEP; }
  runs.sort((a, b) => (a.wrap ? -1 : a.start) - (b.wrap ? -1 : b.start));
  runs.forEach((r, i) => { r.i = i; });
  return { at, home, antipode, view, runs, step: STEP, mode: MODE };
}

// ---------------------------------------------------------------- globe

const canvas = $('#globe');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0f1a);
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
camera.position.set(2.9, 0, 0); // facing 0°N 0°E (toVec(0, 0) is the +x axis)
// Free "trackball" rotation instead of OrbitControls: OrbitControls keeps the camera's up
// vector fixed and clamps at the poles, so you could never roll the globe over the top to
// follow a path across the Arctic. Here a drag rotates the camera (and its up vector) about
// screen axes, so every direction is the same and the poles are ordinary places.
// Mouse: left = pick, right-drag = rotate, wheel/middle-drag = zoom. Touch: one finger
// rotates, two fingers pinch-zoom; a tap without movement picks.
class Trackball {
  constructor(cam, dom) {
    this.camera = cam; this.dom = dom;
    this.minDistance = 1.15; this.maxDistance = 6; this.rotateSpeed = 0.6; this.damping = 0.85;
    this.vel = [0, 0]; this.dragging = false; this.pointers = new Map(); this.pinch = 0;
    dom.style.touchAction = 'none';
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    dom.addEventListener('pointerdown', (e) => {
      this.pointers.set(e.pointerId, [e.clientX, e.clientY]);
      const rotates = e.pointerType === 'touch' ? this.pointers.size === 1 : e.button === 2;
      if (rotates) { this.dragging = true; this.vel = [0, 0]; }
      if (e.pointerType !== 'touch' && e.button === 1) this.dolly = true;
      if (this.pointers.size === 2) { this.dragging = false; this.pinch = this.span(); }
      dom.setPointerCapture(e.pointerId);
    });
    dom.addEventListener('pointermove', (e) => {
      const prev = this.pointers.get(e.pointerId);
      if (!prev) return;
      const dx = e.clientX - prev[0], dy = e.clientY - prev[1];
      this.pointers.set(e.pointerId, [e.clientX, e.clientY]);
      if (this.pointers.size === 2) {
        const s = this.span();
        if (this.pinch) this.zoom(this.pinch / s);
        this.pinch = s;
      } else if (this.dragging) {
        this.rotate(dx, dy); this.vel = [dx, dy];
      } else if (this.dolly) {
        this.zoom(Math.pow(1.01, dy));
      }
    });
    const end = (e) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = 0;
      if (this.pointers.size === 0) { this.dragging = false; this.dolly = false; }
    };
    dom.addEventListener('pointerup', end); dom.addEventListener('pointercancel', end);
    dom.addEventListener('wheel', (e) => { e.preventDefault(); this.zoom(Math.pow(1.001, e.deltaY)); }, { passive: false });
  }
  span() { const p = [...this.pointers.values()]; return Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]) || 1; }
  zoom(f) {
    const d = Math.min(this.maxDistance, Math.max(this.minDistance, this.camera.position.length() * f));
    this.camera.position.setLength(d);
  }
  // dx, dy in pixels: rotate about the screen's vertical and horizontal axes.
  rotate(dx, dy) {
    const cam = this.camera, k = 2 * Math.PI * this.rotateSpeed / this.dom.clientHeight;
    // Screen-right for a camera at `position` looking at the origin is up × position.
    const right = new THREE.Vector3().crossVectors(cam.up, cam.position).normalize();
    // Drag right: the globe follows the pointer, so the camera swings left (about up).
    // Drag down: the globe rolls down, so the camera swings up over the top (about right).
    // Away from the poles a horizontal drag spins about the Earth's axis (so latitude holds
    // and north stays up, like an orbit); close to a pole it blends into a free spin about
    // the screen's vertical so the globe can roll straight over the top.
    const w = this.polarWeight();
    const axisY = new THREE.Vector3(0, cam.up.y >= 0 ? 1 : -1, 0);
    const yaw = axisY.lerp(cam.up, w).normalize();
    const q = new THREE.Quaternion().setFromAxisAngle(yaw, -dx * k)
      .multiply(new THREE.Quaternion().setFromAxisAngle(right, -dy * k));
    cam.position.applyQuaternion(q);
    cam.up.applyQuaternion(q);
    this.orthonormalise();
  }
  // 0 below 75° latitude, 1 above 88°: how much of the free-trackball behaviour applies.
  polarWeight() {
    const n = this.camera.position.clone().normalize();
    const lat = Math.abs(Math.asin(Math.max(-1, Math.min(1, n.y)))) / DEG;
    return Math.max(0, Math.min(1, (lat - 75) / 13));
  }
  // Bring north back to the top of the screen. Only runs between interactions (levelling
  // during a drag would keep steering "up" towards the pole, so you could never cross it),
  // and only away from the poles, easing the roll out over a few frames.
  level(rate) {
    const cam = this.camera;
    if (this.polarWeight() >= 1) return;
    const n = cam.position.clone().normalize();
    const north = new THREE.Vector3(0, 1, 0).addScaledVector(n, -n.y);
    if (north.lengthSq() < 1e-8) return;
    north.normalize();
    let roll = Math.atan2(new THREE.Vector3().crossVectors(north, cam.up).dot(n), north.dot(cam.up));
    if (Math.abs(roll) < 1e-4) return;
    if (Math.abs(roll) > Math.PI - 0.01) roll = Math.PI - 0.01; // exactly upside down: pick a way round
    cam.up.copy(north).applyAxisAngle(n, roll * (1 - rate));
    cam.lookAt(0, 0, 0);
  }
  orthonormalise() {
    const cam = this.camera, n = cam.position.clone().normalize();
    cam.up.addScaledVector(n, -cam.up.dot(n)).normalize();
    cam.lookAt(0, 0, 0);
  }
  // Point the camera at a place; keep north roughly up on screen.
  lookFrom(v) {
    const cam = this.camera;
    cam.position.copy(v);
    const n = v.clone().normalize();
    cam.up.set(0, 1, 0).addScaledVector(n, -n.y);
    if (cam.up.lengthSq() < 1e-6) cam.up.set(1, 0, 0).addScaledVector(n, -n.x);
    this.orthonormalise();
  }
  update() {
    if (this.dragging) return;
    if (Math.abs(this.vel[0]) >= 0.05 || Math.abs(this.vel[1]) >= 0.05) {
      this.vel[0] *= this.damping; this.vel[1] *= this.damping;
      this.rotate(this.vel[0], this.vel[1]);
      return; // let the glide finish on its own path before levelling
    }
    this.level(0.12);
  }
}
const controls = new Trackball(camera, canvas);
controls.lookFrom(camera.position.clone());

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

// ------------------------------------------------------------------ display layers
// 'political' is the generated per-country texture above; 'terrain' is Natural Earth I
// (1:50m, public domain) pre-resized to data/ne1-8192.jpg / ne1-4096.jpg. Cosmetic only:
// the analysis raster, borders, labels and paths are unaffected. Fetched on first use;
// the service worker then keeps it cache-first like other images.
const LAYERS = ['political', 'terrain'];
let LAYER = 'political';
try { const l = localStorage.getItem('nl-layer'); if (LAYERS.includes(l)) LAYER = l; } catch (e) { /* ignore */ }
let terrainTex = null, terrainPromise = null;
// 16384 (11 MB, ~2.4 km/px) only where the GPU and memory clearly allow it; the political
// canvas texture stays at TEX_W regardless.
const TERRAIN_URL = `data/ne1-${TEX_W >= 8192
  ? (renderer.capabilities.maxTextureSize >= 16384 && (navigator.deviceMemory === undefined || navigator.deviceMemory >= 8) && !lowMem ? 16384 : 8192)
  : 4096}.jpg`;
// Byte-counted download (so the loading bar can track it), abortable via `signal`.
// Memoised: concurrent callers share one download; a failure or abort clears it for retry.
function ensureTerrain(onPct, signal) {
  if (terrainTex) return Promise.resolve();
  if (!terrainPromise) {
    terrainPromise = (async () => {
      const resp = await fetch(TERRAIN_URL, { signal });
      const total = Number(resp.headers.get('content-length')) || 11e6;
      const reader = resp.body.getReader();
      const chunks = []; let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); got += value.length;
        if (onPct) onPct(Math.min(1, got / total));
      }
      // Decode via createImageBitmap, not an <img> with a blob: URL - the CSP's
      // img-src 'self' data: blocks blob: loads, but bitmap decoding is not a resource load.
      // flipY is baked in at decode (three.js ignores .flipY for ImageBitmaps).
      const bitmap = await createImageBitmap(new Blob(chunks, { type: 'image/jpeg' }), { imageOrientation: 'flipY' });
      terrainTex = new THREE.Texture(bitmap);
      terrainTex.flipY = false;
      terrainTex.colorSpace = THREE.SRGBColorSpace;
      terrainTex.anisotropy = maxAniso;
      terrainTex.generateMipmaps = texture.generateMipmaps;
      terrainTex.minFilter = texture.minFilter;
      terrainTex.needsUpdate = true;
    })().catch((e) => { terrainPromise = null; throw e; });
  }
  return terrainPromise;
}
async function applyLayer(onPct, signal) {
  let map = texture;
  if (LAYER === 'terrain') {
    try { await ensureTerrain(onPct, signal); } catch (e) { return false; } // offline or aborted: stay political
    if (LAYER !== 'terrain') return true; // switched back while downloading
    map = terrainTex;
  }
  if (globe.material.map !== map) { globe.material.map = map; globe.material.needsUpdate = true; }
  return true;
}
const layerSel = $('#layer');
// The shareable URL: the picked point plus any non-default mode and map layer.
let lastAt = null;
function writeUrl() {
  if (!lastAt) return;
  history.replaceState(null, '', `?at=${lastAt}${MODE !== 'coast' ? `&mode=${MODE}` : ''}${LAYER !== 'political' ? `&layer=${LAYER}` : ''}`);
}
const layerStatus = $('#layerStatus');
function setLayer(layer) {
  if (!LAYERS.includes(layer)) return;
  LAYER = layer;
  layerSel.value = layer;
  try { localStorage.setItem('nl-layer', layer); } catch (e) { /* ignore */ }
  writeUrl();
  refreshLayer();
}
// Runtime layer switch: show download progress beside the selector while the terrain image
// arrives (the first switch costs a few seconds; after that it is cached and instant).
async function refreshLayer() {
  if (LAYER === 'terrain' && !terrainTex) {
    layerStatus.textContent = '0%';
    const ok = await applyLayer((f) => { layerStatus.textContent = `${Math.round(f * 100)}%`; });
    layerStatus.textContent = '';
    if (!ok && LAYER === 'terrain') setLayer('political'); // offline: fall back visibly
    return;
  }
  applyLayer();
}
layerSel.value = LAYER;
layerSel.addEventListener('change', () => setLayer(layerSel.value));
{ const l = new URLSearchParams(location.search).get('layer'); if (LAYERS.includes(l)) { LAYER = l; layerSel.value = l; } }
// When terrain is the saved layer, its download is folded into the initial loading bar (with a
// skip button) at the end of startup, so the political colours never flash first.
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
  d.textContent = fullName(f);
  d.hidden = true;
  labelsBox.appendChild(d);
  return { el: d, v: toVec(labelInfo[i].lat, labelInfo[i].lon, 1.0), area: labelInfo[i].area, w: fullName(f).length * 6.4 + 10 };
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
  // Clicking the marker itself clears the pick, same as clicking off the globe.
  if (marker.visible && raycaster.intersectObject(marker).length) { clearPick(); return; }
  const hit = raycaster.intersectObject(globe)[0];
  if (!hit) { clearPick(); return; } // clicked off the globe: clear the selection
  const { lat, lon } = fromVec(hit.point);
  if (puzzle.active) { puzzleGuess(lat, lon); return; }
  $('#jump').value = '';
  pick(lat, lon);
});

// A Coast-mode pick with no shore within reach (mid-ocean, or a point in open sea): drop the
// previous result instead of leaving it on screen under the wrong place name.
function noCoast() {
  clearPick();
  const place = $('#place');
  place.replaceChildren();
  const hint = document.createElement('p'); hint.className = 'hint';
  hint.textContent = 'No coastline within reach of that point. Pick closer to a shore, or switch the mode to Anywhere.';
  place.appendChild(hint);
}
function clearPick() {
  if (!marker.visible) return;
  marker.visible = antiMarker.visible = false;
  linesGroup.clear();
  svg.replaceChildren();
  $('#legend').replaceChildren();
  $('#legendCount').textContent = '';
  hlRun = -1;
  lastPick = null;
  const place = $('#place');
  place.replaceChildren();
  const hint = document.createElement('p'); hint.className = 'hint';
  hint.textContent = 'Nothing picked. Click the globe - a coastline in Coast mode, any point on land or sea in Anywhere or Over land - or try one of the places under it.';
  place.appendChild(hint);
  lastAt = null;
  history.replaceState(null, '', location.pathname);
  $('#jump').value = '';
  $('#viewLink').disabled = true;
  $('#viewLink').title = 'Pick a point first';
  $('#viewLinkStatus').textContent = '';
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
      const idx = Math.round(run.startI + (run.count - 1) * (k / n)) % res.view.length;
      const b = idx * res.step;
      const v = res.view[idx];
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
const bearingLabel = (run) => (run.start === run.end ? fmtDeg(run.start) : `${fmtDeg(run.start)}–${fmtDeg(run.end)}`);

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

function drawChart(res, target = svg) {
  target.replaceChildren();
  target.setAttribute('viewBox', '-14 -14 388 388'); // margin so the N/E/S/W letters are not clipped
  const cx = 180, cy = 180, r0 = 46, r1 = 160;
  for (const run of res.runs) {
    const a0 = run.start - res.step / 2, a1 = (run.wrap ? run.end + 360 : run.end) + res.step / 2;
    const path = el('path', { d: wedgePath(cx, cy, r0, r1, a0, a1), fill: palette[run.id], class: 'wedge', 'data-run': run.i });
    path.appendChild(el('title', {}, `${names[run.id]} · ${bearingLabel(run)} · nearest ${fmtKm(run.km)}`));
    if (target === svg) {
      path.addEventListener('pointerenter', () => highlightRun(run.i));
      path.addEventListener('pointerleave', () => highlightRun(-1));
    }
    target.appendChild(path);
  }
  target.appendChild(el('circle', { cx, cy, r: r1, class: 'ring' }));
  target.appendChild(el('circle', { cx, cy, r: r0, class: 'ring' }));
  for (let a = 0; a < 360; a += 30) {
    const s = Math.sin(a * DEG), c = Math.cos(a * DEG);
    target.appendChild(el('line', { x1: cx + (r1 + 3) * s, y1: cy - (r1 + 3) * c, x2: cx + (r1 + 9) * s, y2: cy - (r1 + 9) * c, class: 'tick' }));
  }
  for (const [a, t] of [[0, 'N'], [90, 'E'], [180, 'S'], [270, 'W']]) {
    target.appendChild(el('text', { x: cx + (r1 + 17) * Math.sin(a * DEG), y: cy - (r1 + 17) * Math.cos(a * DEG) + 4, class: 'tick-label' }, t));
  }
  target.appendChild(el('circle', { cx, cy, r: 5, class: 'you' }));
}

function drawLegend(res) {
  const legend = $('#legend');
  legend.replaceChildren();
  const unique = new Set(res.runs.map((r) => r.id)).size;
  $('#legendCount').textContent = res.runs.length
    ? `- ${unique} ${unique === 1 ? 'country' : 'countries'}, ${res.runs.length} ${res.runs.length === 1 ? 'sector' : 'sectors'}`
    : '';
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
    rg.textContent = `${bearingLabel(run)} · ${fmtDeg(runWidth(run))}`;
    li.append(sw, name, rg);
    li.addEventListener('pointerenter', () => highlightRun(run.i));
    li.addEventListener('pointerleave', () => highlightRun(-1));
    legend.appendChild(li);
  }
  const blocked = res.view.filter((v) => !v).length * res.step;
  if (!blocked) return;
  const li = document.createElement('li');
  li.className = 'blocked';
  const sw = document.createElement('span'); sw.className = 'swatch'; sw.style.border = '1px dashed #4b5563';
  const name = document.createElement('span'); name.textContent = res.mode === 'land' ? `Sea in the way for the other ${fmtDeg(blocked)} - blank on the chart` : `Land in view for the other ${fmtDeg(blocked)} - blank on the chart`;
  li.append(sw, name, document.createElement('span'));
  legend.appendChild(li);
}

let lastPick = null;
function pick(lat, lon) {
  const t0 = performance.now();
  const res = analyze(lat, lon);
  if (!res) { noCoast(); return null; }
  marker.position.copy(toVec(res.at.lat, res.at.lon, 1.008));
  marker.visible = true;
  antiMarker.position.copy(toVec(res.antipode.lat, res.antipode.lon, 1.009));
  antiMarker.lookAt(0, 0, 0);
  antiMarker.visible = true;
  hlRun = -1;
  drawLines(res);
  drawChart(res);
  drawLegend(res);
  const open = res.view.filter((v) => v).length * res.step;
  lastPick = { lat, lon };
  const place = $('#place');
  place.replaceChildren();
  const nm = document.createElement('p'); nm.className = 'name';
  nm.textContent = res.mode === 'any'
    ? `${res.home ? names[res.home] : 'At sea'} - next country in every direction`
    : res.mode === 'land'
      ? (res.home ? `${names[res.home]} - ${fmtDeg(open)} reaches another country over land` : 'At sea - nothing to reach over land')
      : `${names[res.home]} - ${fmtDeg(open)} of open water`;
  const co = document.createElement('p'); co.className = 'coords';
  co.textContent = `${Math.abs(res.at.lat).toFixed(2)}°${res.at.lat >= 0 ? 'N' : 'S'}, ${Math.abs(res.at.lon).toFixed(2)}°${res.at.lon >= 0 ? 'E' : 'W'} · computed in ${Math.round(performance.now() - t0)} ms`;
  place.append(nm, co);
  $('#viewLink').disabled = false;
  $('#viewLink').title = 'Copy or share a link to this view';
  $('#viewLinkStatus').textContent = '';
  // The address bar always holds a link to exactly this view.
  lastAt = `${res.at.lat.toFixed(3)},${res.at.lon.toFixed(3)}`;
  writeUrl();
  // On a stacked (phone) layout the results are below the globe — bring them into view.
  if (window.innerWidth < 860) document.querySelector('.panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  return res;
}

function flyTo(lat, lon) {
  controls.lookFrom(toVec(lat, lon, camera.position.length()));
}

async function shareView() {
  const url = location.href;
  const status = $('#viewLinkStatus');
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
  const q = new URLSearchParams(location.search);
  if (MODES.includes(q.get('mode'))) setMode(q.get('mode'));
  const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(q.get('at') || '');
  if (!m) return false;
  const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
  pick(lat, lon);
  flyTo(lat, lon);
  return true;
}

$('#viewLink').addEventListener('click', shareView);

// Option values are "lat,lon" or "lat,lon,mode": records carry the mode they were computed in.
const modeSel = $('#mode');
modeSel.value = MODE;
const compassModeSel = $('#compassMode');
function setMode(mode) {
  if (!MODES.includes(mode)) return;
  MODE = mode;
  modeSel.value = mode;
  compassModeSel.value = mode;
  try { localStorage.setItem('nl-mode', mode); } catch (e) { /* ignore */ }
}
// The mode selector inside Show Me: switch modes without leaving the compass. The globe view
// behind follows (same as the main selector), and the compass re-reads the new analysis.
compassModeSel.addEventListener('change', () => {
  setMode(compassModeSel.value);
  if (lastPick) pick(lastPick.lat, lastPick.lon);
  if (compassAnalyse()) startHeading();   // no-op if already listening
  if (compass.heading !== null) updateCompass();
});
modeSel.addEventListener('change', () => {
  setMode(modeSel.value);
  if (lastPick) pick(lastPick.lat, lastPick.lon);
});

$('#jump').addEventListener('change', (e) => {
  const parts = e.target.value.split(',');
  const [lat, lon] = parts.map(parseFloat);
  if (Number.isNaN(lat) || Number.isNaN(lon)) return;
  // Records force the mode they were computed in; the Classics are coast views, so they force Coast.
  setMode(MODES.includes(parts[2]) ? parts[2] : 'coast');
  pick(lat, lon);
  flyTo(lat, lon);
});

// ---------------------------------------------------------------- device location

// ---------------------------------------------------------------- device location + compass
//
// The button exists only on devices that can give both a position and a compass heading:
// iOS (DeviceOrientationEvent.requestPermission) or Android-style absolute orientation on a
// touch device. It reads "Request Location" until a fix arrives, then "Show Me", which opens
// the compass panel. The blue dot still appears automatically when permission is already
// granted, button or not.
const locateBtn = $('#locate');
const hasGeo = !!navigator.geolocation;
const iosCompass = typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function';
const absCompass = 'ondeviceorientationabsolute' in window && navigator.maxTouchPoints > 0;
const directionCapable = iosCompass || absCompass;
let gpsPos = null;
if (hasGeo && directionCapable) locateBtn.hidden = false;

function showGps(lat, lon) {
  gpsPos = { lat, lon };
  gpsDot.position.copy(toVec(lat, lon, 1.008));
  gpsRing.position.copy(toVec(lat, lon, 1.009));
  gpsRing.lookAt(0, 0, 0);
  gpsDot.visible = gpsRing.visible = true;
  locateBtn.classList.add('on');
  locateBtn.textContent = 'Show Me';
  locateBtn.title = 'Point your phone at the sea and see which country is in front of you';
}
function requestGps(fly) {
  if (!hasGeo) return;
  locateBtn.textContent = 'Locating…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      showGps(pos.coords.latitude, pos.coords.longitude);
      if (fly) flyTo(pos.coords.latitude, pos.coords.longitude);
      // In Anywhere / Over-land mode the user's own position is a valid pick: pin it straight away.
      if (fly && MODE !== 'coast') pick(pos.coords.latitude, pos.coords.longitude);
    },
    () => { locateBtn.textContent = 'Location unavailable'; },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 120000 }
  );
}
locateBtn.addEventListener('click', () => {
  if (gpsPos) openCompass();
  else requestGps(true);
});

// Haversine distance in km.
function distKm(a, b) {
  const dLat = (b.lat - a.lat) * DEG, dLon = (b.lon - a.lon) * DEG;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(h));
}

const compass = {
  el: $('#compass'), dial: $('#compassDial'), ring: $('#compassRing'), headingEl: $('#compassHeading'),
  countryEl: $('#compassCountry'), noteEl: $('#compassNote'),
  res: null, heading: null, listener: null, eventName: null, timer: null,
};
{ // tick marks every 10°, longer every 30°
  const g = document.getElementById('compassTicks');
  for (let a = 0; a < 360; a += 10) {
    if (a % 90 === 0) continue;
    const len = a % 30 === 0 ? 10 : 5;
    const t = document.createElementNS(NS, 'line');
    const r0 = 92 - len, r1 = 92, rad = a * DEG;
    t.setAttribute('x1', 100 + r0 * Math.sin(rad)); t.setAttribute('y1', 100 - r0 * Math.cos(rad));
    t.setAttribute('x2', 100 + r1 * Math.sin(rad)); t.setAttribute('y2', 100 - r1 * Math.cos(rad));
    t.setAttribute('class', 'tick');
    g.appendChild(t);
  }
}

// Analyse the user's position for the compass and set the dial/notes. Returns false when the
// current mode has nothing to show here (Coast mode, far from any shore).
function compassAnalyse() {
  const res = analyze(gpsPos.lat, gpsPos.lon);
  compass.res = res;
  const shoreKm = res ? distKm(gpsPos, res.at) : Infinity;
  if (res && MODE !== 'coast') {
    compass.dial.classList.remove('noarrow');
    compass.countryEl.textContent = 'Turn to face any direction';
    compass.noteEl.textContent = res.home ? `Standing in ${names[res.home]}. The next country on each bearing${MODE === 'land' ? ', over land only' : ''}.` : 'At sea. The first land on each bearing.';
    return true;
  }
  if (!res || shoreKm > 30) {
    compass.dial.classList.add('noarrow');
    compass.countryEl.textContent = 'You need to be near the water';
    compass.noteEl.textContent = res ? `The nearest shore is about ${Math.round(shoreKm)} km away. Get within sight of the sea and try again.` : 'No coastline found near you.';
    return false;
  }
  compass.dial.classList.remove('noarrow');
  compass.countryEl.textContent = 'Point your phone at the sea';
  compass.noteEl.textContent = shoreKm > 15 ? `Using the ${names[res.home]} shore about ${Math.round(shoreKm)} km from you. Turn slowly.` : `Standing at the ${names[res.home]} shore. Turn slowly.`;
  return true;
}
async function openCompass() {
  compass.heading = null; compass.rot = 0;
  compass.el.hidden = false;
  compass.headingEl.textContent = '-';
  compassModeSel.value = MODE;
  if (!compassAnalyse()) return; // heading starts on a later mode switch if needed
  await startHeading();
}

// Attach the device-orientation listener (asking iOS for permission - must be inside a user
// gesture, which both the Show Me tap and a mode-select change are).
async function startHeading() {
  if (compass.listener) return;
  // Heading source: iOS needs permission inside this tap; Android gives absolute alpha.
  if (iosCompass) {
    try {
      const state = await DeviceOrientationEvent.requestPermission();
      if (state !== 'granted') { compass.noteEl.textContent = 'Compass permission was not granted - allow Motion & Orientation access and try again.'; return; }
    } catch (e) { compass.noteEl.textContent = 'Compass permission was not granted.'; return; }
    compass.eventName = 'deviceorientation';
  } else {
    compass.eventName = 'deviceorientationabsolute';
  }
  compass.listener = onOrientation;
  window.addEventListener(compass.eventName, compass.listener);
  clearTimeout(compass.timer);
  compass.timer = setTimeout(() => {
    if (compass.heading === null) compass.noteEl.textContent = 'No compass reading yet - move the phone in a figure of eight to calibrate, and make sure location and motion access are allowed.';
  }, 4000);
}

function onOrientation(e) {
  let h = null;
  if (typeof e.webkitCompassHeading === 'number' && !Number.isNaN(e.webkitCompassHeading)) h = e.webkitCompassHeading;
  else if (e.absolute && typeof e.alpha === 'number') h = (360 - e.alpha) % 360;
  if (h === null) return;
  // Account for landscape rotation of the screen.
  const angle = (screen.orientation && typeof screen.orientation.angle === 'number') ? screen.orientation.angle : (window.orientation || 0);
  h = (h + angle + 360) % 360;
  // Light smoothing across the 0/360 wrap.
  // Smooth, and keep `rot` unwrapped: the ring is rotated by `rot`, so crossing north never
  // animates a full turn the other way (which made the letters appear twice).
  if (compass.heading === null) { compass.heading = h; compass.rot = -h; }
  else { const d = ((h - compass.heading + 540) % 360) - 180; compass.heading = (compass.heading + d * 0.35 + 360) % 360; compass.rot -= d * 0.35; }
  updateCompass();
}

function updateCompass() {
  const h = compass.heading, res = compass.res;
  if (h === null) return;
  compass.ring.style.transform = `rotate(${compass.rot}deg)`;
  compass.headingEl.textContent = `Facing ${Math.round(h)}°`;
  if (!res) return;
  const idx = Math.round(h / res.step) % res.view.length;
  const v = res.view[idx];
  if (!v) { compass.countryEl.textContent = res.mode === 'land' ? 'Sea that way' : 'Land that way'; compass.noteEl.textContent = res.mode === 'land' ? 'No other country over land on this bearing.' : 'Turn towards the water.'; return; }
  compass.countryEl.textContent = names[v.id];
  compass.noteEl.textContent = `${fmtKm(v.km)} ${res.mode === 'any' ? 'away on this bearing' : 'across the water on this bearing'}${v.km > ANTIPODE_KM ? ' (beyond the antipode)' : ''}.`;
}

function closeCompass() {
  compass.el.hidden = true;
  if (compass.listener) window.removeEventListener(compass.eventName, compass.listener);
  compass.listener = null;
  clearTimeout(compass.timer);
}
$('#compassClose').addEventListener('click', closeCompass);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !compass.el.hidden) closeCompass(); });
// Show the blue dot without asking if permission was already granted earlier.
if (navigator.permissions && navigator.permissions.query) {
  navigator.permissions.query({ name: 'geolocation' }).then((p) => { if (p.state === 'granted') requestGps(false); }).catch(() => {});
}

if (LAYER === 'terrain') {
  const skip = $('#skipTerrain');
  const ac = new AbortController();
  skip.hidden = false;
  skip.addEventListener('click', () => { skip.disabled = true; ac.abort(); }, { once: true });
  await progress(90, 'Downloading the terrain map…');
  const ok = await applyLayer((f) => { bar.style.width = `${90 + 9 * f}%`; }, ac.signal);
  if (!ok) setLayer('political');   // skipped or offline: political, and remembered
  skip.hidden = true;
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


// ---------------------------------------------------------------- daily puzzle
// One mystery shore per UTC day, the same for everyone: the day number seeds a PRNG and the
// first candidate whose Coast view shows enough countries is the answer. Deterministic because
// the analysis raster and sampling are identical on every device. Guess by clicking the globe;
// each guess answers with distance and direction, Worldle-style.
const puzzle = {
  el: $('#puzzle'), chart: $('#puzzleChart'), guessesEl: $('#puzzleGuesses'), statusEl: $('#puzzleStatus'),
  shareBtn: $('#puzzleShare'), revealBtn: $('#puzzleReveal'), titleEl: $('#puzzleTitle'),
  boxEl: document.querySelector('.puzzle-box'), miniEl: $('#puzzleMini'),
  active: false, num: 0, answer: null, guesses: [], done: false, won: false,
};
const PUZZLE_EPOCH = Date.UTC(2026, 7, 31);                // puzzle #1 = 31 August 2026
const GUESS_LIMIT = 6, WIN_KM = 100, HALF_EARTH = 20015;
const guessDots = new THREE.Group();
scene.add(guessDots);
guessDots.visible = false;

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function dailyAnswer(num) {
  const rnd = mulberry32(0x9E3779B9 ^ num);
  const saved = MODE;
  try {
    MODE = 'coast';
    for (let i = 0; i < 500; i++) {
      const lat = Math.asin(rnd() * 2 - 1) / DEG, lon = rnd() * 360 - 180;
      if (Math.abs(lat) > 66) continue;                    // skip the polar wastes
      const p = snapToShore(lat, lon);
      if (p === null) continue;
      const at = cellCentre(p);
      const res = analyze(at.lat, at.lon);
      if (!res) continue;
      const ids = new Set(res.runs.map((r) => r.id));
      if (ids.size < 4) continue;                          // enough countries to reason from
      return { at: res.at, res };
    }
  } finally { MODE = saved; }
  return null;
}

function initialBearing(a, b) {
  const p1 = a.lat * DEG, p2 = b.lat * DEG, dl = (b.lon - a.lon) * DEG;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}
const ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖']; // text arrows: emoji ones render oddly outside chat apps
const arrowFor = (b) => ARROWS[Math.round(b / 45) % 8];
function squaresFor(km, won) {
  if (won) return '🟩🟩🟩🟩🟩';
  const green = Math.max(0, Math.min(4, Math.floor((1 - km / HALF_EARTH) * 5)));
  return '🟩'.repeat(green) + '🟨' + '⬛'.repeat(4 - green);
}

function savePuzzle() {
  try { localStorage.setItem('nl-daily-v1', JSON.stringify({ num: puzzle.num, guesses: puzzle.guesses.map((g) => [g.lat, g.lon]) })); } catch (e) { /* ignore */ }
}

function addGuessDot(lat, lon) {
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.01, 12, 8), new THREE.MeshBasicMaterial({ color: 0xef4444 }));
  dot.position.copy(toVec(lat, lon, 1.006));
  guessDots.add(dot);
}

function puzzleGuess(lat, lon) {
  if (puzzle.done || !puzzle.answer) return;
  const km = distKm({ lat, lon }, puzzle.answer.at);
  const g = { lat, lon, km, bearing: initialBearing({ lat, lon }, puzzle.answer.at) };
  puzzle.guesses.push(g);
  addGuessDot(lat, lon);
  if (km <= WIN_KM) { puzzle.done = true; puzzle.won = true; }
  else if (puzzle.guesses.length >= GUESS_LIMIT) puzzle.done = true;
  savePuzzle();
  renderPuzzle();
  // A finished game deserves the full card; mid-game on a phone, stay out of the way.
  if (puzzle.active) setCollapsed(!puzzle.done && window.innerWidth <= 860);
}

function renderPuzzle() {
  puzzle.titleEl.textContent = `Where on Earth? - daily #${puzzle.num}`;
  puzzle.guessesEl.replaceChildren();
  for (const [i, g] of puzzle.guesses.entries()) {
    const li = document.createElement('li');
    const won = g.km <= WIN_KM;
    const sq = document.createElement('span'); sq.className = 'sq'; sq.textContent = squaresFor(g.km, won);
    const txt = document.createElement('span');
    txt.textContent = won ? `${i + 1}. ${fmtKm(g.km)} - found it!` : `${i + 1}. ${fmtKm(g.km)} ${arrowFor(g.bearing)}`;
    li.append(sq, txt);
    puzzle.guessesEl.appendChild(li);
  }
  const left = GUESS_LIMIT - puzzle.guesses.length;
  puzzle.statusEl.textContent = puzzle.done
    ? (puzzle.won ? `Got it in ${puzzle.guesses.length} - new puzzle at midnight UTC.` : 'Out of guesses - reveal below, new puzzle at midnight UTC.')
    : (puzzle.guesses.length ? `${left} ${left === 1 ? 'guess' : 'guesses'} left. The arrow points from your guess towards the answer.` : '');
  puzzle.shareBtn.hidden = puzzle.revealBtn.hidden = !puzzle.done;
  const last = puzzle.guesses[puzzle.guesses.length - 1];
  puzzle.miniEl.textContent = puzzle.done
    ? (puzzle.won ? `Daily #${puzzle.num} solved in ${puzzle.guesses.length}` : `Daily #${puzzle.num} - out of guesses`)
    : (last ? `${fmtKm(last.km)} ${arrowFor(last.bearing)} · ${GUESS_LIMIT - puzzle.guesses.length} left` : `Daily #${puzzle.num} - tap the globe to guess`);
}
function setCollapsed(on) {
  puzzle.boxEl.classList.toggle('collapsed', on);
  puzzle.miniEl.hidden = !on;
}

function openPuzzle() {
  const num = Math.floor((Date.now() - PUZZLE_EPOCH) / 86400000) + 1;
  if (puzzle.num !== num) {
    puzzle.num = num;
    puzzle.answer = dailyAnswer(num);
    puzzle.guesses = []; puzzle.done = false; puzzle.won = false;
    guessDots.clear();
    if (!puzzle.answer) return;                           // should never happen
    drawChart(puzzle.answer.res, puzzle.chart);
    try {                                                  // restore today's earlier guesses
      const st = JSON.parse(localStorage.getItem('nl-daily-v1') || 'null');
      if (st && st.num === num) for (const [lat, lon] of st.guesses.slice(0, GUESS_LIMIT)) puzzleGuess(lat, lon);
    } catch (e) { /* ignore */ }
  }
  clearPick();
  renderPuzzle();
  // On a phone the card would cover the globe: start collapsed after the first guess exists,
  // and auto-collapse there on open so the globe is visible; desktop opens expanded.
  setCollapsed(window.innerWidth <= 860 && puzzle.guesses.length > 0 && !puzzle.done);
  puzzle.active = true;
  puzzle.el.hidden = false;
  guessDots.visible = true;
  document.body.classList.add('puzzle-open');
}
function closePuzzle() {
  puzzle.active = false;
  puzzle.el.hidden = true;
  guessDots.visible = false;
  document.body.classList.remove('puzzle-open');
}
$('#daily').addEventListener('click', openPuzzle);
$('#puzzleClose').addEventListener('click', closePuzzle);
$('#puzzleMin').addEventListener('click', () => setCollapsed(true));
puzzle.miniEl.addEventListener('click', () => setCollapsed(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && puzzle.active) closePuzzle(); });
puzzle.revealBtn.addEventListener('click', () => {
  closePuzzle();
  setMode('coast');
  pick(puzzle.answer.at.lat, puzzle.answer.at.lon);
  flyTo(puzzle.answer.at.lat, puzzle.answer.at.lon);
});
puzzle.shareBtn.addEventListener('click', async () => {
  const rows = puzzle.guesses.map((g) => `${squaresFor(g.km, g.km <= WIN_KM)} ${fmtKm(g.km)}${g.km <= WIN_KM ? '' : ' ' + arrowFor(g.bearing)}`);
  const text = `🌍 nearest.land daily #${puzzle.num} - ${puzzle.won ? puzzle.guesses.length : 'X'}/${GUESS_LIMIT}
${rows.join('\n')}
Guess the shore from what is across its water:
https://nearest.land/`;
  if (navigator.share) { try { await navigator.share({ text }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  try { await navigator.clipboard.writeText(text); puzzle.shareBtn.textContent = 'Copied!'; setTimeout(() => { puzzle.shareBtn.textContent = 'Share result'; }, 1500); } catch (e) { /* ignore */ }
});

window.__ATW = { puzzle: { open: openPuzzle, close: closePuzzle, guess: puzzleGuess, state: () => ({ num: puzzle.num, guesses: puzzle.guesses.map((g) => ({ km: Math.round(g.km) })), done: puzzle.done, won: puzzle.won, answer: puzzle.answer && puzzle.answer.at }) }, controls, snapToShore, cellCentre, setMode, requestGps, analyze, pick, names, landAt, texW: TEX_W, cam: () => camera.position, borders: () => borders, globe, tex: () => texture.image, aniso: maxAniso, mipmaps: texture.generateMipmaps, compass: { open: openCompass, close: closeCompass, state: () => ({ heading: compass.heading, country: compass.countryEl.textContent, note: compass.noteEl.textContent, hidden: compass.el.hidden, noarrow: compass.dial.classList.contains('noarrow') }) }, capable: { hasGeo, directionCapable }, labels: () => labels.filter((l) => !l.el.hidden).map((l) => l.el.textContent), showGps, highlightRun };
