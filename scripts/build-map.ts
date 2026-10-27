// Erzeugt eine Spielkarte aus Natural-Earth-Daten (Public Domain).
// Aufruf: npx tsx scripts/build-map.ts <kartenId>
// Ablauf: Admin-1-Regionen -> Nationen von 1914 -> vereinfachte Topologie ->
// Projektion (km) -> feste Provinzzahl je Nation (gewichtetes k-Means + Voronoi) ->
// Nachbarschaften, Küsten, Ressourcen, Doppelprovinzen.

import fs from 'node:fs';
import { applyEdits } from '../src/game/mapedits.ts';
import { checkReport } from '../src/game/mapcheck.ts';
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
import { bundleRoutes, snapSeaLanes, waterRoutes } from './routes.ts';

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

/** Wertrauschen in [-1, 1] mit glatter Interpolation (deterministisch über `seed`) */
function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const r = (i: number, j: number) => {
    let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(seed, 1274126177);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return (((h ^ (h >>> 16)) >>> 0) / 4294967296) * 2 - 1;
  };
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = r(xi, yi) + (r(xi + 1, yi) - r(xi, yi)) * u;
  const b = r(xi, yi + 1) + (r(xi + 1, yi + 1) - r(xi, yi + 1)) * u;
  return a + (b - a) * v;
}

/** Zwei Oktaven Rauschen */
const fbm = (x: number, y: number, seed: number) => (valueNoise(x, y, seed) + 0.5 * valueNoise(2 * x + 17.3, 2 * y - 9.1, seed + 1)) / 1.5;

/**
 * Provinzzellen mit natürlich geschwungenen Grenzen: Das Gebiet wird in viele kleine Zellen
 * (Voronoi eines verwackelten Gitters) zerlegt; jede Zelle fällt an den nächsten Saatpunkt,
 * gemessen von einem durch Rauschen verschobenen Punkt aus (Stärke abhängig vom örtlichen
 * Abstand der Saatpunkte). Die Zellen je Provinz werden vereinigt und auf das Gebiet zugeschnitten.
 */
