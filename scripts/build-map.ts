// Erzeugt eine Spielkarte aus Natural-Earth-Daten (Public Domain).
// Aufruf: npx tsx scripts/build-map.ts <kartenId>
// Ablauf: Admin-1-Regionen -> Nationen von 1914 -> vereinfachte Topologie ->
// Projektion (km) -> feste Provinzzahl je Nation (gewichtetes k-Means + Voronoi) ->
// Nachbarschaften, Küsten, Ressourcen, Doppelprovinzen.

import fs from 'node:fs';
import path from 'node:path';
import * as shapefile from 'shapefile';
import { topology } from 'topojson-server';
import { presimplify, quantile, simplify } from 'topojson-simplify';
import { merge } from 'topojson-client';
import { geoAzimuthalEqualArea } from 'd3-geo';
import { Delaunay } from 'd3-delaunay';
import polygonClipping from 'polygon-clipping';
import type { Feature, Geometry, MultiPolygon as GeoMultiPolygon, Position } from 'geojson';
import type { MapConfig } from './mapconfig.ts';
import type { MapBorder, MapData, MapProvince } from '../src/game/mapdata.ts';
import {
  bboxOf, dist, distSegment, interiorPoint, multiArea, pointInMulti, pointInPoly, polyArea, ringCentroid,
  type MultiPoly, type Pt,
} from '../src/game/geom.ts';
import { makeRng } from '../src/game/rng.ts';
import { assignResources, resourceReport } from './resources.ts';
import { buildSeas, linkSeas } from './seas.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const RAW = path.join(ROOT, 'data', 'raw');

const mapId = process.argv[2] ?? 'europe';
const config: MapConfig = (await import(`./maps/${mapId}.ts`)).default;

// ---------------------------------------------------------------- Einlesen

async function readShp(base: string): Promise<Feature<Geometry, Record<string, unknown>>[]> {
  const src = await shapefile.open(base + '.shp', base + '.dbf', { encoding: 'utf-8' });
  const out: Feature<Geometry, Record<string, unknown>>[] = [];
  for (;;) {
    const r = await src.read();
    if (r.done) break;
    const props = r.value.properties as Record<string, unknown>;
    // DBF-Texte sind mit NUL-Zeichen aufgefüllt
    for (const k in props) if (typeof props[k] === 'string') props[k] = (props[k] as string).replace(/\u0000/g, '').trim();
    out.push(r.value as Feature<Geometry, Record<string, unknown>>);
  }
  return out;
}

function geoBox(g: Geometry): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const visit = (c: unknown): void => {
    if (typeof (c as number[])[0] === 'number') {
      const [x, y] = c as number[];
      if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
    } else for (const s of c as unknown[]) visit(s);
  };
  visit((g as { coordinates: unknown }).coordinates);
  return [x0, y0, x1, y1];
}

const [lb0, lb1, lb2, lb3] = config.lonLatBox;
const admin1 = (await readShp(path.join(RAW, 'admin1', 'ne_10m_admin_1_states_provinces'))).filter((f) => {
  if (!f.geometry) return false;
  const [x0, y0, x1, y1] = geoBox(f.geometry);
  return x1 >= lb0 && x0 <= lb2 && y1 >= lb1 && y0 <= lb3;
});
const places = (await readShp(path.join(RAW, 'places', 'ne_10m_populated_places'))).filter((f) => {
  const p = f.properties;
  const lon = p.LONGITUDE as number, lat = p.LATITUDE as number;
  return lon >= lb0 && lon <= lb2 && lat >= lb1 && lat <= lb3;
});

const seenOverrides = new Set<string>();
for (const f of admin1) {
  const nation = config.assign(f.properties);
  if (config.overrideCodes.includes(f.properties.iso_3166_2 as string)) seenOverrides.add(f.properties.iso_3166_2 as string);
  f.properties = { ...f.properties, nation };
}
for (const c of config.overrideCodes) if (!seenOverrides.has(c)) console.warn(`Warnung: Regionscode ${c} nicht gefunden`);
const regions = admin1.filter((f) => f.properties.nation);
console.log(`${regions.length} von ${admin1.length} Regionen zugeordnet, ${places.length} Orte im Ausschnitt`);

