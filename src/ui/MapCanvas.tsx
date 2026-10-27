// Strategiekarte im Stil der alten Supremacy-Karte: Pergament, gepunktete
// Provinzgrenzen, kräftige Staatsgrenzen, Städte- und Armeesymbole.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Sight } from '../game/visibility.ts';
import { closestOnEdge, edgeParts, edgePoints, edgeSlice, harborSea, isSea, nodeCount, nodeNeighbors, nodePos } from '../game/graph.ts';
import type { MapData } from '../game/mapdata.ts';
import { armyPosition, isNaval, normalizeTarget, remainingRoute, unitCount, unitRange, type MoveTarget, boardingWait } from '../game/military.ts';
import { makeRng } from '../game/rng.ts';
import { REBELS, type Army, type ProvinceState } from '../game/types.ts';
import { DEFECTION, HOUR, UNITS, type UnitType } from '../game/balance.ts';
import { fmtDuration } from './format.ts';
import { iconImage } from './icons.tsx';

export type MapMode = 'political' | 'resources' | 'morale';

/** Fernkampf zwischen zwei Armeen für die Geschossanimation (von Nadelkopf zu Nadelkopf) */
export interface Shot {
  key: string;
  kind: UnitType;
  shooter: number;
  target: number;
  /** Anzahl der feuernden Einheiten dieses Typs: je Einheit eine Kugel */
  count: number;
}

/** Flugbild je Waffe: Takt je Einheit, Flugzeit (ms), Bogenhöhe relativ zur Entfernung, Kugelgröße */
const BALLISTICS: Partial<Record<UnitType, { period: number; flight: number; arc: number; size: number }>> = {
  artillery: { period: 3600, flight: 1500, arc: 0.45, size: 2.4 },
  railgun: { period: 5200, flight: 2400, arc: 0.6, size: 3.6 },
  battleship: { period: 3200, flight: 1100, arc: 0.15, size: 2.8 },
};
/** höchstens so viele Kugeln je Waffentyp und Gefecht (große Verbände bleiben flüssig) */
const MAX_SHELLS = 40;