function voronoiCells(seeds: Seed[], shape: MultiPoly, rnd: () => number, places: { pos: Pt; pop: number }[] = []): MultiPoly[] {
  if (seeds.length === 1) return [shape];
  const box = bboxOf(shape);
  const area = multiArea(shape);
  const spacing = Math.sqrt(area / seeds.length);
  const h = Math.max(5, spacing / 9);
  const pts: Pt[] = [];
  for (let y = box[1] - h; y <= box[3] + h; y += h) {
    for (let x = box[0] - h; x <= box[2] + h; x += h) pts.push([x + (rnd() - 0.5) * h * 0.8, y + (rnd() - 0.5) * h * 0.8]);
  }
  const pad = 3 * h;
  const vor = Delaunay.from(pts).voronoi([box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad]);
  const lambda = spacing * 0.9;
  const seedNoise = Math.floor(rnd() * 1e9);
  const owner = pts.map((c) => {
    let d1 = Infinity, d2 = Infinity;
    for (const s of seeds) {
      const d = dist(s.pos, c);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
    }
    const amp = 0.25 * d2;
    const w: Pt = [c[0] + amp * fbm(c[0] / lambda, c[1] / lambda, seedNoise), c[1] + amp * fbm(c[0] / lambda + 41.7, c[1] / lambda - 13.2, seedNoise)];
    let best = 0, bd = Infinity;
    seeds.forEach((s, i) => {
      const d = dist(s.pos, w);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  });
  // Orte bleiben in der Provinz, in der sie ohne Verwacklung lägen (stabile Namen und Städte)
  const nearestSeed = (p: Pt) => {
    let best = 0, bd = Infinity;
    seeds.forEach((s, i) => {
      const d = dist(s.pos, p);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  };
  // die größte Stadt jeder Provinz (namensgebend) bleibt fest; kleinere Orte folgen den Grenzen
  const pinned = new Uint8Array(pts.length);
  const top = new Map<number, { pos: Pt; pop: number }>();
  for (const pl of places) {
    const i = nearestSeed(pl.pos);
    if (!top.has(i) || top.get(i)!.pop < pl.pop) top.set(i, pl);
  }
  for (const [i, pl] of top) {
    const k = vor.delaunay.find(pl.pos[0], pl.pos[1]);
    if (k >= 0) { owner[k] = i; pinned[k] = 1; }
  }
  // größter Ort je Zelle: ein Landstück darf nur wechseln, wenn es der neuen Provinz nicht den Namen nimmt
  const cellPop = new Float64Array(pts.length);
  for (const pl of places) {
    const k = vor.delaunay.find(pl.pos[0], pl.pos[1]);
    if (k >= 0) cellPop[k] = Math.max(cellPop[k], pl.pop);
  }
  // die Zelle um den Saatpunkt gehört immer zur eigenen Provinz
  const seedCell = seeds.map((s, i) => {
    const k = vor.delaunay.find(s.pos[0], s.pos[1]);
    owner[k] = i;
    pinned[k] = 1;
    return k;
  });
  // Abgesprengte Landstücke (nicht über eigenes Land mit dem Saatpunkt verbunden) an die
  // angrenzende Provinz geben; reine Inseln ohne fremde Landnachbarn bleiben, wie sie sind
  const land = pts.map((c) => pointInMulti(c[0], c[1], shape));
  // Nachbarzellen nur über Land (Mitte der Verbindung an Land), nicht über Meerengen hinweg
  const nearCache = new Map<number, number[]>();
  const near = (k: number) => {
    let r = nearCache.get(k);
    if (!r) {
      r = [...vor.delaunay.neighbors(k)].filter((n) => land[n]
        && pointInMulti((pts[k][0] + pts[n][0]) / 2, (pts[k][1] + pts[n][1]) / 2, shape));
      nearCache.set(k, r);
    }
    return r;
  };
  for (let iter = 0; iter < 6; iter++) {
    const linked = new Uint8Array(pts.length);
    seedCell.forEach((start, i) => {
      const stack = [start];
      linked[start] = 1;
      while (stack.length) {
        const k = stack.pop()!;
        for (const n of near(k)) if (!linked[n] && owner[n] === i && land[n]) { linked[n] = 1; stack.push(n); }
      }
    });
    let changed = false;
    const seen = new Uint8Array(pts.length);
    for (let k = 0; k < pts.length; k++) {
      if (!land[k] || linked[k] || seen[k]) continue;
      const comp: number[] = [];
      const votes = new Map<number, number>();
      const stack = [k];
      seen[k] = 1;
      while (stack.length) {
        const c = stack.pop()!;
        comp.push(c);
        for (const n of near(c)) {
          if (!land[n]) continue;
          if (owner[n] === owner[k] && !linked[n]) {
            if (!seen[n]) { seen[n] = 1; stack.push(n); }
          } else if (owner[n] !== owner[k]) votes.set(owner[n], (votes.get(owner[n]) ?? 0) + 1);
        }
      }
      if (!votes.size || comp.some((c) => pinned[c])) continue;
      const to = [...votes].sort((a, b) => b[1] - a[1])[0][0];
      if (Math.max(...comp.map((c) => cellPop[c])) > (top.get(to)?.pop ?? 0)) continue;
      for (const c of comp) owner[c] = to;
      changed = true;
    }
    if (!changed) break;
  }
  return seeds.map((_, i) => {
    const cells: Pt[][][] = [];
    pts.forEach((_, k) => {
      if (owner[k] !== i) return;
      const cell = vor.cellPolygon(k) as Pt[] | null;
      if (cell) cells.push([cell]);
    });
    if (!cells.length) return [];
    const merged = polygonClipping.union(cells[0] as never, ...(cells.slice(1) as never[])) as MultiPoly;
    return polygonClipping.intersection(shape as never, merged as never) as MultiPoly;
  });
}

interface Prov { nation: string; seed: Seed; shape: MultiPoly; /** namensgebender Ort (größter im unverwackelten Zuschnitt) */ place?: Place; box?: number[] }
const provs: Prov[] = [];

for (const cfg of config.nations) {
  const shape = nationShapes.get(cfg.id)!;
  const rnd = makeRng(hash(cfg.id) ^ 0x5eed);
  // kleine Inseln bekommen keinen eigenen Mittelpunkt, sie fallen an die nächste Provinz
  const { pts, effArea } = samplesIn(shape.filter((part) => polyArea(part) >= 2000), 3000, rnd);
  let count = cfg.provinces ?? (cfg.major
    ? config.majorProvinces
    : Math.max(1, Math.min(config.minorMaxProvinces, Math.round(effArea / config.minorCellArea))));

  const own = allPlaces.filter((pl) => pl.nation === cfg.id);
  const cap = own.find((pl) => pl.aliases.includes(cfg.capital)) ?? own.sort((a, b) => b.pop - a.pop)[0];
  if (!cap) throw new Error(`Hauptstadt ${cfg.capital} für ${cfg.id} nicht gefunden`);
  let seeds = kmeansSeeds(cap.pos, pts, count, rnd);
  const seedOrder = [...seeds];
  // Mittelgroße Inseln werden genau eine eigene Provinz (weder angehängt noch zerteilt);
  // das übrige Gebiet wird mit entsprechend weniger Provinzen neu aufgeteilt.
  const largest = shape.reduce((a, b) => (polyArea(a) > polyArea(b) ? a : b));
  const forced = (config.ownIslands ?? []).map((ll) => project(ll));
  const islands = shape.filter((part) => part !== largest && !pointInPoly(cap.pos[0], cap.pos[1], part)
    && ((polyArea(part) >= ISLAND_OWN && polyArea(part) < ISLAND_MAX) || forced.some((p) => pointInPoly(p[0], p[1], part))));
  let mainShape = shape;
  const islandProvs: Prov[] = [];
  // Kleinstaaten bekommen Inselprovinzen zusätzlich, statt ihr Festland auszudünnen
  if (!cfg.major && cfg.provinces === undefined) count = Math.min(config.minorMaxProvinces, count + islands.length);
  const forcedOnly = islands.length > 0 && islands.every((part) => forced.some((p) => pointInPoly(p[0], p[1], part)))
    && islands.every((part) => seeds.some((s) => pointInPoly(s.pos[0], s.pos[1], part)));
  if (forcedOnly) {
    // vorgegebene Inseln: ein Saatpunkt bleibt auf der Insel (sie wird genau eine Provinz), weitere
    // Saatpunkte dort rücken an den nächsten Punkt des Festlands – die übrigen Provinzen bleiben unverändert
    mainShape = shape.filter((part) => !islands.includes(part));
    const mainPts = pts.filter((p) => !islands.some((part) => pointInPoly(p[0], p[1], part)));
    for (const part of islands) {
      const on = seeds.filter((s) => pointInPoly(s.pos[0], s.pos[1], part));
      const keep = on.reduce((a, b) => {
        const pop = (s: Seed) => Math.max(0, ...own.filter((pl) => dist(pl.pos, s.pos) < 60).map((pl) => pl.pop));
        return pop(b) > pop(a) ? b : a;
      });
      for (const s of on) {
        if (s === keep) continue;
        let best = mainPts[0], bd = Infinity;
        for (const p of mainPts) {
          const d = dist(p, s.pos);
          if (d < bd && !seeds.some((o) => o.pos === p)) { bd = d; best = p; }
        }
        s.pos = best;
      }
      seeds = seeds.filter((s) => s !== keep);
      islandProvs.push({ nation: cfg.id, seed: keep, shape: [part] });
    }
  } else if (islands.length && count - islands.length >= 1) {
    mainShape = shape.filter((part) => !islands.includes(part));
    const mainPts = pts.filter((p) => !islands.some((part) => pointInPoly(p[0], p[1], part)));
    seeds = kmeansSeeds(cap.pos, mainPts, count - islands.length, rnd);
    for (const part of islands) {
      const c = ringCentroid(part[0]);
      const pos = pointInPoly(c[0], c[1], part) ? c : pts.find((p) => pointInPoly(p[0], p[1], part)) ?? part[0][0];
      islandProvs.push({ nation: cfg.id, seed: { pos, capital: false }, shape: [part] });
    }
  }
  const cells = voronoiCells(seeds, mainShape, rnd, own);
  const local: Prov[] = [...seeds.map((s, i) => ({ nation: cfg.id, seed: s, shape: cells[i] })), ...islandProvs];
  // Reihenfolge der Saatpunkte beibehalten (Provinznummern bleiben stabil, auch für Spielstände)
  const rank = (pr: Prov) => { const k = seedOrder.indexOf(pr.seed); return k < 0 ? Infinity : k; };
  local.sort((x, y) => rank(x) - rank(y));
  // Namen wie beim geraden Zuschnitt: größter Ort, dessen nächster Saatpunkt der eigene ist
  for (const pl of own) {
    let best: Prov | null = null, bd = Infinity;
    for (const pr of local) {
      const d = dist(pr.seed.pos, pl.pos);
      if (d < bd) { bd = d; best = pr; }
    }
    if (best && (!best.place || best.place.pop < pl.pop)) best.place = pl;
  }

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
  // Inseln nicht zerteilen: Stücke einer Insel gehören der Provinz, deren Stadt dort liegt
  // (sonst dem größten Anteil); Provinzen mit Stadt anderswo geben ihre Stücke ab
  for (const part of shape) {
    if (part === largest || polyArea(part) < 5) continue;
    const [bx0, by0, bx1, by1] = bboxOf([part]);
    const pieces = local.map((pr) => {
      if (!pr.shape.length) return 0;
      const [x0, y0, x1, y1] = bboxOf(pr.shape);
      if (x1 < bx0 || x0 > bx1 || y1 < by0 || y0 > by1) return 0;
      return multiArea(polygonClipping.intersection(pr.shape as never, [part] as never) as MultiPoly);
    });
    const holders = local.filter((_, i) => pieces[i] > 0.01);
    if (holders.length < 2) continue;
    const on = holders.filter((pr) => pointInPoly(pr.seed.pos[0], pr.seed.pos[1], part));
    const pick = on.length ? on : holders;
    const winner = pick.reduce((a, b) => (pieces[local.indexOf(b)] > pieces[local.indexOf(a)] ? b : a));
    for (const pr of holders) {
      if (pr === winner || on.includes(pr)) continue;
      const rest = polygonClipping.difference(pr.shape as never, [part] as never) as MultiPoly;
      if (!rest.length) continue;
      pr.shape = rest;
      winner.shape = polygonClipping.union(winner.shape as never, [part] as never) as MultiPoly;
    }
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
  else if (b.len > 10) { neighbors[b.a].add(b.b); neighbors[b.b].add(b.a); }
}

// ---------------------------------------------------------------- Seegebiete

const seaZones = buildSeas(rectPoly, [...nationShapes.values()], {
  count: config.seaCount,
  minArea: 25000,
  names: config.seaNames.map((n) => ({ name: n.name, pos: project(n.at) })),
}, makeRng(hash(config.id + ':see')));
const seaBorders = linkSeas(seaZones, provs.map((p) => p.shape));
// Mitte jedes Seegebiets muss im Wasser liegen (bei verwinkelten Gebieten fällt der Schwerpunkt sonst aufs Land)
for (const z of seaZones) {
  if (!pointInMulti(z.center[0], z.center[1], z.shape)) z.center = interiorPoint(z.shape);
}
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
  // namensgebende Stadt muss im Hauptteil der Provinz liegen (nicht auf einer angehängten Kleininsel)
  const mainPart = [shape.reduce((x, y) => (polyArea(x) > polyArea(y) ? x : y))];
  let place: Place | undefined = pr.place && pointInMulti(pr.place.pos[0], pr.place.pos[1], mainPart) ? pr.place : undefined;
  if (!place) for (const pl of allPlaces) {
    if (pl.nation !== pr.nation || (place && pl.pop <= place.pop)) continue;
    if (pointInMulti(pl.pos[0], pl.pos[1], mainPart)) place = pl;
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
  let center: Pt = place && pointInMulti(place.pos[0], place.pos[1], shape) ? place.pos : pr.seed.pos;
  const moved = place ? config.cityAt?.[place.name] : undefined;
  if (moved) center = snapInside(project(moved), shape, 80) ?? center;
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

// Küstenorte ohne echte Stadt: nur etwa 20 % bleiben am Wasser (unter 10 km), die übrigen rücken an
// eine zufällige Stelle im Inneren der Provinz – weit genug von allen Grenzen und von der Mitte mit dem
// Rohstoffsymbol, damit die Wege einfach bleiben. Vorgegebene Lagen (cityAt) bleiben unangetastet.
{
  const COAST_NEAR = 10, KEEP_SHARE = 0.2;
  const coastSegs = provs.map(() => [] as number[]);
  for (const b of borderMap.values()) if (b.b === -1) coastSegs[b.a].push(...b.segs);
  const segDist = (segs: number[], p: Pt) => {
    let d = Infinity;
    for (let k = 0; k + 3 < segs.length; k += 4) d = Math.min(d, distSegment(p[0], p[1], segs[k], segs[k + 1], segs[k + 2], segs[k + 3]));
    return d;
  };
  const fixed = new Set(Object.keys(config.cityAt ?? {}));
  const near = provinces.filter((p) => !p.city && !p.capital && coastSegs[p.id].length && !fixed.has(p.name)
    && segDist(coastSegs[p.id], p.center) < COAST_NEAR);
  // feste Auswahl der Bleibenden (nach Namens-Hash), damit jeder Neubau gleich ausfällt
  const order = [...near].sort((a, b) => (hash(a.name) >>> 0) - (hash(b.name) >>> 0));
  const stay = new Set(order.slice(0, Math.round(near.length * KEEP_SHARE)).map((p) => p.id));
  let movedCount = 0;
  for (const p of near) {
    if (stay.has(p.id)) continue;
    const shape = provs[p.id].shape;
    const main = shape.reduce((a, b) => (polyArea(a) > polyArea(b) ? a : b));
    const edgeDist = (x: number, y: number) => {
      let d = Infinity;
      for (const ring of main) for (let k = 0; k + 1 < ring.length; k++) d = Math.min(d, distSegment(x, y, ring[k][0], ring[k][1], ring[k + 1][0], ring[k + 1][1]));
      return d;
    };
    const mid: Pt = [p.mid[0], p.mid[1]];
    const dMax = edgeDist(mid[0], mid[1]);
    const [x0, y0, x1, y1] = bboxOf([main]);
    const step = Math.max(2, Math.min(x1 - x0, y1 - y0) / 25);
    const cand: Pt[] = [];
    for (let x = x0; x <= x1; x += step) for (let y = y0; y <= y1; y += step) {
      if (!pointInPoly(x, y, main)) continue;
      if (edgeDist(x, y) >= 0.5 * dMax && dist([x, y], mid) >= 0.3 * dMax) cand.push([x, y]);
    }
    if (!cand.length) continue;
    const pick = cand[Math.floor(makeRng(hash(p.name) ^ 0xc0a57)() * cand.length)];
    p.center = [r1(pick[0]), r1(pick[1])];
    const ll = unproject(pick);
    p.lonlat = [Math.round(ll[0] * 1000) / 1000, Math.round(ll[1] * 1000) / 1000];
    movedCount++;
  }
  console.log(`Küstenorte ohne Stadt unter ${COAST_NEAR} km: ${near.length}, davon bleiben ${stay.size}, ins Innere verlegt: ${movedCount}`);
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
  if (!p) { if (process.env.MAP_DEBUG) { console.warn(`Vorgabe: Provinz ${name} nicht gefunden`); return { resource: "", double: false } as unknown as MapProvince; } throw new Error(`Vorgabe: Provinz ${name} nicht gefunden`); }
  return p;
};
// Rohstoffe und Doppelprovinzen der bisherigen Karte übernehmen, wenn dieselben Provinzen (Namen)
// vorliegen – Grenzkorrekturen ändern so die abgestimmte Verteilung nicht. Neu verteilen: --new-resources.
// Die festen Vorgaben der Konfiguration gelten danach in jedem Fall.
{
  // aus der Grundkarte, damit Vorgaben aus dem Karteneditor nicht in die Grundkarte wandern
  const prev = path.join(ROOT, 'data', 'maps', `${config.id}.base.json`);
  if (!process.argv.includes('--new-resources') && fs.existsSync(prev)) {
    const old = JSON.parse(fs.readFileSync(prev, 'utf8')) as MapData;
    const byOldName = new Map(old.provinces.map((p) => [p.name, p]));
    const unmatchedOld = old.provinces.filter((p) => !provinces.some((q) => q.name === p.name && q.nation === p.nation));
    const renamed: string[] = [];
    let kept = 0;
    for (const p of provinces) {
      let o = byOldName.get(p.name);
      if (!o || o.nation !== p.nation) {
        // neu benannte Provinz: Werte einer weggefallenen Provinz derselben Nation übernehmen
        const i = unmatchedOld.findIndex((x) => x.nation === p.nation);
        if (i < 0) continue;
        o = unmatchedOld.splice(i, 1)[0];
        renamed.push(`${o.name} → ${p.name}`);
      }
      p.resource = o.resource;
      p.double = o.double;
      kept++;
    }
    console.log(`Rohstoffe und Doppelprovinzen aus der bisherigen Karte übernommen: ${kept}${renamed.length ? ` (umbenannt: ${renamed.join(', ')})` : ''}`);
  }
}
for (const [name, r] of Object.entries(config.adjust?.resources ?? {})) byName(name).resource = r;
for (const name of config.adjust?.doubles?.remove ?? []) byName(name).double = false;
for (const name of config.adjust?.doubles?.add ?? []) byName(name).double = true;
for (const n of config.nations.filter((x) => x.major)) {
  const d = provinces.filter((p) => p.nation === n.id && p.double).length;
  if (d !== 2) throw new Error(`${n.id} hat ${d} Doppelprovinzen statt 2`);
}
console.log(resourceReport(provinces));

// ---------------------------------------------------------------- Wegverlauf an Land

const roads: { a: number; b: number; pts: number[]; split: number }[] = [];

/** Provinz an einem Punkt (−1 = Wasser) */
function provinceIndexAt(x: number, y: number): number {
  for (let i = 0; i < provs.length; i++) {
    const pr = provs[i];
    const bb = pr.box ?? (pr.box = bboxOf(pr.shape));
    if (x < bb[0] || x > bb[2] || y < bb[1] || y > bb[3]) continue;
    if (pointInMulti(x, y, pr.shape)) return i;
  }
  return -1;
}

/** Liegt der Punkt an Land (in irgendeiner Provinz)? */
function anyLand(x: number, y: number): boolean {
  for (const pr of provs) {
    const bb = pr.box ?? (pr.box = bboxOf(pr.shape));
    if (x < bb[0] || x > bb[2] || y < bb[1] || y > bb[3]) continue;
    if (pointInMulti(x, y, pr.shape)) return true;
  }
  return false;
}

/** Liegt die Strecke a–b (Probe alle ~2 km) an Land? */
function segmentOnLand(a: Pt, b: Pt, onLand: (x: number, y: number) => boolean): boolean {
  const n = Math.max(2, Math.ceil(dist(a, b) / 2));
  for (let k = 1; k < n; k++) if (!onLand(a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n)) return false;
  return true;
}

/**
 * Landweg zwischen zwei Nachbarprovinzen, der nicht übers Wasser führt. null = der übliche Weg
 * über den Grenzpunkt passt (oder es gibt keinen Landweg, z. B. zwischen Inseln).
 */
function routeOnLand(u: number, v: number, via: Pt, wide = false): { a: number; b: number; pts: number[]; split: number } | null {
  const su = provs[u].shape, sv = provs[v].shape;
  const cu = provinces[u].center as Pt, cv = provinces[v].center as Pt;
  const inU = (x: number, y: number) => pointInMulti(x, y, su);
  const inV = (x: number, y: number) => pointInMulti(x, y, sv);
  // zuerst nur durch die beiden Provinzen, notfalls über beliebiges Land (wide)
  const onLand = wide ? anyLand : (x: number, y: number) => inU(x, y) || inV(x, y);
  // eigener Verlauf nur, wo der übliche Weg übers Wasser oder durch eine dritte Provinz führt;
  // gibt es keinen Landweg (z. B. Kopenhagen–Aarhus über den Belt), bleibt es beim geraden Weg
  const ownLand = (x: number, y: number) => { const at = provinceIndexAt(x, y); return at < 0 || at === u || at === v; };
  const overWater = !(segmentOnLand(cu, via, anyLand) && segmentOnLand(via, cv, anyLand));
  const overThird = !(segmentOnLand(cu, via, ownLand) && segmentOnLand(via, cv, ownLand));
  if (!overWater && !overThird) return null;
  if (wide && !overWater) return null;
  // Raster über beide Provinzen
  const [ux0, uy0, ux1, uy1] = bboxOf(su), [vx0, vy0, vx1, vy1] = bboxOf(sv);
  const pad = wide ? 0.3 * Math.hypot(Math.max(ux1, vx1) - Math.min(ux0, vx0), Math.max(uy1, vy1) - Math.min(uy0, vy0)) : 0;
  const x0 = Math.min(ux0, vx0) - pad, y0 = Math.min(uy0, vy0) - pad, x1 = Math.max(ux1, vx1) + pad, y1 = Math.max(uy1, vy1) + pad;
  const h = Math.max(3, Math.hypot(x1 - x0, y1 - y0) / 260);
  const W = Math.ceil((x1 - x0) / h) + 1, H = Math.ceil((y1 - y0) / h) + 1;
  const ok = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) ok[j * W + i] = onLand(x0 + i * h, y0 + j * h) ? 1 : 0;
  const cellOf = (p: Pt) => {
    let bi = Math.round((p[0] - x0) / h), bj = Math.round((p[1] - y0) / h);
    if (ok[bj * W + bi]) return bj * W + bi;
    // nächste Landzelle
    let best = -1, bd = Infinity;
    for (let j = Math.max(0, bj - 6); j <= Math.min(H - 1, bj + 6); j++) {
      for (let i = Math.max(0, bi - 6); i <= Math.min(W - 1, bi + 6); i++) {
        const d = (i - bi) ** 2 + (j - bj) ** 2;
        if (ok[j * W + i] && d < bd) { bd = d; best = j * W + i; }
      }
    }
    return best;
  };
  const start = cellOf(cu), goal = cellOf(cv);
  if (start < 0 || goal < 0) return wide ? null : routeOnLand(u, v, via, true);
  // A* mit 8 Nachbarn
  const g = new Float64Array(W * H).fill(Infinity);
  const prev = new Int32Array(W * H).fill(-1);
  const open: [number, number][] = [[0, start]];
  g[start] = 0;
  const hx = (c: number) => Math.hypot((c % W) - (goal % W), Math.floor(c / W) - Math.floor(goal / W));
  while (open.length) {
    let bi = 0;
    for (let k = 1; k < open.length; k++) if (open[k][0] < open[bi][0]) bi = k;
    const [, c] = open[bi];
    open[bi] = open[open.length - 1];
    open.pop();
    if (c === goal) break;
    const ci = c % W, cj = Math.floor(c / W);
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const ni = ci + di, nj = cj + dj;
      if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
      const nc = nj * W + ni;
      if (!ok[nc]) continue;
      const cost = g[c] + (di && dj ? Math.SQRT2 : 1);
      if (cost < g[nc]) { g[nc] = cost; prev[nc] = c; open.push([cost + hx(nc), nc]); }
    }
  }
  if (!isFinite(g[goal])) return wide ? null : routeOnLand(u, v, via, true);
  const cells: Pt[] = [];
  for (let c = goal; c !== -1; c = prev[c]) cells.unshift([x0 + (c % W) * h, y0 + Math.floor(c / W) * h]);
  const raw: Pt[] = [cu, ...cells, cv];
  // glätten: jeweils so weit wie möglich geradeaus, solange an Land
  const out: Pt[] = [raw[0]];
  let i = 0;
  while (i < raw.length - 1) {
    let j = raw.length - 1;
    while (j > i + 1 && !segmentOnLand(raw[i], raw[j], onLand)) j--;
    out.push(raw[j]);
    i = j;
  }
  // Anteil in Provinz u: bis zur ersten Stelle, ab der der Weg in v liegt
  let total = 0, split = -1;
  for (let k = 0; k + 1 < out.length; k++) {
    const L = dist(out[k], out[k + 1]);
    const steps = Math.max(1, Math.ceil(L / 2));
    for (let s = 1; s <= steps && split < 0; s++) {
      const x = out[k][0] + ((out[k + 1][0] - out[k][0]) * s) / steps, y = out[k][1] + ((out[k + 1][1] - out[k][1]) * s) / steps;
      if (!inU(x, y) && inV(x, y)) split = total + (L * s) / steps;
    }
    total += L;
  }
  return { a: u, b: v, pts: out.flatMap(([x, y]) => [r1(x), r1(y)]), split: total > 0 ? Math.round(((split < 0 ? total / 2 : split) / total) * 1000) / 1000 : 0.5 };
}

// ---------------------------------------------------------------- Wege (Verbindungen zwischen Nachbarn)
// Nicht jede Nachbarschaft bekommt einen Weg: höchstens 5 je Provinz, mindestens 2 (sofern vorhanden);
// zusätzlich fallen rund 10 % der Wege weg. Wegfallen sollen bevorzugt lange Wege (im Vergleich zu den
// anderen Wegen der Provinz), Wege durch das Gebiet einer dritten Provinz, mit großem Umweg über die
// Grenze oder sehr kurzer gemeinsamer Grenze; bei Gleichstand bleiben Wege im eigenen Land eher erhalten.
// Das Netz bleibt zusammenhängend.
{
  const links = provinces.map((p) => new Set(p.neighbors));
  const key = (a: number, b: number) => `${Math.min(a, b)}:${Math.max(a, b)}`;
  const edgeInfo = new Map<string, { detour: number; border: number; via: Pt; straight: number; third: boolean }>();
  /** führt der gerade Weg Stadt → Grenzpunkt → Stadt durch eine dritte Provinz? */
  const crossesThird = (u: number, v: number, via: Pt) => {
    for (const [a, b] of [[provinces[u].center as Pt, via], [via, provinces[v].center as Pt]] as [Pt, Pt][]) {
      const n = Math.max(2, Math.ceil(dist(a, b) / 4));
      for (let k = 1; k < n; k++) {
        const x = a[0] + ((b[0] - a[0]) * k) / n, y = a[1] + ((b[1] - a[1]) * k) / n;
        const at = provinceIndexAt(x, y);
        if (at >= 0 && at !== u && at !== v) return true;
      }
    }
    return false;
  };
  for (const p of provinces) {
    for (const n of p.neighbors) {
      if (n < p.id) continue;
      const b = borderMap.get(key(p.id, n));
      const q = provinces[n];
      const mx = (p.center[0] + q.center[0]) / 2, my = (p.center[1] + q.center[1]) / 2;
      let via: Pt = [mx, my], bd = Infinity;
      for (let k = 0; b && k < b.segs.length; k += 2) {
        const d = Math.hypot(b.segs[k] - mx, b.segs[k + 1] - my);
        if (d < bd) { bd = d; via = [b.segs[k], b.segs[k + 1]]; }
      }
      const straight = Math.max(1, dist(p.center as Pt, q.center as Pt));
      const detour = (dist(p.center as Pt, via) + dist(via, q.center as Pt)) / straight;
      edgeInfo.set(key(p.id, n), { detour, border: b?.len ?? 0, via, straight, third: crossesThird(p.id, n, via) });
    }
  }
  const total = [...edgeInfo.keys()].length;
  const deg = (i: number) => links[i].size;
  /** bleibt v von u aus erreichbar, wenn die Verbindung u–v wegfällt? */
  const stillConnected = (u: number, v: number) => {
    const seen = new Set([u]);
    const stack = [u];
    while (stack.length) {
      const x = stack.pop()!;
      for (const y of links[x]) {
        if ((x === u && y === v) || (x === v && y === u) || seen.has(y)) continue;
        if (y === v) return true;
        seen.add(y);
        stack.push(y);
      }
    }
    return false;
  };
  /** mittlere Weglänge (Luftlinie) der Nachbarschaften einer Provinz */
  const avgLen = provinces.map((p) => {
    const ls = p.neighbors.map((n) => edgeInfo.get(key(p.id, n))!.straight);
    return ls.length ? ls.reduce((a, b) => a + b, 0) / ls.length : 1;
  });
  const score = (u: number, v: number) => {
    const e = edgeInfo.get(key(u, v))!;
    const rel = e.straight / ((avgLen[u] + avgLen[v]) / 2);
    // lange Wege zuerst; Provinzen mit 5 Verbindungen entlasten (5 soll selten sein)
    return 8 * rel + (deg(u) + deg(v)) / 2 + (deg(u) >= 5 ? 4 : 0) + (deg(v) >= 5 ? 4 : 0) + 4 * (e.detour - 1)
      + (e.border < 25 ? 2 : 0) + (e.third ? 6 : 0) - (provinces[u].nation === provinces[v].nation ? 0.5 : 0);
  };
  /** Wege zwischen zwei Nationen: zwischen Nachbarländern bleiben mindestens 2 (bzw. alle, wenn es weniger gibt) */
  const crossings = (u: number, v: number) => {
    const na = provinces[u].nation, nb = provinces[v].nation;
    let n = 0;
    for (const p of provinces) if (p.nation === na) for (const q of links[p.id]) if (provinces[q].nation === nb) n++;
    return n;
  };
  const removable = (u: number, v: number) => deg(u) > 2 && deg(v) > 2 && stillConnected(u, v)
    && (provinces[u].nation === provinces[v].nation || crossings(u, v) > 2);
  const remove = (u: number, v: number) => { links[u].delete(v); links[v].delete(u); };
  let removed = 0;
  // 1. höchstens 5 Verbindungen je Provinz
  for (let guard = 0; guard < 1000; guard++) {
    const over = provinces.map((p) => p.id).filter((i) => deg(i) > 5);
    if (!over.length) break;
    const cand = over.flatMap((u) => [...links[u]].map((v) => [u, v] as [number, number]))
      .sort((a, b) => score(b[0], b[1]) - score(a[0], a[1]));
    const pick = cand.find(([u, v]) => removable(u, v));
    if (!pick) break;
    remove(...pick);
    removed++;
  }
  // 2. auf rund 10 % ausdünnen, nur wo viele Verbindungen bestehen
  const want = Math.round(total * 0.1);
  for (let guard = 0; guard < 1000 && removed < want; guard++) {
    const cand: [number, number][] = [];
    for (const p of provinces) for (const n of links[p.id]) if (n > p.id && deg(p.id) >= 4 && deg(n) >= 4) cand.push([p.id, n]);
    cand.sort((a, b) => score(b[0], b[1]) - score(a[0], a[1]));
    const pick = cand.find(([u, v]) => removable(u, v));
    if (!pick) break;
    remove(...pick);
    removed++;
  }
  // 3. fünf Verbindungen sollen selten sein (höchstens etwa 8 % der Provinzen)
  for (let guard = 0; guard < 1000; guard++) {
    const five = provinces.map((p) => p.id).filter((i) => deg(i) >= 5);
    if (five.length <= provinces.length * 0.08) break;
    const cand = five.flatMap((u) => [...links[u]].filter((v) => deg(v) >= 3).map((v) => [u, v] as [number, number]))
      .sort((a, b) => score(b[0], b[1]) - score(a[0], a[1]));
    const pick = cand.find(([u, v]) => removable(u, v));
    if (!pick) break;
    remove(...pick);
    removed++;
  }
  provinces.forEach((p, i) => (p.links = [...links[i]].sort((a, b) => a - b)));

  // Verlauf der Landwege: Wo der Weg Stadt → Grenzpunkt → Stadt übers Wasser führt, wird er über
  // ein Rasterwegenetz an Land um die Bucht herumgeführt und danach geglättet (eckiger Pfad).
  for (const p of provinces) {
    for (const n of p.links!) {
      if (n < p.id) continue;
      const r = routeOnLand(p.id, n, edgeInfo.get(key(p.id, n))!.via);
      if (r) roads.push(r);
    }
  }
  console.log(`Landwege mit eigenem Verlauf (sonst übers Wasser): ${roads.length}`);

  // Wege, die trotz eigener Führung durch eine dritte Provinz laufen, entfallen (sofern jede Provinz
  // mindestens 2 behält); dafür kommen kurze, saubere Wege anderswo hinzu – innerhalb der Grenzen
  // (höchstens 5 je Provinz, 5 selten). Insgesamt sinkt die Zahl der Wege dabei um höchstens 10.
  const routePts = (u: number, v: number): Pt[] => {
    const r = roads.find((x) => (x.a === u && x.b === v) || (x.a === v && x.b === u));
    if (!r) return [provinces[u].center as Pt, edgeInfo.get(key(u, v))!.via, provinces[v].center as Pt];
    const pts: Pt[] = [];
    for (let k = 0; k < r.pts.length; k += 2) pts.push([r.pts[k], r.pts[k + 1]]);
    return r.a === u ? pts : pts.reverse();
  };
  const thirdShare = (pts: Pt[], u: number, v: number) => {
    let bad = 0, total = 0;
    for (let k = 0; k + 1 < pts.length; k++) {
      const n = Math.max(2, Math.ceil(dist(pts[k], pts[k + 1]) / 4));
      for (let s = 1; s < n; s++) {
        const x = pts[k][0] + ((pts[k + 1][0] - pts[k][0]) * s) / n, y = pts[k][1] + ((pts[k + 1][1] - pts[k][1]) * s) / n;
        total++;
        const at = provinceIndexAt(x, y);
        if (at >= 0 && at !== u && at !== v) bad++;
      }
    }
    return total ? bad / total : 0;
  };
  const countLinks = () => provinces.reduce((t, p) => t + links[p.id].size, 0) / 2;
  const startCount = countLinks();
  let dropped = 0, added = 0;
  const badLinks: [number, number, number][] = [];
  for (const p of provinces) for (const n of links[p.id]) if (n > p.id) {
    const sh = thirdShare(routePts(p.id, n), p.id, n);
    if (sh > 0.03) badLinks.push([p.id, n, sh]);
  }
  badLinks.sort((a, b) => b[2] - a[2]);
  console.log('Wege durch dritte Provinzen:', badLinks.map(([u, v, sh]) => `${provinces[u].name}–${provinces[v].name} ${Math.round(sh * 100)} % (${links[u].size}/${links[v].size})`).join(', ') || 'keine');
  for (const [u, v] of badLinks) {
    if (!removable(u, v)) continue;
    remove(u, v);
    const i = roads.findIndex((x) => (x.a === u && x.b === v) || (x.a === v && x.b === u));
    if (i >= 0) roads.splice(i, 1);
    dropped++;
  }
  const fives = () => provinces.filter((p) => links[p.id].size >= 5).length;
  /** sauberen Weg u–v anlegen (ohne Wasser und dritte Provinzen, innerhalb der Grenzen); true bei Erfolg */
  const tryAdd = (u: number, v: number): boolean => {
    if (links[u].has(v) || links[u].size >= 5 || links[v].size >= 5) return false;
    if ((links[u].size === 4 || links[v].size === 4) && fives() + 1 > provinces.length * 0.08) return false;
    const via = edgeInfo.get(key(u, v))!.via;
    const straight: Pt[] = [provinces[u].center as Pt, via, provinces[v].center as Pt];
    let r: ReturnType<typeof routeOnLand> = null;
    if (!segmentOnLand(straight[0], via, anyLand) || !segmentOnLand(via, straight[2], anyLand) || thirdShare(straight, u, v) > 0.03) {
      r = routeOnLand(u, v, via);
      if (!r) return false;
      const pts: Pt[] = [];
      for (let k = 0; k < r.pts.length; k += 2) pts.push([r.pts[k], r.pts[k + 1]]);
      if (thirdShare(pts, u, v) > 0.03) return false;
    }
    links[u].add(v);
    links[v].add(u);
    if (r) roads.push(r);
    added++;
    return true;
  };
  // Provinzen mit nur 2 Wegen erst einen sauberen Ersatz geben, damit der schlechte Weg entfallen kann
  for (const [u, v] of badLinks) {
    if (!links[u].has(v) || removable(u, v)) continue;
    for (const w of [u, v]) {
      if (links[w].size > 2) continue;
      const opts = provinces[w].neighbors.filter((x) => !links[w].has(x)).sort((a, b) => score(w, a) - score(w, b));
      for (const x of opts) if (tryAdd(w, x)) break;
    }
    if (removable(u, v)) {
      remove(u, v);
      const i = roads.findIndex((x) => (x.a === u && x.b === v) || (x.a === v && x.b === u));
      if (i >= 0) roads.splice(i, 1);
      dropped++;
    }
  }
  const cands: [number, number][] = [];
  for (const p of provinces) for (const n of p.neighbors) if (n > p.id && !links[p.id].has(n)) cands.push([p.id, n]);
  cands.sort((a, b) => score(a[0], a[1]) - score(b[0], b[1]));
  for (const [u, v] of cands) {
    if (countLinks() >= startCount) break;
    tryAdd(u, v);
  }
  provinces.forEach((p, i) => (p.links = [...links[i]].sort((a, b) => a - b)));
  console.log(`Wege durch dritte Provinzen gestrichen: ${dropped}, als Ersatz angelegt: ${added}, Wege jetzt: ${countLinks()} (vorher ${startCount})`);
  // Wasserwege: jede Küstenprovinz mindestens einer (dort liegt der Hafen), höchstens 2 – Inseln ohne
  // Landnachbarn bis 4. Behalten werden die Seegebiete, die der Stadt am nächsten liegen.
  const seaDist = (p: MapProvince, z: number) => {
    let best = Infinity;
    for (const poly of seaZones[z].shape) for (const ring of poly) for (const v of ring) best = Math.min(best, dist(p.center as Pt, v));
    return best;
  };
  for (const p of provinces) {
    const max = p.neighbors.length === 0 ? 4 : 2;
    p.seaLinks = [...p.seas].sort((a, b) => seaDist(p, a) - seaDist(p, b)).slice(0, max).sort((a, b) => a - b);
    // feste Vorgabe aus der Konfiguration
    const fixed = config.seaLinks?.[p.name];
    if (fixed) p.seaLinks = fixed.map((n) => seaZones.findIndex((z) => z.name === n)).filter((z) => z >= 0 && p.seas.includes(z));
  }
  const seaTotal = provinces.reduce((t, p) => t + p.seas.length, 0), seaKept = provinces.reduce((t, p) => t + p.seaLinks!.length, 0);
  console.log(`Wasserwege: ${seaKept} von ${seaTotal} Küstenanbindungen`);
  const hist = new Map<number, number>();
  for (const p of provinces) hist.set(p.links!.length, (hist.get(p.links!.length) ?? 0) + 1);
  console.log(`Wege: ${total - removed} von ${total} Nachbarschaften (${removed} entfernt); Verbindungen je Provinz: ${[...hist].sort((a, b) => a[0] - b[0]).map(([k, n]) => `${k}×${n}`).join(' ')}`);
}

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
  roads,
};

// Seewege durchs Wasser, danach Wegbündel mit Kreuzungen und Abkürzungen (je auf frischer Geometrie)
{
  const sea = waterRoutes({ ...data }, anyLand);
  data.roads = [...(data.roads ?? []), ...sea];
  console.log(`Seewege durchs Wasser verlegt: ${sea.length}`);
  const bundled = bundleRoutes({ ...data }, provs.map((p) => p.shape));
  const key = (a: number, b: number) => `${Math.min(a, b)}:${Math.max(a, b)}`;
  const replaced = new Set(bundled.roads.map((r) => key(r.a, r.b)));
  data.roads = [...data.roads.filter((r) => !replaced.has(key(r.a, r.b))), ...bundled.roads];
  // je Ortspaar nur eine Abkürzung (die kürzere), falls zwei Bündel dieselbe Verbindung anbieten
  const scLen = (s: { pts: number[] }) => {
    let l = 0;
    for (let k = 2; k < s.pts.length; k += 2) l += Math.hypot(s.pts[k] - s.pts[k - 2], s.pts[k + 1] - s.pts[k - 1]);
    return l;
  };
  const bestSc = new Map<string, (typeof bundled.shortcuts)[number]>();
  for (const s of bundled.shortcuts) {
    const k = key(s.a, s.b), old = bestSc.get(k);
    if (!old || scLen(s) < scLen(old)) bestSc.set(k, s);
  }
  data.shortcuts = [...bestSc.values()];
  // Seewege zusammenlegen (auf der Geometrie nach dem Bündeln)
  const snapped = snapSeaLanes({ ...data });
  const snappedKeys = new Set(snapped.roads.map((r) => key(r.a, r.b)));
  data.roads = [...data.roads.filter((r) => !snappedKeys.has(key(r.a, r.b))), ...snapped.roads];
  // Kreuzungspunkte dicht beieinander (unter 20 km) zusammenfassen
  data.junctions = [];
  for (const j of [...bundled.junctions, ...snapped.junctions]) {
    if (!data.junctions.some((k) => Math.hypot(k.x - j.x, k.y - j.y) < 20)) data.junctions.push(j);
  }
  console.log(`Seewege zusammengelegt: ${snapped.roads.length}, Kreuzungen auf See: ${snapped.junctions.length}`);
  const where = (n: number) => (n < provinces.length ? provinces[n].name : seaZones[n - provinces.length].name);
  console.log(`Wegkreuzungen: ${bundled.junctions.length} (${bundled.junctions.map((j) => where(j.node)).join(', ')}), Abkürzungen: ${bundled.shortcuts.length}`);
}

// Maßstab: alle Lagen in km verkleinern (Zuschnitt und Wege bleiben, nur die Entfernungen schrumpfen)
if (config.scale && config.scale !== 1) {
  const s = config.scale;
  const sc = (v: number) => r1(v * s);
  const scFlat = (a: number[]) => a.map(sc);
  data.bounds = data.bounds.map(sc) as MapData['bounds'];
  for (const p of data.provinces) {
    p.polys = p.polys.map((poly) => poly.map(scFlat));
    p.center = [sc(p.center[0]), sc(p.center[1])];
    p.mid = [sc(p.mid[0]), sc(p.mid[1])];
    p.area = Math.round(p.area * s * s);
  }
  for (const z of data.seas) {
    z.polys = z.polys.map((poly) => poly.map(scFlat));
    z.center = [sc(z.center[0]), sc(z.center[1])];
  }
  for (const b of data.borders) b.segs = scFlat(b.segs);
  data.seaBorders = scFlat(data.seaBorders);
  for (const r of data.roads ?? []) r.pts = scFlat(r.pts);
  for (const r of data.shortcuts ?? []) r.pts = scFlat(r.pts);
  for (const j of data.junctions ?? []) { j.x = sc(j.x); j.y = sc(j.y); }
  console.log(`Maßstab ${s}: Entfernungen ${Math.round((1 - s) * 100)} % kürzer`);
}

// Grundkarte sichern, dann die Handarbeit aus dem Karteneditor anwenden (scripts/maps/<id>.edits.json)
const baseOut = path.join(ROOT, 'data', 'maps', `${config.id}.base.json`);
fs.mkdirSync(path.dirname(baseOut), { recursive: true });
fs.writeFileSync(baseOut, JSON.stringify(data));
const editsFile = path.join(ROOT, 'scripts', 'maps', `${config.id}.edits.json`);
let final: MapData = data;
if (fs.existsSync(editsFile)) {
  const res = applyEdits(data, JSON.parse(fs.readFileSync(editsFile, 'utf8')));
  final = res.map;
  console.log(`Vorgaben aus dem Karteneditor angewendet${res.warnings.length ? `; Hinweise: ${res.warnings.join('; ')}` : ''}`);
}
const outDir = path.join(ROOT, 'public', 'maps');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `${config.id}.json`);
fs.writeFileSync(out, JSON.stringify(final));
const isolated = provinces.filter((p) => p.neighbors.length === 0 && !p.coastal).map((p) => p.name);
if (isolated.length) console.warn('Ohne Nachbarn und Küste:', isolated.join(', '));
console.log(`geschrieben: ${out} (${Math.round(fs.statSync(out).size / 1024)} KB), Küstenprovinzen: ${provinces.filter((p) => p.coastal).length}`);
console.log('Rohstoffprüfung (Entfernung Hauptstadt → nächstes Feld, eigene Provinz = 0):');
console.log(checkReport(final, (nation) => config.oilLimit?.[nation] ?? (config.nations.find((n) => n.id === nation)!.major ? 1 : 0)));