// ---------------------------------------------------------------- Topologie + Vereinfachung

let topo = topology({ regions: { type: 'FeatureCollection', features: admin1 } } as never, 1e6);
topo = presimplify(topo as never) as never;
topo = simplify(topo as never, quantile(topo as never, 0.035)) as never;
const regionGeoms = (topo.objects.regions as unknown as { geometries: { properties: Record<string, unknown> }[] }).geometries;

const projection = geoAzimuthalEqualArea().rotate([-config.center[0], -config.center[1]]).scale(6371).translate([0, 0]);
const project = (p: Position): Pt => {
  const r = projection([p[0], p[1]])!;
  return [r[0], r[1]];
};
const unproject = (p: Pt): [number, number] => projection.invert!(p) as [number, number];

const [rx0, ry0, rx1, ry1] = config.rect;
const rectPoly: MultiPoly = [[[[rx0, ry0], [rx1, ry0], [rx1, ry1], [rx0, ry1], [rx0, ry0]]]];


function projectMulti(g: GeoMultiPolygon): MultiPoly {
  return g.coordinates.map((poly) => poly.map((ring) => ring.map(project)));
}

const nationShapes = new Map<string, MultiPoly>();
for (const n of config.nations) {
  const geoms = regionGeoms.filter((g) => g.properties.nation === n.id);
  if (!geoms.length) throw new Error(`Nation ${n.id} hat keine Regionen`);
  let shape = projectMulti(merge(topo as never, geoms as never) as GeoMultiPolygon);
  shape = polygonClipping.union(shape as never) as MultiPoly;
  shape = polygonClipping.intersection(shape as never, rectPoly as never) as MultiPoly;
  shape = shape.filter((p) => polyArea(p) > 60); // Kleinstinseln weglassen
  nationShapes.set(n.id, shape);
}

// Jedes Land im Kartenausschnitt muss einer Nation gehören (keine grauen Reste)
let allLand = projectMulti(merge(topo as never, regionGeoms as never) as GeoMultiPolygon);
allLand = polygonClipping.intersection(polygonClipping.union(allLand as never) as never, rectPoly as never) as MultiPoly;
const leftover = (polygonClipping.difference(allLand as never, ...([...nationShapes.values()] as never[])) as MultiPoly)
  .filter((p) => polyArea(p) > 500);
if (leftover.length) {
  const unassigned = new Set(admin1.filter((f) => !f.properties.nation).map((f) => f.properties.adm0_a3 as string));
  throw new Error(`${leftover.length} Landflächen ohne Nation im Ausschnitt (${Math.round(multiArea(leftover))} km²). `
    + `Nicht zugeordnete Länder: ${[...unassigned].join(', ')}`);
}

// ---------------------------------------------------------------- Orte

interface Place { name: string; aliases: string[]; pos: Pt; pop: number; nation: string | null }
const allPlaces: Place[] = places.map((f) => {
  const p = f.properties;
  const ascii = p.NAMEASCII as string;
  const name = config.renames[ascii] ?? config.renames[p.NAME as string] ?? ((p.NAME_DE as string) || (p.NAME as string));
  const aliases = [ascii, p.NAME, p.NAME_EN, p.NAME_DE].filter(Boolean) as string[];
  return { name, aliases, pos: project([p.LONGITUDE as number, p.LATITUDE as number]), pop: (p.POP_MAX as number) ?? 0, nation: null };
});

