// Wegebenachbarungen: gerade Wegabschnitte verschiedener Wege, die fast parallel übereinander
// oder sehr nah nebeneinander liegen, werden auf die Referenzgerade gesnappt (exaktes
// Übereinanderlegen statt doppelt gezeichneter, "dicker" Linien). Es wirken nur Abschnitte,
// nie ganze Wege: Kollineare Fächer von der Stadt aus behalten ihre Spreizung am entfernten Ende,
// und stark abwinkelnde Wege (Fach) werden wegen des Winkelkriteriums nie zusammengefasst.
// Zusätzlich: mergeRailSegs fasst (nach dem Snapping kollineare) Schienenabschnitte zu einem Zug zusammen.

import type { MapData } from './mapdata.ts';
import { edgeParts, edgePoints, isSea, nodeNeighbors } from './graph.ts';

type Pt = [number, number];

const MAX_DIST = 1.0; // km – Abschnitt gilt als „auf derselben Straße“, wenn er innerhalb dieses Lotabstands liegt
const MAX_ANGLE = (2.5 * Math.PI) / 180; // noch winkelgleich zur Referenzgeraden (darüber: echter Fächer/Kreuzung)
const MIN_OVERLAP = 2; // km – gemeinsamer Abschnitt mindestens so lang, sonst Zufallskreuzung
const r3 = (v: number) => Math.round(v * 1000) / 1000; // gesnappte Punkte: Metergenauigkeit

interface EdgeRec {
  u: number; // Provinzseite (immer < P)
  v: number;
  harbor: boolean;
  pts: Pt[]; // von u nach anderen Knoten
  boundary: number; // Landgrenze bzw. Wasseraustritt: Abstand von pts[0]
  roadAIsU: boolean | null; // vorhandene Straße? gilt split ab u?
  changed: boolean;
}

function lineAngle(p: Pt, q: Pt): number {
  let a = Math.atan2(q[1] - p[1], q[0] - p[0]);
  if (a < 0) a += Math.PI;
  if (a >= Math.PI) a -= Math.PI;
  return a;
}

function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % Math.PI;
  return Math.min(d, Math.PI - d);
}

function project(p: Pt, l0: Pt, d: Pt): Pt {
  const t = (p[0] - l0[0]) * d[0] + (p[1] - l0[1]) * d[1];
  return [l0[0] + d[0] * t, l0[1] + d[1] * t];
}

function totalLen(pts: Pt[]): number {
  let s = 0;
  for (let k = 0; k + 1 < pts.length; k++) s += Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]);
  return s;
}

/** Schnitt der Intervalle [lo[i], hi[i]], leer wenn keines */
function intersectIv(ivs: [number, number][]): [number, number] | null {
  let lo = -Infinity, hi = Infinity;
  for (const [a, b] of ivs) { lo = Math.max(lo, a); hi = Math.min(hi, b); }
  return hi > lo ? [lo, hi] : null;
}

/**
 * Snapped überlappende gerade Wegabschnitte auf die jeweils längere Referenzgerade.
 * Nur der Abschnitt innerhalb von MAX_DIST Lotabstand wird auf die Referenz gelegt;
 * Endpunkte (Städte, Seepunkte, Küsten) bleiben an ihrem Ort.
 * Liefert eine neue MapData (Kopie mit angepassten/ergänzten roads); ohne Änderung das Original.
 */
export function snapEdgeOverlaps(map: MapData): MapData {
  // Mehrere Runden: eine Runde kann Abschnitte verschieben, die anderen Paaren erst die Überdeckung zeigen
  let work = map;
  for (let round = 0; round < 5; round++) {
    const next = snapPass(work);
    if (next === work) break;
    work = next;
  }
  return work;
}

