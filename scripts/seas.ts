// Seegebiete beim Kartenbau: Meer = Kartenausschnitt minus Land, ohne Binnenseen,
// aufgeteilt per k-Means + Voronoi; danach Nachbarschaften zu Seegebieten und Küstenprovinzen.

import { Delaunay } from 'd3-delaunay';
import polygonClipping from 'polygon-clipping';
import {
  bboxOf, dist, distSegment, interiorPoint, pointInMulti, pointInPoly, polyArea, ringCentroid,
  type MultiPoly, type Pt,
} from '../src/game/geom.ts';

export interface SeaZoneBuild {
  name: string;
  shape: MultiPoly;
  center: Pt;
  /** benachbarte Seegebiete (Index) */
  seas: Set<number>;
  /** angrenzende Küstenprovinzen (Index) */
  coasts: Set<number>;
}

export interface SeaOptions {
  /** ungefähre Zahl der Seegebiete */
  count: number;
  /** Wasserflächen darunter (km²) sind Binnenseen und nicht befahrbar */
  minArea: number;
  names: { name: string; pos: Pt }[];
}

export function buildSeas(rect: MultiPoly, land: MultiPoly[], opt: SeaOptions, rnd: () => number): SeaZoneBuild[] {
  const water = (polygonClipping.difference(rect as never, ...(land as never[])) as MultiPoly)
    .filter((p) => polyArea(p) >= opt.minArea);
  // Küstennahe Gewässer bekommen kleinere Seegebiete als der offene Ozean:
  // Stichproben werden mit dem Abstand zur nächsten Küste ausgedünnt.
  const coastDist = landDistance(rect, land);
  const weight = (p: Pt) => Math.max(0.06, 1 - coastDist(p) / 600) ** 1.5;
  const basins = water.map((basin) => {
    const box = bboxOf([basin]);
    const pts: Pt[] = [];
    let w = 0, n = 0;
    for (let tries = 0; pts.length < 6000 && tries < 200000; tries++) {
      const p: Pt = [box[0] + rnd() * (box[2] - box[0]), box[1] + rnd() * (box[3] - box[1])];
      if (!pointInPoly(p[0], p[1], basin)) continue;
      const wp = weight(p);
      w += wp; n++;
      if (rnd() < wp) pts.push(p);
    }
    return { basin, pts, eff: polyArea(basin) * (w / Math.max(1, n)) };
  });
  const total = basins.reduce((s, b) => s + b.eff, 0);
  const zones: SeaZoneBuild[] = [];

  for (const { basin, pts } of basins) {
    const k = Math.max(1, Math.round((opt.count * basins.find((b) => b.basin === basin)!.eff) / total));
    const shape: MultiPoly = [basin];
    const centers = kmeans(pts, Math.min(k, pts.length), rnd);
    const cells = voronoi(centers, shape);
    const local = centers.map((c, i) => ({ center: c, shape: cells[i] }));
    // abgetrennte Zellteile (hinter Inseln/Halbinseln) dem nächsten anderen Zentrum zuschlagen
    for (const z of local) {
      if (z.shape.length < 2) continue;
      const main = z.shape.reduce((a, b) => (polyArea(a) > polyArea(b) ? a : b));
      const keep: MultiPoly = [main];
      for (const part of z.shape) {
        if (part === main) continue;
        const c = ringCentroid(part[0]);
        let best: (typeof local)[number] | null = null, bd = Infinity;
        for (const o of local) {
          if (o === z || !o.shape.length) continue;
          const d = dist(o.center, c);
          if (d < bd) { bd = d; best = o; }
        }
        if (best && polyArea(part) > 200) best.shape = polygonClipping.union(best.shape as never, [part] as never) as MultiPoly;
        else keep.push(part);
      }
      z.shape = keep;
    }
    for (const z of local) {
      if (!z.shape.length) continue;
      zones.push({ name: '', shape: z.shape, center: interiorPoint(z.shape), seas: new Set(), coasts: new Set() });
    }
  }

  // Namen: nächster benannter Meerespunkt
  const used = new Map<string, number>();
  for (const z of zones) {
    let best = 'Seegebiet', bd = Infinity;
    for (const n of opt.names) {
      const d = pointInMulti(n.pos[0], n.pos[1], z.shape) ? 0 : dist(n.pos, z.center);
      if (d < bd) { bd = d; best = n.name; }
    }
    const c = used.get(best) ?? 0;
    used.set(best, c + 1);
    z.name = c === 0 ? best : `${best} ${['', 'II', 'III', 'IV', 'V', 'VI'][c] ?? c + 1}`;
  }
  return zones;
}

