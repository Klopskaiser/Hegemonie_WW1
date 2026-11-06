// Kartenvorlage (PNG) einlesen: jede Pixelfarbe wird einer der fünf Vorlagefarben zugeordnet (Land,
// Grenze, Hauptstadt, Seepunkt, Verbindung), alles andere ist Wasser.
//  - Provinzen = zusammenhängende Landflächen, getrennt durch Grenzlinien; Grenz-, Stadt- und Linienpixel
//    an Land werden der nächsten Provinz zugeschlagen.
//  - Umrisse laufen über die Pixelecken; jede Grenze zwischen zwei Provinzen wird einmal vereinfacht und
//    von beiden benutzt (gemeinsame Eckpunkte, keine Lücken).
//  - Hauptstadtpunkte → Stadt der Provinz, Seepunkte → Seeknoten, Linien zwischen zwei Punkten → Verbindung.
// Koordinaten werden auf die Kartengröße in km gestreckt.

import type { DraftProvince, DraftSea, ImportColors, NodeRef, Pt } from './draft.ts';

export interface RasterImage {
  width: number;
  height: number;
  /** RGBA */
  data: Uint8ClampedArray;
}

export interface ImportOptions {
  colors: ImportColors;
  /** Farbabstand (RGB, euklidisch), bis zu dem ein Pixel als Vorlagefarbe gilt */
  tolerance: number;
  /** Vereinfachung der Umrisse in Pixeln (Douglas-Peucker) */
  simplify: number;
  /** Landflächen darunter (Pixel) sind keine eigene Provinz */
  minArea: number;
  /** Landstücke ohne Hauptstadtpunkt der nächsten Provinz zuschlagen (Standard an) */
  attachOrphans?: boolean;
}

export interface ImportResult {
  verts: Record<number, Pt>;
  provinces: DraftProvince[];
  seas: DraftSea[];
  links: [NodeRef, NodeRef][];
  nextId: number;
  warnings: string[];
}

export const DEFAULT_IMPORT: Omit<ImportOptions, 'colors'> = { tolerance: 60, simplify: 1.2, minArea: 25 };

const enum C { Other = 0, Land = 1, Border = 2, Capital = 3, Sea = 4, Link = 5 }

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const v = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** Pixel den Vorlagefarben zuordnen */
export function classify(img: RasterImage, colors: ImportColors, tolerance: number): Uint8Array {
  const pal: [C, number, number, number][] = [
    [C.Land, ...hexToRgb(colors.land)],
    [C.Border, ...hexToRgb(colors.border)],
    [C.Capital, ...hexToRgb(colors.capital)],
    [C.Sea, ...hexToRgb(colors.sea)],
    [C.Link, ...hexToRgb(colors.link)],
  ];
  const t2 = tolerance * tolerance;
  const n = img.width * img.height;
  const cls = new Uint8Array(n);
  const cache = new Map<number, C>();
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (img.data[o + 3] < 128) continue;
    const key = (img.data[o] << 16) | (img.data[o + 1] << 8) | img.data[o + 2];
    let c = cache.get(key);
    if (c === undefined) {
      c = C.Other;
      let best = t2 + 1;
      for (const [k, r, g, b] of pal) {
        const dr = img.data[o] - r, dg = img.data[o + 1] - g, db = img.data[o + 2] - b;
        const d = dr * dr + dg * dg + db * db;
        if (d <= t2 && d < best) { best = d; c = k; }
      }
      cache.set(key, c);
    }
    cls[i] = c;
  }
  return cls;
}

/** Zusammenhangskomponenten (4er- oder 8er-Nachbarschaft) einer Maske; -1 = nicht in der Maske */
function components(w: number, h: number, inMask: (i: number) => boolean, eight: boolean): { lab: Int32Array; count: number[]; sx: number[]; sy: number[] } {
  const n = w * h;
  const lab = new Int32Array(n).fill(-1);
  const count: number[] = [], sx: number[] = [], sy: number[] = [];
  const stack = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (lab[s] >= 0 || !inMask(s)) continue;
    const id = count.length;
    let top = 0, c = 0, ax = 0, ay = 0;
    stack[top++] = s;
    lab[s] = id;
    while (top) {
      const i = stack[--top];
      const x = i % w, y = (i - x) / w;
      c++; ax += x; ay += y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if ((!dx && !dy) || (!eight && dx && dy)) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (lab[j] < 0 && inMask(j)) { lab[j] = id; stack[top++] = j; }
        }
      }
    }
    count.push(c); sx.push(ax / c + 0.5); sy.push(ay / c + 0.5);
  }
  return { lab, count, sx, sy };
}