function hashKey(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

interface Props {
  map: MapData;
  owners: string[];
  morale?: number[];
  /** nur die sichtbaren Armeen übergeben */
  armies?: Army[];
  /** Spielzeit für Marschpositionen */
  time?: number;
  /** Spieltempo (für Restzeiten in Echtzeit) und Pause */
  speed?: number;
  paused?: boolean;
  /** eigene Nation: deren Marschwege werden gezeichnet */
  nation?: string;
  /** Sicht des Spielers: ganz einsehbare Provinzen und Sichtkreise; alles andere liegt im Nebel */
  visible?: Sight | null;
  /** Provinzzustände für Gebäudesymbole (Schienen, Hafen, Festung); nur in sichtbaren Provinzen gezeichnet */
  provinces?: readonly ProvinceState[];
  selected?: number | null;
  /** ausgewählte Armeen (auch mehrere, z. B. per Lasso) */
  selectedArmies?: number[];
  /** Orte mit laufenden Kämpfen */
  battles?: number[];
  /** aktive Hauptstädte (verlegt oder laut Karte); fehlt das Feld, gelten die der Karte */
  capitals?: number[];
  /** laufende Fernkampfgefechte (animiert) */
  shots?: Shot[];
  /** Vorschau eines Marschweges (Knoten) mit Beschriftung am Ziel */
  previews?: { pts: [number, number][]; label: string }[];
  highlightNation?: string | null;
  mode?: MapMode;
  /** Klick auf eine Provinz (Menü-Vorschau) */
  onSelect?: (id: number | null) => void;
  /** Klick auf einen Knoten: Provinz (0..P-1) oder Seegebiet (P + Index), null = ins Leere */
  onNode?: (node: number | null) => void;
  onArmy?: (id: number, add: boolean) => void;
  onHoverNode?: (node: number | null) => void;
  /** Ziel unter dem Mauszeiger (für die Marschvorschau), nur bei ausgewählten Armeen */
  onHoverTarget?: (t: MoveTarget | null) => void;
  /** Rechtsklick: Marschziel (Knoten oder Wegpunkt) oder Armee */
  onTarget?: (t: MoveTarget | { army: number }) => void;
  /** Lassoauswahl mit gedrückter linker Maustaste: eigene Armeen im Lasso */
  onLasso?: (ids: number[], add: boolean) => void;
  /** Karte auf eine Provinz zentrieren; seq erhöhen, um erneut zu springen */
  focus?: { province: number; seq: number } | null;
  /** Vorschau im Menü: keine Namen, keine Armeen */
  compact?: boolean;
}

interface Token { id: number; x: number; y: number; w: number; h: number }

/** Nadel einer Armee in Bildschirmkoordinaten: Spitze (Standort) und Kopf */
interface PinPoint { id: number; owner: string; tx: number; ty: number; hx: number; hy: number }

function pointInPoly(x: number, y: number, pts: [number, number][]): boolean {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

interface View { s: number; ox: number; oy: number }

const SEA = '#b7c6bf';
const SEA_DEEP = '#a9bab4';
const INK = 'rgba(58, 38, 22, 0.9)';


let paperCanvas: HTMLCanvasElement | null = null;
function paperTexture(): HTMLCanvasElement {
  if (paperCanvas) return paperCanvas;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const rnd = makeRng(1914);
  g.fillStyle = '#fff';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 9000; i++) {
    const v = 200 + Math.floor(rnd() * 55);
    g.fillStyle = `rgba(${v - 20},${v - 35},${v - 60},${0.08 + rnd() * 0.12})`;
    g.fillRect(rnd() * 256, rnd() * 256, 1 + rnd() * 2, 1 + rnd() * 2);
  }
  g.strokeStyle = 'rgba(120, 90, 50, 0.07)';
  for (let i = 0; i < 60; i++) {
    g.beginPath();
    const x = rnd() * 256, y = rnd() * 256;
    g.moveTo(x, y);
    g.quadraticCurveTo(x + rnd() * 40 - 20, y + rnd() * 40 - 20, x + rnd() * 60 - 30, y + rnd() * 60 - 30);
    g.stroke();
  }
  paperCanvas = c;
  return c;
}

function moraleColor(m: number): string {
  const r = m < 0.5 ? 200 : Math.round(200 - (m - 0.5) * 2 * 110);
  const g = m < 0.5 ? Math.round(70 + m * 2 * 120) : 190;
  return `rgb(${r},${g},80)`;
}

function pointInFlatRing(x: number, y: number, r: number[]): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function hitProvince(map: MapData, boxes: number[][], x: number, y: number): number | null {
  for (let i = 0; i < map.provinces.length; i++) {
    const b = boxes[i];
    if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
    for (const poly of map.provinces[i].polys) {
      if (!pointInFlatRing(x, y, poly[0])) continue;
      let hole = false;
      for (let k = 1; k < poly.length; k++) if (pointInFlatRing(x, y, poly[k])) hole = true;
      if (!hole) return i;
    }
  }
  return null;
}

function hitSea(map: MapData, x: number, y: number): number | null {
  for (const z of map.seas) {
    for (const poly of z.polys) if (pointInFlatRing(x, y, poly[0])) return z.id;
  }
  return null;
}

function buildPath(segs: number[], path: Path2D) {
  let lx = NaN, ly = NaN;
  for (let k = 0; k < segs.length; k += 4) {
    if (segs[k] !== lx || segs[k + 1] !== ly) path.moveTo(segs[k], segs[k + 1]);
    path.lineTo(segs[k + 2], segs[k + 3]);
    lx = segs[k + 2]; ly = segs[k + 3];
  }
}

export function MapCanvas(props: Props) {
  const { map, owners, compact } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const view = useRef<View>({ s: 0.2, ox: 0, oy: 0 });
  const frame = useRef(0);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [hover, setHover] = useState<{ node: number; x: number; y: number } | null>(null);
  const hoverRef = useRef<number | null>(null);
  const tokens = useRef<Token[]>([]);
  const animTimer = useRef(0);

  const prepared = useMemo(() => {
    const paths = map.provinces.map((p) => {
      const path = new Path2D();
      for (const poly of p.polys) for (const ring of poly) {
        path.moveTo(ring[0], ring[1]);
        for (let k = 2; k < ring.length; k += 2) path.lineTo(ring[k], ring[k + 1]);
        path.closePath();
      }
      return path;
    });
    const boxes = map.provinces.map((p) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const poly of p.polys) {
        const r = poly[0];
        for (let k = 0; k < r.length; k += 2) {
          if (r[k] < x0) x0 = r[k]; if (r[k] > x1) x1 = r[k];
          if (r[k + 1] < y0) y0 = r[k + 1]; if (r[k + 1] > y1) y1 = r[k + 1];
        }
      }
      return [x0, y0, x1, y1];
    });
    const coast = new Path2D();
    const coastSegs: number[] = [];
    for (const b of map.borders) if (b.b < 0) coastSegs.push(...b.segs);
    buildPath(coastSegs, coast);
    const colors = new Map(map.nations.map((n) => [n.id, n.color]));
    colors.set(REBELS, '#4a4540');
    const names = new Map(map.nations.map((n) => [n.id, n.name]));
    names.set(REBELS, 'Aufständische');
    const seaBorders = new Path2D();
    buildPath(map.seaBorders ?? [], seaBorders);
    // Liegeplatz des Hafens: Küstenpunkt der Provinz, der dem vorgelagerten Seegebiet am nächsten liegt
    const harborSpots = map.provinces.map((mp, i) => {
      const node = harborSea(map, i);
      if (node === null) return null;
      const c = map.seas[node - map.provinces.length].center;
      // Hafen am Knickpunkt des Wasserwegs (Küstenpunkt zum vorgelagerten Seegebiet)
      const best = edgePoints(map, i, node)[1] ?? mp.center;
      const len = Math.hypot(c[0] - best[0], c[1] - best[1]) || 1;
      return { x: best[0], y: best[1], dx: (c[0] - best[0]) / len, dy: (c[1] - best[1]) / len };
    });
    // Wege des Bewegungsnetzes (jede Verbindung einmal); Landwege knicken an der Grenze
    const edges: { u: number; v: number; land: boolean; pts: [number, number][] }[] = [];
    for (let u = 0; u < nodeCount(map); u++) {
      for (const v of nodeNeighbors(map, u)) {
        if (v <= u) continue;
        edges.push({ u, v, land: !isSea(map, u) && !isSea(map, v), pts: edgePoints(map, u, v) });
      }
    }
    return { paths, boxes, coast, colors, names, seaBorders, harborSpots, edges };
  }, [map]);

  const ownerKey = owners.join(',');
  const borderPaths = useMemo(() => {
    const internal: number[] = [], national: number[] = [];
    for (const b of map.borders) {
      if (b.b < 0) continue;
      (owners[b.a] === owners[b.b] ? internal : national).push(...b.segs);
    }
    const pi = new Path2D(), pn = new Path2D();
    buildPath(internal, pi);
    buildPath(national, pn);
    return { internal: pi, national: pn };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, ownerKey]);

  const fit = () => {
    const el = wrapRef.current;
    if (!el) return;
    const [x0, y0, x1, y1] = map.bounds;
    const w = el.clientWidth, h = el.clientHeight;
    const s = Math.min(w / (x1 - x0), h / (y1 - y0)) * (compact ? 1 : 1.25);
    view.current = { s, ox: w / 2 - ((x0 + x1) / 2) * s, oy: h / 2 - ((y0 + y1) / 2) * s };
  };

  const fogRef = useRef<HTMLCanvasElement | null>(null);
  const draw = () => {
    frame.current = 0;
    const canvas = canvasRef.current, el = wrapRef.current;
    if (!canvas || !el) return;
    const p = propsRef.current;
    const dpr = window.devicePixelRatio || 1;
    const w = el.clientWidth, h = el.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d')!;
    const { s, ox, oy } = view.current;
    const owners = p.owners;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sea = ctx.createLinearGradient(0, 0, 0, h);
    sea.addColorStop(0, SEA);
    sea.addColorStop(1, SEA_DEEP);
    ctx.fillStyle = sea;
    ctx.fillRect(0, 0, w, h);

    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
    // Küstenschimmer
    ctx.strokeStyle = 'rgba(235, 240, 225, 0.55)';
    ctx.lineWidth = 7 / s;
    ctx.lineJoin = 'round';
    ctx.stroke(prepared.coast);

    for (let i = 0; i < map.provinces.length; i++) {
      let color = prepared.colors.get(owners[i]) ?? '#ccc';
      if (p.mode === 'morale' && p.morale) color = moraleColor(p.morale[i]);
      ctx.fillStyle = color;
      ctx.fill(prepared.paths[i]);
      if (p.highlightNation && owners[i] !== p.highlightNation) {
        ctx.fillStyle = 'rgba(235, 225, 200, 0.55)';
        ctx.fill(prepared.paths[i]);
      }
    }
    // Nebel des Krieges: fremde Provinzen abdunkeln, ausgenommen die Sichtkreise der eigenen Armeen
    if (p.visible) {
      const fog = (fogRef.current ??= document.createElement('canvas'));
      if (fog.width !== canvas.width || fog.height !== canvas.height) {
        fog.width = canvas.width;
        fog.height = canvas.height;
      }
      const f = fog.getContext('2d')!;
      f.setTransform(1, 0, 0, 1, 0, 0);
      f.clearRect(0, 0, fog.width, fog.height);
      f.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
      // Meer: eigener, bläulicher Nebel über der ganzen Karte, an Land wieder ausgespart
      const [bx0, by0, bx1, by1] = map.bounds;
      f.globalCompositeOperation = 'source-over';
      f.fillStyle = 'rgba(20, 35, 55, 0.3)';
      f.fillRect(bx0, by0, bx1 - bx0, by1 - by0);
      f.globalCompositeOperation = 'destination-out';
      f.fillStyle = '#000';
      for (let i = 0; i < map.provinces.length; i++) f.fill(prepared.paths[i]);
      // Land: nicht ganz einsehbare Provinzen
      f.globalCompositeOperation = 'source-over';
      f.fillStyle = 'rgba(105, 95, 80, 0.32)';
      for (let i = 0; i < map.provinces.length; i++) if (!p.visible.full.has(i)) f.fill(prepared.paths[i]);
      // Sichtkreise der Armeen (an Land und auf See) freilegen
      f.globalCompositeOperation = 'destination-out';
      f.fillStyle = '#000';
      f.beginPath();
      for (const [cx, cy, r] of p.visible.circles) {
        f.moveTo(cx + r, cy);
        f.arc(cx, cy, r, 0, Math.PI * 2);
      }
      f.fill();
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(fog, 0, 0);
      ctx.restore();
    }
    if (hoverRef.current !== null && !compact && hoverRef.current < map.provinces.length) {
      ctx.fillStyle = 'rgba(255, 250, 230, 0.28)';
      ctx.fill(prepared.paths[hoverRef.current]);
    }

    // Papierstruktur
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = ctx.createPattern(paperTexture(), 'repeat')!;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
    const vign = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
    vign.addColorStop(0, 'rgba(90, 60, 30, 0)');
    vign.addColorStop(1, 'rgba(90, 60, 30, 0.28)');
    ctx.fillStyle = vign;
    ctx.fillRect(0, 0, w, h);

    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
    ctx.lineCap = 'round';
    if (!compact) {
      // Seegebiete: feine gestrichelte Grenzen
      ctx.strokeStyle = 'rgba(60, 85, 95, 0.35)';
      ctx.lineWidth = 0.9 / s;
      ctx.setLineDash([4 / s, 4 / s]);
      ctx.stroke(prepared.seaBorders);
      ctx.setLineDash([]);
    }
    ctx.strokeStyle = 'rgba(55, 36, 20, 0.72)';
    ctx.lineWidth = 1.3 / s;
    ctx.setLineDash([3 / s, 2 / s]);
    ctx.stroke(borderPaths.internal);
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(62, 70, 74, 0.75)';
    ctx.lineWidth = 1.1 / s;
    ctx.stroke(prepared.coast);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2.2 / s;
    ctx.stroke(borderPaths.national);

    if (p.selected != null) {
      ctx.strokeStyle = '#f6d36b';
      ctx.lineWidth = 3 / s;
      ctx.stroke(prepared.paths[p.selected]);
      ctx.strokeStyle = 'rgba(60, 30, 10, 0.9)';
      ctx.lineWidth = 1 / s;
      ctx.stroke(prepared.paths[p.selected]);
    }

    // ------------------------------------------------ Symbole und Beschriftung (Bildschirmkoordinaten)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Kartenrand: außerhalb des Kartenausschnitts dunkler Holzrahmen
    {
      const [bx0, by0, bx1, by1] = map.bounds;
      const fx = ox + bx0 * s, fy = oy + by0 * s, fw = (bx1 - bx0) * s, fh = (by1 - by0) * s;
      ctx.beginPath();
      ctx.rect(0, 0, w, h);
      ctx.rect(fx, fy, fw, fh);
      ctx.fillStyle = '#2a1a0d';
      ctx.fill('evenodd');
      ctx.strokeStyle = '#c9a35a';
      ctx.lineWidth = 2;
      ctx.strokeRect(fx - 1, fy - 1, fw + 2, fh + 2);
    }
    const X = (x: number) => ox + x * s, Y = (y: number) => oy + y * s;
    const visible = (x: number, y: number, m = 40) => x > -m && y > -m && x < w + m && y < h + m;

    // Gebäude nur in einsehbaren Provinzen zeigen
    const shown = (i: number) => !!p.provinces && (!p.visible || p.visible.has(i));

    // Wege: Landwege als feine Linien, Seewege gestrichelt
    if (!compact && s > 0.1) {
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const land of [false, true]) {
        ctx.beginPath();
        for (const e of prepared.edges) {
          if (e.land !== land) continue;
          // nur Wege, deren Umriss ins Bild ragt (lange Wege können mitten durchs Bild laufen)
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (const [x, y] of e.pts) {
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
          if (X(x1) < -20 || X(x0) > w + 20 || Y(y1) < -20 || Y(y0) > h + 20) continue;
          e.pts.forEach(([x, y], k) => (k ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
        }
        ctx.strokeStyle = land ? 'rgba(105, 75, 45, 0.6)' : 'rgba(35, 70, 95, 0.5)';
        ctx.lineWidth = land ? 1.3 : 1.2;
        ctx.setLineDash(land ? [] : [4, 4]);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      // Wegkreuzungen
      for (const j of map.junctions ?? []) {
        const x = X(j.x), y = Y(j.y);
        if (!visible(x, y)) continue;
        const sea = isSea(map, j.node);
        ctx.fillStyle = sea ? 'rgba(35, 70, 95, 0.75)' : 'rgba(105, 75, 45, 0.9)';
        ctx.beginPath();
        ctx.arc(x, y, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // Eisenbahn: Schienen auf den Wegen von der Stadt bis zur Grenze (treffen sich bei beidseitiger Bahn)
    // und bis zu den Hafenpunkten
    if (p.provinces && !compact) {
      const rails: [number, number, number, number][] = [];
      const P = map.provinces.length;
      const add = (pts: [number, number][]) => {
        if (!pts.some(([x, y]) => visible(X(x), Y(y), 400))) return;
        for (let k = 0; k + 1 < pts.length; k++) rails.push([X(pts[k][0]), Y(pts[k][1]), X(pts[k + 1][0]), Y(pts[k + 1][1])]);
      };
      map.provinces.forEach((mp, i) => {
        if (!shown(i) || p.provinces![i].buildings.railroad <= 0) return;
        for (const n of mp.links ?? mp.neighbors) {
          const [l1, len] = edgeParts(map, i, n);
          add(edgeSlice(map, i, n, 0, len > 0 ? l1 / len : 0.5));
        }
        for (const z of mp.seaLinks ?? mp.seas) add(edgePoints(map, i, P + z).slice(0, 2));
      });
      drawRails(ctx, rails, s);
    }

    // Symbole wachsen beim Hineinzoomen mit, höchstens um 40 % (bei größter Zoomstufe); kleiner als bisher werden sie nie
    const Z = 1 + 0.4 * Math.max(0, Math.min(1, Math.log(s / 0.6) / Math.log(4 / 0.6)));

    // Rohstoffsymbole: immer sichtbar in der Mitte der Provinz, in der Rohstoffansicht größer
    if (s > 0.1 && !compact) {
      const big = p.mode === 'resources';
      const size = (big ? (s > 0.5 ? 20 : 16) : s > 0.5 ? 15 : 12) * 1.1 * Z;
      for (const mp of map.provinces) {
        const n = mp.double ? 2 : 1;
        const mx = X(mp.mid[0]);
        let my = Y(mp.mid[1]);
        // liegt die Mitte auf Stadt/Armee, etwas nach unten ausweichen
        const cx = X(mp.center[0]), cy = Y(mp.center[1]);
        if (Math.abs(mx - cx) < 24 * Z && Math.abs(my - cy) < 18 * Z) my = cy + 20 * Z;
        const x = mx - (n * size) / 2, y = my - size / 2;
        if (!visible(x, y)) continue;
        const img = iconImage(mp.resource, schedule);
        if (!img.complete) continue;
        if (!big) {
          ctx.fillStyle = 'rgba(245, 235, 210, 0.75)';
          ctx.beginPath();
          ctx.roundRect(x - 2, y - 2, n * size + 4, size + 4, 4);
          ctx.fill();
        }
        for (let k = 0; k < n; k++) ctx.drawImage(img, x + k * size, y, size, size);
      }
    }

    // Rebellionsfaust: Provinzen, die überlaufen könnten
    if (p.morale && !compact && s > 0.12) {
      map.provinces.forEach((mp, i) => {
        if (p.morale![i] >= DEFECTION.threshold || (p.visible && !p.visible.has(i))) return;
        const x = X(mp.center[0]) + 14 * Z, y = Y(mp.center[1]) - 14 * Z;
        if (visible(x, y)) drawFist(ctx, x, y, Z);
      });
    }

    // Häfen: Anker am Liegeplatz an der Küste
    if (p.provinces && !compact && s > 0.12) {
      map.provinces.forEach((_, i) => {
        const spot = prepared.harborSpots[i];
        if (!spot || !shown(i) || p.provinces![i].buildings.harbor <= 0) return;
        const x = X(spot.x) + spot.dx * 5, y = Y(spot.y) + spot.dy * 5;
        if (visible(x, y)) drawAnchor(ctx, x, y, Z);
      });
    }

    if (!compact) {
      const caps = p.capitals ? new Set(p.capitals) : null;
      for (const mp of map.provinces) {
        const isCapital = caps ? caps.has(mp.id) : mp.capital;
        if (!mp.city && !isCapital) continue;
        const x = X(mp.center[0]), y = Y(mp.center[1]);
        if (!visible(x, y)) continue;
        if (isCapital) {
          ctx.fillStyle = '#f3e5bf';
          ctx.strokeStyle = INK;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(x, y, 5.5 * Z, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          star(ctx, x, y, 4.2 * Z, '#7a1f12');
        } else {
          ctx.fillStyle = '#f3e5bf';
          ctx.strokeStyle = INK;
          ctx.lineWidth = 1.1;
          ctx.fillRect(x - 3.5 * Z, y - 3.5 * Z, 7 * Z, 7 * Z);
          ctx.strokeRect(x - 3.5 * Z, y - 3.5 * Z, 7 * Z, 7 * Z);
          ctx.fillStyle = INK;
          ctx.fillRect(x - 1.5 * Z, y - 1.5 * Z, 3 * Z, 3 * Z);
        }
      }

      // Festungen: Turm neben der Stadt, Stufe als Zahl
      if (p.provinces && s > 0.12) {
        map.provinces.forEach((mp, i) => {
          const lvl = p.provinces![i].buildings.fortress;
          if (lvl <= 0 || !shown(i)) return;
          const x = X(mp.center[0]) - 13 * Z, y = Y(mp.center[1]) + 1;
          if (visible(x, y)) drawFortress(ctx, x, y, lvl, Z);
        });
      }

      if (s > 0.42) {
        ctx.font = `${s > 0.9 ? 13 : 11}px "Palatino Linotype", "Book Antiqua", Georgia, serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (const mp of map.provinces) {
          if (!mp.city && s < 0.7) continue;
          const x = X(mp.center[0]), y = Y(mp.center[1]) + 7;
          if (!visible(x, y, 80)) continue;
          ctx.lineWidth = 3;
          ctx.strokeStyle = 'rgba(245, 235, 210, 0.85)';
          ctx.strokeText(mp.name, x, y);
          ctx.fillStyle = 'rgba(45, 28, 15, 0.95)';
          ctx.fillText(mp.name, x, y);
        }
      }

      if (s < 0.75 && p.mode !== 'morale') {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (const [id, g] of nationLabelSpots(map, owners)) {
          const cx = g.x, cy = g.y;
          const raw = Math.sqrt(g.a) * s * 0.075;
          if (raw < 5.5 && !compact) continue;
          const size = Math.max(9, Math.min(30, raw));
          ctx.font = `bold ${size}px "Palatino Linotype", "Book Antiqua", Georgia, serif`;
          const label = (prepared.names.get(id) ?? id).toUpperCase().split('').join(String.fromCharCode(8202));
          const x = X(cx), y = Y(cy) - 14;
          ctx.lineWidth = 3;
          ctx.strokeStyle = 'rgba(245, 235, 210, 0.6)';
          ctx.strokeText(label, x, y);
          ctx.fillStyle = 'rgba(55, 30, 15, 0.8)';
          ctx.fillText(label, x, y);
        }
      }

      // Namen der Seegebiete
      if (s > 0.3) {
        ctx.font = `italic ${s > 0.8 ? 13 : 11}px "Palatino Linotype", "Book Antiqua", Georgia, serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(40, 70, 85, 0.6)';
        for (const z of map.seas) {
          const x = X(z.center[0]), y = Y(z.center[1]);
          if (visible(x, y, 80)) ctx.fillText(z.name, x, y);
        }
      }

      const time = p.time ?? 0;
      const linePath = (pts: [number, number][], color: string, dash: number[]) => {
        ctx.beginPath();
        pts.forEach(([x, y], k) => (k ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
        ctx.strokeStyle = 'rgba(245, 235, 210, 0.8)';
        ctx.lineWidth = 4;
        ctx.setLineDash([]);
        ctx.stroke();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.setLineDash(dash);
        ctx.stroke();
        ctx.setLineDash([]);
      };

      // Marschwege eigener Armeen
      const chosenSet = new Set(p.selectedArmies ?? []);
      for (const a of p.armies ?? []) {
        if (!a.move || a.owner !== p.nation) continue;
        const pts = remainingRoute(map, a, time);
        linePath(pts, chosenSet.has(a.id) ? '#8a1f10' : 'rgba(60, 35, 20, 0.85)', [6, 4]);
        const end = pts[pts.length - 1];
        ctx.fillStyle = '#8a1f10';
        ctx.beginPath();
        ctx.arc(X(end[0]), Y(end[1]), 3.5, 0, Math.PI * 2);
        ctx.fill();
      }

      // Vorschau des Marschweges
      for (const pv of p.previews ?? []) {
        if (pv.pts.length < 2) continue;
        linePath(pv.pts, '#b8860b', [3, 4]);
        const [ex, ey] = pv.pts[pv.pts.length - 1];
        ctx.fillStyle = '#b8860b';
        ctx.beginPath();
        ctx.arc(X(ex), Y(ey), 3.5, 0, Math.PI * 2);
        ctx.fill();
        if (!pv.label) continue;
        ctx.font = 'bold 12px Georgia, serif';
        const tw = ctx.measureText(pv.label).width;
        ctx.fillStyle = 'rgba(42, 26, 13, 0.88)';
        ctx.fillRect(X(ex) + 8, Y(ey) - 20, tw + 10, 18);
        ctx.fillStyle = '#ecd08f';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(pv.label, X(ex) + 13, Y(ey) - 11);
      }

      // Reichweitenkreise der ausgewählten Armee (je Fernkampfeinheit)
      for (const chosen of (p.armies ?? []).filter((a) => chosenSet.has(a.id)).slice(0, 12)) {
        const [px, py] = armyPosition(map, chosen, time);
        const ranges = new Map<number, string>();
        for (const u of Object.keys(chosen.units) as UnitType[]) {
          if ((chosen.units[u] ?? 0) > 0 && unitRange(chosen, u, map) > 0) {
            const r = UNITS[u].range;
            ranges.set(r, ranges.has(r) ? `${ranges.get(r)}, ${UNITS[u].name}` : UNITS[u].name);
          }
        }
        for (const [r, label] of ranges) {
          const rx = r * s;
          ctx.beginPath();
          ctx.arc(X(px), Y(py), rx, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(160, 50, 25, 0.07)';
          ctx.fill();
          ctx.setLineDash([6, 4]);
          ctx.strokeStyle = 'rgba(140, 40, 20, 0.8)';
          ctx.lineWidth = 1.6;
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.font = 'italic 11px Georgia, serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          ctx.fillStyle = 'rgba(120, 30, 15, 0.9)';
          ctx.fillText(`${label} · ${r} km`, X(px), Y(py) - rx - 2);
        }
      }

      // Kampfsymbole
      for (const n of p.battles ?? []) {
        const [bx, by] = nodePos(map, n);
        drawSwords(ctx, X(bx) - 16, Y(by) + 12);
      }

      // Armeen als Pinnadeln: die Spitze zeigt auf die Position, der Kopf zeigt die Einheitentypen.
      // Liegen Armeen dicht beieinander, werden die Nadeln aufgefächert.
      const hits: Token[] = [];
      const heads = new Map<number, [number, number]>();
      const lassoSel = lasso.current?.sel ?? new Set<number>();
      const pinList: PinPoint[] = [];
      if (p.armies) {
        const small = s < 0.35;
        const pins = p.armies.filter((a) => unitCount(a) > 0).map((a) => {
          const [px, py] = armyPosition(map, a, time);
          return { a, x: X(px), y: Y(py), angle: -80, len: (small ? 20 : 28) * Z };
        }).filter((q) => visible(q.x, q.y, 60));
        // Gruppen naher Nadeln bilden und Winkel verteilen
        const done = new Set<number>();
        pins.sort((q, r) => q.x - r.x);
        for (let i = 0; i < pins.length; i++) {
          if (done.has(i)) continue;
          const group = [i];
          for (let j = i + 1; j < pins.length; j++) {
            if (!done.has(j) && group.some((g) => Math.hypot(pins[g].x - pins[j].x, pins[g].y - pins[j].y) < 14)) group.push(j);
          }
          group.forEach((g) => done.add(g));
          if (group.length === 1) continue;
          // Köpfe auf einem Bogen verteilen; Radius so, dass benachbarte Köpfe sich nicht überdecken
          const n = group.length;
          const spread = Math.min(150, 40 * (n - 1));
          const radius = Math.max(pins[i].len, (small ? 22 : 30) * Z * (n - 1) / ((spread * Math.PI) / 180));
          group.forEach((g, k) => {
            pins[g].angle = -90 - spread / 2 + (k * spread) / (n - 1);
            pins[g].len = radius + (k % 2 ? (small ? 4 : 7) * Z : 0);
          });
        }
        for (const q of pins) drawNeedle(ctx, q.x, q.y, q.angle, q.len);
        for (const q of pins) {
          const rad = (q.angle * Math.PI) / 180;
          const hx = q.x + Math.cos(rad) * q.len, hy = q.y + Math.sin(rad) * q.len;
          heads.set(q.a.id, [hx, hy]);
          pinList.push({ id: q.a.id, owner: q.a.owner, tx: q.x, ty: q.y, hx, hy });
          const t = drawPinHead(ctx, hx, hy, pinShapes(q.a), prepared.colors.get(q.a.owner) ?? '#888', unitCount(q.a), small,
            chosenSet.has(q.a.id) || lassoSel.has(q.a.id), Z);
          hits.push({ id: q.a.id, ...t });
          // Ein-/Ausschiffen: Restzeit unter dem Nadelkopf (eigene und sichtbare fremde Armeen)
          const bw = p.time !== undefined ? boardingWait(map, q.a, p.time) : null;
          if (bw) {
            const left = p.paused ? `${Math.ceil(bw.remaining * 60)} min` : fmtDuration((bw.remaining * HOUR) / Math.max(1, p.speed ?? 1));
            drawBadge(ctx, t.x + t.w / 2, t.y + t.h + 2, `${bw.landing ? 'Ausschiffen' : 'Einschiffen'} ${left}`, Z);
          }
        }
      }
      tokens.current = hits;
      pins.current = pinList;

      // Lasso: geschlossene Freihandlinie
      const lp = lasso.current?.pts;
      if (lp && lp.length > 2) {
        ctx.beginPath();
        lp.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath();
        ctx.fillStyle = 'rgba(246, 211, 107, 0.14)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(40, 25, 10, 0.75)';
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.strokeStyle = '#f6d36b';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Geschosse: laufen, solange das Gefecht besteht – unabhängig von den Schadensrunden
      if (p.shots?.length) {
        const now = performance.now();
        for (const sh of p.shots) {
          const b = BALLISTICS[sh.kind];
          if (!b) continue;
          const from = heads.get(sh.shooter), to = heads.get(sh.target);
          if (!from || !to) continue;
          const [x0, y0] = from, [x1, y1] = to;
          const dist = Math.hypot(x1 - x0, y1 - y0);
          const height = Math.max(10, Math.min(140, dist * b.arc));
          const base = hashKey(sh.key) % b.period;
          const shells = Math.min(MAX_SHELLS, Math.max(1, sh.count));
          for (let k = 0; k < shells; k++) {
            // je Einheit eine Kugel, über den Takt verteilt und leicht gestreut um das Ziel
            const t = (now + base + (k * b.period) / shells) % b.period;
            const h = hashKey(`${sh.key}-${k}`);
            const tx = x1 + ((h % 13) - 6), ty = y1 + (((h >> 4) % 9) - 4);
            if (t < b.flight) {
              const f = t / b.flight;
              const pos = (q: number) => [x0 + (tx - x0) * q, y0 + (ty - y0) * q - height * 4 * q * (1 - q)] as const;
              // Spur
              ctx.strokeStyle = 'rgba(60, 45, 30, 0.35)';
              ctx.lineWidth = 1.2;
              ctx.beginPath();
              for (let j = 0; j <= 4; j++) {
                const [sx, sy] = pos(Math.max(0, f - 0.06 + j * 0.015));
                if (j) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy);
              }
              ctx.stroke();
              const [sx, sy] = pos(f);
              ctx.fillStyle = '#1d1712';
              ctx.strokeStyle = 'rgba(250, 240, 215, 0.8)';
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.arc(sx, sy, b.size, 0, Math.PI * 2);
              ctx.fill();
              ctx.stroke();
            } else if (t < b.flight + 350) {
              // Einschlag
              const f = (t - b.flight) / 350;
              ctx.fillStyle = `rgba(235, 150, 50, ${0.7 * (1 - f)})`;
              ctx.beginPath();
              ctx.arc(tx, ty, 2 + 4 * f, 0, Math.PI * 2);
              ctx.fill();
              ctx.fillStyle = `rgba(90, 80, 70, ${0.45 * (1 - f)})`;
              ctx.beginPath();
              ctx.arc(tx, ty - 2 * f, 4 + 9 * f, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }
        // Animation fortsetzen (~30 Bilder/s)
        if (!animTimer.current) {
          animTimer.current = window.setTimeout(() => {
            animTimer.current = 0;
            schedule();
          }, 33);
        }
      }
    }
  };

  function schedule() {
    if (!frame.current) frame.current = requestAnimationFrame(draw);
  }

  useEffect(() => {
    fit();
    schedule();
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => {
      if (compact) fit();
      schedule();
    });
    ro.observe(el);
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const v = view.current;
      const [x0, y0, x1, y1] = map.bounds;
      const minS = Math.min(el.clientWidth / (x1 - x0), el.clientHeight / (y1 - y0)) * 0.8;
      const ns = Math.max(minS, Math.min(4, v.s * Math.pow(1.0015, -e.deltaY)));
      v.ox = mx - ((mx - v.ox) * ns) / v.s;
      v.oy = my - ((my - v.oy) * ns) / v.s;
      v.s = ns;
      schedule();
    };
    if (!compact) el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener('wheel', onWheel);
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = 0;
      if (animTimer.current) clearTimeout(animTimer.current);
      animTimer.current = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, compact]);

  useEffect(schedule);

  // Karte mit Pfeiltasten/WASD verschieben (Ziehen mit links ist das Lasso; rechts oder Mitte ziehen verschiebt)
  useEffect(() => {
    if (compact) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
      const step = 90;
      const d: Record<string, [number, number]> = {
        ArrowLeft: [step, 0], a: [step, 0], ArrowRight: [-step, 0], d: [-step, 0],
        ArrowUp: [0, step], w: [0, step], ArrowDown: [0, -step], s: [0, -step],
      };
      const m = d[e.key];
      if (!m) return;
      e.preventDefault();
      view.current.ox += m[0];
      view.current.oy += m[1];
      schedule();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compact]);

  useEffect(() => {
    const f = props.focus;
    const el = wrapRef.current;
    if (!f || !el) return;
    const v = view.current;
    const c = map.provinces[f.province].center;
    v.s = Math.max(v.s, 0.8);
    v.ox = el.clientWidth / 2 - c[0] * v.s;
    v.oy = el.clientHeight / 2 - c[1] * v.s;
    schedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.focus?.seq]);

  const drag = useRef<{ button: number; x: number; y: number; ox: number; oy: number; moved: boolean } | null>(null);
  const lasso = useRef<{ pts: [number, number][]; sel: Set<number> } | null>(null);
  const pins = useRef<PinPoint[]>([]);
  const hoverTarget = useRef('');

  /** Ziel unter dem Zeiger: Knoten nahe der Mitte, sonst Wegpunkt, sonst Provinz/Seegebiet */
  const targetAt = (x: number, y: number): MoveTarget | null => {
    const s = view.current.s;
    let best = -1, bd = Infinity;
    for (let i = 0; i < nodeCount(map); i++) {
      const q = nodePos(map, i);
      const d = Math.hypot(q[0] - x, q[1] - y) * s;
      if (d < bd) { bd = d; best = i; }
    }
    if (bd <= 12) return { node: best };
    let road: { u: number; v: number; f: number; d: number } | null = null;
    for (const e of prepared.edges) {
      const r = closestOnEdge(map, e.u, e.v, x, y);
      const d = r.d * s;
      if (d <= 9 && (!road || d < road.d)) road = { u: e.u, v: e.v, f: r.f, d };
    }
    if (road) return normalizeTarget({ road: { a: road.u, b: road.v, f: road.f } });
    const n = hitNode(x, y);
    return n === null ? null : { node: n };
  };
  const pinAt = (mx: number, my: number) =>
    [...tokens.current].reverse().find((t) => mx >= t.x && mx <= t.x + t.w && my >= t.y && my <= t.y + t.h);

  const toMap = (e: React.PointerEvent) => {
    const rect = wrapRef.current!.getBoundingClientRect();
    const v = view.current;
    return { mx: e.clientX - rect.left, my: e.clientY - rect.top, x: (e.clientX - rect.left - v.ox) / v.s, y: (e.clientY - rect.top - v.oy) / v.s };
  };

  return (
    <div ref={wrapRef} className={'map-wrap' + (compact ? ' compact' : '')}>
      <canvas
        ref={canvasRef}
        onPointerDown={(e) => {
          if (compact) return;
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { button: e.button, x: e.clientX, y: e.clientY, ox: view.current.ox, oy: view.current.oy, moved: false };
          if (e.button === 0 && props.onLasso) {
            const { mx, my } = toMap(e);
            lasso.current = { pts: [[mx, my]], sel: new Set() };
          }
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d) {
            if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 4) d.moved = true;
            if (d.moved && d.button === 0 && lasso.current) {
              // Lasso ziehen; Vorschau: eigene Armeen, deren Nadel oder Kopf im Lasso liegt
              const { mx, my } = toMap(e);
              const lp = lasso.current.pts;
              const [lx, ly] = lp[lp.length - 1];
              if (Math.hypot(mx - lx, my - ly) > 3) lp.push([mx, my]);
              lasso.current.sel = new Set(pins.current
                .filter((q) => q.owner === props.nation && (pointInPoly(q.tx, q.ty, lp) || pointInPoly(q.hx, q.hy, lp)))
                .map((q) => q.id));
              schedule();
              return;
            }
            if (d.moved) {
              view.current.ox = d.ox + e.clientX - d.x;
              view.current.oy = d.oy + e.clientY - d.y;
              schedule();
              return;
            }
          }
          const { mx, my, x, y } = toMap(e);
          const node = hitNode(x, y);
          if (node !== hoverRef.current) {
            hoverRef.current = node;
            props.onHoverNode?.(node);
            schedule();
          }
          setHover(node === null ? null : { node, x: mx, y: my });
          if (props.onHoverTarget && props.selectedArmies?.length) {
            const t = targetAt(x, y);
            const key = JSON.stringify(t);
            if (key !== hoverTarget.current) {
              hoverTarget.current = key;
              props.onHoverTarget(t);
            }
          }
        }}
        onPointerLeave={() => {
          hoverRef.current = null;
          hoverTarget.current = '';
          props.onHoverTarget?.(null);
          props.onHoverNode?.(null);
          setHover(null);
          schedule();
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          const l = lasso.current;
          lasso.current = null;
          if (l && d?.moved && d.button === 0) {
            props.onLasso?.([...l.sel], e.shiftKey);
            schedule();
            return;
          }
          if (d?.moved && !compact) return;
          const { mx, my, x, y } = toMap(e);
          if (e.button === 2) {
            // Rechtsklick: Marschbefehl für die ausgewählten Armeen
            const hit = pinAt(mx, my);
            if (hit) props.onTarget?.({ army: hit.id });
            else {
              const t = targetAt(x, y);
              if (t) props.onTarget?.(t);
            }
            return;
          }
          if (e.button !== 0) return;
          const hit = pinAt(mx, my);
          if (hit && props.onArmy) {
            props.onArmy(hit.id, e.shiftKey);
            return;
          }
          const node = hitNode(x, y);
          props.onNode?.(node);
          props.onSelect?.(node !== null && node < map.provinces.length ? node : null);
        }}
        onContextMenu={(e) => e.preventDefault()}
      />
      {hover && !props.previews?.length && (
        <div className="map-tooltip" style={{ left: hover.x + 14, top: hover.y + 10 }}>
          {hover.node < map.provinces.length ? (
            <>
              <b>{compact ? prepared.names.get(owners[hover.node]) : map.provinces[hover.node].name}</b>
              {!compact && <span>{prepared.names.get(owners[hover.node])}</span>}
            </>
          ) : (
            <b>{map.seas[hover.node - map.provinces.length].name}</b>
          )}
        </div>
      )}
    </div>
  );

  function hitNode(x: number, y: number): number | null {
    const prov = hitProvince(map, prepared.boxes, x, y);
    if (prov !== null) return prov;
    if (compact) return null;
    const sea = hitSea(map, x, y);
    return sea === null ? null : map.provinces.length + sea;
  }
}

/** Beschriftungspunkt je Nation: Mitte des zusammenhängenden Kerngebiets um die Hauptstadt. */
function nationLabelSpots(map: MapData, owners: string[]): Map<string, { x: number; y: number; a: number }> {
  const out = new Map<string, { x: number; y: number; a: number }>();
  const seen = new Uint8Array(map.provinces.length);
  const starts = new Map<string, number>();
  map.provinces.forEach((mp, i) => {
    const st = starts.get(owners[i]);
    if (st === undefined || map.provinces[st].area < mp.area) starts.set(owners[i], i);
  });
  for (const n of map.nations) if (owners[n.capital] === n.id) starts.set(n.id, n.capital);
  for (const [id, start] of starts) {
    const stack = [start];
    seen[start] = 1;
    let x = 0, y = 0, a = 0;
    const members: number[] = [];
    while (stack.length) {
      const i = stack.pop()!;
      const mp = map.provinces[i];
      members.push(i);
      x += mp.center[0] * mp.area; y += mp.center[1] * mp.area; a += mp.area;
      for (const n of mp.neighbors) if (!seen[n] && owners[n] === id) { seen[n] = 1; stack.push(n); }
    }
    let cx = x / a, cy = y / a, best = Infinity, bx = cx, by = cy;
    for (const i of members) {
      const c = map.provinces[i].center;
      const d = (c[0] - cx) ** 2 + (c[1] - cy) ** 2;
      if (d < best) { best = d; bx = c[0]; by = c[1]; }
    }
    // Mittelpunkt bevorzugen, wenn er an Land der Nation liegt
    const inside = members.some((i) => map.provinces[i].polys.some((poly) => pointInFlatRing(cx, cy, poly[0])));
    if (!inside) { cx = bx; cy = by; }
    out.set(id, { x: cx, y: cy, a });
  }
  return out;
}

/** Einfache Schiene: Schwellen quer, zwei Schienenstränge darüber (Bildschirmkoordinaten). */
function drawRails(ctx: CanvasRenderingContext2D, segs: [number, number, number, number][], s: number) {
  if (!segs.length) return;
  const gauge = s > 0.5 ? 2 : 1.5, tie = gauge + 2, step = s > 0.5 ? 6 : 5;
  ctx.save();
  ctx.lineCap = 'butt';
  ctx.strokeStyle = 'rgba(92, 64, 38, 0.85)';
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  for (const [x0, y0, x1, y1] of segs) {
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 1) continue;
    const ux = (x1 - x0) / len, uy = (y1 - y0) / len, nx = -uy, ny = ux;
    for (let d = step / 2; d < len; d += step) {
      const cx = x0 + ux * d, cy = y0 + uy * d;
      ctx.moveTo(cx + nx * tie, cy + ny * tie);
      ctx.lineTo(cx - nx * tie, cy - ny * tie);
    }
  }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(40, 36, 34, 0.9)';
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  for (const [x0, y0, x1, y1] of segs) {
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 1) continue;
    const nx = -(y1 - y0) / len, ny = (x1 - x0) / len;
    for (const side of [1, -1]) {
      ctx.moveTo(x0 + nx * gauge * side, y0 + ny * gauge * side);
      ctx.lineTo(x1 + nx * gauge * side, y1 + ny * gauge * side);
    }
  }
  ctx.stroke();
  ctx.restore();
}

/** Rebellionsfaust: erhobene Faust auf rotem Grund */
function drawFist(ctx: CanvasRenderingContext2D, x0: number, y0: number, k = 1) {
  ctx.save();
  ctx.translate(x0, y0);
  ctx.scale(k, k);
  const x = 0, y = 0;
  ctx.fillStyle = '#8f1d14';
  ctx.strokeStyle = '#f3e5bf';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(x, y, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#f3e5bf';
  // Unterarm
  ctx.fillRect(x - 2.2, y + 1, 4.4, 5.5);
  // Finger als vier Glieder und Daumen
  ctx.beginPath();
  ctx.roundRect(x - 4.6, y - 5, 9.2, 6.4, 1.6);
  ctx.fill();
  ctx.strokeStyle = '#8f1d14';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  for (const dx of [-2.3, 0, 2.3]) { ctx.moveTo(x + dx, y - 5); ctx.lineTo(x + dx, y - 2); }
  ctx.moveTo(x - 4.6, y - 1.4);
  ctx.lineTo(x + 1.5, y - 1.4);
  ctx.stroke();
  ctx.restore();
}

/** kleines Schild unter einer Nadel (oben mittig an x, y) */
function drawBadge(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, zoom = 1) {
  ctx.save();
  ctx.font = `${Math.round(9 * zoom)}px Georgia, serif`;
  const w = ctx.measureText(text).width + 8 * zoom, h = 12 * zoom;
  ctx.fillStyle = 'rgba(30, 60, 95, 0.88)';
  ctx.strokeStyle = 'rgba(245, 233, 205, 0.9)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y, w, h, 3);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#f5ecd2';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + h / 2 + 0.5);
  ctx.restore();
}

/** Hafen: Anker auf blauem Grund */
function drawAnchor(ctx: CanvasRenderingContext2D, x0: number, y0: number, k = 1) {
  ctx.save();
  ctx.translate(x0, y0);
  ctx.scale(k, k);
  const x = 0, y = 0;
  ctx.fillStyle = '#2f4f6b';
  ctx.strokeStyle = '#f3e5bf';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(x, y, 6.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = '#f3e5bf';
  ctx.lineWidth = 1.3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(x, y - 3.4, 1.2, 0, Math.PI * 2);
  ctx.moveTo(x, y - 2.2);
  ctx.lineTo(x, y + 3.8);
  ctx.moveTo(x - 2.4, y - 0.8);
  ctx.lineTo(x + 2.4, y - 0.8);
  ctx.moveTo(x - 3.4, y + 1.2);
  ctx.quadraticCurveTo(x - 2.6, y + 4, x, y + 3.8);
  ctx.quadraticCurveTo(x + 2.6, y + 4, x + 3.4, y + 1.2);
  ctx.stroke();
  ctx.restore();
}

/** Festung: Turm mit Zinnen, darunter die Stufe */
function drawFortress(ctx: CanvasRenderingContext2D, x0: number, y0: number, level: number, k = 1) {
  ctx.save();
  ctx.translate(x0, y0);
  ctx.scale(k, k);
  const x = 0, y = 0;
  ctx.fillStyle = '#8a8378';
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x - 5, y + 5);
  ctx.lineTo(x - 5, y - 4);
  for (let k = 0; k < 3; k++) {
    const bx = x - 5 + k * 4;
    ctx.lineTo(bx, y - 7);
    ctx.lineTo(bx + 2, y - 7);
    ctx.lineTo(bx + 2, y - 4);
    ctx.lineTo(bx + 4, y - 4);
  }
  ctx.lineTo(x + 5, y - 7);
  ctx.lineTo(x + 5, y + 5);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#f3e5bf';
  ctx.font = 'bold 8px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(level), x, y + 0.8);
  ctx.restore();
}

function star(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 === 0 ? r : r * 0.45;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

type PinShape = 'circle' | 'triangle' | 'bigTriangle' | 'square' | 'diamond' | 'ship';

/**
 * Formen des Nadelkopfes, in Zeichenreihenfolge (groß nach klein, damit alle sichtbar bleiben).
 * Ein Schlachtschiff in der Armee überdeckt alle anderen Symbole.
 */
function pinShapes(a: Army): PinShape[] {
  if (isNaval(a)) return ['ship'];
  const order: [UnitType, PinShape][] = [
    ['railgun', 'bigTriangle'], ['artillery', 'triangle'], ['armoredCar', 'diamond'], ['tank', 'square'], ['infantry', 'circle'],
  ];
  return order.filter(([u]) => (a.units[u] ?? 0) > 0).map(([, sh]) => sh);
}

function drawNeedle(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, len: number) {
  const rad = (angle * Math.PI) / 180;
  ctx.strokeStyle = 'rgba(40, 30, 20, 0.85)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + Math.cos(rad) * len, y + Math.sin(rad) * len);
  ctx.stroke();
  ctx.fillStyle = '#2a1c10';
  ctx.beginPath();
  ctx.arc(x, y, 1.8, 0, Math.PI * 2);
  ctx.fill();
}

/** Halbe Breite/Höhe einer Form (Bildschirmpixel) */
function shapeSize(sh: PinShape, k: number): [number, number] {
  switch (sh) {
    case 'bigTriangle': return [10 * k, 9 * k];
    case 'triangle': return [7.5 * k, 6.5 * k];
    case 'diamond': return [5.5 * k, 7 * k];
    case 'square': return [4.5 * k, 4.5 * k];
    case 'circle': return [4.5 * k, 4.5 * k];
    case 'ship': return [11 * k, 5 * k];
  }
}

/** Ein Nadelkopf je Armee: die Formen aller Einheitentypen übereinander, daneben die Zahl der Einheiten. */
function drawPinHead(
  ctx: CanvasRenderingContext2D, cx: number, cy: number, shapes: PinShape[], color: string, count: number, small: boolean, selected: boolean,
  zoom = 1,
): { x: number; y: number; w: number; h: number } {
  const k = (small ? 0.75 : 1) * zoom;
  let hw = 0, hh = 0;
  for (const sh of shapes) {
    const [w, h] = shapeSize(sh, k);
    hw = Math.max(hw, w); hh = Math.max(hh, h);
  }
  ctx.save();
  for (const sh of shapes) {
    const [w, h] = shapeSize(sh, k);
    ctx.beginPath();
    switch (sh) {
      case 'circle': ctx.arc(cx, cy, w, 0, Math.PI * 2); break;
      case 'square': ctx.rect(cx - w, cy - h, 2 * w, 2 * h); break;
      case 'diamond':
        ctx.moveTo(cx, cy - h); ctx.lineTo(cx + w, cy); ctx.lineTo(cx, cy + h); ctx.lineTo(cx - w, cy);
        ctx.closePath();
        break;
      case 'triangle':
      case 'bigTriangle':
        ctx.moveTo(cx, cy - h); ctx.lineTo(cx + w, cy + h * 0.75); ctx.lineTo(cx - w, cy + h * 0.75);
        ctx.closePath();
        break;
      case 'ship':
        ctx.rect(cx - w, cy - h, 2 * w, 2 * h);
        break;
    }
    // heller Rand, damit der Kopf auch auf gleichfarbigem eigenem Gebiet lesbar bleibt
    ctx.strokeStyle = 'rgba(250, 242, 220, 0.95)';
    ctx.lineWidth = 3.5;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(30, 20, 12, 0.95)';
    ctx.lineWidth = 1.3;
    ctx.stroke();
  }
  // Zahl der Einheiten
  ctx.font = `bold ${Math.round((small ? 8 : 10) * zoom)}px Georgia, serif`;
  const label = String(count);
  const lw = ctx.measureText(label).width + 6 * zoom;
  const lh = (small ? 12 : 14) * zoom;
  const bx = cx + hw + 3, by = cy - lh / 2;
  ctx.fillStyle = 'rgba(245, 235, 210, 0.95)';
  ctx.strokeStyle = 'rgba(40, 28, 16, 0.8)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(bx, by, lw, lh, 3);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#20140a';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, bx + lw / 2, cy + 0.5);
  const box = { x: cx - hw - 4, y: cy - Math.max(hh, lh / 2) - 4, w: 2 * hw + lw + 11, h: 2 * Math.max(hh, lh / 2) + 8 };
  if (selected) {
    ctx.strokeStyle = '#f6d36b';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.roundRect(box.x, box.y, box.w, box.h, 5);
    ctx.stroke();
  }
  ctx.restore();
  return box;
}

/** Gekreuzte Säbel als Kampfanzeige */
function drawSwords(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.save();
  ctx.fillStyle = 'rgba(140, 25, 15, 0.9)';
  ctx.beginPath();
  ctx.arc(x, y, 9, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#f3e5bf';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x - 5, y - 5); ctx.lineTo(x + 5, y + 5);
  ctx.moveTo(x + 5, y - 5); ctx.lineTo(x - 5, y + 5);
  ctx.stroke();
  ctx.restore();
}
