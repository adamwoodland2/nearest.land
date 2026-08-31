# nearest.land

**Live: <https://nearest.land/>**

Click any coastline on a 3D globe and see which country lies across the water in every
direction. Each of 360 compass bearings is followed along a great circle to its first landfall.
Free, runs entirely in your browser, no account, no adverts.

## What it does

- Pick a point on any coast (click, tap, a preset, or your device location). The point snaps to
  the water's edge.
- You get a north-up polar chart: 360 one-degree wedges coloured by the country you'd reach in
  that direction, blank where land is in view. Below it, one row per sector clockwise from
  north with the bearing range and the nearest distance.
- The great-circle paths are drawn on the globe; hover a wedge, a row or a path and the three
  highlight together, with a tooltip giving country, bearing and distance.
- Paths continue past the antipode until they hit land. The antipode itself is marked and
  named.
- Country names on the globe, decluttered by zoom; crisp vector coastlines at any zoom.
- **Share this view** — every pick puts `?at=lat,lon` in the address bar; the Share button uses
  the native share sheet where available, otherwise copies the link.
- **Three modes** — *Coast* (default) snaps to the water's edge and follows each direction across
  the sea; *Anywhere* starts from the exact point, on land or at sea, and follows each direction
  to the first land that isn't the country you're in (from Berlin, east is Poland at 80 km);
  *Over land* is the same but never crosses water.
- **Daily puzzle** - one mystery shore per UTC day, the same for everyone: guess where it is
  from its view alone, six tries, Worldle-style emoji share.
- **Show Me** (phones with a compass) — stand by the sea, tap it, and as you turn the phone the
  panel names the country across the water in the direction you face.

Why great circles: "straight out to sea" on a sphere is not a line of latitude. That is why
parts of the US east coast face Australia and Land's End faces Brazil.

## How it works

All client-side, no backend:

1. Natural Earth 1:10m country polygons (via [world-atlas](https://github.com/topojson/world-atlas),
   public domain, 3.7 MB TopoJSON) are decoded with topojson-client and rasterised onto a
   4096×2048 equirectangular canvas in id-encoded colours, giving a country index at ~10 km
   cells. Canvas anti-aliasing is handled with a checksum channel; antimeridian-crossing
   polygons are unwrapped and drawn at three offsets; the polar cap south of 83.5°S is painted
   as Antarctica because the dataset stops there. Islands smaller than a cell (Tristan da Cunha,
   Bermuda, Easter Island, atolls) are stamped in directly so they are never lost.
2. The clicked point snaps to the nearest water cell touching land.
3. Each bearing is walked along its great circle (3 km steps near the shore, 8 km beyond) until
   the first land cell — a full circle if needed. Land within 20 km counts as "land in view".
   Bearings are sampled every 0.25° (1,440 of them), so a distant island narrower than ~1/230 of
   its distance can fall between two bearings.
4. The globe is [three.js](https://threejs.org/) (vendored in `lib/`): an 8192-wide texture where
   the GPU allows, coastlines and borders as line geometry, HTML labels projected per frame.

The whole analysis takes ~30 ms per pick. Results are inherently approximate — see the
[coastline paradox](https://en.wikipedia.org/wiki/Coastline_paradox), which the page explains.

Installable PWA (`manifest.json`, `sw.js`): the dataset and code are precached, so it works
offline once loaded. Hosted as static files on S3 behind CloudFront with a strict
Content-Security-Policy (`script-src 'self'`).

## Licence

MIT for this project's own code — see [LICENSE](LICENSE). Bundled: three.js (MIT),
topojson-client (ISC), Natural Earth data via world-atlas (public domain / ISC).

Built by Adam Woodland with the assistance of AI (Anthropic Claude).
