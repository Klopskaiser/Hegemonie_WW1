// Karteneditor (nur mit Dev-Server): Wege, Häfen, Seewege, Kreuzungen und Rohstoffe von Hand nachbessern.
// Bearbeitet werden Vorgaben (scripts/maps/<karte>.edits.json), die auf die generierte Grundkarte
// angewendet werden; Speichern schreibt zusätzlich die fertige Karte nach public/maps.

import { useEffect, useMemo, useRef, useState } from 'react';
import { CATEGORIES, CATEGORY_NAMES, RES_NAMES } from '../game/balance.ts';
import { edgePoints, isSea, nodeCount, nodeName, nodeNeighbors, nodePos } from '../game/graph.ts';
import { checkNation, FAR_KM, NATION_MAX, NATION_MIN } from '../game/mapcheck.ts';
import { RESOURCES, type MapData, type Resource } from '../game/mapdata.ts';
import { applyEdits, pairKey, samplePath, territoryAt, type MapEdits, type Pt } from '../game/mapedits.ts';
import { iconImage, ResIcon } from './icons.tsx';
import { forgetMap, MAPS } from './maps.ts';

interface Edge {
  u: number;
  v: number;
  pts: Pt[];
  kind: 'land' | 'harbor' | 'sea';
}

interface View { s: number; ox: number; oy: number }

interface Drag {
  /** betroffene Wegpunkte: Weg und Index im Punktzug */
  items: { e: Edge; k: number }[];
  from: Pt;
  cur: Pt;
  junction: boolean;
  moved: boolean;
  /** Abschnittsziehen: alle Punkte um denselben Vektor wie den gegriffenen verschieben */
  chunk?: boolean;
  /** eine Kreuzung wird verschoben (leere items) */
  junctionMove?: boolean;
}

/** Karten, die der Editor bearbeiten kann (Grundkarte data/maps/<id>.base.json, Vorgaben scripts/maps/<id>.edits.json) */
const EDITOR_MAPS = MAPS.filter((m) => m.available);
const SNAP_PX = 9;
const HIT_PX = 7;

const edgeId = (u: number, v: number) => `${Math.min(u, v)}-${Math.max(u, v)}`;

function distToSeg(p: Pt, a: Pt, b: Pt): { d: number; t: number } {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return { d: Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t)), t };
}

/** Prüft einen Weg: Landwege nicht über Wasser oder durch Dritte, Seewege nicht über Land */
function checkEdge(map: MapData, e: Edge): string[] {
  const P = map.provinces.length;
  const samples = samplePath(e.pts, 2).slice(1, -1);
  if (!samples.length) return [];
  const out: string[] = [];
  const terr = samples.map((s) => territoryAt(map, s.x, s.y));
  if (e.kind === 'land') {
    const water = terr.filter((t) => t < 0 || t >= P).length;
    if (water) out.push(`führt ${Math.round((100 * water) / samples.length)} % über Wasser`);
    const third = [...new Set(terr.filter((t) => t >= 0 && t < P && t !== e.u && t !== e.v))];
    if (third.length) out.push(`durch ${third.map((t) => map.provinces[t].name).join(', ')}`);
  } else if (e.kind === 'sea') {
    const land = terr.filter((t) => t >= 0 && t < P).length;
    if (land) out.push(`führt ${Math.round((100 * land) / samples.length)} % über Land`);
  } else {
    // Hafenweg: nach dem Verlassen der Küstenprovinz nur noch Wasser
    const p = e.u < P ? e.u : e.v;
    const fromLand = e.u < P ? terr : [...terr].reverse();
    const first = fromLand.findIndex((t) => t !== p);
    const land = first < 0 ? 0 : fromLand.slice(first).filter((t) => t >= 0 && t < P).length;
    if (land) out.push(`führt ${Math.round((100 * land) / samples.length)} % über Land`);
  }
  return out;
}