function snapPass(map: MapData): MapData {
  const P = map.provinces.length;
  const N = P + map.seas.length;
  const roadByKey = new Map<number, { a: number; b: number; pts: number[]; split: number }>();
  for (const r of map.roads ?? []) roadByKey.set(Math.min(r.a, r.b) * N + Math.max(r.a, r.b), r);
  const shortcutKeys = new Set((map.shortcuts ?? []).map((s) => Math.min(s.a, s.b) * N + Math.max(s.a, s.b)));

  // Kanten und Geometrie einmalig ablesen (danach nur noch auf Arbeitskopien geändert)
  const edges: EdgeRec[] = [];
  const push = (u: number, v: number, harbor: boolean) => {
    if (shortcutKeys.has(Math.min(u, v) * N + Math.max(u, v))) return;
    const pts = edgePoints(map, u, v).map(([x, y]) => [x, y] as Pt);
    if (pts.length < 2) return;
    const [l1] = edgeParts(map, u, v);
    const rd = roadByKey.get(Math.min(u, v) * N + Math.max(u, v));
    edges.push({ u, v, harbor, pts, boundary: l1, roadAIsU: rd ? rd.a === u : null, changed: false });
  };
  for (let u = 0; u < P; u++) {
    for (const v of nodeNeighbors(map, u)) if (v > u && !isSea(map, v)) push(u, v, false);
    for (const z of map.provinces[u].seaLinks ?? map.provinces[u].seas) push(u, P + z, true);
  }

  // gerade Abschnitte; an Hafenwegen nur der Landanteil (Segment vollständig vor Wasseraustritt)
  interface Seg { e: EdgeRec; p: Pt; q: Pt; len: number; ang: number }
  const segs: Seg[] = [];
  for (const e of edges) {
    let cum = 0;
    for (let k = 0; k + 1 < e.pts.length; k++) {
      const L = Math.hypot(e.pts[k + 1][0] - e.pts[k][0], e.pts[k + 1][1] - e.pts[k][1]);
      cum += L;
      if (L > 0.01 && (!e.harbor || cum <= e.boundary + 1e-6)) segs.push({ e, p: e.pts[k], q: e.pts[k + 1], len: L, ang: lineAngle(e.pts[k], e.pts[k + 1]) });
    }
  }

  // Kandidaten: kürzerer Abschnitt wird abschnittsweise auf den längeren gesnappt
  interface Cand { tgt: Seg; refP: Pt; refD: Pt; s0: number; s1: number; refLen: number }
  const cands: Cand[] = [];
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const a = segs[i], b = segs[j];
      if (a.e === b.e) continue;
      if (angleDiff(a.ang, b.ang) > MAX_ANGLE) continue;
      const [ref, tgt] = a.len >= b.len ? [a, b] : [b, a];
      const d: Pt = [(ref.q[0] - ref.p[0]) / ref.len, (ref.q[1] - ref.p[1]) / ref.len];
      const n: Pt = [-d[1], d[0]];
      // Lotabstand und Projektion der Zielpunkte sind linear entlang des Zielabschnitts
      const o0 = (tgt.p[0] - ref.p[0]) * n[0] + (tgt.p[1] - ref.p[1]) * n[1];
      const o1 = (tgt.q[0] - ref.p[0]) * n[0] + (tgt.q[1] - ref.p[1]) * n[1];
      const t0 = (tgt.p[0] - ref.p[0]) * d[0] + (tgt.p[1] - ref.p[1]) * d[1];
      const t1 = (tgt.q[0] - ref.p[0]) * d[0] + (tgt.q[1] - ref.p[1]) * d[1];
      const ivs: [number, number][] = [[0, tgt.len]];
      // |o(s)| ≤ MAX_DIST (s in km Bogenlänge entlang des Zielabschnitts)
      if (Math.abs(o0) <= MAX_DIST && Math.abs(o1) <= MAX_DIST) ivs.push([0, tgt.len]);
      else {
        const dv = o1 - o0;
        if (Math.abs(dv) < 1e-9) continue; // parallel und zu weit weg
        const lo = ((-MAX_DIST - o0) / dv) * tgt.len, hi = ((MAX_DIST - o0) / dv) * tgt.len;
        ivs.push([Math.min(lo, hi), Math.max(lo, hi)]);
      }
      // Projektion im Bereich der Referenz
      if (Math.abs(t1 - t0) < 1e-9) ivs.push(t0 >= 0 && t0 <= ref.len ? [0, tgt.len] : [1, 0]);
      else {
        const lo = ((0 - t0) / (t1 - t0)) * tgt.len, hi = ((ref.len - t0) / (t1 - t0)) * tgt.len;
        ivs.push([Math.min(lo, hi), Math.max(lo, hi)]);
      }
      const iv = intersectIv(ivs);
      if (!iv || iv[1] - iv[0] < MIN_OVERLAP) continue;
      // liegt der Überlappungsbereich schon (auf mm genau) auf der Referenz → nichts zu tun (Idempotenz)
      const os0 = o0 + ((o1 - o0) * iv[0]) / tgt.len;
      const os1 = o0 + ((o1 - o0) * iv[1]) / tgt.len;
      if (Math.abs(os0) <= 0.002 && Math.abs(os1) <= 0.002) continue;
      cands.push({ tgt, refP: ref.p, refD: d, s0: iv[0], s1: iv[1], refLen: ref.len });
    }
  }
  if (!cands.length) return map;
  cands.sort((x, y) => y.refLen - x.refLen || x.tgt.e.u - y.tgt.e.u || x.tgt.p[0] - y.tgt.p[0] || x.tgt.p[1] - y.tgt.p[1]);

  // Anwenden: Überlappungspunkte einsetzen und auf die Referenzgerade legen
  for (const c of cands) {
    const pts = c.tgt.e.pts;
    let m = -1;
    for (let k = 0; k + 1 < pts.length; k++) {
      if (Math.hypot(pts[k][0] - c.tgt.p[0], pts[k][1] - c.tgt.p[1]) < 1e-6 && Math.hypot(pts[k + 1][0] - c.tgt.q[0], pts[k + 1][1] - c.tgt.q[1]) < 1e-6) { m = k; break; }
    }
    if (m < 0) continue; // Abschnitt durch früheres Snapping schon verändert
    const A = pts[m], B = pts[m + 1];
    const L = Math.hypot(B[0] - A[0], B[1] - A[1]);
    const dd: Pt = [(B[0] - A[0]) / L, (B[1] - A[1]) / L];
    const at = (s: number): Pt => [A[0] + dd[0] * s, A[1] + dd[1] * s];
    const X0 = at(c.s0), X1 = at(c.s1);
    const P0 = project(X0, c.refP, c.refD), P1 = project(X1, c.refP, c.refD);
    // Kette von A nach B mit eingelegtem Referenzstück; überflüssige Punkte weglassen
    const chain: Pt[] = [A];
    const near = (p: Pt) => Math.hypot(p[0] - chain[chain.length - 1][0], p[1] - chain[chain.length - 1][1]) < 1e-6;
    for (const p of [X0, P0, P1, X1, B]) if (!near(p)) chain.push([r3(p[0]), r3(p[1])]);
    if (chain.length === 2) continue; // liegt schon auf der Referenz
    let cum = 0;
    for (let k = 0; k < m; k++) cum += Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]);
    // Landgrenze / Wasseraustritt entlang der neuen Kette mitnehmen
    const dOld = c.tgt.e.boundary;
    if (dOld > cum + L + 1e-9) {
      let newLen = 0;
      for (let k = 0; k + 1 < chain.length; k++) newLen += Math.hypot(chain[k + 1][0] - chain[k][0], chain[k + 1][1] - chain[k][1]);
      c.tgt.e.boundary = dOld + newLen - L;
    } else if (dOld > cum - 1e-9) {
      const want = dOld - cum; // Anteil innerhalb der alten Segmentlänge
      const f = L > 0 ? Math.max(0, Math.min(1, want / L)) : 0;
      let newLen = 0;
      for (let k = 0; k + 1 < chain.length; k++) newLen += Math.hypot(chain[k + 1][0] - chain[k][0], chain[k + 1][1] - chain[k][1]);
      let acc = 0, dNew = newLen;
      const target = f * newLen;
      for (let k = 0; k + 1 < chain.length; k++) {
        const sl = Math.hypot(chain[k + 1][0] - chain[k][0], chain[k + 1][1] - chain[k][1]);
        if (target <= acc + sl + 1e-9) { dNew = acc + Math.max(0, target - acc); break; }
        acc += sl;
      }
      c.tgt.e.boundary = cum + dNew;
    }
    c.tgt.e.pts = [...pts.slice(0, m), ...chain, ...pts.slice(m + 2)];
    c.tgt.e.changed = true;
  }

  const changed = edges.filter((e) => e.changed);
  if (!changed.length) return map;

  // Zurückschreiben: Straßen anpassen bzw. anlegen (split so, dass die Landgrenze gleich bleibt)
  const replacedRoads = new Map<number, { a: number; b: number; pts: number[]; split: number }>();
  const newRoads: { a: number; b: number; pts: number[]; split: number }[] = [];
  for (const e of changed) {
    const len = totalLen(e.pts);
    const fFromU = len > 0 ? Math.max(0, Math.min(1, e.boundary / len)) : 1;
    const key = Math.min(e.u, e.v) * N + Math.max(e.u, e.v);
    const rd = roadByKey.get(key);
    if (rd) {
      const fromA = rd.a === e.u ? e.pts : [...e.pts].reverse();
      const split = rd.a === e.u ? fFromU : 1 - fFromU;
      replacedRoads.set(key, { a: rd.a, b: rd.b, pts: fromA.flatMap(([x, y]) => [x, y]), split: Math.round(split * 1000) / 1000 });
    } else {
      newRoads.push({ a: e.u, b: e.v, pts: e.pts.flatMap(([x, y]) => [r3(x), r3(y)]), split: Math.round(fFromU * 1000) / 1000 });
    }
  }
  const roads = (map.roads ?? []).map((r) => replacedRoads.get(Math.min(r.a, r.b) * N + Math.max(r.a, r.b)) ?? r);
  return { ...map, roads: [...roads, ...newRoads] };
}

