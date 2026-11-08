// Kartenentwurf für den Karten-Zeichner: frei gezeichnete Provinzen mit gemeinsamen Eckpunkten (Topologie –
// Nachbarprovinzen teilen sich ihre Grenzpunkte, Verschieben wirkt auf beide), Seepunkte, Verbindungen,
// Nationen und Rohstoffe. exportDraft() erzeugt daraus eine spielfertige MapData mit Seeknoten.
//
// Ringe sind Listen von Eckpunkt-IDs ohne Wiederholung des ersten Punkts. Ausrichtung: Außenringe haben
// eine negative Fläche nach der Schuhbandformel (x_i·y_{i+1} − x_{i+1}·y_i, y nach unten), Löcher eine
// positive – so liegt das Innere einer Provinz stets auf derselben Seite jeder Kante (wichtig fürs Verschmelzen).

import { Delaunay } from 'd3-delaunay';
import polygonClipping, { type MultiPolygon as PcMulti, type Polygon as PcPoly } from 'polygon-clipping';
import type { MapBorder, MapData, MapProvince, MapSea, Resource } from './mapdata.ts';
import { snapEdgeOverlaps } from './pathsnap.ts';

export type Pt = [number, number];

export interface DraftProvince {
  id: number;
  name: string;
  nation: string | null;
  /** Multipolygon aus Eckpunkt-IDs: je Teil zuerst der Außenring, danach Löcher */
  polys: number[][][];
  /** Provinzhauptstadt (km); null = automatisch im Inneren */
  city: Pt | null;
  /** größere Stadt (mehr Siegpunkte, KI bevorzugt sie) */
  bigCity: boolean;
  resource: Resource | null;
  double: boolean;
  /** keine Hafenprovinz: bekommt keinen Wasserweg, auch nicht ans nächste Seegebiet (z. B. nur an einen See ohne Seepunkt angrenzend) */
  noHarbor: boolean;
}

export interface DraftSea {
  id: number;
  name: string;
  at: Pt;
}

export interface DraftNation {
  id: string;
  name: string;
  color: string;
  /** Großmacht (volle KI) oder Kleinstaat */
  major: boolean;
  /** Provinz-ID der Hauptstadt */
  capital: number | null;
}

/** Farben der Kartenvorlage (PNG) für das Einlesen */
export interface ImportColors {
  land: string;
  border: string;
  capital: string;
  sea: string;
  link: string;
}

/** Knotenbezug einer Verbindung: 'p12' = Provinz-ID 12, 's3' = Seepunkt-ID 3 */
export type NodeRef = string;

export interface Draft {
  version: 1;
  id: string;
  name: string;
  description: string;
  /** Kartengröße in km */
  width: number;
  height: number;
  verts: Record<number, Pt>;
  provinces: DraftProvince[];
  seas: DraftSea[];
  /** Verbindungen; drittes Element = Knickpunkte in km zwischen den Endpunkten */
  links: [NodeRef, NodeRef, Pt[]?][];
  nations: DraftNation[];
  /** nächste freie ID (gemeinsam für Eckpunkte, Provinzen und Seepunkte) */
  nextId: number;
  colors?: ImportColors;
}

export const DEFAULT_COLORS: ImportColors = {
  land: '#ffffff',
  border: '#000000',
  capital: '#ff0000',
  sea: '#0000ff',
  link: '#00ff00',
};

export function newDraft(id: string, name: string, width: number, height: number): Draft {
  return {
    version: 1, id, name, description: '', width, height,
    verts: {}, provinces: [], seas: [], links: [], nations: [], nextId: 1,
    colors: { ...DEFAULT_COLORS },
  };
}

export const provRef = (id: number): NodeRef => `p${id}`;
export const seaRef = (id: number): NodeRef => `s${id}`;
export function parseRef(r: NodeRef): { kind: 'p' | 's'; id: number } {
  return { kind: r[0] as 'p' | 's', id: Number(r.slice(1)) };
}

// ---------------------------------------------------------------- Geometrie

export function signedArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function pointInRing(pts: Pt[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function distToSeg(p: Pt, a: Pt, b: Pt): { d: number; t: number } {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return { d: Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t)), t };
}

export function ringPts(d: Draft, ring: number[]): Pt[] {
  return ring.map((v) => d.verts[v]);
}

/** Polygonteile einer Provinz als Koordinaten */
export function provPts(d: Draft, p: DraftProvince): Pt[][][] {
  return p.polys.map((part) => part.map((r) => ringPts(d, r)));
}

function inParts(parts: Pt[][][], x: number, y: number): boolean {
  for (const part of parts) {
    if (!part.length || !pointInRing(part[0], x, y)) continue;
    let hole = false;
    for (let k = 1; k < part.length; k++) if (pointInRing(part[k], x, y)) hole = true;
    if (!hole) return true;
  }
  return false;
}

export function provinceContains(d: Draft, p: DraftProvince, x: number, y: number): boolean {
  return inParts(provPts(d, p), x, y);
}

/** oberste Provinz am Punkt (zuletzt gezeichnete liegt oben) */
export function provinceAt(d: Draft, x: number, y: number): DraftProvince | null {
  for (let i = d.provinces.length - 1; i >= 0; i--) if (provinceContains(d, d.provinces[i], x, y)) return d.provinces[i];
  return null;
}

export function provArea(d: Draft, p: DraftProvince): number {
  let a = 0;
  for (const part of p.polys) for (const r of part) a -= signedArea(ringPts(d, r));
  return a;
}

function distToRings(rings: Pt[][], x: number, y: number): number {
  let best = Infinity;
  for (const r of rings) {
    for (let i = 0; i < r.length; i++) best = Math.min(best, distToSeg([x, y], r[i], r[(i + 1) % r.length]).d);
  }
  return best;
}

