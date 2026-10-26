// Strategiekarte im Stil der alten Supremacy-Karte: Pergament, gepunktete
// Provinzgrenzen, kräftige Staatsgrenzen, Städte- und Armeesymbole.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Res } from '../game/balance.ts';
import { harborSea, nodePos } from '../game/graph.ts';
import type { MapData } from '../game/mapdata.ts';
import { armyPosition, isNaval, unitCount } from '../game/military.ts';
import { makeRng } from '../game/rng.ts';
import { REBELS, type Army, type ProvinceState } from '../game/types.ts';
import { UNITS, type UnitType } from '../game/balance.ts';
import { RES_ICON } from './icons.tsx';

export type MapMode = 'political' | 'resources' | 'morale';

/** Fernkampf zwischen zwei Armeen für die Geschossanimation (von Nadelkopf zu Nadelkopf) */
export interface Shot {
  key: string;
  kind: UnitType;
  shooter: number;
  target: number;
}

/** Flugbild je Waffe: Takt, Flugzeit (ms), Bogenhöhe relativ zur Entfernung, Geschosse je Salve */
const BALLISTICS: Partial<Record<UnitType, { period: number; flight: number; arc: number; shells: number; size: number }>> = {
  artillery: { period: 1800, flight: 1100, arc: 0.45, shells: 1, size: 2.4 },
  railgun: { period: 2600, flight: 1700, arc: 0.6, shells: 1, size: 3.6 },
  battleship: { period: 1600, flight: 800, arc: 0.15, shells: 2, size: 2.8 },
};

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
  /** eigene Nation: deren Marschwege werden gezeichnet */
  nation?: string;
  /** sichtbare Knoten; übrige Provinzen liegen im Nebel */
  visible?: Set<number> | null;
  /** Provinzzustände für Gebäudesymbole (Schienen, Hafen, Festung); nur in sichtbaren Provinzen gezeichnet */
  provinces?: readonly ProvinceState[];
  selected?: number | null;
  selectedArmy?: number | null;
  /** Orte mit laufenden Kämpfen */
  battles?: number[];
  /** laufende Fernkampfgefechte (animiert) */
  shots?: Shot[];
  /** Vorschau eines Marschweges (Knoten) mit Beschriftung am Ziel */
  preview?: { path: number[]; label: string } | null;
  highlightNation?: string | null;
  mode?: MapMode;
  /** Klick auf eine Provinz (Menü-Vorschau) */
  onSelect?: (id: number | null) => void;
  /** Klick auf einen Knoten: Provinz (0..P-1) oder Seegebiet (P + Index), null = ins Leere */
  onNode?: (node: number | null) => void;
  onArmy?: (id: number) => void;
  onHoverNode?: (node: number | null) => void;
  /** Rechtsklick (z. B. Auswahl aufheben) */
  onContext?: () => void;
  /** Karte auf eine Provinz zentrieren; seq erhöhen, um erneut zu springen */
  focus?: { province: number; seq: number } | null;
  /** Vorschau im Menü: keine Namen, keine Armeen */
  compact?: boolean;
}

interface Token { id: number; x: number; y: number; w: number; h: number }

interface View { s: number; ox: number; oy: number }

const SEA = '#b7c6bf';
const SEA_DEEP = '#a9bab4';
const INK = 'rgba(58, 38, 22, 0.9)';