/** Verknüpft Seegebiete untereinander und mit Küstenprovinzen; liefert die Grenzlinien zwischen Seegebieten. */
export function linkSeas(zones: SeaZoneBuild[], provinces: MultiPoly[]): number[] {
  interface Seg { owner: number; ax: number; ay: number; bx: number; by: number }
  const CELL = 40, EPS = 0.35;
  const grid = new Map<string, Seg[]>();
  const put = (s: Seg) => {
    const gx0 = Math.floor(Math.min(s.ax, s.bx) / CELL), gx1 = Math.floor(Math.max(s.ax, s.bx) / CELL);
    const gy0 = Math.floor(Math.min(s.ay, s.by) / CELL), gy1 = Math.floor(Math.max(s.ay, s.by) / CELL);
    for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
      const key = gx + ',' + gy;
      (grid.get(key) ?? grid.set(key, []).get(key)!).push(s);
    }
  };
  const segsOf = (shape: MultiPoly, owner: number): Seg[] => {
    const out: Seg[] = [];
    for (const poly of shape) for (const ring of poly) for (let k = 0; k + 1 < ring.length; k++) {
      out.push({ owner, ax: ring[k][0], ay: ring[k][1], bx: ring[k + 1][0], by: ring[k + 1][1] });
    }
    return out;
  };
  const seaSegs = zones.flatMap((z, i) => segsOf(z.shape, i));
  seaSegs.forEach(put);
  const match = (s: Seg): Seg | null => {
    const mx = (s.ax + s.bx) / 2, my = (s.ay + s.by) / 2;
    for (const t of grid.get(Math.floor(mx / CELL) + ',' + Math.floor(my / CELL)) ?? []) {
      if (t === s || t.owner === s.owner) continue;
      if (distSegment(mx, my, t.ax, t.ay, t.bx, t.by) < EPS) return t;
    }
    return null;
  };
  const seaBorders: number[] = [];
  const r1 = (v: number) => Math.round(v * 10) / 10;
  for (const s of seaSegs) {
    const t = match(s);
    if (!t) continue;
    zones[s.owner].seas.add(t.owner);
    zones[t.owner].seas.add(s.owner);
    if (s.owner < t.owner) seaBorders.push(r1(s.ax), r1(s.ay), r1(s.bx), r1(s.by));
  }
  provinces.forEach((shape, pi) => {
    const len = new Map<number, number>();
    for (const s of segsOf(shape, -1)) {
      const t = match(s);
      if (t) len.set(t.owner, (len.get(t.owner) ?? 0) + Math.hypot(s.bx - s.ax, s.by - s.ay));
    }
    for (const [z, l] of len) if (l > 5) zones[z].coasts.add(pi);
  });
  return seaBorders;
}

/** Abstand zur nächsten Landfläche (km) über ein Raster mit Distanztransformation. */
function landDistance(rect: MultiPoly, land: MultiPoly[]): (p: Pt) => number {
  const CELL = 25;
  const [x0, y0, x1, y1] = bboxOf(rect);
  const w = Math.ceil((x1 - x0) / CELL), h = Math.ceil((y1 - y0) / CELL);
  const d = new Float32Array(w * h).fill(Infinity);
  const boxes = land.map((m) => bboxOf(m));
  const queue: number[] = [];
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const x = x0 + (i + 0.5) * CELL, y = y0 + (j + 0.5) * CELL;
    for (let k = 0; k < land.length; k++) {
      const b = boxes[k];
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
      if (pointInMulti(x, y, land[k])) { d[j * w + i] = 0; queue.push(j * w + i); break; }
    }
  }
  // Breitensuche (8er-Nachbarschaft, genähert)
  for (let q = 0; q < queue.length; q++) {
    const c = queue[q], ci = c % w, cj = (c - ci) / w;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const ni = ci + di, nj = cj + dj;
      if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
      const nd = d[c] + (di && dj ? 1.414 : 1) * CELL;
      if (nd < d[nj * w + ni]) { d[nj * w + ni] = nd; queue.push(nj * w + ni); }
    }
  }
  return (p) => {
    const i = Math.min(w - 1, Math.max(0, Math.floor((p[0] - x0) / CELL)));
    const j = Math.min(h - 1, Math.max(0, Math.floor((p[1] - y0) / CELL)));
    return d[j * w + i];
  };
}

function kmeans(pts: Pt[], k: number, rnd: () => number): Pt[] {
  const centers: Pt[] = [pts[Math.floor(rnd() * pts.length)]];
  while (centers.length < k) {
    const d2 = pts.map((p) => Math.min(...centers.map((c) => (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2)));
    let r = rnd() * d2.reduce((a, b) => a + b, 0), i = 0;
    while (i < pts.length - 1 && (r -= d2[i]) > 0) i++;
    centers.push(pts[i]);
  }
  for (let it = 0; it < 20; it++) {
    const sum = centers.map(() => [0, 0, 0]);
    for (const p of pts) {
      let best = 0, bd = Infinity;
      centers.forEach((c, i) => {
        const d = (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2;
        if (d < bd) { bd = d; best = i; }
      });
      sum[best][0] += p[0]; sum[best][1] += p[1]; sum[best][2]++;
    }
    centers.forEach((_, i) => {
      if (sum[i][2]) centers[i] = [sum[i][0] / sum[i][2], sum[i][1] / sum[i][2]];
    });
  }
  return centers;
}

function voronoi(centers: Pt[], shape: MultiPoly): MultiPoly[] {
  if (centers.length === 1) return [shape];
  const box = bboxOf(shape);
  const vor = Delaunay.from(centers).voronoi([box[0] - 50, box[1] - 50, box[2] + 50, box[3] + 50]);
  return centers.map((_, i) => {
    const cell = vor.cellPolygon(i) as Pt[] | null;
    return cell ? (polygonClipping.intersection(shape as never, [[cell]] as never) as MultiPoly) : [];
  });
}