/** Punkt im Inneren mit größtem Wert von score(Abstand zum Rand, Punkt) – Rastersuche mit Verfeinerung */
function bestInside(parts: Pt[][][], score: (dB: number, x: number, y: number) => number): Pt | null {
  // größter Teil
  let part: Pt[][] | null = null, pa = -1;
  for (const pp of parts) {
    if (!pp.length) continue;
    const a = Math.abs(signedArea(pp[0]));
    if (a > pa) { pa = a; part = pp; }
  }
  if (!part) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of part[0]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  let best: Pt | null = null, bs = -Infinity;
  let step = Math.max(x1 - x0, y1 - y0) / 14 || 1;
  let cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, half = Math.max(x1 - x0, y1 - y0) / 2;
  for (let round = 0; round < 4; round++) {
    for (let x = cx - half; x <= cx + half + 1e-9; x += step) {
      for (let y = cy - half; y <= cy + half + 1e-9; y += step) {
        if (!inParts([part], x, y)) continue;
        const s = score(distToRings(part, x, y), x, y);
        if (s > bs) { bs = s; best = [x, y]; }
      }
    }
    if (!best) break;
    cx = best[0]; cy = best[1]; half = step * 1.5; step /= 3;
  }
  if (!best) {
    // sehr schmale Teile: Mittelpunkt der längsten Kante leicht nach innen
    const r = part[0];
    best = [(r[0][0] + r[1][0]) / 2, (r[0][1] + r[1][1]) / 2];
  }
  return best;
}

/** Punkt tief im Inneren der Provinz (Ersatz für eine fehlende Hauptstadt) */
export function interiorPoint(d: Draft, p: DraftProvince): Pt {
  return bestInside(provPts(d, p), (dB) => dB) ?? [0, 0];
}

/** Stadt der Provinz: gesetzt oder automatisch */
export function cityOf(d: Draft, p: DraftProvince): Pt {
  return p.city ?? interiorPoint(d, p);
}

/** Lage des Rohstoffsymbols: weit vom Rand und nicht auf der Stadt */
export function midPoint(d: Draft, p: DraftProvince, city: Pt): Pt {
  return bestInside(provPts(d, p), (dB, x, y) => Math.min(dB, 0.8 * Math.hypot(x - city[0], y - city[1]))) ?? city;
}

// ---------------------------------------------------------------- Abfragen

export function nearestVertex(d: Draft, x: number, y: number, r: number, skip?: Set<number>): number | null {
  let best: number | null = null, bd = r;
  for (const [k, p] of Object.entries(d.verts)) {
    const id = Number(k);
    if (skip?.has(id)) continue;
    const dd = Math.hypot(p[0] - x, p[1] - y);
    if (dd <= bd) { bd = dd; best = id; }
  }
  return best;
}

/** alle Ringe mit Provinz, Teil- und Ringindex */
export function* allRings(d: Draft): Generator<{ p: DraftProvince; part: number; ring: number; ids: number[] }> {
  for (const p of d.provinces) {
    for (let i = 0; i < p.polys.length; i++) for (let k = 0; k < p.polys[i].length; k++) yield { p, part: i, ring: k, ids: p.polys[i][k] };
  }
}

export function nearestEdge(d: Draft, x: number, y: number, r: number): { a: number; b: number; at: Pt } | null {
  let best: { a: number; b: number; at: Pt } | null = null, bd = r;
  for (const { ids } of allRings(d)) {
    for (let i = 0; i < ids.length; i++) {
      const a = ids[i], b = ids[(i + 1) % ids.length];
      const pa = d.verts[a], pb = d.verts[b];
      const { d: dd, t } = distToSeg([x, y], pa, pb);
      if (dd < bd) { bd = dd; best = { a, b, at: [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t] }; }
    }
  }
  return best;
}

/** jede Kante einmal: Schlüssel "kleine-große ID" → Provinz-IDs links/rechts */
export function edgeOwners(d: Draft): Map<string, { a: number; b: number; owners: number[] }> {
  const m = new Map<string, { a: number; b: number; owners: number[] }>();
  for (const { p, ids } of allRings(d)) {
    for (let i = 0; i < ids.length; i++) {
      const a = ids[i], b = ids[(i + 1) % ids.length];
      if (a === b) continue;
      const k = a < b ? `${a}-${b}` : `${b}-${a}`;
      let e = m.get(k);
      if (!e) m.set(k, (e = { a: Math.min(a, b), b: Math.max(a, b), owners: [] }));
      if (!e.owners.includes(p.id)) e.owners.push(p.id);
    }
  }
  return m;
}

// ---------------------------------------------------------------- Bearbeiten (verändern den übergebenen Entwurf)