const iconImages: Partial<Record<Res, HTMLImageElement>> = {};
function iconImage(r: Res, onLoad: () => void): HTMLImageElement {
  let img = iconImages[r];
  if (!img) {
    img = new Image();
    img.src = RES_ICON[r];
    iconImages[r] = img;
  }
  if (!img.complete) img.addEventListener('load', onLoad, { once: true });
  return img;
}

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
      let best: [number, number] | null = null, bd = Infinity;
      for (const b of map.borders) {
        if (b.b >= 0 || b.a !== i) continue;
        for (let k = 0; k < b.segs.length; k += 2) {
          const d = Math.hypot(b.segs[k] - c[0], b.segs[k + 1] - c[1]);
          if (d < bd) { bd = d; best = [b.segs[k], b.segs[k + 1]]; }
        }
      }
      if (!best) best = mp.center;
      const len = Math.hypot(c[0] - best[0], c[1] - best[1]) || 1;
      return { x: best[0], y: best[1], dx: (c[0] - best[0]) / len, dy: (c[1] - best[1]) / len };
    });
    // Schienenwege: von der Stadt zu dem Punkt der gemeinsamen Grenze, der der Verbindungslinie
    // beider Städte am nächsten liegt – so bleibt die Strecke an Land und trifft die Bahn des Nachbarn
    const shared = new Map<string, number[]>();
    for (const b of map.borders) {
      if (b.b < 0) continue;
      const k = b.a < b.b ? `${b.a}|${b.b}` : `${b.b}|${b.a}`;
      (shared.get(k) ?? shared.set(k, []).get(k)!).push(...b.segs);
    }
    const railEdges = map.provinces.map((mp, i) => mp.neighbors.flatMap((n) => {
      const segs = shared.get(i < n ? `${i}|${n}` : `${n}|${i}`);
      if (!segs) return [];
      const q = map.provinces[n].center;
      const mx = (mp.center[0] + q[0]) / 2, my = (mp.center[1] + q[1]) / 2;
      let bx = mx, by = my, bd = Infinity;
      for (let k = 0; k < segs.length; k += 2) {
        const d = Math.hypot(segs[k] - mx, segs[k + 1] - my);
        if (d < bd) { bd = d; bx = segs[k]; by = segs[k + 1]; }
      }
      return [{ x: bx, y: by }];
    }));
    return { paths, boxes, coast, colors, names, seaBorders, harborSpots, railEdges };
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
      if (owners[i] !== map.provinces[i].nation && p.mode !== 'morale') {
        // besetzte Provinz: Schraffur in der Farbe des alten Besitzers
        ctx.save();
        ctx.clip(prepared.paths[i]);
        ctx.strokeStyle = prepared.colors.get(map.provinces[i].nation) ?? '#999';
        ctx.lineWidth = 3 / s;
        const b = prepared.boxes[i];
        ctx.beginPath();
        for (let x = b[0] - (b[3] - b[1]); x < b[2]; x += 12 / s) {
          ctx.moveTo(x, b[3]);
          ctx.lineTo(x + (b[3] - b[1]), b[1]);
        }
        ctx.stroke();
        ctx.restore();
      }
    }
    // Nebel des Krieges: nicht einsehbare Provinzen abdunkeln
    if (p.visible) {
      ctx.fillStyle = 'rgba(105, 95, 80, 0.32)';
      for (let i = 0; i < map.provinces.length; i++) if (!p.visible.has(i)) ctx.fill(prepared.paths[i]);
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
    ctx.strokeStyle = 'rgba(70, 50, 30, 0.45)';
    ctx.lineWidth = 0.9 / s;
    ctx.setLineDash([1.5 / s, 2.5 / s]);
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

    // Eisenbahn: Schienen von der Stadt bis zur Grenze jeder Nachbarprovinz (treffen sich bei beidseitiger Bahn)
    if (p.provinces && !compact) {
      const rails: [number, number, number, number][] = [];
      map.provinces.forEach((mp, i) => {
        if (!shown(i) || p.provinces![i].buildings.railroad <= 0) return;
        for (const e of prepared.railEdges[i]) {
          const x0 = X(mp.center[0]), y0 = Y(mp.center[1]);
          const x1 = X(e.x), y1 = Y(e.y);
          if (visible(x0, y0, 400) || visible(x1, y1, 400)) rails.push([x0, y0, x1, y1]);
        }
      });
      drawRails(ctx, rails, s);
    }

    // Rohstoffsymbole: immer sichtbar in der Mitte der Provinz, in der Rohstoffansicht größer
    if (s > 0.1 && !compact) {
      const big = p.mode === 'resources';
      const size = (big ? (s > 0.5 ? 20 : 16) : s > 0.5 ? 15 : 12) * 1.1;
      for (const mp of map.provinces) {
        const n = mp.double ? 2 : 1;
        const mx = X(mp.mid[0]);
        let my = Y(mp.mid[1]);
        // liegt die Mitte auf Stadt/Armee, etwas nach unten ausweichen
        const cx = X(mp.center[0]), cy = Y(mp.center[1]);
        if (Math.abs(mx - cx) < 24 && Math.abs(my - cy) < 18) my = cy + 20;
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

    // Häfen: Anker am Liegeplatz an der Küste
    if (p.provinces && !compact && s > 0.12) {
      map.provinces.forEach((_, i) => {
        const spot = prepared.harborSpots[i];
        if (!spot || !shown(i) || p.provinces![i].buildings.harbor <= 0) return;
        const x = X(spot.x) + spot.dx * 5, y = Y(spot.y) + spot.dy * 5;
        if (visible(x, y)) drawAnchor(ctx, x, y);
      });
    }

    if (!compact) {
      for (const mp of map.provinces) {
        if (!mp.city) continue;
        const x = X(mp.center[0]), y = Y(mp.center[1]);
        if (!visible(x, y)) continue;
        if (mp.capital) {
          ctx.fillStyle = '#f3e5bf';
          ctx.strokeStyle = INK;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(x, y, 5.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          star(ctx, x, y, 4.2, '#7a1f12');
        } else {
          ctx.fillStyle = '#f3e5bf';
          ctx.strokeStyle = INK;
          ctx.lineWidth = 1.1;
          ctx.fillRect(x - 3.5, y - 3.5, 7, 7);
          ctx.strokeRect(x - 3.5, y - 3.5, 7, 7);
          ctx.fillStyle = INK;
          ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
        }
      }

      // Festungen: Turm neben der Stadt, Stufe als Zahl
      if (p.provinces && s > 0.12) {
        map.provinces.forEach((mp, i) => {
          const lvl = p.provinces![i].buildings.fortress;
          if (lvl <= 0 || !shown(i)) return;
          const x = X(mp.center[0]) - 13, y = Y(mp.center[1]) + 1;
          if (visible(x, y)) drawFortress(ctx, x, y, lvl);
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
      for (const a of p.armies ?? []) {
        if (!a.move || a.owner !== p.nation) continue;
        const pts: [number, number][] = [armyPosition(map, a, time)];
        for (let k = a.move.seg + 1; k < a.move.path.length; k++) pts.push(nodePos(map, a.move.path[k]));
        linePath(pts, a.id === p.selectedArmy ? '#8a1f10' : 'rgba(60, 35, 20, 0.85)', [6, 4]);
        const end = pts[pts.length - 1];
        ctx.fillStyle = '#8a1f10';
        ctx.beginPath();
        ctx.arc(X(end[0]), Y(end[1]), 3.5, 0, Math.PI * 2);
        ctx.fill();
      }

      // Vorschau des Marschweges
      if (p.preview && p.preview.path.length > 1) {
        const pts = p.preview.path.map((n) => nodePos(map, n));
        const sel = p.armies?.find((a) => a.id === p.selectedArmy);
        if (sel) pts[0] = armyPosition(map, sel, time);
        linePath(pts, '#b8860b', [3, 4]);
        const [ex, ey] = pts[pts.length - 1];
        ctx.font = 'bold 12px Georgia, serif';
        const tw = ctx.measureText(p.preview.label).width;
        ctx.fillStyle = 'rgba(42, 26, 13, 0.88)';
        ctx.fillRect(X(ex) + 8, Y(ey) - 20, tw + 10, 18);
        ctx.fillStyle = '#ecd08f';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(p.preview.label, X(ex) + 13, Y(ey) - 11);
      }

      // Reichweitenkreise der ausgewählten Armee (je Fernkampfeinheit)
      const chosen = p.armies?.find((a) => a.id === p.selectedArmy);
      if (chosen) {
        const [px, py] = armyPosition(map, chosen, time);
        const ranges = new Map<number, string>();
        for (const u of Object.keys(chosen.units) as UnitType[]) {
          if ((chosen.units[u] ?? 0) > 0 && UNITS[u].range > 0) {
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
      if (p.armies) {
        const small = s < 0.35;
        const pins = p.armies.filter((a) => unitCount(a) > 0).map((a) => {
          const [px, py] = armyPosition(map, a, time);
          return { a, x: X(px), y: Y(py), angle: -80, len: small ? 20 : 28 };
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
          const radius = Math.max(pins[i].len, (small ? 22 : 30) * (n - 1) / ((spread * Math.PI) / 180));
          group.forEach((g, k) => {
            pins[g].angle = -90 - spread / 2 + (k * spread) / (n - 1);
            pins[g].len = radius + (k % 2 ? (small ? 4 : 7) : 0);
          });
        }
        for (const q of pins) drawNeedle(ctx, q.x, q.y, q.angle, q.len);
        for (const q of pins) {
          const rad = (q.angle * Math.PI) / 180;
          const hx = q.x + Math.cos(rad) * q.len, hy = q.y + Math.sin(rad) * q.len;
          heads.set(q.a.id, [hx, hy]);
          const t = drawPinHead(ctx, hx, hy, pinShapes(q.a), prepared.colors.get(q.a.owner) ?? '#888', unitCount(q.a), small, q.a.id === p.selectedArmy);
          hits.push({ id: q.a.id, ...t });
        }
      }
      tokens.current = hits;

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
          for (let k = 0; k < b.shells; k++) {
            const t = (now + base + k * 140) % b.period;
            const jitter = b.shells > 1 ? (k ? 4 : -4) : 0;
            const tx = x1 + jitter, ty = y1 - jitter / 2;
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

  const drag = useRef<{ x: number; y: number; ox: number; oy: number; moved: boolean } | null>(null);

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
          drag.current = { x: e.clientX, y: e.clientY, ox: view.current.ox, oy: view.current.oy, moved: false };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d) {
            if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 4) d.moved = true;
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
        }}
        onPointerLeave={() => {
          hoverRef.current = null;
          props.onHoverNode?.(null);
          setHover(null);
          schedule();
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (e.button !== 0 || (d?.moved && !compact)) return;
          const { mx, my, x, y } = toMap(e);
          const hit = [...tokens.current].reverse().find((t) => mx >= t.x && mx <= t.x + t.w && my >= t.y && my <= t.y + t.h);
          if (hit && props.onArmy) {
            props.onArmy(hit.id);
            return;
          }
          const node = hitNode(x, y);
          props.onNode?.(node);
          props.onSelect?.(node !== null && node < map.provinces.length ? node : null);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          props.onContext?.();
        }}
      />
      {hover && !props.preview && (
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

/** Hafen: Anker auf blauem Grund */
function drawAnchor(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.save();
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
function drawFortress(ctx: CanvasRenderingContext2D, x: number, y: number, level: number) {
  ctx.save();
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
): { x: number; y: number; w: number; h: number } {
  const k = small ? 0.75 : 1;
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
  ctx.font = `bold ${small ? 8 : 10}px Georgia, serif`;
  const label = String(count);
  const lw = ctx.measureText(label).width + 6;
  const lh = small ? 12 : 14;
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