// Küstenstädte liegen nach der Vereinfachung teils knapp im Meer: nach innen ziehen.
function snapInside(p: Pt, shape: MultiPoly, maxDist: number): Pt | null {
  let best: { q: Pt; part: number; d: number } | null = null;
  shape.forEach((poly, pi) => {
    const r = poly[0];
    for (let k = 0; k + 1 < r.length; k++) {
      const d = distSegment(p[0], p[1], r[k][0], r[k][1], r[k + 1][0], r[k + 1][1]);
      if (d < maxDist && (!best || d < best.d)) best = { q: r[k], part: pi, d };
    }
  });
  if (!best) return null;
  const { q, part } = best as { q: Pt; part: number; d: number };
  const c = ringCentroid(shape[part][0]);
  for (let t = 0.02; t <= 1; t += 0.02) {
    const s: Pt = [p[0] + (c[0] - p[0]) * t, p[1] + (c[1] - p[1]) * t];
    if (pointInPoly(s[0], s[1], shape[part])) return s;
    const s2: Pt = [q[0] + (c[0] - q[0]) * t, q[1] + (c[1] - q[1]) * t];
    if (pointInPoly(s2[0], s2[1], shape[part])) return s2;
  }
  return null;
}

for (const pl of allPlaces) {
  for (const [id, shape] of nationShapes) {
    if (pointInMulti(pl.pos[0], pl.pos[1], shape)) { pl.nation = id; break; }
  }
  if (pl.nation) continue;
  for (const [id, shape] of nationShapes) {
    const s = snapInside(pl.pos, shape, 20);
    if (s) { pl.nation = id; pl.pos = s; break; }
  }
}

// Regionsnamen als Rückfall für Provinzen ohne Ort
const regionLabels = regions.map((f) => {
  const p = f.properties;
  let name = ((p.name_de as string) || (p.name as string) || '').trim();
  name = name.replace(/^(Woiwodschaft|Kreis|Okrug|Département|Provinz|Region|Gouvernement|Oblast|Bezirk)\s+/i, '').replace(/\s+okrug$/i, '');
  return { name, pos: project([p.longitude as number, p.latitude as number]), nation: p.nation as string };
});

// ---------------------------------------------------------------- Provinzzahl und Saatpunkte

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h | 0;
}

const weightAt = (p: Pt) => {
  const [lon, lat] = unproject(p);
  return 1 / config.cellFactor(lon, lat);
};

/** Stichprobe gleichmäßig verteilter Landpunkte, ausgedünnt nach Besiedlungsgewicht. */
function samplesIn(shape: MultiPoly, n: number, rnd: () => number): { pts: Pt[]; effArea: number } {
  const box = bboxOf(shape);
  const pts: Pt[] = [];
  let inside = 0, weight = 0;
  for (let tries = 0; pts.length < n && tries < n * 400; tries++) {
    const p: Pt = [box[0] + rnd() * (box[2] - box[0]), box[1] + rnd() * (box[3] - box[1])];
    if (!pointInMulti(p[0], p[1], shape)) continue;
    inside++;
    const w = weightAt(p);
    weight += w;
    if (rnd() < w) pts.push(p);
  }
  return { pts, effArea: multiArea(shape) * (weight / Math.max(1, inside)) };
}

interface Seed { pos: Pt; capital: boolean }

/** Mittelgroße Inseln (km²) werden immer genau eine eigene Provinz (Korsika, Zypern, Kreta) */
const ISLAND_OWN = 5000;
const ISLAND_MAX = 15000;

