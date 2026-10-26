// Handarbeit an der Karte (Karteneditor): Vorgaben, die auf die generierte Grundkarte angewendet werden.
// Genutzt vom Kartenbau (scripts/build-map.ts), vom Dev-Server (Speichern) und vom Editor (Vorschau).
// Orte werden über Namen angesprochen (Provinzen und Seegebiete), Punkte in km wie in der Karte.

import type { MapData } from './mapdata.ts';

export type Pt = [number, number];

export interface MapEdits {
  /** neue Verbindungen [Name, Name]: Provinz–Provinz (auch Abkürzung durch ein Gebiet), Provinz–Seegebiet, Seegebiet–Seegebiet */
  add?: [string, string][];
  /** gestrichene Verbindungen */
  remove?: [string, string][];
  /** eigener Verlauf je Verbindung, Schlüssel "A|B": Zwischenpunkte von A nach B (ohne die Endpunkte) */
  paths?: Record<string, Pt[]>;
  /** Kreuzungspunkte: zusätzliche und entfernte (entfernt wird, was näher als 3 km liegt) */
  junctions?: { add?: Pt[]; remove?: Pt[] };
}

export interface EditResult {
  map: MapData;
  warnings: string[];
}

const r1 = (v: number) => Math.round(v * 10) / 10;

export function pairKey(a: string, b: string): string {
  return `${a}|${b}`;
}