/**
 * Schienenabschnitte (Weltkoordinaten, km) zusammenfassen: überlappende oder sich berührende
 * Abschnitte auf derselben Geraden werden ein Zug. Nach dem Kantensnapping liegen doppelte
 * Schienen exakt aufeinander und werden hier zu genau einem Zug vereint.
 */
export function mergeRailSegs(
  segs: [number, number, number, number][],
  angTol = 5e-4,
  offTol = 0.15,
): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  const used = new Array(segs.length).fill(false);
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const [ax, ay, bx, by] = segs[i];
    const L = Math.hypot(bx - ax, by - ay);
    if (L < 1e-9) continue;
    const dx = (bx - ax) / L, dy = (by - ay) / L;
    const ai = lineAngle([ax, ay], [bx, by]);
    const group: number[] = [i];
    for (let j = i + 1; j < segs.length; j++) {
      if (used[j]) continue;
      const [cx, cy, ex, ey] = segs[j];
      const L2 = Math.hypot(ex - cx, ey - cy);
      if (L2 < 1e-9) continue;
      if (angleDiff(ai, lineAngle([cx, cy], [ex, ey])) > angTol) continue;
      const o1 = Math.abs((cx - ax) * dy - (cy - ay) * dx);
      const o2 = Math.abs((ex - ax) * dy - (ey - ay) * dx);
      if (Math.max(o1, o2) > offTol) continue;
      used[j] = true;
      group.push(j);
    }
    const iv = group
      .map((k) => {
        const [px, py, qx, qy] = segs[k];
        const t0 = (px - ax) * dx + (py - ay) * dy;
        const t1 = (qx - ax) * dx + (qy - ay) * dy;
        return [Math.min(t0, t1), Math.max(t0, t1)] as [number, number];
      })
      .sort((p, q) => p[0] - q[0]);
    let c0 = iv[0][0], c1 = iv[0][1];
    const flush = () => {
      if (c1 - c0 > 1e-6) out.push([ax + dx * c0, ay + dy * c0, ax + dx * c1, ay + dy * c1]);
    };
    for (let k = 1; k < iv.length; k++) {
      if (iv[k][0] <= c1) c1 = Math.max(c1, iv[k][1]);
      else { flush(); c0 = iv[k][0]; c1 = iv[k][1]; }
    }
    flush();
  }
  return out;
}