/** Genau `count` Saatpunkte: Hauptstadt fest, Rest per k-Means über die Landstichprobe. */
function kmeansSeeds(capital: Pt, pts: Pt[], count: number, rnd: () => number): Seed[] {
  const centers: Pt[] = [capital];
  // k-Means++-Start
  while (centers.length < count) {
    const d2 = pts.map((p) => Math.min(...centers.map((c) => (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2)));
    const total = d2.reduce((a, b) => a + b, 0);
    let r = rnd() * total, k = 0;
    while (k < pts.length - 1 && (r -= d2[k]) > 0) k++;
    centers.push(pts[k]);
  }
  for (let it = 0; it < 25; it++) {
    const sum = centers.map(() => [0, 0, 0]);
    const members: Pt[][] = centers.map(() => []);
    for (const p of pts) {
      let best = 0, bd = Infinity;
      centers.forEach((c, i) => {
        const d = (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2;
        if (d < bd) { bd = d; best = i; }
      });
      sum[best][0] += p[0]; sum[best][1] += p[1]; sum[best][2]++;
      members[best].push(p);
    }
    for (let i = 1; i < centers.length; i++) {
      if (!sum[i][2]) continue;
      const m: Pt = [sum[i][0] / sum[i][2], sum[i][1] / sum[i][2]];
      // auf den nächstgelegenen Stichprobenpunkt ziehen, damit der Punkt an Land bleibt
      let bp = members[i][0], bd = Infinity;
      for (const p of members[i]) {
        const d = (p[0] - m[0]) ** 2 + (p[1] - m[1]) ** 2;
        if (d < bd) { bd = d; bp = p; }
      }
      centers[i] = bp;
    }
  }
  return centers.map((pos, i) => ({ pos, capital: i === 0 }));
}

function voronoiCells(seeds: Seed[], shape: MultiPoly): MultiPoly[] {
  if (seeds.length === 1) return [shape];
  const box = bboxOf(shape);
  const pad = 50;
  const vor = Delaunay.from(seeds.map((s) => s.pos)).voronoi([box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad]);
  return seeds.map((_, i) => {
    const cell = vor.cellPolygon(i) as Pt[] | null;
    if (!cell) return [];
    return polygonClipping.intersection(shape as never, [[cell]] as never) as MultiPoly;
  });
}

interface Prov { nation: string; seed: Seed; shape: MultiPoly }
const provs: Prov[] = [];

for (const cfg of config.nations) {
  const shape = nationShapes.get(cfg.id)!;
  const rnd = makeRng(hash(cfg.id) ^ 0x5eed);
  // kleine Inseln bekommen keinen eigenen Mittelpunkt, sie fallen an die nächste Provinz
  const { pts, effArea } = samplesIn(shape.filter((part) => polyArea(part) >= 2000), 3000, rnd);
  let count = cfg.major
    ? config.majorProvinces
    : Math.max(1, Math.min(config.minorMaxProvinces, Math.round(effArea / config.minorCellArea)));

  const own = allPlaces.filter((pl) => pl.nation === cfg.id);
  const cap = own.find((pl) => pl.aliases.includes(cfg.capital)) ?? own.sort((a, b) => b.pop - a.pop)[0];
  if (!cap) throw new Error(`Hauptstadt ${cfg.capital} für ${cfg.id} nicht gefunden`);
  let seeds = kmeansSeeds(cap.pos, pts, count, rnd);
  // Mittelgroße Inseln werden genau eine eigene Provinz (weder angehängt noch zerteilt);
  // das übrige Gebiet wird mit entsprechend weniger Provinzen neu aufgeteilt.
  const largest = shape.reduce((a, b) => (polyArea(a) > polyArea(b) ? a : b));
  const islands = shape.filter((part) => part !== largest && polyArea(part) >= ISLAND_OWN && polyArea(part) < ISLAND_MAX
    && !pointInPoly(cap.pos[0], cap.pos[1], part));
  let mainShape = shape;
  const islandProvs: Prov[] = [];
  // Kleinstaaten bekommen Inselprovinzen zusätzlich, statt ihr Festland auszudünnen
  if (!cfg.major) count = Math.min(config.minorMaxProvinces, count + islands.length);
  if (islands.length && count - islands.length >= 1) {
    mainShape = shape.filter((part) => !islands.includes(part));
    const mainPts = pts.filter((p) => !islands.some((part) => pointInPoly(p[0], p[1], part)));
    seeds = kmeansSeeds(cap.pos, mainPts, count - islands.length, rnd);
    for (const part of islands) {
      const c = ringCentroid(part[0]);
      const pos = pointInPoly(c[0], c[1], part) ? c : pts.find((p) => pointInPoly(p[0], p[1], part)) ?? part[0][0];
      islandProvs.push({ nation: cfg.id, seed: { pos, capital: false }, shape: [part] });
    }
  }
  const cells = voronoiCells(seeds, mainShape);
  const local: Prov[] = [...seeds.map((s, i) => ({ nation: cfg.id, seed: s, shape: cells[i] })), ...islandProvs];

  // Abgetrennte Teile einer Zelle an die Provinz mit dem nächsten anderen Saatpunkt hängen
  const nearestOther = (p: Pt, self: Prov): Prov | null => {
    let best: Prov | null = null, bd = Infinity;
    for (const o of local) {
      if (o === self || !o.shape.length) continue;
      const d = dist(o.seed.pos, p);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  };
  for (const pr of local) {
    if (pr.shape.length < 2) continue;
    const main = pr.shape.find((p) => pointInPoly(pr.seed.pos[0], pr.seed.pos[1], p))
      ?? pr.shape.reduce((a, b) => (polyArea(a) > polyArea(b) ? a : b));
    const keep: MultiPoly = [main];
    for (const part of pr.shape) {
      if (part === main) continue;
      const target = polyArea(part) < 350 ? null : nearestOther(ringCentroid(part[0]), pr);
      if (target) target.shape = polygonClipping.union(target.shape as never, [part] as never) as MultiPoly;
      else keep.push(part);
    }
    pr.shape = keep;
  }
  const empty = local.filter((p) => !p.shape.length).length;
  if (empty) console.warn(`${cfg.id}: ${empty} leere Provinz(en)`);
  provs.push(...local.filter((p) => p.shape.length));
  console.log(`${cfg.id}: ${Math.round(multiArea(shape) / 1000)} Tkm² -> ${local.length - empty} Provinzen`);
}
console.log(`${provs.length} Provinzen`);

// ---------------------------------------------------------------- Grenzen, Nachbarn, Küsten

interface Seg { prov: number; ax: number; ay: number; bx: number; by: number }
const segs: Seg[] = [];
provs.forEach((pr, i) => {
  for (const poly of pr.shape) for (const ring of poly) {
    for (let k = 0; k + 1 < ring.length; k++) {
      segs.push({ prov: i, ax: ring[k][0], ay: ring[k][1], bx: ring[k + 1][0], by: ring[k + 1][1] });
    }
  }
});
const CELL = 40;
const grid = new Map<string, Seg[]>();
for (const s of segs) {
  const gx0 = Math.floor(Math.min(s.ax, s.bx) / CELL), gx1 = Math.floor(Math.max(s.ax, s.bx) / CELL);
  const gy0 = Math.floor(Math.min(s.ay, s.by) / CELL), gy1 = Math.floor(Math.max(s.ay, s.by) / CELL);
  for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
    const key = gx + ',' + gy;
    (grid.get(key) ?? grid.set(key, []).get(key)!).push(s);
  }
}

const EPS = 0.35;
const borderMap = new Map<string, { a: number; b: number; segs: number[]; len: number }>();
const addBorder = (a: number, b: number, s: Seg) => {
  const key = a + ':' + b;
  const e = borderMap.get(key) ?? borderMap.set(key, { a, b, segs: [], len: 0 }).get(key)!;
  e.segs.push(r1(s.ax), r1(s.ay), r1(s.bx), r1(s.by));
  e.len += Math.hypot(s.bx - s.ax, s.by - s.ay);
};
const onRect = (x: number, y: number) =>
  Math.abs(x - rx0) < EPS || Math.abs(x - rx1) < EPS || Math.abs(y - ry0) < EPS || Math.abs(y - ry1) < EPS;

for (const s of segs) {
  const mx = (s.ax + s.bx) / 2, my = (s.ay + s.by) / 2;
  const gx = Math.floor(mx / CELL), gy = Math.floor(my / CELL);
  let other = -1;
  outer: for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    for (const t of grid.get(gx + dx + ',' + (gy + dy)) ?? []) {
      if (t.prov === s.prov) continue;
      if (distSegment(mx, my, t.ax, t.ay, t.bx, t.by) < EPS) { other = t.prov; break outer; }
    }
  }
  if (other >= 0) {
    if (s.prov < other) addBorder(s.prov, other, s);
  } else if (!onRect(mx, my)) {
    addBorder(s.prov, -1, s);
  }
}

const neighbors: Set<number>[] = provs.map(() => new Set());
const coastLen = provs.map(() => 0);
for (const b of borderMap.values()) {
  if (b.b === -1) coastLen[b.a] += b.len;
  else if (b.len > 2) { neighbors[b.a].add(b.b); neighbors[b.b].add(b.a); }
}

// ---------------------------------------------------------------- Seegebiete

const seaZones = buildSeas(rectPoly, [...nationShapes.values()], {
  count: config.seaCount,
  minArea: 25000,
  names: config.seaNames.map((n) => ({ name: n.name, pos: project(n.at) })),
}, makeRng(hash(config.id + ':see')));
const seaBorders = linkSeas(seaZones, provs.map((p) => p.shape));
const provSeas: number[][] = provs.map(() => []);
seaZones.forEach((z, zi) => z.coasts.forEach((pi) => provSeas[pi].push(zi)));
console.log(`${seaZones.length} Seegebiete: ${seaZones.map((z) => z.name).join(', ')}`);

// ---------------------------------------------------------------- Namen, Ressourcen, Ausgabe

function r1(v: number): number { return Math.round(v * 10) / 10; }

const used = new Map<string, number>();
function uniqueName(n: string): string {
  const c = used.get(n) ?? 0;
  used.set(n, c + 1);
  return c === 0 ? n : `${n} ${['', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'][c] ?? c + 1}`;
}

const hotspots = config.hotspots.map((h) => ({ r: h.r, pos: project(h.at) }));
const rnd = makeRng(hash(config.id));

const biggestPop: number[] = [];
const provinces: MapProvince[] = provs.map((pr, i) => {
  const shape = pr.shape;
  // Name und Lage: größte Stadt der Provinz (bei der Hauptstadt die Hauptstadt selbst)
  let place: Place | undefined;
  for (const pl of allPlaces) {
    if (pl.nation !== pr.nation || (place && pl.pop <= place.pop)) continue;
    if (pointInMulti(pl.pos[0], pl.pos[1], shape)) place = pl;
  }
  if (pr.seed.capital) {
    const cfg = config.nations.find((n) => n.id === pr.nation)!;
    place = allPlaces.find((pl) => pl.nation === pr.nation && pl.aliases.includes(cfg.capital)) ?? place;
  }
  let name: string;
  if (place) name = place.name;
  else {
    let best = regionLabels[0], bd = Infinity;
    for (const rl of regionLabels) {
      if (rl.nation !== pr.nation) continue;
      const d = dist(rl.pos, pr.seed.pos);
      if (d < bd) { bd = d; best = rl; }
    }
    name = best.name;
  }
  biggestPop[i] = place?.pop ?? 0;
  const center: Pt = place && pointInMulti(place.pos[0], place.pos[1], shape) ? place.pos : pr.seed.pos;
  const lonlat = unproject(center);
  // Küste = grenzt an ein befahrbares Seegebiet (Binnenseen zählen nicht)
  const coastal = provSeas[i].length > 0;

  const mid = interiorPoint(shape);
  return {
    id: i,
    name: uniqueName(name),
    nation: pr.nation,
    polys: shape.map((poly) => poly.map((ring) => ring.slice(0, -1).flatMap(([x, y]) => [r1(x), r1(y)]))),
    center: [r1(center[0]), r1(center[1])],
    mid: [r1(mid[0]), r1(mid[1])],
    lonlat: [Math.round(lonlat[0] * 1000) / 1000, Math.round(lonlat[1] * 1000) / 1000],
    area: Math.round(multiArea(shape)),
    city: pr.seed.capital,
    capital: pr.seed.capital,
    coastal,
    resource: 'grain', // wird unten verteilt
    double: false,
    neighbors: [...neighbors[i]].sort((a, b) => a - b),
    seas: provSeas[i],
  };
});

// Städte: Hauptstadt plus die größten Städte (ab 300.000 Einwohnern), höchstens 30 % der Provinzen
for (const n of config.nations) {
  const own = provinces.filter((p) => p.nation === n.id && !p.capital).sort((a, b) => biggestPop[b.id] - biggestPop[a.id]);
  const max = Math.floor((own.length + 1) * 0.3);
  own.slice(0, max).filter((p) => biggestPop[p.id] >= 300000).forEach((p) => (p.city = true));
}

// Doppelprovinzen: Spielernationen genau 2, Kleinstaaten ab 3 Provinzen eine
for (const n of config.nations) {
  const own = provinces.filter((p) => p.nation === n.id && !p.capital);
  const want = n.major ? 2 : own.length + 1 >= 3 ? 1 : 0;
  for (let k = 0; k < want && own.length; k++) {
    const pick = own.splice(Math.floor(rnd() * own.length), 1)[0];
    pick.double = true;
  }
}

// Rohstoffe: nach Lage, mit Regeln für Gesamtkarte und Nationen (scripts/resources.ts)
assignResources(
  provinces.map((p, i) => ({ province: p, shape: provs[i].shape, lat: p.lonlat[1], desert: config.cellFactor(p.lonlat[0], p.lonlat[1]) >= 3 })),
  hotspots,
  rnd,
  (nation) => config.oilLimit?.[nation] ?? (config.nations.find((n) => n.id === nation)!.major ? 1 : 0),
);
// Feste Vorgaben aus der Kartenkonfiguration
const byName = (name: string) => {
  const p = provinces.find((x) => x.name === name);
  if (!p) throw new Error(`Vorgabe: Provinz ${name} nicht gefunden`);
  return p;
};
for (const [name, r] of Object.entries(config.adjust?.resources ?? {})) byName(name).resource = r;
for (const name of config.adjust?.doubles?.remove ?? []) byName(name).double = false;
for (const name of config.adjust?.doubles?.add ?? []) byName(name).double = true;
for (const n of config.nations.filter((x) => x.major)) {
  const d = provinces.filter((p) => p.nation === n.id && p.double).length;
  if (d !== 2) throw new Error(`${n.id} hat ${d} Doppelprovinzen statt 2`);
}
console.log(resourceReport(provinces));

const borders: MapBorder[] = [...borderMap.values()].map((b) => ({ a: b.a, b: b.b, segs: b.segs }));

const data: MapData = {
  id: config.id,
  name: config.name,
  bounds: config.rect,
  nations: config.nations.map((n) => ({
    id: n.id, name: n.name, color: n.color, major: n.major,
    capital: provinces.find((p) => p.nation === n.id && p.capital)!.id,
  })),
  provinces,
  borders,
  seas: seaZones.map((z, i) => ({
    id: i,
    name: z.name,
    polys: z.shape.map((poly) => poly.map((ring) => ring.slice(0, -1).flatMap(([x, y]) => [r1(x), r1(y)]))),
    center: [r1(z.center[0]), r1(z.center[1])],
    seas: [...z.seas].sort((a, b) => a - b),
    coasts: [...z.coasts].sort((a, b) => a - b),
  })),
  seaBorders,
};

const outDir = path.join(ROOT, 'public', 'maps');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `${config.id}.json`);
fs.writeFileSync(out, JSON.stringify(data));
const isolated = provinces.filter((p) => p.neighbors.length === 0 && !p.coastal).map((p) => p.name);
if (isolated.length) console.warn('Ohne Nachbarn und Küste:', isolated.join(', '));
console.log(`geschrieben: ${out} (${Math.round(fs.statSync(out).size / 1024)} KB), Küstenprovinzen: ${provinces.filter((p) => p.coastal).length}`);