export function MapEditor({ onExit }: { onExit(): void }) {
  const [mapId, setMapId] = useState('europe');
  const MAP_ID = mapId;
  const [base, setBase] = useState<MapData | null>(null);
  const [edits, setEdits] = useState<MapEdits>({});
  const [history, setHistory] = useState<MapEdits[]>([]);
  const [future, setFuture] = useState<MapEdits[]>([]);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'edit' | 'connect' | 'resources'>('edit');
  const [selProv, setSelProv] = useState<number | null>(null);
  const [connectFrom, setConnectFrom] = useState<number | null>(null);
  /** Startpunkt der neuen Verbindung, wenn er eine Kreuzung war (sonst Ortsmitte) */
  const [connectFromPt, setConnectFromPt] = useState<Pt | null>(null);
  const [sel, setSel] = useState<{ u: number; v: number } | null>(null);
  const [selNode, setSelNode] = useState<number | null>(null);
  const [selVertex, setSelVertex] = useState<Pt | null>(null);
  const [selJunction, setSelJunction] = useState<Pt | null>(null);
  const [selChunk, setSelChunk] = useState<number | null>(null);
  const [merging, setMerging] = useState<{ u: number; v: number; chunk: number } | null>(null);
  const [hover, setHover] = useState('');
  const [search, setSearch] = useState('');

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const view = useRef<View>({ s: 0.2, ox: 0, oy: 0 });
  const drag = useRef<Drag | null>(null);
  const pan = useRef<{ x: number; y: number; ox: number; oy: number; moved: boolean; at: Pt } | null>(null);
  const mouse = useRef<Pt | null>(null);
  const frame = useRef(0);

  useEffect(() => {
    setBase(null);
    setEdits({});
    setHistory([]);
    setFuture([]);
    setDirty(false);
    setError('');
    setSel(null); setSelNode(null); setSelVertex(null); setSelJunction(null); setSelChunk(null); setSelProv(null);
    setConnectFrom(null); setConnectFromPt(null); setMerging(null);
    Promise.all([
      fetch(`/__editor/${MAP_ID}/base`).then((r) => (r.ok ? r.json() : r.json().then((e) => Promise.reject(new Error(e.error))))),
      fetch(`/__editor/${MAP_ID}/edits`).then((r) => r.json()),
    ]).then(([b, e]) => {
      setBase(b);
      setEdits(e);
    }).catch((e) => setError(`Editor nicht verfügbar (nur mit npm run dev): ${e.message ?? e}`));
  }, [mapId]);

  const applied = useMemo(() => (base ? applyEdits(base, edits) : null), [base, edits]);
  const map = applied?.map ?? null;

  const edges = useMemo(() => {
    if (!map) return [] as Edge[];
    const P = map.provinces.length;
    const out: Edge[] = [];
    for (let u = 0; u < nodeCount(map); u++) {
      for (const v of nodeNeighbors(map, u)) {
        if (v <= u) continue;
        const kind = u < P && v < P ? 'land' : u >= P && v >= P ? 'sea' : 'harbor';
        out.push({ u, v, pts: edgePoints(map, u, v), kind });
      }
    }
    return out;
  }, [map]);

  const name = (n: number) => (map ? nodeName(map, n) : '');
  const findEdge = (u: number, v: number) => edges.find((e) => (e.u === u && e.v === v) || (e.u === v && e.v === u)) ?? null;
  const selEdge = sel ? findEdge(sel.u, sel.v) : null;

  /** Abschnitte des gewählten Weges: zerlegt an Knicken ab 25° und an Kreuzungen (für Auswahl und Ziehen) */
  const chunks = useMemo<[number, number][]>(() => {
    if (!selEdge) return [];
    const pts = selEdge.pts;
    const bounds = [0];
    for (let k = 1; k + 1 < pts.length; k++) {
      const [ax, ay] = pts[k - 1], [x, y] = pts[k], [bx, by] = pts[k + 1];
      const ux = x - ax, uy = y - ay, vx = bx - x, vy = by - y;
      const c = (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1);
      const dev = (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI; // 0 = geradeaus
      const jn = map?.junctions?.some((j) => Math.hypot(j.x - x, j.y - y) < 3) ?? false;
      if (dev >= 25 || jn) bounds.push(k);
    }
    bounds.push(pts.length - 1);
    const out: [number, number][] = [];
    for (let i = 0; i + 1 < bounds.length; i++) out.push([bounds[i], bounds[i + 1]]);
    return out;
  }, [selEdge, map]);
  const chunkIdx = selChunk !== null && selChunk < chunks.length ? selChunk : null;

  const clearSel = () => {
    setSel(null); setSelNode(null); setSelVertex(null); setSelJunction(null); setSelChunk(null); setMerging(null); setSelProv(null);
  };

  /** nächste Stelle auf einem Weg zu p (Punkt und Bogenlänge) */
  const projectOnEdge = (e: Edge, p: Pt): { pt: Pt; s: number } | null => {
    let best: { pt: Pt; s: number } | null = null, bd = Infinity, cum = 0;
    for (let k = 0; k + 1 < e.pts.length; k++) {
      const [a, b] = [e.pts[k], e.pts[k + 1]];
      const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const r = distToSeg(p, a, b);
      if (r.d < bd) { bd = r.d; best = { pt: [a[0] + (b[0] - a[0]) * r.t, a[1] + (b[1] - a[1]) * r.t], s: cum + r.t * seg }; }
      cum += seg;
    }
    return best;
  };

  /** gewählten Abschnitt des gewählten Weges auf einen Abschnitt eines anderen Weges legen (echte Überlagerung) */
  const mergeChunk = (target: Edge) => {
    if (!merging || !selEdge || merging.chunk >= chunks.length) return;
    const [i0, i1] = chunks[merging.chunk];
    const src = selEdge.pts, T = target.pts;
    const A = projectOnEdge(target, src[i0]), B = projectOnEdge(target, src[i1]);
    if (!A || !B || Math.hypot(A.pt[0] - B.pt[0], A.pt[1] - B.pt[1]) < 1) {
      setStatus('Zusammenlegen unmöglich: Anfang und Ende des Abschnitts liegen auf dem Zielweg fast am selben Punkt.');
      return;
    }
    const lo = Math.min(A.s, B.s), hi = Math.max(A.s, B.s);
    const mid: Pt[] = [];
    let cum = 0;
    for (let k = 1; k + 1 < T.length; k++) {
      cum += Math.hypot(T[k][0] - T[k - 1][0], T[k][1] - T[k - 1][1]);
      if (cum > lo + 0.05 && cum < hi - 0.05) mid.push(T[k]);
    }
    if (A.s > B.s) mid.reverse();
    const pts: Pt[] = [];
    for (const q of [...src.slice(0, i0), A.pt, ...mid, B.pt, ...src.slice(i1 + 1)])
      if (!pts.length || Math.hypot(q[0] - pts[pts.length - 1][0], q[1] - pts[pts.length - 1][1]) > 0.05) pts.push(q);
    commit(setInner(selEdge, pts));
    setStatus(`Abschnitt auf ${name(target.u)}–${name(target.v)} gelegt (${mid.length} Wegpunkte übernommen).`);
    setMerging(null);
    setSelChunk(null);
  };

  const custom = useMemo(() => {
    const s = new Set<string>();
    if (!map) return s;
    const ids = new Map<string, number>();
    for (let n = 0; n < nodeCount(map); n++) ids.set(nodeName(map, n), n);
    for (const k of Object.keys(edits.paths ?? {})) {
      const [a, b] = k.split('|');
      if (ids.has(a) && ids.has(b)) s.add(edgeId(ids.get(a)!, ids.get(b)!));
    }
    for (const [a, b] of edits.add ?? []) if (ids.has(a) && ids.has(b)) s.add('+' + edgeId(ids.get(a)!, ids.get(b)!));
    return s;
  }, [edits, map]);

  // ------------------------------------------------------------ Änderungen

  const commit = (next: MapEdits) => {
    setHistory((h) => [...h.slice(-199), edits]);
    setFuture([]);
    setEdits(next);
    setDirty(true);
  };
  const undo = () => {
    if (!history.length) return;
    setFuture((f) => [edits, ...f]);
    setEdits(history[history.length - 1]);
    setHistory((h) => h.slice(0, -1));
    setDirty(true);
  };
  const redo = () => {
    if (!future.length) return;
    setHistory((h) => [...h, edits]);
    setEdits(future[0]);
    setFuture((f) => f.slice(1));
    setDirty(true);
  };

  const samePair = (p: [string, string], a: string, b: string) => (p[0] === a && p[1] === b) || (p[0] === b && p[1] === a);

  /** Verlauf eines Weges setzen (null = zurück zur Grundkarte) */
  const withPath = (e: MapEdits, a: string, b: string, inner: Pt[] | null): MapEdits => {
    const paths = { ...(e.paths ?? {}) };
    delete paths[pairKey(a, b)];
    delete paths[pairKey(b, a)];
    if (inner) paths[pairKey(a, b)] = inner.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
    return { ...e, paths };
  };

  const withJunction = (e: MapEdits, p: Pt, on: boolean): MapEdits => {
    if (!map) return e;
    const near = (q: Pt) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 3;
    const j = { add: [...(e.junctions?.add ?? [])], remove: [...(e.junctions?.remove ?? [])] };
    const exists = map.junctions?.some((k) => near([k.x, k.y])) ?? false;
    if (on && !exists) {
      if (j.remove.some(near)) j.remove = j.remove.filter((q) => !near(q));
      else j.add.push([Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]);
    } else if (!on && exists) {
      if (j.add.some(near)) j.add = j.add.filter((q) => !near(q));
      else j.remove.push([Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]);
    }
    return { ...e, junctions: j };
  };

  const deleteEdge = (e: Edge) => {
    const a = name(e.u), b = name(e.v);
    let next: MapEdits = withPath(edits, a, b, null);
    if ((edits.add ?? []).some((p) => samePair(p, a, b))) next = { ...next, add: (edits.add ?? []).filter((p) => !samePair(p, a, b)) };
    else next = { ...next, remove: [...(edits.remove ?? []), [a, b]] };
    commit(next);
    setSel(null);
    setSelVertex(null);
  };

  /**
   * Kette vom Gebiet `node` entlang eines bestehenden Weges bis zum Punkt p: neue Verbindungen
   * folgen so dem vorhandenen Korridor, statt als Geraden über offene See zu schneiden.
   */
  const corridorTo = (p: Pt, node: number): Pt[] => {
    if (!map) return [p];
    let e: Edge | null = null, bd = Infinity;
    for (const ed of edges) {
      const pr = projectOnEdge(ed, p);
      if (!pr) continue;
      const d = Math.hypot(pr.pt[0] - p[0], pr.pt[1] - p[1]);
      if (d < bd) { bd = d; e = ed; }
    }
    const [nx, ny] = nodePos(map, node);
    if (!e || bd > 3) return [[nx, ny], p]; // kein Weg führt nahe vorbei: gerade zum Gebietsmittelpunkt
    const pr = projectOnEdge(e, p)!;
    let total = 0;
    for (let k = 0; k + 1 < e.pts.length; k++)
      total += Math.hypot(e.pts[k + 1][0] - e.pts[k][0], e.pts[k + 1][1] - e.pts[k][1]);
    const startIsNode = Math.hypot(e.pts[0][0] - nx, e.pts[0][1] - ny) < 2;
    const endIsNode = Math.hypot(e.pts[e.pts.length - 1][0] - nx, e.pts[e.pts.length - 1][1] - ny) < 2;
    // Ende wählen, das (entlang des Weges) zum Gebiet führt; bei durchfahrenen Wegen das nähere
    const usePrefix = startIsNode !== endIsNode ? startIsNode : pr.s <= total - pr.s;
    const segAt = (s: number) => {
      let c = 0;
      for (let k = 0; k + 1 < e!.pts.length; k++) {
        const L = Math.hypot(e!.pts[k + 1][0] - e!.pts[k][0], e!.pts[k + 1][1] - e!.pts[k][1]);
        if (s <= c + L) return k;
        c += L;
      }
      return e!.pts.length - 2;
    };
    const k = segAt(pr.s);
    const chain = usePrefix ? [...e.pts.slice(0, k + 1), p] : [p, ...e.pts.slice(k + 1)];
    if (!usePrefix) chain.reverse(); // immer vom Gebiet aus gesehen: node → … → p
    const out: Pt[] = [];
    for (const q of chain)
      if (!out.length || Math.hypot(q[0] - out[out.length - 1][0], q[1] - out[out.length - 1][1]) > 0.05) out.push(q);
    return out;
  };

  const connect = (u: number, v: number, fromPt?: Pt | null, toPt?: Pt | null) => {
    if (!map || u === v) return;
    setSelNode(null);
    const a = name(u), b = name(v);
    const ex = findEdge(u, v);
    const inner = [fromPt, toPt].filter((q): q is Pt => q !== null && q !== undefined);
    // Verlauf: vom Startgebiet entlang des dortigen Weges bis zum Punkt, gerade hinüber,
    // dann dem Weg des Zielgebiets nach – nie als Stachel quer über offene See
    const corridorPts = (): Pt[] => {
      const full: Pt[] = [];
      for (const q of [...corridorTo(fromPt ?? nodePos(map, u), u), ...(toPt ? corridorTo(toPt, v) : [[...nodePos(map, v)] as Pt]).reverse()])
        if (!full.length || Math.hypot(q[0] - full[full.length - 1][0], q[1] - full[full.length - 1][1]) > 0.05) full.push(q);
      return full;
    };
    if (ex) {
      // schon verbunden: neu über die Punkte trassieren (Korridortreue), statt Punkte mit
      // Sprüngen in den alten Verlauf zu stechen
      if (inner.length) {
        commit(withPath(edits, a, b, corridorPts().slice(1, -1)));
        setSel({ u, v });
        setStatus(`${a}–${b} war schon verbunden – der Verlauf läuft jetzt über die gewählten Punkte und folgt dabei den bestehenden Korridoren.`);
      } else {
        setSel({ u, v });
        setStatus(`${a}–${b} ist schon verbunden.`);
      }
      return;
    }
    let next: MapEdits = (edits.remove ?? []).some((p) => samePair(p, a, b))
      ? { ...edits, remove: (edits.remove ?? []).filter((p) => !samePair(p, a, b)) }
      : { ...edits, add: [...(edits.add ?? []), [a, b]] };
    if (inner.length) {
      const full = corridorPts();
      if (full.length > 2) next = withPath(next, a, b, full.slice(1, -1));
    }
    commit(next);
    setSel({ u, v });
    setStatus(`Neue Verbindung ${a}–${b}${inner.length ? ' über die gewählten Punkte; sie folgt den bestehenden Korridoren' : ''}. Verlauf mit Doppelklick (Knick einfügen) und Ziehen anpassen.`);
  };

  /** zwei Punkte und ihre Bogenlagen: Zug zwischen ihnen auf die Gerade A–B legen */
  const spliceChord = (pts: Pt[], A: Pt, sA: number, B: Pt, sB: number): Pt[] => {
    const segAt = (s: number) => {
      let c = 0;
      for (let k = 0; k + 1 < pts.length; k++) {
        const L = Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]);
        if (s <= c + L) return k;
        c += L;
      }
      return pts.length - 2;
    };
    const [p0, p1] = sA <= sB ? [A, B] : [B, A];
    const [k0, k1] = [segAt(Math.min(sA, sB)), segAt(Math.max(sA, sB))];
    const out: Pt[] = [];
    for (const q of [...pts.slice(0, k0 + 1), p0, p1, ...pts.slice(k1 + 1)])
      if (!out.length || Math.hypot(q[0] - out[out.length - 1][0], q[1] - out[out.length - 1][1]) > 0.05) out.push(q);
    return out;
  };

  const samePts = (a: Pt[], b: Pt[]) =>
    a.length === b.length && a.every((q, i) => Math.hypot(q[0] - b[i][0], q[1] - b[i][1]) < 0.1);

  /**
   * Zwei Punkte im selben Gebiet, kein Weg führt nahe an beide: der Weg des STARTpunktes wird
   * über die beiden Punkte umgeleitet – er schneidet bei A nach B über und läuft ab B weiter
   * zu seinem eigenen Ziel. Der Zielweg braucht den Sprung nicht, B liegt schon auf ihm.
   */
  const forceChord = (A: Pt, B: Pt): Edge | null => {
    const bestNear = (q: Pt) => {
      let be: Edge | null = null, bd = Infinity;
      for (const e of edges)
        for (let k = 1; k + 1 < e.pts.length; k++) {
          const d = Math.hypot(e.pts[k][0] - q[0], e.pts[k][1] - q[1]);
          if (d < bd) { bd = d; be = e; }
        }
      return bd <= 5 ? be : null;
    };
    const e = bestNear(A);
    if (!e) return null;
    const pa = projectOnEdge(e, A), pb = projectOnEdge(e, B);
    if (!pa || !pb || Math.abs(pa.s - pb.s) < 2) return null;
    // B muss in Reichweite dieses Weges liegen, sonst entsteht ein Sinnlos-Sprung über offene See
    if (Math.hypot(pb.pt[0] - B[0], pb.pt[1] - B[1]) > 60) return null;
    const pts = spliceChord(e.pts, A, pa.s, B, pb.s);
    if (samePts(pts, e.pts)) return null;
    commit(setInner(e, pts));
    return e;
  };

  /**
   * Zwei Kreuzungen desselben Gebiets: die Gerade zwischen ihnen auf alle Wege des Gebiets legen,
   * die nahe an beiden vorbeilaufen (Korridor im selben Seegebiet, ohne neue Verbindung).
   * Findet kein Weg beide Punkte, wird das Stück Ecke–Ecke in die nächstliegenden Wege eingesetzt.
   */
  const laySegmentOnPaths = (t: number, A: Pt, B: Pt) => {
    let next = edits;
    let n = 0, tried = 0;
    for (const e of edges) {
      if (e.u !== t && e.v !== t) continue;
      const pa = projectOnEdge(e, A), pb = projectOnEdge(e, B);
      if (!pa || !pb) continue;
      if (Math.hypot(pa.pt[0] - A[0], pa.pt[1] - A[1]) > 3 || Math.hypot(pb.pt[0] - B[0], pb.pt[1] - B[1]) > 3) continue;
      if (Math.abs(pa.s - pb.s) < 2) continue;
      tried++;
      const pts = spliceChord(e.pts, A, pa.s, B, pb.s);
      if (samePts(pts, e.pts)) continue; // zwischen den Punkten ist längst gerade
      next = setInner(e, pts, next);
      n++;
    }
    if (n) {
      commit(next);
      setStatus(`${n} ${n === 1 ? 'Weg' : 'Wege'}: Abschnitt zwischen den Punkten auf gerade Linie gelegt.`);
      return;
    }
    if (tried) { setStatus('Die Punkte liegen schon direkt (und gerade) auf einem Weg – nichts zu tun.'); return; }
    const f = forceChord(A, B);
    if (f) setStatus(`${name(f.u)}–${name(f.v)} über die beiden Punkte umgeleitet (Stück A–B neu, Rest bleibt).`);
    else setStatus('Kein Weg führt nahe an beide Punkte vorbei – Endpunkt näher an einen Weg klicken, oder zwei Punkte auf einem gemeinsamen Korridor wählen.');
  };

  const setInner = (e: Edge, pts: Pt[], base: MapEdits = edits) => withPath(base, name(e.u), name(e.v), pts.slice(1, -1));

  /** Rohstoff einer Provinz setzen; entspricht er der Grundkarte, entfällt die Vorgabe */
  const setResource = (prov: number, r: Resource, double: boolean) => {
    if (!base) return;
    const pname = base.provinces[prov].name;
    const resources = { ...(edits.resources ?? {}) };
    delete resources[pname];
    if (base.provinces[prov].resource !== r || base.provinces[prov].double !== double) resources[pname] = { r, double };
    commit({ ...edits, resources });
  };

  // ------------------------------------------------------------ Zeichnen

  const provincePaths = useMemo(() => {
    if (!base) return null;
    const mk = (polys: number[][][]) => {
      const p = new Path2D();
      for (const poly of polys) for (const ring of poly) {
        for (let k = 0; k < ring.length; k += 2) (k ? p.lineTo(ring[k], ring[k + 1]) : p.moveTo(ring[k], ring[k + 1]));
        p.closePath();
      }
      return p;
    };
    return { provinces: base.provinces.map((p) => mk(p.polys)), seas: base.seas.map((z) => mk(z.polys)) };
  }, [base]);

  const colors = useMemo(() => new Map(base?.nations.map((n) => [n.id, n.color]) ?? []), [base]);

  const draw = () => {
    frame.current = 0;
    const canvas = canvasRef.current, el = wrapRef.current;
    if (!canvas || !el || !map || !provincePaths) return;
    const dpr = window.devicePixelRatio || 1;
    const w = el.clientWidth, h = el.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d')!;
    const { s, ox, oy } = view.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#9fb9c4';
    ctx.fillRect(0, 0, w, h);
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
    // Seegebiete abwechselnd getönt; Seeknoten haben keine Gebiete (Punkte folgen unten)
    if (!map.seaNodes) map.seas.forEach((_, i) => {
      ctx.fillStyle = i % 2 ? '#a9c3cd' : '#b2cbd4';
      ctx.fill(provincePaths.seas[i]);
    });
    ctx.lineWidth = 1 / s;
    map.provinces.forEach((p, i) => {
      ctx.fillStyle = colors.get(p.nation) ?? '#ccc';
      ctx.globalAlpha = 0.55;
      ctx.fill(provincePaths.provinces[i]);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(60, 40, 20, 0.45)';
      ctx.stroke(provincePaths.provinces[i]);
    });
    if ((mode === 'resources' || mode === 'edit') && selProv !== null) {
      ctx.strokeStyle = '#c0281a';
      ctx.lineWidth = 3 / s;
      ctx.stroke(provincePaths.provinces[selProv]);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const X = (x: number) => ox + x * s, Y = (y: number) => oy + y * s;
    // Hauptstädte: goldener Stern am Nationssitz
    const drawCapitals = () => {
      ctx.font = 'bold 15px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const n of map.nations) {
        const [x, y] = nodePos(map, n.capital);
        ctx.fillStyle = 'rgba(40, 25, 10, 0.85)';
        ctx.fillText('★', X(x) + 1, Y(y) + 1);
        ctx.fillStyle = '#ffd24a';
        ctx.fillText('★', X(x), Y(y));
      }
      ctx.textBaseline = 'alphabetic';
    };
    // Rohstoffmodus: Symbole statt Wege
    if (mode === 'resources') {
      const size = s > 0.5 ? 18 : 14;
      ctx.font = '11px Georgia, serif';
      ctx.textAlign = 'center';
      for (const p of map.provinces) {
        const n = p.double ? 2 : 1;
        const x = X(p.mid[0]) - (n * size) / 2, y = Y(p.mid[1]) - size / 2;
        ctx.fillStyle = edits.resources?.[p.name] ? 'rgba(255, 214, 120, 0.95)' : 'rgba(245, 235, 210, 0.8)';
        ctx.beginPath();
        ctx.roundRect(x - 2, y - 2, n * size + 4, size + 4, 4);
        ctx.fill();
        const img = iconImage(p.resource, schedule);
        if (img.complete) for (let k = 0; k < n; k++) ctx.drawImage(img, x + k * size, y, size, size);
        if (s > 0.35) {
          ctx.fillStyle = 'rgba(40, 25, 10, 0.95)';
          ctx.fillText(p.name, X(p.mid[0]), y - 5);
        }
      }
      drawCapitals();
      return;
    }
    const line = (pts: Pt[]) => {
      ctx.beginPath();
      pts.forEach(([x, y], k) => (k ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
      ctx.stroke();
    };
    const preview = new Map<Edge, Pt[]>();
    const d = drag.current;
    if (d?.moved) {
      for (const { e, k } of d.items) {
        const pts = [...(preview.get(e) ?? e.pts)];
        pts[k] = d.chunk ? [e.pts[k][0] + (d.cur[0] - d.from[0]), e.pts[k][1] + (d.cur[1] - d.from[1])] : d.cur;
        preview.set(e, pts);
      }
    }
    // Wege
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const e of edges) {
      const id = edgeId(e.u, e.v);
      const isSel = selEdge === e;
      if (isSel) continue;
      ctx.setLineDash(e.kind === 'land' ? [] : [5, 4]);
      ctx.strokeStyle = custom.has('+' + id) ? '#1d7a2e' : custom.has(id) ? '#c26a12' : e.kind === 'land' ? 'rgba(90, 60, 30, 0.85)' : e.kind === 'harbor' ? 'rgba(20, 90, 110, 0.9)' : 'rgba(30, 60, 110, 0.75)';
      ctx.lineWidth = custom.has(id) || custom.has('+' + id) ? 2.2 : 1.4;
      line(preview.get(e) ?? e.pts);
    }
    ctx.setLineDash([]);
    // Verbinden-Modus: alle Wegknicke als greifbare Punkte zeigen (sie sind Start-/Endpunkte)
    if (mode === 'connect') {
      ctx.fillStyle = 'rgba(29, 122, 46, 0.8)';
      for (const e of edges)
        for (let k = 1; k + 1 < e.pts.length; k++) {
          const [x, y] = e.pts[k];
          ctx.beginPath();
          ctx.arc(X(x), Y(y), 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
    }
    // Kreuzungen (ausgewählte gelb umrandet; beim Ziehen an neuer Stelle)
    for (const j of map.junctions ?? []) {
      let x = j.x, y = j.y;
      if (d?.junctionMove && d.moved && Math.hypot(j.x - d.from[0], j.y - d.from[1]) < 3) { x = d.cur[0]; y = d.cur[1]; }
      ctx.fillStyle = isSea(map, j.node) ? '#1e3c6e' : '#5a3c1e';
      ctx.beginPath();
      ctx.arc(X(x), Y(y), 4, 0, Math.PI * 2);
      ctx.fill();
      if ((selJunction && Math.hypot(j.x - selJunction[0], j.y - selJunction[1]) < 3) || (d?.junctionMove && d.moved && Math.hypot(j.x - d.from[0], j.y - d.from[1]) < 3)) {
        ctx.strokeStyle = '#ffd24a';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(X(x), Y(y), 7, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    // Orte
    ctx.font = '11px Georgia, serif';
    ctx.textAlign = 'center';
    for (let n = 0; n < nodeCount(map); n++) {
      const [x, y] = nodePos(map, n);
      const sea = isSea(map, n);
      const hi = n === selNode || n === connectFrom;
      ctx.fillStyle = hi ? '#c0281a' : sea ? '#1e3c6e' : '#2d1c0f';
      ctx.beginPath();
      if (sea) {
        ctx.moveTo(X(x), Y(y) - 5);
        ctx.lineTo(X(x) + 5, Y(y));
        ctx.lineTo(X(x), Y(y) + 5);
        ctx.lineTo(X(x) - 5, Y(y));
      } else ctx.arc(X(x), Y(y), hi ? 5 : 3.5, 0, Math.PI * 2);
      ctx.fill();
      if (s > 0.35 || (sea && !map.seaNodes) || hi) {
        ctx.fillStyle = sea ? 'rgba(20, 45, 85, 0.9)' : 'rgba(40, 25, 10, 0.95)';
        ctx.fillText(nodeName(map, n), X(x), Y(y) - 8);
      }
    }
    drawCapitals();
    // ausgewählter Weg mit Wegpunkten (gewählter Abschnitt golden)
    if (selEdge) {
      const pts = preview.get(selEdge) ?? selEdge.pts;
      ctx.strokeStyle = '#c0281a';
      ctx.lineWidth = 3;
      ctx.setLineDash(selEdge.kind === 'land' ? [] : [6, 4]);
      line(pts);
      ctx.setLineDash([]);
      if (chunkIdx !== null && chunks[chunkIdx]) {
        const [a, b] = chunks[chunkIdx];
        ctx.strokeStyle = '#ffd24a';
        ctx.lineWidth = 5;
        line(pts.slice(a, b + 1));
      }
      pts.forEach(([x, y], k) => {
        const end = k === 0 || k === pts.length - 1;
        const inChunk = chunkIdx !== null && chunks[chunkIdx] && k >= chunks[chunkIdx][0] && k <= chunks[chunkIdx][1];
        const chosen = (!!selVertex && Math.hypot(selVertex[0] - x, selVertex[1] - y) < 0.05) || inChunk;
        ctx.fillStyle = end ? '#2d1c0f' : chosen ? '#ffd24a' : '#fff6dc';
        ctx.strokeStyle = '#c0281a';
        ctx.lineWidth = 2;
        ctx.beginPath();
        if (end) ctx.rect(X(x) - 4, Y(y) - 4, 8, 8);
        else ctx.arc(X(x), Y(y), 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      });
    }
    // neue Verbindung: Linie zur Maus (von der Kreuzung, falls eine gewählt war)
    if (mode === 'connect' && connectFrom !== null && mouse.current) {
      const [nx, ny] = nodePos(map, connectFrom);
      const [x, y] = connectFromPt ?? [nx, ny];
      ctx.strokeStyle = '#1d7a2e';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      line([[x, y], mouse.current]);
      if (connectFromPt) {
        ctx.strokeStyle = '#ffd24a';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(X(x), Y(y), 7, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
  };

  // immer mit dem aktuellen Stand zeichnen (auch aus Größenänderung und Mausrad heraus)
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const schedule = () => {
    if (!frame.current) frame.current = requestAnimationFrame(() => drawRef.current());
  };
  useEffect(schedule);

  // Ansicht einpassen, Größenänderung und Mausrad
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || !base) return;
    const [x0, y0, x1, y1] = base.bounds;
    const s = Math.min(el.clientWidth / (x1 - x0), el.clientHeight / (y1 - y0));
    view.current = { s, ox: (el.clientWidth - (x1 - x0) * s) / 2 - x0 * s, oy: (el.clientHeight - (y1 - y0) * s) / 2 - y0 * s };
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const v = view.current;
      const ns = Math.max(0.05, Math.min(30, v.s * Math.pow(1.0015, -e.deltaY)));
      v.ox = mx - ((mx - v.ox) * ns) / v.s;
      v.oy = my - ((my - v.oy) * ns) / v.s;
      v.s = ns;
      schedule();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener('wheel', onWheel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);

  // ------------------------------------------------------------ Maus

  const toKm = (ev: { clientX: number; clientY: number }): Pt => {
    const r = canvasRef.current!.getBoundingClientRect();
    const { s, ox, oy } = view.current;
    return [(ev.clientX - r.left - ox) / s, (ev.clientY - r.top - oy) / s];
  };
  const px = (km: number) => km * view.current.s;

  const nodeAt = (p: Pt): number | null => {
    if (!map) return null;
    let best: number | null = null, bd = Infinity;
    for (let n = 0; n < nodeCount(map); n++) {
      const [x, y] = nodePos(map, n);
      const d = Math.hypot(x - p[0], y - p[1]);
      if (d < bd) { bd = d; best = n; }
    }
    return best !== null && px(bd) <= (mode === 'connect' ? 14 : HIT_PX + 2) ? best : null;
  };

  const edgeAt = (p: Pt): { e: Edge; seg: number; t: number } | null => {
    let best: { e: Edge; seg: number; t: number } | null = null, bd = Infinity;
    for (const e of edges) {
      for (let k = 0; k + 1 < e.pts.length; k++) {
        const r = distToSeg(p, e.pts[k], e.pts[k + 1]);
        if (r.d < bd) { bd = r.d; best = { e, seg: k, t: r.t }; }
      }
    }
    return best && px(bd) <= HIT_PX ? best : null;
  };

  const vertexAt = (e: Edge, p: Pt): number => {
    let best = -1, bd = Infinity;
    for (let k = 1; k + 1 < e.pts.length; k++) {
      const d = Math.hypot(e.pts[k][0] - p[0], e.pts[k][1] - p[1]);
      if (d < bd) { bd = d; best = k; }
    }
    return best >= 0 && px(bd) <= SNAP_PX ? best : -1;
  };

  /** Einrasten auf Wegpunkte und Wegstücke anderer Wege sowie auf Kreuzungen (Umschalt: frei) */
  const snap = (p: Pt, skip: Set<Edge>, free: boolean): Pt => {
    if (free || !map) return p;
    let best: Pt | null = null, bd = Infinity;
    const consider = (q: Pt) => {
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < bd) { bd = d; best = q; }
    };
    for (const e of edges) {
      if (skip.has(e)) continue;
      for (let k = 1; k + 1 < e.pts.length; k++) consider(e.pts[k]);
      // auch auf Wegstücke rasten: gehaltene Korridore bleiben deckungsgleich, statt zu verrutschen
      for (let k = 0; k + 1 < e.pts.length; k++) {
        const [a, b] = [e.pts[k], e.pts[k + 1]];
        const r = distToSeg(p, a, b);
        if (r.t > 0.02 && r.t < 0.98) consider([a[0] + (b[0] - a[0]) * r.t, a[1] + (b[1] - a[1]) * r.t]);
      }
    }
    for (const j of map.junctions ?? []) consider([j.x, j.y]);
    return best && px(bd) <= SNAP_PX ? best : p;
  };

  /** nächstliegende Kreuzung in Trefferweite (Punkte sind sonst nicht anwählbar) */
  const junctionHit = (p: Pt) => {
    if (!map) return null;
    let best = null as null | { node: number; x: number; y: number }, bd = Infinity;
    for (const j of map.junctions ?? []) {
      const d = Math.hypot(j.x - p[0], j.y - p[1]);
      if (d < bd) { bd = d; best = j; }
    }
    return best !== null && px(bd) <= HIT_PX ? best : null;
  };

  const onPointerDown = (ev: React.PointerEvent) => {
    if (!map) return;
    const p = toKm(ev);
    if (ev.button === 2) return;
    // Rohstoffe: Klick wählt die Provinz (beim Loslassen), Ziehen verschiebt die Karte
    if (mode === 'resources') return startPan(ev);
    // Wegpunkt des gewählten Weges greifen (gewählter Abschnitt: ganzer Abschnitt, sonst Einzelknick)
    if (selEdge && mode === 'edit') {
      const k = vertexAt(selEdge, p);
      if (k >= 0) {
        const from = selEdge.pts[k];
        const ci = chunkIdx !== null && k >= chunks[chunkIdx][0] && k <= chunks[chunkIdx][1] ? chunkIdx : -1;
        const asChunk = ci >= 0 && !ev.altKey;
        const range: number[] = [];
        if (asChunk) for (let q = chunks[ci][0]; q <= chunks[ci][1]; q++) range.push(q);
        else range.push(k);
        const items: Drag['items'] = range.map((q) => ({ e: selEdge, k: q }));
        // gebündelt: alle Wege mit einem Wegpunkt an derselben Stelle ziehen mit (Alt: nur dieser Weg)
        if (!ev.altKey) {
          for (const e of edges) {
            if (e === selEdge) continue;
            for (let j = 1; j + 1 < e.pts.length; j++)
              if (range.some((q) => Math.hypot(e.pts[j][0] - selEdge.pts[q][0], e.pts[j][1] - selEdge.pts[q][1]) < 0.6)) items.push({ e, k: j });
          }
        }
        const junction = map.junctions?.some((j) => Math.hypot(j.x - from[0], j.y - from[1]) < 3) ?? false;
        drag.current = { items, from, cur: from, junction, moved: false, chunk: asChunk };
        setSelVertex(from);
        (ev.target as Element).setPointerCapture?.(ev.pointerId);
        return;
      }
    }
    // Kreuzung anwählen oder verschieben (geht auch, wenn sie auf keinem Weg mehr liegt)
    if (mode === 'edit') {
      const j = junctionHit(p);
      if (j) {
        setSel(null); setSelNode(null); setSelVertex(null); setSelChunk(null); setMerging(null); setSelProv(null);
        drag.current = { items: [], from: [j.x, j.y], cur: [j.x, j.y], junction: false, moved: false, junctionMove: true };
        setSelJunction([j.x, j.y]);
        (ev.target as Element).setPointerCapture?.(ev.pointerId);
        return;
      }
    }
    const n = nodeAt(p);
    if (mode === 'connect') {
      // Endpunkte: Ort, Kreuzung oder Punkt auf einem Weg – der nächste in Schirmdistanz gewinnt,
      // damit ein Knick auf See nicht von einem Gebietsmittelpunkt in der Nähe „weggeschnappt“ wird
      const cands: { d: number; node: number; pt: Pt | null }[] = [];
      if (n !== null) {
        const [nx, ny] = nodePos(map, n);
        cands.push({ d: px(Math.hypot(nx - p[0], ny - p[1])), node: n, pt: null });
      }
      const jj = junctionHit(p);
      if (jj) cands.push({ d: px(Math.hypot(jj.x - p[0], jj.y - p[1])), node: jj.node, pt: [jj.x, jj.y] });
      const h = edgeAt(p);
      if (h) {
        const k = vertexAt(h.e, p);
        const [a, b] = [h.e.pts[h.seg], h.e.pts[h.seg + 1]];
        const pt: Pt = k >= 0 ? h.e.pts[k] : [a[0] + (b[0] - a[0]) * h.t, a[1] + (b[1] - a[1]) * h.t];
        const t = territoryAt(map, pt[0], pt[1]);
        cands.push({ d: px(Math.hypot(pt[0] - p[0], pt[1] - p[1])), node: t >= 0 ? t : h.e.u, pt });
      }
      if (!cands.length) return startPan(ev);
      cands.sort((x, y) => x.d - y.d);
      const target = cands[0];
      if (connectFrom === null) {
        setConnectFrom(target.node);
        setConnectFromPt(target.pt);
      } else {
        const from = connectFrom, fromPt = connectFromPt;
        setConnectFrom(null);
        setConnectFromPt(null);
        if (from === target.node && fromPt && target.pt) laySegmentOnPaths(from, fromPt, target.pt);
        else if (from === target.node) setStatus('Beide Endpunkte liegen im selben Gebiet – für einen Korridor zwei verschiedene Punkte auf Wegen wählen.');
        else connect(from, target.node, fromPt, target.pt);
      }
      return;
    }
    const hit = edgeAt(p);
    if (n !== null && (!hit || px(Math.hypot(nodePos(map, n)[0] - p[0], nodePos(map, n)[1] - p[1])) < HIT_PX)) {
      clearSel();
      setSelNode(n);
      return;
    }
    if (hit) {
      // Zusammenlegen: zweiter Klick bestimmt den Zielweg
      if (merging && selEdge && hit.e !== selEdge) { mergeChunk(hit.e); return; }
      // zweiter Klick auf den gleichen Weg wählt den Abschnitt (sonst ganzer Weg)
      if (selEdge && hit.e === selEdge) {
        const ci = chunks.findIndex(([a, b]) => hit.seg >= a && hit.seg < b);
        if (ci >= 0) {
          setSelChunk(ci); setSelVertex(null); setSelJunction(null);
          setStatus(`Abschnitt ${ci + 1}/${chunks.length} gewählt: ziehen bewegt ihn ganz, M legt ihn auf einen anderen Weg.`);
          return;
        }
      }
      setSel({ u: hit.e.u, v: hit.e.v });
      setSelNode(null); setSelVertex(null); setSelJunction(null); setSelChunk(null); setMerging(null); setSelProv(null);
      return;
    }
    startPan(ev);
  };

  const startPan = (ev: React.PointerEvent) => {
    pan.current = { x: ev.clientX, y: ev.clientY, ox: view.current.ox, oy: view.current.oy, moved: false, at: toKm(ev) };
    (ev.target as Element).setPointerCapture?.(ev.pointerId);
  };

  const onPointerMove = (ev: React.PointerEvent) => {
    if (!map) return;
    const p = toKm(ev);
    mouse.current = p;
    const d = drag.current;
    if (d) {
      d.cur = snap(p, new Set(d.items.map((i) => i.e)), ev.shiftKey);
      d.moved = true;
      schedule();
      return;
    }
    const pn = pan.current;
    if (pn) {
      // kleines Zittern beim Klicken verschiebt die Karte nicht
      if (!pn.moved && Math.hypot(ev.clientX - pn.x, ev.clientY - pn.y) < 3) return;
      view.current.ox = pn.ox + ev.clientX - pn.x;
      view.current.oy = pn.oy + ev.clientY - pn.y;
      pn.moved = true;
      schedule();
      return;
    }
    const t = territoryAt(map, p[0], p[1]);
    const h = edgeAt(p);
    setHover(`${t >= 0 ? nodeName(map, t) : '–'}${h ? ` · Weg ${name(h.e.u)}–${name(h.e.v)}` : ''} · ${p[0].toFixed(1)} / ${p[1].toFixed(1)} km`);
    if (mode === 'connect') schedule();
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (pan.current) {
      if (!pan.current.moved && mode === 'resources' && map) {
        const t = territoryAt(map, pan.current.at[0], pan.current.at[1]);
        setSelProv(t >= 0 && t < map.provinces.length ? t : null);
      } else if (!pan.current.moved && mode === 'edit') {
        clearSel();
        // Klick auf freie Provinzfläche wählt die Provinz (Hauptstadt-Panel)
        const t = map ? territoryAt(map, pan.current.at[0], pan.current.at[1]) : -1;
        if (map && t >= 0 && t < map.provinces.length) setSelProv(t);
      }
      pan.current = null;
      return;
    }
    if (!d || !d.moved || (d.cur[0] === d.from[0] && d.cur[1] === d.from[1])) return;
    if (d.junctionMove) {
      // Kreuzung umsetzen: alte Stelle abmelden, neue setzen
      commit(withJunction(withJunction(edits, d.from, false), d.cur, true));
      setSelJunction(d.cur);
      return;
    }
    let next = edits;
    const byEdge = new Map<Edge, Pt[]>();
    for (const { e, k } of d.items) {
      const pts = [...(byEdge.get(e) ?? e.pts)];
      pts[k] = d.chunk ? [e.pts[k][0] + (d.cur[0] - d.from[0]), e.pts[k][1] + (d.cur[1] - d.from[1])] : d.cur;
      byEdge.set(e, pts);
    }
    for (const [e, pts] of byEdge) next = setInner(e, pts, next);
    if (d.junction) next = withJunction(withJunction(next, d.from, false), d.cur, true);
    commit(next);
    setSelVertex(d.cur);
  };

  const onDoubleClick = (ev: React.MouseEvent) => {
    if (!selEdge || mode !== 'edit') return;
    const p = toKm(ev);
    let best = -1, bd = Infinity, at: Pt = p;
    for (let k = 0; k + 1 < selEdge.pts.length; k++) {
      const r = distToSeg(p, selEdge.pts[k], selEdge.pts[k + 1]);
      if (r.d < bd) {
        bd = r.d;
        best = k;
        const [a, b] = [selEdge.pts[k], selEdge.pts[k + 1]];
        at = [a[0] + (b[0] - a[0]) * r.t, a[1] + (b[1] - a[1]) * r.t];
      }
    }
    if (best < 0 || px(bd) > HIT_PX * 2) return;
    const pts = [...selEdge.pts];
    pts.splice(best + 1, 0, at);
    commit(setInner(selEdge, pts));
    setSelVertex(at);
  };

  const onContextMenu = (ev: React.MouseEvent) => {
    ev.preventDefault();
    if (!selEdge) return;
    const k = vertexAt(selEdge, toKm(ev));
    if (k < 0) return;
    const pts = selEdge.pts.filter((_, i) => i !== k);
    commit(setInner(selEdge, pts));
    setSelVertex(null);
  };

  // Tastatur
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); }
      else if (e.key === 'Delete' && selJunction) { commit(withJunction(edits, selJunction, false)); setSelJunction(null); }
      else if (e.key === 'Delete' && selEdge) deleteEdge(selEdge);
      else if (e.key.toLowerCase() === 'k' && selVertex) toggleJunction();
      else if (e.key.toLowerCase() === 'm' && !merging && selEdge && chunkIdx !== null) {
        setMerging({ u: selEdge.u, v: selEdge.v, chunk: chunkIdx });
        setStatus('Zusammenlegen: jetzt einen Abschnitt des Zielwegs anklicken (Esc bricht ab).');
      }
      else if (e.key === 'Escape') { setConnectFrom(null); setConnectFromPt(null); clearSel(); setSelProv(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const junctionAt = (p: Pt) => map?.junctions?.some((j) => Math.hypot(j.x - p[0], j.y - p[1]) < 3) ?? false;
  const toggleJunction = () => {
    if (!selVertex) return;
    commit(withJunction(edits, selVertex, !junctionAt(selVertex)));
  };

  const save = async () => {
    setStatus('Speichere …');
    try {
      const r = await fetch(`/__editor/${MAP_ID}/edits`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(edits) });
      const res = await r.json();
      if (!r.ok) throw new Error(res.error);
      forgetMap(MAP_ID);
      setDirty(false);
      setStatus(`Gespeichert: scripts/maps/${MAP_ID}.edits.json und public/maps/${MAP_ID}.json.${res.warnings.length ? ' Hinweise siehe unten.' : ''}`);
    } catch (e) {
      setStatus(`Speichern fehlgeschlagen: ${String(e)}`);
    }
  };

  const goTo = (n: number) => {
    const el = wrapRef.current;
    if (!map || !el) return;
    const [x, y] = nodePos(map, n);
    const v = view.current;
    v.s = Math.max(v.s, 1.2);
    v.ox = el.clientWidth / 2 - x * v.s;
    v.oy = el.clientHeight / 2 - y * v.s;
    if (mode === 'resources' && n < map.provinces.length) setSelProv(n);
    else setSelNode(n);
    setSel(null);
    schedule();
  };

  // ------------------------------------------------------------ Oberfläche

  if (error) {
    return (
      <div className="editor">
        <div className="editor-error">
          <p>{error}</p>
          <button className="btn" onClick={onExit}>Zurück</button>
        </div>
      </div>
    );
  }
  if (!map) return <div className="editor"><div className="editor-error">Lade Karte …</div></div>;

  const P = map.provinces.length;
  const selChecks = selEdge ? checkEdge(map, selEdge) : [];
  const selLen = selEdge ? selEdge.pts.reduce((s, q, k) => (k ? s + Math.hypot(q[0] - selEdge.pts[k - 1][0], q[1] - selEdge.pts[k - 1][1]) : 0), 0) : 0;
  const selCustom = selEdge ? custom.has(edgeId(selEdge.u, selEdge.v)) : false;
  const nodeLinks = selNode !== null ? nodeNeighbors(map, selNode) : [];
  const landLinks = nodeLinks.filter((n) => n < P).length;
  const matches = search.length >= 2
    ? Array.from({ length: nodeCount(map) }, (_, n) => n).filter((n) => nodeName(map, n).toLowerCase().includes(search.toLowerCase())).slice(0, 8)
    : [];
  const pathKeys = Object.keys(edits.paths ?? {});

  return (
    <div className="editor">
      <div className="editor-bar">
        <button className="btn small" onClick={() => {
          if (!dirty || window.confirm('Ungespeicherte Änderungen verwerfen?')) onExit();
        }}>Zurück</button>
        <strong>Karteneditor</strong>
        <select value={mapId} onChange={(e) => {
          if (!dirty || window.confirm('Ungespeicherte Änderungen verwerfen?')) setMapId(e.target.value);
        }}>
          {EDITOR_MAPS.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <button className={'btn small' + (mode === 'edit' ? ' active' : '')} onClick={() => { setMode('edit'); setConnectFrom(null); setConnectFromPt(null); }}>Bearbeiten</button>
        <button className={'btn small' + (mode === 'connect' ? ' active' : '')} onClick={() => { setMode('connect'); setConnectFrom(null); setConnectFromPt(null); }}>Verbinden</button>
        <button className={'btn small' + (mode === 'resources' ? ' active' : '')} onClick={() => { setMode('resources'); setConnectFrom(null); setConnectFromPt(null); setSel(null); setSelNode(null); setSelVertex(null); }}>Rohstoffe</button>
        <button className="btn small" disabled={!history.length} onClick={undo}>Rückgängig</button>
        <button className="btn small" disabled={!future.length} onClick={redo}>Wiederholen</button>
        <button className="btn small primary" disabled={!dirty} onClick={() => void save()}>Speichern</button>
        <span className="editor-status small">{dirty ? 'ungespeichert · ' : ''}{status}</span>
      </div>
      <div className="editor-main">
        <div className="editor-map" ref={wrapRef}>
          <canvas ref={canvasRef}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
            onDoubleClick={onDoubleClick} onContextMenu={onContextMenu}
            style={{ cursor: mode === 'connect' ? 'crosshair' : 'default' }} />
          <div className="editor-hover small">{hover}</div>
        </div>
        <aside className="editor-side">
          <input className="editor-search" placeholder="Ort suchen …" value={search} onChange={(e) => setSearch(e.target.value)} />
          {matches.map((n) => (
            <button key={n} className="editor-link" onClick={() => { goTo(n); setSearch(''); }}>{nodeName(map, n)}</button>
          ))}

          {mode === 'connect' && (
            <section>
              <h3>Verbinden</h3>
              <p className="small">{connectFrom === null ? 'Ersten Punkt anklicken: Ort, Kreuzung oder Knick auf einem Weg.' : `Von ${connectFromPt ? 'Punkt' : name(connectFrom)} in ${name(connectFrom)}: zweiten Punkt anklicken (Esc bricht ab). Zwei Punkte im selben Gebiet verbinden sich direkt, verbundene Gebiete werden über die Punkte gebogen.`}</p>
              <p className="small muted">Provinz–Provinz (auch ohne gemeinsame Grenze, dann als Abkürzung), Provinz–Seegebiet (Hafen), Seegebiet–Seegebiet. Anfang/Ende können auch ein Knick oder beliebiger Punkt auf einem Weg sein – der neue Verlauf biegt über ihn. Zwei Punkte desselben Gebiets legen stattdessen die Gerade zwischen ihnen auf alle Wege, die nahe an beiden vorbeilaufen (Korridor).</p>
            </section>
          )}

          {mode === 'resources' && <ResourcePanel map={map} base={base!} edits={edits} prov={selProv} onSet={setResource} onGo={goTo} />}

          {mode === 'edit' && selProv !== null && (() => {
            const p = map.provinces[selProv];
            const nat = map.nations.find((n) => n.id === p.nation);
            const isCap = !!nat && nat.capital === p.id;
            return (
              <section>
                <h3>{p.name}</h3>
                <p className="small">{nat?.name ?? p.nation}{isCap ? ' · Hauptstadt' : ''}</p>
                <div className="editor-buttons">
                  <button className="btn small" disabled={!nat || isCap}
                    onClick={() => nat && commit({ ...edits, capitals: { ...(edits.capitals ?? {}), [nat.id]: p.name } })}>
                    {isCap ? 'Ist Hauptstadt' : 'Zur Hauptstadt machen'}
                  </button>
                  {nat && !isCap && <button className="btn small" onClick={() => goTo(nat.capital)}>Sitz: {map.provinces[nat.capital].name}</button>}
                </div>
                <p className="small muted">Klick auf freie Provinzfläche wählt die Provinz. Hauptstädte stehen als goldener Stern auf der Karte; die Vorgabe wird beim Speichern mitgesichert.</p>
              </section>
            );
          })()}

          {selEdge && (
            <section>
              <h3>{name(selEdge.u)} – {name(selEdge.v)}</h3>
              <p className="small">
                {selEdge.kind === 'land' ? 'Landweg' : selEdge.kind === 'harbor' ? 'Hafenweg (Knicke an Land wirken, im Wasser nicht)' : 'Seeweg'} ·
                {' '}{Math.round(selLen)} km · {selEdge.pts.length - 2} Knicke{selCustom ? ' · eigener Verlauf' : ''}
              </p>
              {selChecks.map((c) => <p key={c} className="small warn">⚠ {c}</p>)}
              <div className="editor-buttons">
                {selCustom && <button className="btn small" onClick={() => commit(withPath(edits, name(selEdge.u), name(selEdge.v), null))}>Verlauf zurücksetzen</button>}
                <button className="btn small" disabled={chunkIdx === null} title="M: gewählten Abschnitt auf einen Abschnitt eines anderen Weges legen" onClick={() => {
                  if (chunkIdx === null) return;
                  setMerging({ u: selEdge.u, v: selEdge.v, chunk: chunkIdx });
                  setStatus('Zusammenlegen: jetzt einen Abschnitt des Zielwegs anklicken (Esc bricht ab).');
                }}>{merging ? 'Zielweg wählen …' : 'Abschnitt zusammenlegen'}</button>
                <button className="btn small" disabled={!selVertex} onClick={toggleJunction}>
                  {selVertex && junctionAt(selVertex) ? 'Kreuzung entfernen' : 'Kreuzung setzen'}
                </button>
                <button className="btn small danger" onClick={() => deleteEdge(selEdge)}>Verbindung löschen</button>
              </div>
            </section>
          )}

          {selJunction && !selEdge && (
            <section>
              <h3>Kreuzung</h3>
              <p className="small">Bei {Math.round(selJunction[0])} / {Math.round(selJunction[1])} km. Ziehen verschiebt sie.</p>
              <div className="editor-buttons">
                <button className="btn small danger" onClick={() => { commit(withJunction(edits, selJunction, false)); setSelJunction(null); }}>Kreuzung entfernen</button>
              </div>
            </section>
          )}

          {selNode !== null && (
            <section>
              <h3>{name(selNode)}</h3>
              <p className="small">
                {selNode < P ? `${map.nations.find((n) => n.id === map.provinces[selNode].nation)?.name ?? ''} · ${landLinks} Landwege, ${nodeLinks.length - landLinks} Wasserwege` : `Seegebiet · ${nodeLinks.length} Verbindungen`}
              </p>
              {selNode < P && (landLinks < 2 || landLinks > 5) && map.provinces[selNode].neighbors.length > 0 && <p className="small warn">⚠ Regel: 2–5 Landwege</p>}
              {nodeLinks.map((n) => (
                <button key={n} className="editor-link" onClick={() => { setSel({ u: selNode, v: n }); setSelNode(null); }}>→ {name(n)}</button>
              ))}
              <div className="editor-buttons">
                <button className="btn small" onClick={() => { setMode('connect'); setConnectFrom(selNode); }}>Neue Verbindung ab hier</button>
              </div>
            </section>
          )}

          <section>
            <h3>Änderungen</h3>
            {(edits.add ?? []).map(([a, b]) => (
              <div key={'a' + a + b} className="editor-row small">
                <span className="add">+ {a}–{b}</span>
                <button className="btn small" title="Verbindung wieder entfernen" onClick={() => commit({ ...withPath(edits, a, b, null), add: (edits.add ?? []).filter((p) => !samePair(p, a, b)) })}>✕</button>
              </div>
            ))}
            {(edits.remove ?? []).map(([a, b]) => (
              <div key={'r' + a + b} className="editor-row small">
                <span className="del">− {a}–{b}</span>
                <button className="btn small" title="Verbindung wiederherstellen" onClick={() => commit({ ...edits, remove: (edits.remove ?? []).filter((p) => !samePair(p, a, b)) })}>✕</button>
              </div>
            ))}
            {pathKeys.map((k) => {
              const [a, b] = k.split('|');
              return (
                <div key={'p' + k} className="editor-row small">
                  <span>~ {a}–{b}</span>
                  <button className="btn small" title="Verlauf der Grundkarte" onClick={() => commit(withPath(edits, a, b, null))}>✕</button>
                </div>
              );
            })}
            {Object.entries(edits.resources ?? {}).map(([pname, v]) => (
              <div key={'res' + pname} className="editor-row small">
                <span>◆ {pname}: {RES_NAMES[v.r]}{v.double ? ' ×2' : ''}</span>
                <button className="btn small" title="Rohstoff der Grundkarte" onClick={() => {
                  const resources = { ...(edits.resources ?? {}) };
                  delete resources[pname];
                  commit({ ...edits, resources });
                }}>✕</button>
              </div>
            ))}
            {(edits.junctions?.add?.length || edits.junctions?.remove?.length)
              ? <p className="small">Kreuzungen: +{edits.junctions?.add?.length ?? 0} / −{edits.junctions?.remove?.length ?? 0}</p> : null}
            {!edits.add?.length && !edits.remove?.length && !pathKeys.length && !Object.keys(edits.resources ?? {}).length && <p className="small muted">Noch keine.</p>}
            {applied!.warnings.map((w) => <p key={w} className="small warn">⚠ {w}</p>)}
          </section>

          <section className="small muted">
            <h3>Bedienung</h3>
            <p>Weg anklicken zum Auswählen, zweiten Klick auf den Weg: wählt den Abschnitt (gold). Abschnitt ziehen bewegt ihn ganz, Einzelknick ohne Abschnittswahl oder mit Alt. Rastet an Knicken, Wegstücken anderer Wege und Kreuzungen ein (Umschalt: frei). Knicke an derselben Stelle ziehen gemeinsam mit (Alt: nur dieser Weg).</p>
            <p>Doppelklick auf den Weg: Knick einfügen. Rechtsklick auf einen Knick: löschen. M bzw. „Abschnitt zusammenlegen“: gewählten Abschnitt auf einen Abschnitt eines anderen Weges legen (deckt ihn exakt). K: Kreuzung am gewählten Knick. Kreuzung direkt anklicken: auswählen, ziehen, mit Entf oder Button entfernen. Entf: Verbindung löschen. Nicht mehr auf einem Weg liegende Kreuzungen werden beim Anwenden automatisch entfernt.</p>
            <p>Verbinden: Ort, Kreuzung <em>oder Punkt auf einem Weg</em> als Anfang und Ende. Fremde Punkte als Endpunkte biegen den Verlauf direkt über sich; zwei Punkte im selben Seegebiet ziehen eine Gerade als Korridor auf alle Wege, die an beiden vorbeiführen. Scharfe Knicke, an denen ein anderer Weg vorbeiläuft, bekommt der Kartenbau automatisch eine Kreuzung; übrige Knicke lassen sich mit K markieren.</p>
            <p>Rohstoffe: Provinz anklicken, Rohstoff wählen und „doppelt“ umschalten. Geänderte Provinzen sind gelb hinterlegt.</p>
            <p>Strg+Z / Strg+Y, Strg+S speichert. Mausrad zoomt, Ziehen auf freier Fläche verschiebt die Karte.</p>
          </section>
        </aside>
      </div>
    </div>
  );
}

/** Rohstoffmodus: Auswahl für die gewählte Provinz und Regelprüfung ihrer Nation */
function ResourcePanel({ map, base, edits, prov, onSet, onGo }: {
  map: MapData;
  base: MapData;
  edits: MapEdits;
  prov: number | null;
  onSet(prov: number, r: Resource, double: boolean): void;
  onGo(node: number): void;
}) {
  const nationName = (id: string) => map.nations.find((n) => n.id === id)?.name ?? id;
  const pct = (v: number) => `${Math.round(v * 100)} %`;
  if (prov === null) {
    const all = map.nations.map((n) => checkNation(map, n.id)).filter((c) => c.problems.length);
    return (
      <section>
        <h3>Rohstoffe</h3>
        <p className="small">Provinz anklicken.</p>
        <h3>Regelverstöße und weite Wege</h3>
        {all.map((c) => (
          <button key={c.nation} className="editor-link small" onClick={() => onGo(map.nations.find((n) => n.id === c.nation)!.capital)}>
            ⚠ {nationName(c.nation)}: {c.problems.join(', ')}
          </button>
        ))}
        {!all.length && <p className="small muted">Keine.</p>}
      </section>
    );
  }
  const p = map.provinces[prov];
  const b = base.provinces[prov];
  const c = checkNation(map, p.nation);
  const major = map.nations.find((n) => n.id === p.nation)?.major;
  return (
    <section>
      <h3>{p.name}</h3>
      <p className="small">
        {nationName(p.nation)}{p.capital ? ' · Hauptstadt' : ''}
        {edits.resources?.[p.name] ? ` · Grundkarte: ${RES_NAMES[b.resource]}${b.double ? ' ×2' : ''}` : ''}
      </p>
      <div className="editor-res">
        {RESOURCES.map((r) => (
          <button key={r} className={'btn small' + (p.resource === r ? ' active' : '')} onClick={() => onSet(prov, r, p.double)}>
            <ResIcon res={r} size={16} /> {RES_NAMES[r]}
          </button>
        ))}
      </div>
      <label className="small">
        <input type="checkbox" checked={p.double} onChange={(e) => onSet(prov, p.resource, e.target.checked)} /> doppelt
      </label>
      <h3>{nationName(p.nation)}{major ? ' (Großmacht)' : ''}</h3>
      <p className="small">
        {CATEGORIES.map((k) => `${CATEGORY_NAMES[k]} ${pct(c.shares[k])}`).join(' · ')}
        <br />Doppelprovinzen: {c.doubles} · Öl: {c.oil} · {c.provinces} Provinzen
      </p>
      {major && <p className="small muted">Großmächte: jede Kategorie {pct(NATION_MIN)}–{pct(NATION_MAX)}, genau 2 Doppelprovinzen.</p>}
      {c.problems.map((x) => <p key={x} className="small warn">⚠ {x}</p>)}
      <h3>Nächstes Feld ab Hauptstadt</h3>
      {RESOURCES.map((r) => (
        <div key={r} className={'editor-row small' + (c.nearest[r].km > FAR_KM ? ' warn' : '')}>
          <span><ResIcon res={r} size={14} /> {RES_NAMES[r]}</span>
          <span>{c.nearest[r].km === 0 ? 'eigen' : c.nearest[r].province >= 0 ? `${Math.round(c.nearest[r].km)} km (${map.provinces[c.nearest[r].province].name})` : '–'}</span>
        </div>
      ))}
    </section>
  );
}