/** Douglas-Peucker: Indizes der behaltenen Punkte (Anfang und Ende immer) */
function simplifyIdx(pts: Pt[], tol: number): number[] {
  const n = pts.length;
  if (n <= 2) return pts.map((_, i) => i);
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let best = -1, bd = tol;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    for (let i = a + 1; i < b; i++) {
      const d = len > 0 ? Math.abs(dy * (pts[i][0] - ax) - dx * (pts[i][1] - ay)) / len : Math.hypot(pts[i][0] - ax, pts[i][1] - ay);
      if (d > bd) { bd = d; best = i; }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

export function importRaster(img: RasterImage, opt: ImportOptions, kmW: number, kmH: number, startId = 1): ImportResult {
  const W = img.width, H = img.height, N = W * H;
  const warnings: string[] = [];
  const cls = classify(img, opt.colors, opt.tolerance);
  let nextId = startId;
  const kx = kmW / W, ky = kmH / H;
  const toKm = (x: number, y: number): Pt => [Math.round(x * kx * 10) / 10, Math.round(y * ky * 10) / 10];

  // Land oder Wasser für Stadt- und Linienpixel: Mehrheit im Umkreis (Summen über ein Integralbild)
  const R = 6;
  const integ = (pred: (c: number) => boolean) => {
    const s = new Int32Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) {
      let row = 0;
      for (let x = 0; x < W; x++) {
        row += pred(cls[y * W + x]) ? 1 : 0;
        s[(y + 1) * (W + 1) + x + 1] = s[y * (W + 1) + x + 1] + row;
      }
    }
    return s;
  };
  const landSum = integ((c) => c === C.Land || c === C.Border);
  const waterSum = integ((c) => c === C.Other || c === C.Sea);
  const boxSum = (s: Int32Array, x: number, y: number) => {
    const x0 = Math.max(0, x - R), y0 = Math.max(0, y - R), x1 = Math.min(W, x + R + 1), y1 = Math.min(H, y + R + 1);
    return s[y1 * (W + 1) + x1] - s[y0 * (W + 1) + x1] - s[y1 * (W + 1) + x0] + s[y0 * (W + 1) + x0];
  };
  // Was liegt unter Stadt- und Linienpixeln? An Land: Land – außer sie unterbrechen eine Grenzlinie (in zwei
  // Gegenrichtungen stößt man hinter den Linienpixeln auf Grenze), dann Grenze. Im Wasser: Wasser.
  const overlay = (c: number) => c === C.Capital || c === C.Link;
  const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
  const firstBeyond = (x: number, y: number, dx: number, dy: number) => {
    for (let k = 1; k <= 8; k++) {
      const nx = x + dx * k, ny = y + dy * k;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) return C.Other;
      const c = cls[ny * W + nx];
      if (!overlay(c)) return c;
    }
    return C.Link;
  };
  const base = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const c = cls[i];
    if (!overlay(c)) { base[i] = c === C.Sea ? C.Other : c; continue; }
    const x = i % W, y = (i - x) / W;
    if (boxSum(landSum, x, y) <= boxSum(waterSum, x, y)) { base[i] = C.Other; continue; }
    base[i] = DIRS.some(([dx, dy]) => firstBeyond(x, y, dx, dy) === C.Border && firstBeyond(x, y, -dx, -dy) === C.Border) ? C.Border : C.Land;
  }
  const growable = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (base[i] === C.Border) growable[i] = 1;

  // Provinzkerne: zusammenhängende Landflächen
  const land = components(W, H, (i) => base[i] === C.Land, false);
  const lab = new Int32Array(N).fill(-1);
  const seedOf: number[] = []; // Komponente → Provinzlabel
  let labels = 0;
  for (let k = 0; k < land.count.length; k++) seedOf.push(land.count[k] >= opt.minArea ? labels++ : -1);
  const queue = new Int32Array(N);
  let qh = 0, qt = 0;
  for (let i = 0; i < N; i++) {
    const k = land.lab[i];
    if (k < 0) continue;
    if (seedOf[k] >= 0) { lab[i] = seedOf[k]; queue[qt++] = i; }
    else growable[i] = 1; // kleine Landreste werden zugeschlagen
  }
  // Grenz-, Stadt- und Linienpixel an Land der nächsten Provinz zuschlagen (Breitensuche)
  while (qh < qt) {
    const i = queue[qh++];
    const x = i % W, y = (i - x) / W;
    const l = lab[i];
    if (x > 0 && growable[i - 1] && lab[i - 1] < 0) { lab[i - 1] = l; queue[qt++] = i - 1; }
    if (x < W - 1 && growable[i + 1] && lab[i + 1] < 0) { lab[i + 1] = l; queue[qt++] = i + 1; }
    if (y > 0 && growable[i - W] && lab[i - W] < 0) { lab[i - W] = l; queue[qt++] = i - W; }
    if (y < H - 1 && growable[i + W] && lab[i + W] < 0) { lab[i + W] = l; queue[qt++] = i + W; }
  }
  if (!labels) warnings.push('Keine Landfläche gefunden – stimmt die Landfarbe?');

  // Hauptstadtpunkte: Provinz = häufigstes Label unter und dicht um den Punkt (Punkte am Ufer liegen halb im Wasser)
  const caps = components(W, H, (i) => cls[i] === C.Capital, true);
  const capLabel = caps.count.map((cnt, k) => {
    if (cnt < 2) return -1;
    const r = Math.ceil(Math.sqrt(cnt / Math.PI)) + 3;
    const votes = new Map<number, number>();
    for (let y = Math.max(0, Math.floor(caps.sy[k] - r)); y <= Math.min(H - 1, Math.ceil(caps.sy[k] + r)); y++) {
      for (let x = Math.max(0, Math.floor(caps.sx[k] - r)); x <= Math.min(W - 1, Math.ceil(caps.sx[k] + r)); x++) {
        const l = lab[y * W + x];
        if (l >= 0) votes.set(l, (votes.get(l) ?? 0) + (Math.hypot(x + 0.5 - caps.sx[k], y + 0.5 - caps.sy[k]) <= r - 3 ? 3 : 1));
      }
    }
    let best = -1, bv = 0;
    for (const [l, v] of votes) if (v > bv) { bv = v; best = l; }
    return best;
  });

  // Landstücke ohne Hauptstadtpunkt (Inseln, Splitter) der nächstgelegenen Provinz mit Punkt zuschlagen –
  // so entstehen Provinzen aus mehreren Teilen (Breitensuche über Land und Wasser von allen Provinzen mit Punkt)
  const hasCity = new Uint8Array(labels);
  for (const l of capLabel) if (l >= 0) hasCity[l] = 1;
  if (opt.attachOrphans !== false && hasCity.some((v) => v) && hasCity.some((v) => !v)) {
    const owner = new Int32Array(N).fill(-1);
    const q = new Int32Array(N);
    let h = 0, t = 0;
    for (let i = 0; i < N; i++) if (lab[i] >= 0 && hasCity[lab[i]]) { owner[i] = lab[i]; q[t++] = i; }
    while (h < t) {
      const i = q[h++];
      const x = i % W;
      const o = owner[i];
      if (x > 0 && owner[i - 1] < 0) { owner[i - 1] = o; q[t++] = i - 1; }
      if (x < W - 1 && owner[i + 1] < 0) { owner[i + 1] = o; q[t++] = i + 1; }
      if (i >= W && owner[i - W] < 0) { owner[i - W] = o; q[t++] = i - W; }
      if (i + W < N && owner[i + W] < 0) { owner[i + W] = o; q[t++] = i + W; }
    }
    const votes = new Map<number, Map<number, number>>();
    for (let i = 0; i < N; i++) {
      const l = lab[i];
      if (l < 0 || hasCity[l]) continue;
      const m = votes.get(l) ?? votes.set(l, new Map()).get(l)!;
      m.set(owner[i], (m.get(owner[i]) ?? 0) + 1);
    }
    const remap = Array.from({ length: labels }, (_, l) => l);
    for (const [l, m] of votes) {
      let best = l, bv = 0;
      for (const [o, v] of m) if (v > bv) { bv = v; best = o; }
      remap[l] = best;
    }
    // durchnummerieren
    const compact = new Map<number, number>();
    for (let l = 0; l < labels; l++) if (remap[l] === l) compact.set(l, compact.size);
    const final = remap.map((l) => compact.get(l)!);
    for (let i = 0; i < N; i++) if (lab[i] >= 0) lab[i] = final[lab[i]];
    for (let k = 0; k < capLabel.length; k++) if (capLabel[k] >= 0) capLabel[k] = final[capLabel[k]];
    const attached = labels - compact.size;
    labels = compact.size;
    if (attached) warnings.push(`${attached} Landstücke ohne Hauptstadtpunkt der nächsten Provinz zugeschlagen.`);
  }

  // ---------------------------------------------------------------- Umrisse über die Pixelecken
  const CW = W + 1;
  const L = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : lab[y * W + x]);
  // Randkanten: u→v ist die Richtung für Label l (Inneres links im Sinne der Außenring-Ausrichtung), r = Label auf der anderen Seite
  const eu: number[] = [], ev: number[] = [], el: number[] = [], er: number[] = [];
  for (let y = 0; y <= H; y++) {
    for (let x = 0; x < W; x++) {
      const a = L(x, y - 1), b = L(x, y);
      if (a !== b) { eu.push(y * CW + x); ev.push(y * CW + x + 1); el.push(a); er.push(b); } // Label oben: nach Osten
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x <= W; x++) {
      const a = L(x, y), b = L(x - 1, y);
      if (a !== b) { eu.push(y * CW + x); ev.push((y + 1) * CW + x); el.push(a); er.push(b); } // Label östlich: nach Süden
    }
  }
  const E = eu.length;
  const inc = new Map<number, number[]>();
  for (let e = 0; e < E; e++) {
    (inc.get(eu[e]) ?? inc.set(eu[e], []).get(eu[e])!).push(e);
    (inc.get(ev[e]) ?? inc.set(ev[e], []).get(ev[e])!).push(e);
  }
  const pairOf = (e: number) => (el[e] < er[e] ? `${el[e]}|${er[e]}` : `${er[e]}|${el[e]}`);
  const junction = new Set<number>();
  for (const [c, es] of inc) if (es.length !== 2 || pairOf(es[0]) !== pairOf(es[1])) junction.add(c);
  const cornerPt = (c: number): Pt => [c % CW, Math.floor(c / CW)];

  const vidOf = new Map<number, number>(); // Ecke → Eckpunkt-ID (nur Knoten)
  const verts: Record<number, Pt> = {};
  const vertex = (c: number) => {
    let v = vidOf.get(c);
    if (v === undefined) {
      v = nextId++;
      vidOf.set(c, v);
      const [x, y] = cornerPt(c);
      verts[v] = toKm(x, y);
    }
    return v;
  };
  interface Chain { ids: number[]; fwdLabel: number; backLabel: number }
  const chains: Chain[] = [];
  const used = new Uint8Array(E);
  const walk = (start: number, e0: number) => {
    const corners = [start];
    let c = start, e = e0;
    for (;;) {
      used[e] = 1;
      c = eu[e] === c ? ev[e] : eu[e];
      corners.push(c);
      if (junction.has(c)) break;
      const nx = inc.get(c)!.find((k) => k !== e && !used[k]);
      if (nx === undefined) break;
      e = nx;
    }
    // Richtung: läuft die Kette in Kantenrichtung von e0, gehört sie (vorwärts) zu el[e0]
    const fwd = eu[e0] === start;
    const fwdLabel = fwd ? el[e0] : er[e0], backLabel = fwd ? er[e0] : el[e0];
    // vereinfachen (geschlossene Kette: zweiter Anker am fernsten Punkt)
    const pts = corners.map(cornerPt);
    let keep: number[];
    if (corners[0] === corners[corners.length - 1] && corners.length > 3) {
      let far = 1, fd = -1;
      for (let i = 1; i < pts.length - 1; i++) {
        const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]);
        if (d > fd) { fd = d; far = i; }
      }
      const a = simplifyIdx(pts.slice(0, far + 1), opt.simplify);
      const b = simplifyIdx(pts.slice(far), opt.simplify).map((i) => i + far);
      keep = [...a, ...b.slice(1)];
      // geschlossene Kette ohne Knoten: den fernsten Punkt als Knoten führen
      junction.add(corners[far]);
    } else {
      keep = simplifyIdx(pts, opt.simplify);
    }
    const ids = keep.map((i) => {
      const c2 = corners[i];
      if (i === 0 || i === corners.length - 1 || junction.has(c2)) return vertex(c2);
      const v = nextId++;
      verts[v] = toKm(...pts[i]);
      return v;
    });
    chains.push({ ids, fwdLabel, backLabel });
  };
  for (const j of junction) for (const e of inc.get(j)!) if (!used[e]) walk(j, e);
  // geschlossene Umrisse ohne Knoten (Inseln, Enklaven)
  for (let e = 0; e < E; e++) {
    if (used[e]) continue;
    junction.add(eu[e]);
    walk(eu[e], e);
  }

  // Ringe je Provinz aus den gerichteten Ketten
  const byLabel = new Map<number, number[][]>();
  for (const ch of chains) {
    if (ch.fwdLabel >= 0) (byLabel.get(ch.fwdLabel) ?? byLabel.set(ch.fwdLabel, []).get(ch.fwdLabel)!).push(ch.ids);
    if (ch.backLabel >= 0) (byLabel.get(ch.backLabel) ?? byLabel.set(ch.backLabel, []).get(ch.backLabel)!).push([...ch.ids].reverse());
  }
  const area = (ring: number[]) => {
    let a = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = verts[ring[i]], q = verts[ring[(i + 1) % ring.length]];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
  };
  const inRing = (ring: number[], x: number, y: number) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = verts[ring[i]], [xj, yj] = verts[ring[j]];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const polysOf: number[][][][] = [];
  for (let l = 0; l < labels; l++) {
    const list = byLabel.get(l) ?? [];
    const from = new Map<number, number[]>();
    list.forEach((ch, i) => (from.get(ch[0]) ?? from.set(ch[0], []).get(ch[0])!).push(i));
    const done = new Uint8Array(list.length);
    const rings: number[][] = [];
    for (let s = 0; s < list.length; s++) {
      if (done[s]) continue;
      const ring: number[] = [];
      const start = list[s][0];
      let k = s;
      for (;;) {
        done[k] = 1;
        ring.push(...list[k].slice(0, -1));
        const end = list[k][list[k].length - 1];
        if (end === start) break;
        const nx = (from.get(end) ?? []).find((i) => !done[i]);
        if (nx === undefined) break;
        k = nx;
      }
      const clean = ring.filter((v, i) => v !== ring[(i + 1) % ring.length]);
      if (clean.length >= 3 && Math.abs(area(clean)) > 0) rings.push(clean);
    }
    const outers = rings.filter((r) => area(r) < 0);
    const holes = rings.filter((r) => area(r) > 0);
    const parts = outers.map((r) => [r]);
    for (const h of holes) {
      const a = verts[h[0]], b = verts[h[1]];
      const probe: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      let best = -1, ba = Infinity;
      outers.forEach((o, i) => {
        if (inRing(o, probe[0], probe[1]) && Math.abs(area(o)) < ba) { ba = Math.abs(area(o)); best = i; }
      });
      if (best >= 0) parts[best].push(h);
    }
    polysOf.push(parts);
  }

  // ---------------------------------------------------------------- Punkte
  const seaPts = components(W, H, (i) => cls[i] === C.Sea, true);
  const provId = Array.from({ length: labels }, () => nextId++);
  const provinces: DraftProvince[] = provId.map((id, l) => ({
    id, name: `Provinz ${l + 1}`, nation: null, polys: polysOf[l], city: null, bigCity: false, resource: null, double: false,
  }));
  // Knoten für Verbindungen: Scheiben um die Punkte
  interface Node { ref: NodeRef; x: number; y: number; r: number }
  const nodes: Node[] = [];
  let extraCaps = 0, lostCaps = 0;
  for (let k = 0; k < caps.count.length; k++) {
    if (caps.count[k] < 2) continue;
    const x = caps.sx[k], y = caps.sy[k];
    const l = capLabel[k];
    if (l < 0) { lostCaps++; continue; }
    const p = provinces[l];
    if (p.city) { extraCaps++; continue; }
    p.city = toKm(x, y);
    nodes.push({ ref: `p${p.id}`, x, y, r: Math.sqrt(caps.count[k] / Math.PI) + 3 });
  }
  if (extraCaps) warnings.push(`${extraCaps} weitere Hauptstadtpunkte in schon belegten Provinzen übergangen.`);
  if (lostCaps) warnings.push(`${lostCaps} Hauptstadtpunkte liegen im Wasser und wurden übergangen.`);
  const seas: DraftSea[] = [];
  for (let k = 0; k < seaPts.count.length; k++) {
    if (seaPts.count[k] < 2) continue;
    const id = nextId++;
    seas.push({ id, name: `Seepunkt ${seas.length + 1}`, at: toKm(seaPts.sx[k], seaPts.sy[k]) });
    nodes.push({ ref: `s${id}`, x: seaPts.sx[k], y: seaPts.sy[k], r: Math.sqrt(seaPts.count[k] / Math.PI) + 3 });
  }
  // Provinzen ohne Hauptstadtpunkt bekommen ihre Stadt automatisch – als Knoten trotzdem erreichbar
  const noCity = provinces.filter((p) => !p.city).length;
  if (noCity) warnings.push(`${noCity} Provinzen ohne Hauptstadtpunkt (Stadt wird automatisch gesetzt, Verbindungen dorthin werden nicht erkannt).`);

  // ---------------------------------------------------------------- Verbindungen
  const nodeAt = new Int32Array(N).fill(-1);
  nodes.forEach((nd, k) => {
    const r = Math.ceil(nd.r);
    for (let y = Math.max(0, Math.floor(nd.y - r)); y <= Math.min(H - 1, Math.ceil(nd.y + r)); y++) {
      for (let x = Math.max(0, Math.floor(nd.x - r)); x <= Math.min(W - 1, Math.ceil(nd.x + r)); x++) {
        if (Math.hypot(x + 0.5 - nd.x, y + 0.5 - nd.y) <= nd.r && nodeAt[y * W + x] < 0) nodeAt[y * W + x] = k;
      }
    }
  });
  const linkComp = components(W, H, (i) => cls[i] === C.Link, true);
  const touched = new Map<number, Set<number>>();
  for (let i = 0; i < N; i++) {
    const k = linkComp.lab[i];
    if (k < 0) continue;
    const x = i % W, y = (i - x) / W;
    // Linie berührt einen Knoten, wenn ein Nachbarpixel in dessen Scheibe liegt
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const nd = nodeAt[ny * W + nx];
        if (nd >= 0) (touched.get(k) ?? touched.set(k, new Set()).get(k)!).add(nd);
      }
    }
  }
  const nearLink = (x: number, y: number) => {
    const cx = Math.floor(x), cy = Math.floor(y);
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx >= 0 && ny >= 0 && nx < W && ny < H && cls[ny * W + nx] === C.Link) return true;
      }
    }
    return false;
  };
  const links: [NodeRef, NodeRef][] = [];
  const seen = new Set<string>();
  for (const set of touched.values()) {
    const list = [...set];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = nodes[list[i]], b = nodes[list[j]];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        let hit = 0, total = 0, blocked = false;
        for (let s = 0; s <= len; s += 1) {
          const t = s / len;
          const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
          if (Math.hypot(x - a.x, y - a.y) <= a.r || Math.hypot(x - b.x, y - b.y) <= b.r) continue;
          const other = nodeAt[Math.floor(y) * W + Math.floor(x)];
          if (other >= 0 && other !== list[i] && other !== list[j]) { blocked = true; break; }
          total++;
          if (nearLink(x, y)) hit++;
        }
        if (blocked || (total > 0 && hit / total < 0.75)) continue;
        const key = a.ref < b.ref ? `${a.ref}|${b.ref}` : `${b.ref}|${a.ref}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push([a.ref, b.ref]);
      }
    }
  }
  return { verts, provinces, seas, links, nextId, warnings };
}