export function addVertex(d: Draft, at: Pt): number {
  const id = d.nextId++;
  d.verts[id] = [round1(at[0]), round1(at[1])];
  return id;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/** neuen Punkt auf der Kante a–b einfügen (in allen Ringen, die diese Kante haben) */
export function insertOnEdge(d: Draft, a: number, b: number, at: Pt): number {
  const v = addVertex(d, at);
  for (const { ids } of allRings(d)) {
    for (let i = 0; i < ids.length; i++) {
      const j = (i + 1) % ids.length;
      if ((ids[i] === a && ids[j] === b) || (ids[i] === b && ids[j] === a)) {
        ids.splice(i + 1, 0, v);
        i++;
      }
    }
  }
  return v;
}

export function moveVertex(d: Draft, v: number, at: Pt): void {
  if (d.verts[v]) d.verts[v] = [round1(at[0]), round1(at[1])];
}

/** Punkt v mit Punkt w zusammenlegen (v verschwindet) */
export function weldVertex(d: Draft, v: number, w: number): void {
  if (v === w) return;
  for (const { ids } of allRings(d)) for (let i = 0; i < ids.length; i++) if (ids[i] === v) ids[i] = w;
  for (const p of d.provinces) p.polys = p.polys.map((part) => part.map(cleanRing)).map((part) => part.filter((r) => r.length >= 3)).filter((part) => part.length);
  delete d.verts[v];
}

function cleanRing(ids: number[]): number[] {
  const out = ids.filter((v, i) => v !== ids[(i + 1) % ids.length]);
  return out;
}

/** Punkt entfernen; misslingt, wenn ein Ring dadurch weniger als drei Punkte hätte */
export function deleteVertex(d: Draft, v: number): boolean {
  for (const { ids } of allRings(d)) if (ids.includes(v) && ids.length <= 3) return false;
  for (const { ids } of allRings(d)) {
    const i = ids.indexOf(v);
    if (i >= 0) ids.splice(i, 1);
  }
  delete d.verts[v];
  return true;
}

/**
 * Nachzeichnen: Zwischenpunkte von a nach b entlang einer bestehenden Grenze (kürzerer Weg über einen
 * Ring, der beide enthält); null, wenn kein Ring beide enthält.
 */
export function tracePath(d: Draft, a: number, b: number): number[] | null {
  let best: number[] | null = null, bl = Infinity;
  for (const { ids } of allRings(d)) {
    const i = ids.indexOf(a), j = ids.indexOf(b);
    if (i < 0 || j < 0 || i === j) continue;
    const n = ids.length;
    for (const dir of [1, -1]) {
      const path: number[] = [];
      let len = 0, prev = a;
      for (let k = (i + dir + n) % n; ; k = (k + dir + n) % n) {
        const v = ids[k];
        len += Math.hypot(d.verts[v][0] - d.verts[prev][0], d.verts[v][1] - d.verts[prev][1]);
        prev = v;
        if (v === b) break;
        path.push(v);
      }
      if (len < bl) { bl = len; best = path; }
    }
  }
  return best;
}

/** Ring als Außenring ausrichten (negative Fläche) */
export function orientOuter(d: Draft, ring: number[]): number[] {
  return signedArea(ringPts(d, ring)) > 0 ? [...ring].reverse() : ring;
}

export function addProvince(d: Draft, ring: number[], props: Partial<DraftProvince> = {}): DraftProvince {
  const id = d.nextId++;
  const p: DraftProvince = {
    id, name: props.name ?? `Provinz ${d.provinces.length + 1}`, nation: props.nation ?? null,
    polys: [[orientOuter(d, cleanRing(ring))]], city: props.city ?? null, bigCity: props.bigCity ?? false,
    resource: props.resource ?? null, double: props.double ?? false, noHarbor: props.noHarbor ?? false,
  };
  d.provinces.push(p);
  return p;
}

export function getProvince(d: Draft, id: number): DraftProvince | undefined {
  return d.provinces.find((p) => p.id === id);
}

/**
 * Provinz entlang eines Pfades teilen: path[0] und path[last] liegen auf demselben Außenring, die Punkte
 * dazwischen im Inneren. Der abgetrennte Teil wird eine neue Provinz (gleiche Nation). Gibt sie zurück.
 */
export function splitProvince(d: Draft, pid: number, path: number[]): DraftProvince | string {
  const p = getProvince(d, pid);
  if (!p) return 'Provinz nicht gefunden';
  if (path.length < 2) return 'Pfad zu kurz';
  const u = path[0], v = path[path.length - 1];
  if (u === v) return 'Anfang und Ende sind derselbe Punkt';
  const partIdx = p.polys.findIndex((part) => part[0].includes(u) && part[0].includes(v));
  if (partIdx < 0) return 'Anfang und Ende müssen auf dem Außenrand derselben Provinz liegen';
  const part = p.polys[partIdx];
  const ring = part[0];
  const n = ring.length;
  const i = ring.indexOf(u), j = ring.indexOf(v);
  const inner = path.slice(1, -1);
  if (!inner.length && ((i + 1) % n === j || (j + 1) % n === i)) return 'Die beiden Punkte sind schon durch eine Kante verbunden';
  const walk = (from: number, to: number) => {
    const out: number[] = [];
    for (let k = from; ; k = (k + 1) % n) {
      out.push(ring[k]);
      if (k === to) break;
    }
    return out;
  };
  const a = [...walk(i, j), ...[...inner].reverse()];
  const b = [...walk(j, i), ...inner];
  if (a.length < 3 || b.length < 3) return 'Teilstück zu klein';
  const holes = part.slice(1);
  const ptsA = ringPts(d, a);
  const holesA = holes.filter((h) => pointInRing(ptsA, ...d.verts[h[0]]));
  const holesB = holes.filter((h) => !holesA.includes(h));
  p.polys[partIdx] = [a, ...holesA];
  const np = addProvince(d, b, { nation: p.nation, name: `${p.name} (2)`, noHarbor: p.noHarbor });
  np.polys = [[b, ...holesB]];
  // Stadt bleibt im Teil, in dem sie liegt
  if (p.city && pointInRing(ringPts(d, b), p.city[0], p.city[1])) {
    np.city = p.city;
    np.bigCity = p.bigCity;
    p.city = null;
    p.bigCity = false;
  }
  return np;
}

/** Ringe aus gerichteten Kanten zusammensetzen */
function ringsFromEdges(edges: [number, number][]): number[][] {
  const from = new Map<number, number[]>();
  edges.forEach(([a], i) => (from.get(a) ?? from.set(a, []).get(a)!).push(i));
  const used = new Array(edges.length).fill(false);
  const rings: number[][] = [];
  for (let s = 0; s < edges.length; s++) {
    if (used[s]) continue;
    const ring: number[] = [];
    let e = s;
    const start = edges[s][0];
    for (;;) {
      used[e] = true;
      ring.push(edges[e][0]);
      const end = edges[e][1];
      if (end === start) break;
      const next = (from.get(end) ?? []).find((k) => !used[k]);
      if (next === undefined) break;
      e = next;
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

/** Ringe nach Ausrichtung in Teile gliedern: Außenringe (negativ) mit den Löchern (positiv), die darin liegen */
function partsFromRings(d: Draft, rings: number[][]): number[][][] {
  const outers = rings.filter((r) => signedArea(ringPts(d, r)) < 0);
  const holes = rings.filter((r) => signedArea(ringPts(d, r)) >= 0);
  const parts = outers.map((r) => [r]);
  for (const h of holes) {
    const at = d.verts[h[0]];
    let best = -1, ba = Infinity;
    outers.forEach((o, i) => {
      const pts = ringPts(d, o);
      // Lochpunkt liegt auf dem Rand des Außenrings? dann über den Mittelpunkt einer Lochkante prüfen
      const probe: Pt = o.includes(h[0]) ? [(at[0] + d.verts[h[1]][0]) / 2, (at[1] + d.verts[h[1]][1]) / 2] : at;
      if (pointInRing(pts, probe[0], probe[1])) {
        const a = Math.abs(signedArea(pts));
        if (a < ba) { ba = a; best = i; }
      }
    });
    if (best >= 0) parts[best].push(h);
  }
  return parts;
}

/** Provinz b in a aufgehen lassen (gemeinsame Grenzen verschwinden) */
export function mergeProvinces(d: Draft, aId: number, bId: number): string | null {
  const a = getProvince(d, aId), b = getProvince(d, bId);
  if (!a || !b || a === b) return 'zwei verschiedene Provinzen wählen';
  const edges: [number, number][] = [];
  for (const p of [a, b]) {
    for (const part of p.polys) for (const r of part) for (let i = 0; i < r.length; i++) edges.push([r[i], r[(i + 1) % r.length]]);
  }
  // gegenläufige Kantenpaare (gemeinsame Grenze) entfernen
  const count = new Map<string, number>();
  for (const [u, v] of edges) count.set(`${u}>${v}`, (count.get(`${u}>${v}`) ?? 0) + 1);
  const keep: [number, number][] = [];
  for (const [u, v] of edges) {
    const k = `${u}>${v}`, kb = `${v}>${u}`;
    if ((count.get(k) ?? 0) <= 0) continue; // schon als Gegenstück verbraucht
    count.set(k, count.get(k)! - 1);
    if ((count.get(kb) ?? 0) > 0) {
      count.set(kb, count.get(kb)! - 1);
      continue;
    }
    keep.push([u, v]);
  }
  a.polys = partsFromRings(d, ringsFromEdges(keep));
  if (!a.city && b.city) { a.city = b.city; a.bigCity = b.bigCity; }
  a.noHarbor = a.noHarbor && b.noHarbor; // nur wenn beide Teile keine Häfen durften, bleibt die Sperre
  removeProvince(d, bId, aId);
  return null;
}

/** Provinz löschen; Verbindungen und Hauptstädte wandern zu `into` (falls angegeben) */
export function removeProvince(d: Draft, id: number, into?: number): void {
  d.provinces = d.provinces.filter((p) => p.id !== id);
  const r = provRef(id);
  d.links = into === undefined
    ? d.links.filter(([x, y]) => x !== r && y !== r)
    : dedupeLinks(d.links.map((l) => [l[0] === r ? provRef(into) : l[0], l[1] === r ? provRef(into) : l[1], l[2]]));
  for (const n of d.nations) if (n.capital === id) n.capital = into ?? null;
  pruneVerts(d);
}

export function removeSea(d: Draft, id: number): void {
  d.seas = d.seas.filter((z) => z.id !== id);
  const r = seaRef(id);
  d.links = d.links.filter(([x, y]) => x !== r && y !== r);
}

function dedupeLinks(links: [NodeRef, NodeRef, Pt[]?][]): [NodeRef, NodeRef, Pt[]?][] {
  const seen = new Set<string>();
  const out: [NodeRef, NodeRef, Pt[]?][] = [];
  for (const [x, y, bends] of links) {
    if (x === y) continue;
    const k = x < y ? `${x}|${y}` : `${y}|${x}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(bends?.length ? [x, y, bends] : [x, y]);
  }
  return out;
}

/** Verbindung mit ihren Knickpunkten als durchgehender Zug von Endpunkt zu Endpunkt */
export function linkPts(d: Draft, l: [NodeRef, NodeRef, Pt[]?]): Pt[] | null {
  const a = nodeAt(d, l[0]), b = nodeAt(d, l[1]);
  if (!a || !b) return null;
  return [a, ...(l[2] ?? []), b];
}

const linkPair = (d: Draft, a: NodeRef, b: NodeRef) =>
  d.links.find(([x, y]) => (x === a && y === b) || (x === b && y === a));

/** Knickpunkt in eine Verbindung einfügen (wird an die Stelle der Linie gesetzt) */
export function insertBend(d: Draft, a: NodeRef, b: NodeRef, at: Pt): boolean {
  const l = linkPair(d, a, b);
  if (!l) return false;
  (l[2] ??= []).push([round1(at[0]), round1(at[1])]);
  return true;
}

export function moveBend(d: Draft, a: NodeRef, b: NodeRef, k: number, at: Pt): boolean {
  const l = linkPair(d, a, b);
  if (!l?.[2]?.[k]) return false;
  l[2][k] = [round1(at[0]), round1(at[1])];
  return true;
}

export function deleteBend(d: Draft, a: NodeRef, b: NodeRef, k: number): boolean {
  const l = linkPair(d, a, b);
  if (!l?.[2]?.[k]) return false;
  l[2].splice(k, 1);
  if (!l[2].length) delete l[2];
  return true;
}

export function hasLink(d: Draft, a: NodeRef, b: NodeRef): boolean {
  return d.links.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

/** Verbindung an/aus; gibt true zurück, wenn sie jetzt besteht */
export function toggleLink(d: Draft, a: NodeRef, b: NodeRef): boolean {
  if (a === b) return false;
  if (hasLink(d, a, b)) {
    d.links = d.links.filter(([x, y]) => !((x === a && y === b) || (x === b && y === a)));
    return false;
  }
  d.links.push([a, b]);
  return true;
}

/** nicht mehr benutzte Eckpunkte entfernen */
export function pruneVerts(d: Draft): void {
  const used = new Set<number>();
  for (const { ids } of allRings(d)) for (const v of ids) used.add(v);
  for (const k of Object.keys(d.verts)) if (!used.has(Number(k))) delete d.verts[Number(k)];
}

/** alle Koordinaten mit fx/fy strecken (Kartengröße ändern) */
export function rescaleDraft(d: Draft, width: number, height: number): void {
  const fx = width / d.width, fy = height / d.height;
  for (const k of Object.keys(d.verts)) {
    const p = d.verts[Number(k)];
    d.verts[Number(k)] = [round1(p[0] * fx), round1(p[1] * fy)];
  }
  for (const p of d.provinces) if (p.city) p.city = [round1(p.city[0] * fx), round1(p.city[1] * fy)];
  for (const z of d.seas) z.at = [round1(z.at[0] * fx), round1(z.at[1] * fy)];
  for (const l of d.links) if (l[2]) l[2] = l[2].map(([x, y]) => [round1(x * fx), round1(y * fy)] as Pt);
  d.width = width;
  d.height = height;
}

/** Lage eines Knotens (Provinz: Stadt, Seepunkt: Punkt) */
export function nodeAt(d: Draft, r: NodeRef, cities?: Map<number, Pt>): Pt | null {
  const { kind, id } = parseRef(r);
  if (kind === 's') return d.seas.find((z) => z.id === id)?.at ?? null;
  const p = getProvince(d, id);
  if (!p) return null;
  return cities?.get(id) ?? cityOf(d, p);
}

/**
 * Verbindungen ergänzen: Nachbarprovinzen (gemeinsame Kante), Küstenprovinzen ohne Hafen zum nächsten
 * Seepunkt, benachbarte Seepunkte (Delaunay, nicht über Land, nicht länger als maxSeaKm). Gibt die Zahl
 * der neuen Verbindungen zurück.
 */
export function autoLinks(d: Draft, opt: { land?: boolean; harbors?: boolean; seas?: boolean; maxSeaKm?: number } = {}): number {
  const before = d.links.length;
  const add = (a: NodeRef, b: NodeRef) => { if (a !== b && !hasLink(d, a, b)) d.links.push([a, b]); };
  const owners = edgeOwners(d);
  for (const e of owners.values()) if (e.owners.length === 2 && opt.land !== false) add(provRef(e.owners[0]), provRef(e.owners[1]));
  const coastal = new Set(coastalProvinceIds(d)); // Küste ja, aber Kartenrand-Segmente zählen nicht
  const cities = new Map(d.provinces.map((p) => [p.id, cityOf(d, p)]));
  if (opt.harbors !== false && d.seas.length) {
    for (const id of coastal) {
      if (getProvince(d, id)?.noHarbor) continue; //markierte Nicht-Hafenprovinzen bleiben außen vor
      const r = provRef(id);
      if (d.links.some(([x, y]) => (x === r && y[0] === 's') || (y === r && x[0] === 's'))) continue;
      const c = cities.get(id)!;
      let best: DraftSea | null = null, bd = Infinity;
      for (const z of d.seas) {
        const dd = Math.hypot(z.at[0] - c[0], z.at[1] - c[1]);
        if (dd < bd) { bd = dd; best = z; }
      }
      if (best) add(r, seaRef(best.id));
    }
  }
  if (opt.seas !== false && d.seas.length >= 2) {
    const pts = d.seas.map((z) => z.at);
    const del = Delaunay.from(pts);
    // typischer Abstand: Median der Abstände zum nächsten Nachbarn
    const nn = pts.map((p, i) => {
      let best = Infinity;
      for (const j of del.neighbors(i)) best = Math.min(best, Math.hypot(pts[j][0] - p[0], pts[j][1] - p[1]));
      return best;
    }).filter(Number.isFinite).sort((a, b) => a - b);
    const max = opt.maxSeaKm ?? (nn.length ? nn[Math.floor(nn.length / 2)] * 2.2 : Infinity);
    for (let i = 0; i < pts.length; i++) {
      for (const j of del.neighbors(i)) {
        if (j <= i) continue;
        const len = Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]);
        if (len > max) continue;
        const steps = Math.max(2, Math.ceil(len / 5));
        let land = false;
        for (let k = 1; k < steps && !land; k++) {
          const t = k / steps;
          if (provinceAt(d, pts[i][0] + (pts[j][0] - pts[i][0]) * t, pts[i][1] + (pts[j][1] - pts[i][1]) * t)) land = true;
        }
        if (!land) add(seaRef(d.seas[i].id), seaRef(d.seas[j].id));
      }
    }
  }
  return d.links.length - before;
}

/**
 * Provinzen, die tatsächlich am Wasser liegen: Kanten mit nur einem Eigentümer zählen als Küste,
 * Segmente entlang des Kartenrands nicht – dort bricht die Karte ab (Land geht weiter), das ist
 * kein Seezugang.
 */
export function coastalProvinceIds(d: Draft): number[] {
  const on = (v: number, edge: number) => Math.abs(v - edge) <= 0.5;
  const coastal = new Set<number>();
  for (const e of edgeOwners(d).values()) {
    if (e.owners.length !== 1) continue;
    const [ax, ay] = d.verts[e.a], [bx, by] = d.verts[e.b];
    const alongFrame = (on(ax, 0) && on(bx, 0)) || (on(ax, d.width) && on(bx, d.width))
      || (on(ay, 0) && on(by, 0)) || (on(ay, d.height) && on(by, d.height));
    if (!alongFrame) coastal.add(e.owners[0]);
  }
  return [...coastal];
}

/**
 * Küstenprovinzen ohne Anschluss: grenzen an Wasser, haben aber keine Verbindung zu einem Seepunkt
 * und sind nicht als „kein Hafen“ markiert. Für die Hervorhebung im Zeichner und die Prüfung.
 */
export function coastsWithoutHarbor(d: Draft): number[] {
  const coastal = new Set(coastalProvinceIds(d));
  const harbor = new Set<number>();
  for (const [x, y] of d.links) {
    const a = parseRef(x), b = parseRef(y);
    if (a.kind === 'p' && b.kind === 's') harbor.add(a.id);
    else if (a.kind === 's' && b.kind === 'p') harbor.add(b.id);
  }
  return d.provinces.filter((p) => coastal.has(p.id) && !harbor.has(p.id) && !p.noHarbor).map((p) => p.id);
}

// ---------------------------------------------------------------- Export ins Spielformat

export interface ExportResult {
  map: MapData | null;
  errors: string[];
  warnings: string[];
}

const r1 = (v: number) => Math.round(v * 10) / 10;

export function exportDraft(d: Draft): ExportResult {
  const errors: string[] = [], warnings: string[] = [];
  const provs = d.provinces.filter((p) => p.polys.some((part) => part.length && part[0].length >= 3));
  if (!provs.length) errors.push('Keine Provinzen gezeichnet.');
  if (!d.nations.length) errors.push('Keine Nationen angelegt.');
  if (!/^[a-z0-9_-]+$/.test(d.id)) errors.push('Karten-ID nur aus a–z, 0–9, _ und - bilden.');
  const idx = new Map(provs.map((p, i) => [p.id, i]));
  const nationIds = new Set<string>();
  for (const n of d.nations) {
    if (!n.id.trim()) errors.push(`Nation „${n.name}“ ohne Kürzel.`);
    if (nationIds.has(n.id)) errors.push(`Kürzel ${n.id} doppelt vergeben.`);
    nationIds.add(n.id);
    const own = provs.filter((p) => p.nation === n.id);
    if (!own.length) errors.push(`${n.name}: keine Provinzen.`);
    else if (n.capital === null) errors.push(`${n.name}: keine Hauptstadt gewählt.`);
    else if (!own.some((p) => p.id === n.capital)) errors.push(`${n.name}: Hauptstadt liegt nicht in einer eigenen Provinz.`);
  }
  const unassigned = provs.filter((p) => !p.nation || !nationIds.has(p.nation));
  if (unassigned.length) errors.push(`${unassigned.length} Provinzen ohne Nation (z. B. ${unassigned.slice(0, 3).map((p) => p.name).join(', ')}).`);
  const noRes = provs.filter((p) => !p.resource);
  if (noRes.length) warnings.push(`${noRes.length} Provinzen ohne Rohstoff – sie bekommen Getreide (z. B. ${noRes.slice(0, 3).map((p) => p.name).join(', ')}).`);
  const names = new Map<string, number>();
  for (const p of provs) names.set(p.name, (names.get(p.name) ?? 0) + 1);
  const dupNames = [...names].filter(([, c]) => c > 1).map(([n]) => n);
  if (dupNames.length) warnings.push(`Doppelte Provinznamen: ${dupNames.slice(0, 5).join(', ')}${dupNames.length > 5 ? ' …' : ''}`);
  if (errors.length) return { map: null, errors, warnings };

  const P = provs.length;
  const seaIdx = new Map(d.seas.map((z, i) => [z.id, i]));
  // Grenzen aus gemeinsamen Kanten
  const borderSegs = new Map<string, { a: number; b: number; segs: number[] }>();
  let overlaps = 0;
  for (const e of edgeOwners(d).values()) {
    const o = e.owners.filter((id) => idx.has(id)).map((id) => idx.get(id)!);
    if (!o.length) continue;
    if (o.length > 2) overlaps++;
    const a = o.length >= 2 ? Math.min(o[0], o[1]) : o[0];
    const b = o.length >= 2 ? Math.max(o[0], o[1]) : -1;
    const k = `${a}|${b}`;
    let bs = borderSegs.get(k);
    if (!bs) borderSegs.set(k, (bs = { a, b, segs: [] }));
    const pa = d.verts[e.a], pb = d.verts[e.b];
    bs.segs.push(r1(pa[0]), r1(pa[1]), r1(pb[0]), r1(pb[1]));
  }
  if (overlaps) warnings.push(`${overlaps} Kanten gehören zu mehr als zwei Provinzen (überlappende Provinzen?).`);
  const borders: MapBorder[] = [...borderSegs.values()];
  const neighbors = provs.map(() => new Set<number>());
  for (const b of borders) if (b.b >= 0) { neighbors[b.a].add(b.b); neighbors[b.b].add(b.a); }

  // Verbindungen
  const links = provs.map(() => new Set<number>());
  const seaLinks = provs.map(() => new Set<number>());
  const seaSeas = d.seas.map(() => new Set<number>());
  const seaCoasts = d.seas.map(() => new Set<number>());
  const noHbIgnore = new Set<number>(); // markierte Nicht-Hafenprovinzen mit vorhandenem Wasserweg
  for (const [x, y] of d.links) {
    const a = parseRef(x), b = parseRef(y);
    const ia = a.kind === 'p' ? idx.get(a.id) : seaIdx.get(a.id);
    const ib = b.kind === 'p' ? idx.get(b.id) : seaIdx.get(b.id);
    if (ia === undefined || ib === undefined) continue;
    if (a.kind === 'p' && b.kind === 'p') { links[ia].add(ib); links[ib].add(ia); }
    else if (a.kind === 's' && b.kind === 's') { seaSeas[ia].add(ib); seaSeas[ib].add(ia); }
    else {
      const p = a.kind === 'p' ? ia : ib, z = a.kind === 'p' ? ib : ia;
      if (provs[p].noHarbor) { noHbIgnore.add(p); continue; } // als Nicht-Hafen markiert: Wasserweg bleibt weg
      seaLinks[p].add(z);
      seaCoasts[z].add(p);
    }
  }
  if (noHbIgnore.size) warnings.push(`${noHbIgnore.size} als „kein Hafen“ markierte Provinzen: vorhandene Wasserwege werden ignoriert (${provs.filter((_, i) => noHbIgnore.has(i)).slice(0, 3).map((p) => p.name).join(', ')}${noHbIgnore.size > 3 ? ' …' : ''}).`);
  const coastReal = new Set(coastalProvinceIds(d)); // Kartenrand zählt nicht als Küste
  const isolated = provs.filter((_, i) => !links[i].size && !seaLinks[i].size);
  if (isolated.length) warnings.push(`${isolated.length} Provinzen ohne Verbindung (z. B. ${isolated.slice(0, 3).map((p) => p.name).join(', ')}).`);
  const waterNoHarbor = provs.filter((p) => coastReal.has(p.id) && !seaLinks[idx.get(p.id)!].size && d.seas.length && !p.noHarbor);
  if (waterNoHarbor.length > 0) warnings.push(`${waterNoHarbor.length} Provinzen am Wasser ohne Hafen-Verbindung zu einem Seepunkt.`);
  const lonelySeas = d.seas.filter((_, i) => !seaSeas[i].size && !seaCoasts[i].size);
  if (lonelySeas.length) warnings.push(`${lonelySeas.length} Seepunkte ohne Verbindung.`);

  const provinces: MapProvince[] = provs.map((p, i) => {
    const center = cityOf(d, p);
    const nation = d.nations.find((n) => n.id === p.nation)!;
    const capital = nation.capital === p.id;
    const ln = [...links[i]].sort((a, b) => a - b);
    const sl = [...seaLinks[i]].sort((a, b) => a - b);
    return {
      id: i,
      name: p.name,
      nation: p.nation!,
      polys: p.polys.filter((part) => part.length && part[0].length >= 3).map((part) => part.map((r) => ringPts(d, r).flatMap(([x, y]) => [r1(x), r1(y)]))),
      center: [r1(center[0]), r1(center[1])],
      lonlat: [0, 0],
      mid: midPoint(d, p, center).map(r1) as Pt,
      area: Math.round(provArea(d, p)),
      city: p.bigCity || capital,
      capital,
      coastal: sl.length > 0,
      resource: p.resource ?? 'grain',
      double: p.double,
      neighbors: [...new Set([...neighbors[i], ...ln])].sort((a, b) => a - b),
      links: ln,
      seaLinks: sl,
      seas: sl,
    };
  });

  // Seepunkte: Einzugsbereich = Voronoi-Zelle ohne Land (für Anklicken und den Hafenpunkt an der Küste)
  const land: PcMulti = provs.flatMap((p) => provPts(d, p).filter((part) => part.length) as PcPoly[]);
  const landBoxes = land.map((poly) => bbox(poly[0]));
  const vor = d.seas.length ? Delaunay.from(d.seas.map((z) => z.at)).voronoi([0, 0, d.width, d.height]) : null;
  let onLand = 0;
  const seas: MapSea[] = d.seas.map((z, i) => {
    if (provinceAtList(d, provs, z.at)) onLand++;
    let polys: number[][][] = [];
    const cell = vor?.cellPolygon(i) as Pt[] | null;
    if (cell && cell.length >= 4) {
      const cb = bbox(cell);
      const near = land.filter((_, k) => overlapBox(cb, landBoxes[k]));
      let shape: PcMulti = [[cell]];
      try {
        if (near.length) shape = polygonClipping.difference([cell], ...near.map((q) => [q] as PcMulti));
      } catch {
        shape = [[cell]];
      }
      polys = shape.map((poly) => poly.map((ring) => {
        const pts = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring;
        return pts.flatMap(([x, y]) => [r1(x), r1(y)]);
      }));
    }
    // Hit-Test im Spiel nutzt den Außenring: Teil mit dem Punkt nach vorne
    polys.sort((pa, pb) => Number(pointInFlat(pb[0], z.at)) - Number(pointInFlat(pa[0], z.at)));
    return {
      id: i,
      name: z.name,
      polys,
      center: [r1(z.at[0]), r1(z.at[1])],
      seas: [...seaSeas[i]].sort((a, b) => a - b),
      coasts: [...seaCoasts[i]].sort((a, b) => a - b),
    };
  });
  if (onLand) warnings.push(`${onLand} Seepunkte liegen auf Land.`);

  // Wege mit Knicken: die Knickpunkte werden Weggeometrie für das Spiel
  // (pts von a nach b, split = Anteil der Länge bis zur Wassergrenze bzw. bis zu Provinz b – wie im Kartenbau).
  // Endet die Verbindung im Wasser, zählt nur der Landanteil: Knicke an Land wirken (Einschiffpunkt
  // ist der Austritt aus der Provinz), Knicke im eigentlichen Wasser werden verworfen – Seewege bleiben gerade.
  const roads: { a: number; b: number; pts: number[]; split: number }[] = [];
  let seaBends = 0;
  for (const [x, y, bends] of d.links) {
    const A = parseRef(x), B = parseRef(y);
    const ia = A.kind === 'p' ? idx.get(A.id) : seaIdx.get(A.id);
    const ib = B.kind === 'p' ? idx.get(B.id) : seaIdx.get(B.id);
    if (ia === undefined || ib === undefined) continue;
    const bothLand = A.kind === 'p' && B.kind === 'p';
    if (!bends?.length) {
      // Gerader Landweg: als explizite Straße schreiben, damit das Spiel keinen eigenen
      // Grenzknick einfügt – die gezogene Linie Stadt → Stadt ist der Weg.
      if (bothLand) {
        const ca = cityOf(d, provs[ia!]!), cb = cityOf(d, provs[ib!]!);
        const L = Math.hypot(cb[0] - ca[0], cb[1] - ca[1]);
        let split = 1;
        const n = Math.max(1, Math.ceil(L / 2));
        for (let s = 1; s <= n; s++) {
          if (provinceContains(d, provs[ib!]!, ca[0] + ((cb[0] - ca[0]) * s) / n, ca[1] + ((cb[1] - ca[1]) * s) / n)) {
            // Eintritt in Provinz b per Bisektion eingrenzen
            let lo = (s - 1) / n, hi = s / n;
            for (let it = 0; it < 10; it++) {
              const mid = (lo + hi) / 2;
              if (provinceContains(d, provs[ib!]!, ca[0] + (cb[0] - ca[0]) * mid, ca[1] + (cb[1] - ca[1]) * mid)) hi = mid; else lo = mid;
            }
            split = hi;
            break;
          }
        }
        roads.push({ a: ia!, b: ib!, pts: [r1(ca[0]), r1(ca[1]), r1(cb[0]), r1(cb[1])], split: Math.round(split * 1000) / 1000 });
        continue;
      }
      if (A.kind === B.kind) continue; // gerader See↔See-Weg bleibt implizit gerade
      const landFirst = A.kind === 'p';
      const prov = provs[landFirst ? ia! : ib!]!, z = d.seas.find((q) => q.id === (landFirst ? B.id : A.id))!;
      const c = cityOf(d, prov), L = Math.hypot(z.at[0] - c[0], z.at[1] - c[1]);
      let split = 1;
      const n = Math.max(1, Math.ceil(L / 2));
      for (let s = 1; s <= n; s++) {
        if (!provinceContains(d, prov, c[0] + ((z.at[0] - c[0]) * s) / n, c[1] + ((z.at[1] - c[1]) * s) / n)) {
          // Austritt zwischen den beiden letzten Abtastpunkten per Bisektion eingrenzen
          let lo = (s - 1) / n, hi = s / n;
          for (let it = 0; it < 10; it++) {
            const mid = (lo + hi) / 2;
            if (provinceContains(d, prov, c[0] + (z.at[0] - c[0]) * mid, c[1] + (z.at[1] - c[1]) * mid)) lo = mid; else hi = mid;
          }
          split = hi;
          break;
        }
      }
      roads.push({ a: landFirst ? ia! : ib!, b: P + (landFirst ? ib! : ia!), pts: [r1(c[0]), r1(c[1]), r1(z.at[0]), r1(z.at[1])], split: Math.round(split * 1000) / 1000 });
      continue;
    }
    if (!bothLand && A.kind !== 'p' && B.kind !== 'p') { seaBends++; continue; } // See–See: Knick wirkungslos
    const na = A.kind === 'p' ? ia! : P + ia!; // Seepunkte sind Knoten P + Index
    const nb = B.kind === 'p' ? ib! : P + ib!;
    const line = [bothLand || A.kind === 'p' ? cityOf(d, provs[ia!]!) : d.seas.find((z) => z.id === A.id)!.at,
      ...bends,
      bothLand || B.kind === 'p' ? cityOf(d, provs[ib!]!) : d.seas.find((z) => z.id === B.id)!.at];
    // Gesamtlänge zuerst, dann den Grenzübergang suchen (Nenner darf nicht mitschrumpfen)
    let total = 0, split = -1, cum = 0;
    const segL: number[] = [];
    for (let k = 0; k + 1 < line.length; k++) {
      const L = Math.hypot(line[k + 1][0] - line[k][0], line[k + 1][1] - line[k][1]);
      segL.push(L);
      total += L;
    }
    let keep: Pt[] | null = null;
    if (bothLand) {
      // Landweg:pts komplett behalten, split = Eintritt in Provinz b
      keep = line.slice(1, -1);
      let done = false;
      for (let k = 0; k + 1 < line.length && !done; k++) {
        const [x0, y0] = line[k], [x1, y1] = line[k + 1];
        const n = Math.max(1, Math.ceil(segL[k] / 2));
        for (let s = 1; s <= n; s++) {
          if (provinceContains(d, provs[ib]!, x0 + ((x1 - x0) * s) / n, y0 + ((y1 - y0) * s) / n)) { split = total > 0 ? (cum + (segL[k] * s) / n) / total : 0.5; done = true; break; }
        }
        cum += segL[k];
      }
    } else {
      // Hafenweg: Landseite ist die Provinz; pts nur bis zum Wasseraustritt, split dort
      const prov = A.kind === 'p' ? provs[ia!]! : provs[ib!]!;
      const rev = A.kind !== 'p'; // Seepunkt steht im Entwurf vorn → gegen die Leserichtung scannen
      const fromLand = rev ? [...line].reverse() : line;
      const segF = rev ? [...segL].reverse() : segL; // Segmentlängen in Scanreihenfolge
      let done = false;
      for (let k = 0; k + 1 < fromLand.length && !done; k++) {
        const [x0, y0] = fromLand[k], [x1, y1] = fromLand[k + 1];
        const n = Math.max(1, Math.ceil(segF[k] / 2));
        for (let s = 1; s <= n; s++) {
          if (!provinceContains(d, prov, x0 + ((x1 - x0) * s) / n, y0 + ((y1 - y0) * s) / n)) {
            split = total > 0 ? (cum + (segF[k] * s) / n) / total : 0.5;
            // alle Knicke vor dem Austrittssegment liegen an Land; liegt der Austritt erst am
            // letzten Abtastpunkt, darf der Knick des Austrittsendes (knapp auf der Küste) mit –
            // er ist der Einschiffpunkt. Knicke dahinter gehören ins Wasser und entfallen.
            const endBend = s === n && k + 1 <= fromLand.length - 3;
            const landBends = fromLand.slice(1, endBend ? k + 2 : k + 1);
            keep = rev ? [...landBends].reverse() : landBends;
            done = true;
            break;
          }
        }
        cum += segF[k];
      }
      if (!done) { split = 1; keep = A.kind === 'p' ? line.slice(1, -1) : [...line].reverse().slice(1, -1); } // Kuriosum: der Verlauf endet an Land, obwohl er im Wasser endet
      if (rev && split >= 0) split = 1 - split; // split gilt ab road.a – hier liegt der Seepunkt vorn
    }
    if (!keep?.length) { seaBends++; continue; } // kein einziger Knick an Land → nichts zu biegen
    const ptsLine = [line[0], ...keep, line[line.length - 1]];
    roads.push({ a: na, b: nb, pts: ptsLine.flatMap(([qx, qy]) => [r1(qx), r1(qy)]), split: split >= 0 ? Math.round(split * 1000) / 1000 : 0.5 });
  }
  if (seaBends) warnings.push(`${seaBends} Verbindungen mit Knicken enden im Wasser: nur Knicke an Land wirken, Knicke im Wasser werden ignoriert.`);

  const map: MapData = {
    id: d.id,
    name: d.name,
    bounds: [0, 0, d.width, d.height],
    nations: d.nations.map((n) => ({ id: n.id, name: n.name, color: n.color, major: n.major, capital: idx.get(n.capital!)! })),
    provinces,
    borders,
    seas,
    seaBorders: [],
    roads,
    seaNodes: true,
    shortcuts: [],
    junctions: [],
  };
  if (P && !d.seas.length) warnings.push('Keine Seepunkte – Schiffe haben keine Wege.');
  return { map: snapEdgeOverlaps(map), errors, warnings };
}

function provinceAtList(d: Draft, provs: DraftProvince[], at: Pt): boolean {
  return provs.some((p) => provinceContains(d, p, at[0], at[1]));
}

function bbox(pts: Pt[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [x0, y0, x1, y1];
}

function overlapBox(a: number[], b: number[]): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

function pointInFlat(ring: number[] | undefined, at: Pt): boolean {
  if (!ring) return false;
  const pts: Pt[] = [];
  for (let k = 0; k < ring.length; k += 2) pts.push([ring[k], ring[k + 1]]);
  return pointInRing(pts, at[0], at[1]);
}