/** Liegt der Punkt in einem Multipolygon (Ringe als flache Arrays)? */
export function inPolys(polys: number[][][], x: number, y: number): boolean {
  let inside = false;
  for (const poly of polys) {
    for (const ring of poly) {
      for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
        const xi = ring[i], yi = ring[i + 1], xj = ring[j], yj = ring[j + 1];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
  }
  return inside;
}

/** Gebiet an einem Punkt: Provinz-Index, Seegebiet als P + Index, -1 außerhalb */
export function territoryAt(map: MapData, x: number, y: number): number {
  const P = map.provinces.length;
  for (const p of map.provinces) if (inPolys(p.polys, x, y)) return p.id;
  for (const z of map.seas) if (inPolys(z.polys, x, y)) return P + z.id;
  return -1;
}

/** Punkte entlang eines Linienzugs etwa alle `step` km, mit Längenanteil */
export function samplePath(pts: Pt[], step = 2): { x: number; y: number; f: number }[] {
  const cum = [0];
  for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
  const len = cum[cum.length - 1];
  const out: { x: number; y: number; f: number }[] = [];
  if (len <= 0) return [{ x: pts[0][0], y: pts[0][1], f: 0 }];
  const n = Math.max(2, Math.ceil(len / step));
  let k = 0;
  for (let i = 0; i <= n; i++) {
    const d = (len * i) / n;
    while (k < pts.length - 2 && cum[k + 1] < d) k++;
    const seg = cum[k + 1] - cum[k];
    const t = seg > 0 ? (d - cum[k]) / seg : 0;
    out.push({ x: pts[k][0] + (pts[k + 1][0] - pts[k][0]) * t, y: pts[k][1] + (pts[k + 1][1] - pts[k][1]) * t, f: d / len });
  }
  return out;
}

/** Wendet die Vorgaben auf eine Kopie der Karte an. */
export function applyEdits(base: MapData, edits: MapEdits): EditResult {
  const map: MapData = structuredClone(base);
  const warnings: string[] = [];
  const P = map.provinces.length, N = P + map.seas.length;
  const ids = new Map<string, number>();
  map.provinces.forEach((p) => ids.set(p.name, p.id));
  map.seas.forEach((z) => ids.set(z.name, P + z.id));
  const node = (name: string) => {
    const n = ids.get(name);
    if (n === undefined) warnings.push(`Unbekannter Ort: ${name}`);
    return n;
  };
  const pos = (n: number): Pt => (n < P ? map.provinces[n].center : map.seas[n - P].center);
  const same = (a: number, b: number, x: number, y: number) => (a === x && b === y) || (a === y && b === x);
  for (const p of map.provinces) {
    p.links ??= [...p.neighbors];
    p.seaLinks ??= [...p.seas];
  }
  map.roads ??= [];
  map.shortcuts ??= [];
  map.junctions ??= [];
  const dropGeometry = (a: number, b: number) => {
    map.roads = map.roads!.filter((r) => !same(r.a, r.b, a, b));
    map.shortcuts = map.shortcuts!.filter((s) => !same(s.a, s.b, a, b));
  };
  const linked = (a: number, b: number): boolean => {
    if (a < P && b < P) return map.provinces[a].links!.includes(b) || map.shortcuts!.some((s) => same(s.a, s.b, a, b));
    if (a < P) return map.provinces[a].seaLinks!.includes(b - P);
    if (b < P) return map.provinces[b].seaLinks!.includes(a - P);
    return map.seas[a - P].seas.includes(b - P);
  };

  // Verbindungen streichen
  for (const [na, nb] of edits.remove ?? []) {
    const a = node(na), b = node(nb);
    if (a === undefined || b === undefined) continue;
    if (a < P && b < P) {
      map.provinces[a].links = map.provinces[a].links!.filter((x) => x !== b);
      map.provinces[b].links = map.provinces[b].links!.filter((x) => x !== a);
    } else if (a < P || b < P) {
      const [p, z] = a < P ? [a, b - P] : [b, a - P];
      map.provinces[p].seaLinks = map.provinces[p].seaLinks!.filter((x) => x !== z);
    } else {
      map.seas[a - P].seas = map.seas[a - P].seas.filter((x) => x !== b - P);
      map.seas[b - P].seas = map.seas[b - P].seas.filter((x) => x !== a - P);
    }
    dropGeometry(a, b);
  }

  // Verbindungen hinzufügen (Abkürzungen zwischen Provinzen ohne gemeinsame Grenze bekommen ihren Verlauf unten)
  const pending: [number, number][] = [];
  for (const [na, nb] of edits.add ?? []) {
    const a = node(na), b = node(nb);
    if (a === undefined || b === undefined || a === b || linked(a, b)) continue;
    if (a < P && b < P) {
      if (map.provinces[a].neighbors.includes(b)) {
        map.provinces[a].links!.push(b);
        map.provinces[b].links!.push(a);
      } else pending.push([a, b]);
    } else if (a < P || b < P) {
      const [p, z] = a < P ? [a, b - P] : [b, a - P];
      if (!map.provinces[p].seas.includes(z)) {
        warnings.push(`${map.provinces[p].name} grenzt nicht an ${map.seas[z].name}`);
        map.provinces[p].seas.push(z);
        map.seas[z].coasts.push(p);
      }
      map.provinces[p].seaLinks!.push(z);
    } else {
      map.seas[a - P].seas.push(b - P);
      map.seas[b - P].seas.push(a - P);
    }
  }

  // eigene Verläufe
  const paths = new Map<number, { a: number; b: number; inner: Pt[] }>();
  for (const [k, inner] of Object.entries(edits.paths ?? {})) {
    const [na, nb] = k.split('|');
    const a = node(na), b = node(nb);
    if (a === undefined || b === undefined) continue;
    paths.set(Math.min(a, b) * N + Math.max(a, b), { a, b, inner });
  }
  for (const [a, b] of pending) {
    const key = Math.min(a, b) * N + Math.max(a, b);
    const inner = paths.get(key)?.inner ?? [];
    const pts = [pos(a), ...(paths.get(key)?.a === b ? [...inner].reverse() : inner), pos(b)];
    // Gebiet, durch das die Abkürzung führt: das größte fremde Gebiet entlang des Weges
    const samples = samplePath(pts);
    const hits = new Map<number, number[]>();
    for (const s of samples) {
      const t = territoryAt(map, s.x, s.y);
      if (t !== a && t !== b && t >= 0) (hits.get(t) ?? hits.set(t, []).get(t)!).push(s.f);
    }
    if (!hits.size) {
      warnings.push(`${map.provinces[a].name}–${map.provinces[b].name}: kein Gebiet dazwischen gefunden`);
      continue;
    }
    if (hits.size > 1) warnings.push(`${map.provinces[a].name}–${map.provinces[b].name} führt durch mehrere fremde Gebiete`);
    const [via, fs] = [...hits].sort((x, y) => y[1].length - x[1].length)[0];
    map.shortcuts!.push({ a, b, via, pts: pts.flatMap(([x, y]) => [r1(x), r1(y)]), f0: Math.min(...fs), f1: Math.max(...fs) });
    paths.delete(key);
  }
  for (const { a, b, inner } of paths.values()) {
    if (!linked(a, b)) {
      warnings.push(`Verlauf ohne Verbindung: ${a < P ? map.provinces[a].name : map.seas[a - P].name}–${b < P ? map.provinces[b].name : map.seas[b - P].name}`);
      continue;
    }
    const pts = [pos(a), ...inner, pos(b)];
    const sc = map.shortcuts!.find((s) => same(s.a, s.b, a, b));
    if (sc) {
      const own = sc.a === a ? pts : [...pts].reverse();
      const fs = samplePath(own).filter((s) => territoryAt(map, s.x, s.y) === sc.via).map((s) => s.f);
      sc.pts = own.flatMap(([x, y]) => [r1(x), r1(y)]);
      if (fs.length) [sc.f0, sc.f1] = [Math.min(...fs), Math.max(...fs)];
      continue;
    }
    // Anteil der Weglänge in Provinz a (für das Tempo bis zur Grenze)
    let split = 0.5;
    if (a < P && b < P) {
      const out = samplePath(pts).find((s) => !inPolys(map.provinces[a].polys, s.x, s.y));
      split = out ? out.f : 1;
    }
    dropGeometry(a, b);
    map.roads!.push({ a, b, pts: pts.flatMap(([x, y]) => [r1(x), r1(y)]), split });
  }

  // Kreuzungen
  for (const [x, y] of edits.junctions?.remove ?? []) {
    map.junctions = map.junctions!.filter((j) => Math.hypot(j.x - x, j.y - y) >= 3);
  }
  for (const [x, y] of edits.junctions?.add ?? []) {
    const t = territoryAt(map, x, y);
    map.junctions!.push({ node: t >= 0 ? t : P, x: r1(x), y: r1(y) });
  }

  for (const p of map.provinces) {
    p.links!.sort((x, y) => x - y);
    p.seaLinks!.sort((x, y) => x - y);
  }
  for (const z of map.seas) z.seas.sort((x, y) => x - y);
  return { map, warnings };
}
