// Karten-Zeichner (nur mit Dev-Server): Karten frei zeichnen oder aus einer PNG-Vorlage einlesen.
// Provinzen teilen sich ihre Grenzpunkte; Nationen, Groß-/Kleinstaaten, Hauptstädte, Rohstoffe, Seepunkte
// und Verbindungen werden hier festgelegt. Export schreibt eine spielfertige Karte nach public/maps.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CATEGORY_NAMES, RES_NAMES } from '../game/balance.ts';
import {
  addProvince, addVertex, autoLinks, cityOf, DEFAULT_COLORS, deleteVertex, edgeOwners, exportDraft, getProvince, insertOnEdge,
  mergeProvinces, midPoint, moveVertex, nearestEdge, nearestVertex, newDraft, parseRef, provArea, provinceAt, provPts, provRef,
  removeProvince, removeSea, rescaleDraft, seaRef, splitProvince, toggleLink, tracePath, weldVertex,
  type Draft, type ImportColors, type NodeRef, type Pt,
} from '../game/draft.ts';
import { DEFAULT_IMPORT, importRaster, rgbToHex } from '../game/draftImport.ts';
import { checkNation } from '../game/mapcheck.ts';
import { RESOURCES, type Resource } from '../game/mapdata.ts';
import { iconImage, ResIcon } from './icons.tsx';
import { forgetMap } from './maps.ts';

type Tool = 'select' | 'draw' | 'split' | 'vertex' | 'merge' | 'sea' | 'link' | 'nation' | 'resource';

const TOOLS: { id: Tool; name: string; key: string; help: string }[] = [
  { id: 'select', name: 'Auswahl', key: '1', help: 'Provinz oder Seepunkt anklicken. Stadtpunkt und Seepunkte ziehen verschiebt sie, Strg+Klick setzt die Stadt der Provinz an diese Stelle. Ziehen auf freier Fläche verschiebt die Ansicht.' },
  { id: 'draw', name: 'Provinz zeichnen', key: '2', help: 'Punkte setzen; Klick auf den ersten Punkt oder Enter schließt die Provinz. Klicks auf vorhandene Punkte und Kanten rasten ein; zwei Punkte derselben Grenze werden entlang dieser Grenze nachgezeichnet (Alt: gerade). Rücktaste nimmt den letzten Punkt zurück, Esc bricht ab.' },
  { id: 'split', name: 'Teilen', key: '3', help: 'Auf dem Rand einer Provinz beginnen, Punkte im Inneren setzen und auf dem Rand beenden – die Provinz wird entlang dieser Linie geteilt.' },
  { id: 'vertex', name: 'Punkte', key: '4', help: 'Grenzpunkte ziehen (wirkt auf alle Provinzen, die ihn teilen); auf einen anderen Punkt fallen lassen verschweißt beide. Klick auf eine Kante fügt einen Punkt ein, Rechtsklick löscht einen Punkt.' },
  { id: 'merge', name: 'Verschmelzen', key: '5', help: 'Erst die Provinz anklicken, die bleibt, dann die, die in ihr aufgeht.' },
  { id: 'sea', name: 'Seepunkte', key: '6', help: 'Klick ins Wasser setzt einen Seepunkt, Ziehen verschiebt, Rechtsklick löscht.' },
  { id: 'link', name: 'Verbindungen', key: '7', help: 'Zwei Orte nacheinander anklicken (Provinz = ihre Stadt, oder Seepunkt): Verbindung an/aus. Danach geht es vom zweiten Ort weiter; Esc beendet. Rechtsklick auf eine Linie löscht sie.' },
  { id: 'nation', name: 'Nation malen', key: '8', help: 'Klick weist die gewählte Nation zu, Umschalt+Klick macht die Provinz zur Hauptstadt ihrer Nation, Rechtsklick entfernt die Nation.' },
  { id: 'resource', name: 'Rohstoff malen', key: '9', help: 'Klick setzt den gewählten Rohstoff, Rechtsklick schaltet Doppelprovinz um, Umschalt+Klick entfernt den Rohstoff.' },
];

const COLOR_SLOTS: { key: keyof ImportColors; name: string }[] = [
  { key: 'land', name: 'Land' },
  { key: 'border', name: 'Grenzen' },
  { key: 'capital', name: 'Hauptstädte' },
  { key: 'sea', name: 'Seepunkte' },
  { key: 'link', name: 'Verbindungen' },
];

const NATION_COLORS = ['#8e9aa6', '#d8c47e', '#7b97c9', '#c86a5e', '#8cba72', '#5f9877', '#cf9f5e', '#e3b9a0', '#69adbb', '#b493c4',
  '#b8643f', '#9a8c5c', '#d39bb0', '#e6a160', '#c6b25f', '#e3c7c3', '#d88f8a', '#c9a24a', '#a7c69a', '#a8866e', '#937d9c', '#93c1df'];

const SNAP_PX = 9;
const EDGE_PX = 6;
const NO_NATION = '#d9cfb8';

interface PathEntry { v?: number; pt: Pt }
type Sel = { kind: 'prov'; id: number } | { kind: 'sea'; id: number } | null;
interface View { s: number; ox: number; oy: number }
interface Drag {
  kind: 'pan' | 'vertex' | 'sea' | 'city';
  id: number;
  sx: number;
  sy: number;
  view: View;
  moved: boolean;
  at: Pt;
  button: number;
}
interface ImageInfo { src: string; el: HTMLImageElement; data: ImageData }
interface SavedDraft { id: string; name: string; draft: Draft; image: string | null; imageOpacity?: number; imageVisible?: boolean }
interface CheckResult { errors: string[]; warnings: string[]; nations: { id: string; name: string; text: string; problems: string[] }[] }

const isTyping = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
};

async function loadImage(src: string): Promise<ImageInfo> {
  const el = new Image();
  el.src = src;
  await el.decode();
  const c = document.createElement('canvas');
  c.width = el.naturalWidth;
  c.height = el.naturalHeight;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(el, 0, 0);
  return { src, el, data: g.getImageData(0, 0, c.width, c.height) };
}

export function MapDrafter({ onExit }: { onExit(): void }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [image, setImage] = useState<ImageInfo | null>(null);
  const [imgOpacity, setImgOpacity] = useState(0.6);
  const [imgVisible, setImgVisible] = useState(true);
  const [history, setHistory] = useState<Draft[]>([]);
  const [future, setFuture] = useState<Draft[]>([]);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState('');
  const [tool, setToolState] = useState<Tool>('select');
  const [sel, setSel] = useState<Sel>(null);
  const [path, setPath] = useState<PathEntry[]>([]);
  const [mergeFrom, setMergeFrom] = useState<number | null>(null);
  const [linkFrom, setLinkFrom] = useState<NodeRef | null>(null);
  const [brushNation, setBrushNation] = useState<string | null>(null);
  const [brushRes, setBrushRes] = useState<Resource>('grain');
  const [pick, setPick] = useState<keyof ImportColors | null>(null);
  const [importOpt, setImportOpt] = useState(DEFAULT_IMPORT);
  const [importConfirm, setImportConfirm] = useState(false);
  const [importNotes, setImportNotes] = useState<string[]>([]);
  const [busy, setBusy] = useState('');
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [overwrite, setOverwrite] = useState<string | null>(null);
  const [hover, setHover] = useState('');
  const [sizeEdit, setSizeEdit] = useState<{ w: string; h: string } | null>(null);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const view = useRef<View>({ s: 0.3, ox: 20, oy: 20 });
  const frame = useRef(0);
  const draftRef = useRef<Draft | null>(null);
  draftRef.current = draft;
  const drag = useRef<Drag | null>(null);
  const mouse = useRef<Pt | null>(null);
  const snap = useRef<{ v?: number; edge?: { a: number; b: number; at: Pt } } | null>(null);
  const lastKey = useRef<{ key?: string; t: number }>({ t: 0 });
  const geomCache = useRef(new Map<number, { key: string; city: Pt; mid: Pt }>());

  const setTool = (t: Tool) => {
    setToolState(t);
    setPath([]);
    setMergeFrom(null);
    setLinkFrom(null);
    setPick(null);
  };

  // ---------------------------------------------------------------- Änderungen mit Rückgängig

  const commit = (fn: (d: Draft) => string | void, key?: string): boolean => {
    const cur = draftRef.current;
    if (!cur) return false;
    const next = structuredClone(cur);
    const err = fn(next);
    if (typeof err === 'string') {
      setStatus(err);
      return false;
    }
    const now = Date.now();
    const coalesce = !!key && lastKey.current.key === key && now - lastKey.current.t < 1500;
    lastKey.current = { key, t: now };
    if (!coalesce) setHistory((h) => [...h.slice(-99), cur]);
    setFuture([]);
    draftRef.current = next;
    setDraft(next);
    setDirty(true);
    return true;
  };
  const undo = () => {
    if (!history.length || !draft) return;
    setFuture((f) => [draft, ...f]);
    setDraft(history[history.length - 1]);
    setHistory((h) => h.slice(0, -1));
    setPath([]);
    lastKey.current = { t: 0 };
    setDirty(true);
  };
  const redo = () => {
    if (!future.length || !draft) return;
    setHistory((h) => [...h, draft]);
    setDraft(future[0]);
    setFuture((f) => f.slice(1));
    setPath([]);
    setDirty(true);
  };

  // ---------------------------------------------------------------- abgeleitete Geometrie

  /** Stadt und Rohstoffpunkt je Provinz (nur geänderte Provinzen neu berechnen) */
  const geom = useMemo(() => {
    const out = new Map<number, { city: Pt; mid: Pt }>();
    if (!draft) return out;
    const cache = geomCache.current;
    for (const p of draft.provinces) {
      const key = JSON.stringify(p.polys) + '|' + p.polys.flat(2).map((v) => draft.verts[v]?.join(',')).join(';') + '|' + (p.city?.join(',') ?? '');
      let c = cache.get(p.id);
      if (!c || c.key !== key) {
        const city = cityOf(draft, p);
        c = { key, city, mid: midPoint(draft, p, city) };
        cache.set(p.id, c);
      }
      out.set(p.id, { city: c.city, mid: c.mid });
    }
    return out;
  }, [draft]);

  const shapes = useMemo(() => {
    if (!draft) return null;
    const paths = new Map<number, Path2D>();
    for (const p of draft.provinces) {
      const path2 = new Path2D();
      for (const part of provPts(draft, p)) for (const ring of part) {
        if (ring.length < 2) continue;
        path2.moveTo(ring[0][0], ring[0][1]);
        for (let k = 1; k < ring.length; k++) path2.lineTo(ring[k][0], ring[k][1]);
        path2.closePath();
      }
      paths.set(p.id, path2);
    }
    const nationOf = new Map(draft.provinces.map((p) => [p.id, p.nation]));
    const inner = new Path2D(), national = new Path2D(), coast = new Path2D();
    for (const e of edgeOwners(draft).values()) {
      const a = draft.verts[e.a], b = draft.verts[e.b];
      const target = e.owners.length === 1 ? coast : e.owners.every((o) => nationOf.get(o) === nationOf.get(e.owners[0])) ? inner : national;
      target.moveTo(a[0], a[1]);
      target.lineTo(b[0], b[1]);
    }
    return { paths, inner, national, coast };
  }, [draft]);

  const nodePos = (d: Draft, r: NodeRef): Pt | null => {
    const { kind, id } = parseRef(r);
    if (kind === 's') return d.seas.find((z) => z.id === id)?.at ?? null;
    return geom.get(id)?.city ?? null;
  };

  // ---------------------------------------------------------------- Zeichnen

  // gezeichnet wird immer mit dem Stand des letzten Renders (Entwurf, Formen und Werkzeug passen zusammen)
  const drawRef = useRef<() => void>(() => {});
  const schedule = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      drawRef.current();
    });
  };

  const draw = () => {
    const canvas = canvasRef.current, wrap = wrapRef.current;
    const d = draft;
    if (!canvas || !wrap || !d || !shapes) return;
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth, h = wrap.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d')!;
    const { s, ox, oy } = view.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#5a4a36';
    ctx.fillRect(0, 0, w, h);
    const X = (x: number) => ox + x * s, Y = (y: number) => oy + y * s;
    // Kartenfläche (Wasser)
    ctx.fillStyle = '#c4d7df';
    ctx.fillRect(X(0), Y(0), d.width * s, d.height * s);
    if (image && imgVisible) {
      ctx.globalAlpha = imgOpacity;
      ctx.imageSmoothingEnabled = s * d.width < image.el.naturalWidth;
      ctx.drawImage(image.el, X(0), Y(0), d.width * s, d.height * s);
      ctx.imageSmoothingEnabled = true;
      ctx.globalAlpha = 1;
    }
    // gezogener Punkt: betroffene Provinzen mit der neuen Lage zeichnen
    const dr = drag.current;
    const dragV = dr?.kind === 'vertex' && dr.moved ? dr.id : null;
    const vpos = (v: number): Pt => (v === dragV ? dr!.at : d.verts[v]);
    const dragged = new Set<number>();
    if (dragV !== null) for (const p of d.provinces) if (p.polys.some((part) => part.some((r) => r.includes(dragV)))) dragged.add(p.id);
    const livePath = (pid: number) => {
      const p = getProvince(d, pid)!;
      const out = new Path2D();
      for (const part of p.polys) for (const r of part) {
        out.moveTo(...vpos(r[0]));
        for (let k = 1; k < r.length; k++) out.lineTo(...vpos(r[k]));
        out.closePath();
      }
      return out;
    };

    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
    const colors = new Map(d.nations.map((n) => [n.id, n.color]));
    const fillAlpha = image && imgVisible ? 0.55 : 0.92;
    ctx.globalAlpha = fillAlpha;
    for (const p of d.provinces) {
      const pp = dragged.has(p.id) ? livePath(p.id) : shapes.paths.get(p.id)!;
      ctx.fillStyle = (p.nation && colors.get(p.nation)) || NO_NATION;
      ctx.fill(pp, 'evenodd');
    }
    ctx.globalAlpha = 1;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (dragV === null) {
      ctx.strokeStyle = 'rgba(60, 45, 30, 0.55)';
      ctx.lineWidth = 1 / s;
      ctx.stroke(shapes.inner);
      ctx.strokeStyle = 'rgba(35, 55, 70, 0.9)';
      ctx.lineWidth = 1.4 / s;
      ctx.stroke(shapes.coast);
      ctx.strokeStyle = 'rgba(40, 25, 15, 0.95)';
      ctx.lineWidth = 2.2 / s;
      ctx.stroke(shapes.national);
    } else {
      ctx.strokeStyle = 'rgba(60, 45, 30, 0.8)';
      ctx.lineWidth = 1.2 / s;
      for (const p of d.provinces) ctx.stroke(dragged.has(p.id) ? livePath(p.id) : shapes.paths.get(p.id)!);
    }
    // Auswahl
    const outline = (pid: number, color: string) => {
      const pp = shapes.paths.get(pid);
      if (!pp) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 3 / s;
      ctx.stroke(pp);
    };
    if (sel?.kind === 'prov') outline(sel.id, '#e8b730');
    if (mergeFrom !== null) outline(mergeFrom, '#2a7ad4');

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Verbindungen
    for (const [a, b] of d.links) {
      const pa = nodePos(d, a), pb = nodePos(d, b);
      if (!pa || !pb) continue;
      const sea = a[0] === 's' || b[0] === 's';
      ctx.strokeStyle = sea ? 'rgba(30, 80, 140, 0.75)' : 'rgba(110, 60, 20, 0.8)';
      ctx.lineWidth = 1.6;
      ctx.setLineDash(a[0] === 's' && b[0] === 's' ? [5, 4] : []);
      ctx.beginPath();
      ctx.moveTo(X(pa[0]), Y(pa[1]));
      ctx.lineTo(X(pb[0]), Y(pb[1]));
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // Rohstoffe
    const size = Math.max(10, Math.min(22, 26 * s));
    for (const p of d.provinces) {
      if (!p.resource) continue;
      const g = geom.get(p.id);
      if (!g) continue;
      const img = iconImage(p.resource, schedule);
      if (!img.complete) continue;
      const n = p.double ? 2 : 1;
      const x = X(g.mid[0]) - (n * size) / 2, y = Y(g.mid[1]) - size / 2;
      if (x > w || y > h || x + n * size < 0 || y + size < 0) continue;
      ctx.fillStyle = 'rgba(245, 235, 210, 0.75)';
      ctx.beginPath();
      ctx.roundRect(x - 2, y - 2, n * size + 4, size + 4, 4);
      ctx.fill();
      for (let k = 0; k < n; k++) ctx.drawImage(img, x + k * size, y, size, size);
    }
    // Städte
    const capitals = new Set(d.nations.map((n) => n.capital));
    for (const p of d.provinces) {
      const g = geom.get(p.id);
      if (!g) continue;
      const x = X(g.city[0]), y = Y(g.city[1]);
      if (x < -20 || y < -20 || x > w + 20 || y > h + 20) continue;
      if (capitals.has(p.id)) {
        ctx.fillStyle = '#c0281b';
        ctx.strokeStyle = '#3a0d08';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        for (let k = 0; k < 10; k++) {
          const r = k % 2 ? 3.4 : 8, a = -Math.PI / 2 + (k * Math.PI) / 5;
          ctx[k ? 'lineTo' : 'moveTo'](x + r * Math.cos(a), y + r * Math.sin(a));
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else {
        const r = p.bigCity ? 4.5 : 3;
        ctx.fillStyle = p.city ? '#f4ecd8' : 'rgba(244, 236, 216, 0.6)';
        ctx.strokeStyle = '#2b2116';
        ctx.lineWidth = 1.2;
        ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
        ctx.strokeRect(x - r, y - r, 2 * r, 2 * r);
      }
      if (s > 0.45) {
        ctx.font = '12px "Palatino Linotype", Georgia, serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(245, 235, 210, 0.85)';
        ctx.strokeText(p.name, x, y + 7);
        ctx.fillStyle = '#2b2116';
        ctx.fillText(p.name, x, y + 7);
      }
    }
    // Seepunkte
    for (const z of d.seas) {
      const at = dr?.kind === 'sea' && dr.id === z.id && dr.moved ? dr.at : z.at;
      const x = X(at[0]), y = Y(at[1]);
      ctx.beginPath();
      ctx.arc(x, y, 4.2, 0, Math.PI * 2);
      ctx.fillStyle = sel?.kind === 'sea' && sel.id === z.id ? '#e8b730' : '#eef2f0';
      ctx.fill();
      ctx.strokeStyle = '#23465f';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
    if (dr?.kind === 'city' && dr.moved) {
      ctx.strokeStyle = '#e8b730';
      ctx.lineWidth = 2;
      ctx.strokeRect(X(dr.at[0]) - 5, Y(dr.at[1]) - 5, 10, 10);
    }
    // Grenzpunkte
    if (tool === 'vertex' || tool === 'draw' || tool === 'split') {
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#333';
      ctx.lineWidth = 1;
      const many = Object.keys(d.verts).length > 4000 && s < 0.6;
      for (const [k, p] of Object.entries(d.verts)) {
        const at = Number(k) === dragV ? dr!.at : p;
        const x = X(at[0]), y = Y(at[1]);
        if (x < 0 || y < 0 || x > w || y > h) continue;
        if (many) { ctx.fillRect(x - 1, y - 1, 2, 2); continue; }
        ctx.fillRect(x - 2.5, y - 2.5, 5, 5);
        ctx.strokeRect(x - 2.5, y - 2.5, 5, 5);
      }
    }
    // Einrasten
    const sn = snap.current;
    if (sn && (tool === 'vertex' || tool === 'draw' || tool === 'split')) {
      const at = sn.v !== undefined ? d.verts[sn.v] : sn.edge?.at;
      if (at) {
        ctx.strokeStyle = sn.v !== undefined ? '#e8b730' : '#2a7ad4';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(X(at[0]), Y(at[1]), 6, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    // laufender Pfad (Zeichnen/Teilen) bzw. Verbindung
    const pts = path.map((e) => (e.v !== undefined ? d.verts[e.v] ?? e.pt : e.pt));
    if (pts.length) {
      ctx.strokeStyle = tool === 'split' ? '#c0281b' : '#1d5fae';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(X(pts[0][0]), Y(pts[0][1]));
      for (const p of pts.slice(1)) ctx.lineTo(X(p[0]), Y(p[1]));
      if (mouse.current) ctx.lineTo(X(mouse.current[0]), Y(mouse.current[1]));
      ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle;
      for (const p of pts) ctx.fillRect(X(p[0]) - 3, Y(p[1]) - 3, 6, 6);
    }
    if (linkFrom && mouse.current) {
      const a = nodePos(d, linkFrom);
      if (a) {
        ctx.strokeStyle = '#1d5fae';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(X(a[0]), Y(a[1]));
        ctx.lineTo(X(mouse.current[0]), Y(mouse.current[1]));
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    // Rahmen der Karte
    ctx.strokeStyle = '#2b2116';
    ctx.lineWidth = 2;
    ctx.strokeRect(X(0), Y(0), d.width * s, d.height * s);
  };

  drawRef.current = draw;
  useEffect(schedule);

  const fit = () => {
    const wrap = wrapRef.current, d = draftRef.current;
    if (!wrap || !d) return;
    const w = wrap.clientWidth, h = wrap.clientHeight;
    const s = Math.min(w / d.width, h / d.height) * 0.95;
    view.current = { s, ox: (w - d.width * s) / 2, oy: (h - d.height * s) / 2 };
    schedule();
  };
  const fitted = useRef<string | null>(null);
  useEffect(() => {
    if (draft && fitted.current !== draft.id) {
      fitted.current = draft.id;
      fit();
    }
  });
  useEffect(() => {
    const onResize = () => schedule();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });

  // ---------------------------------------------------------------- Maus

  const toKm = (cx: number, cy: number): Pt => {
    const r = canvasRef.current!.getBoundingClientRect();
    const { s, ox, oy } = view.current;
    return [(cx - r.left - ox) / s, (cy - r.top - oy) / s];
  };
  const px = (n: number) => n / view.current.s;

  const seaHit = (d: Draft, p: Pt) => {
    let best: number | null = null, bd = px(SNAP_PX);
    for (const z of d.seas) {
      const dd = Math.hypot(z.at[0] - p[0], z.at[1] - p[1]);
      if (dd <= bd) { bd = dd; best = z.id; }
    }
    return best;
  };
  const cityHit = (d: Draft, p: Pt) => {
    let best: number | null = null, bd = px(SNAP_PX);
    for (const q of d.provinces) {
      const c = geom.get(q.id)?.city;
      if (!c) continue;
      const dd = Math.hypot(c[0] - p[0], c[1] - p[1]);
      if (dd <= bd) { bd = dd; best = q.id; }
    }
    return best;
  };
  const linkHit = (d: Draft, p: Pt): [NodeRef, NodeRef] | null => {
    let best: [NodeRef, NodeRef] | null = null, bd = px(EDGE_PX);
    for (const l of d.links) {
      const a = nodePos(d, l[0]), b = nodePos(d, l[1]);
      if (!a || !b) continue;
      const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
      const dd = Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
      if (dd < bd) { bd = dd; best = l; }
    }
    return best;
  };
  const snapAt = (d: Draft, p: Pt) => {
    const v = nearestVertex(d, p[0], p[1], px(SNAP_PX));
    if (v !== null) return { v };
    const edge = nearestEdge(d, p[0], p[1], px(EDGE_PX));
    return edge ? { edge } : null;
  };

  const onWheel = (e: React.WheelEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const v = view.current;
    const f = Math.exp(-e.deltaY * 0.0015);
    const s = Math.max(0.02, Math.min(40, v.s * f));
    view.current = { s, ox: mx - ((mx - v.ox) * s) / v.s, oy: my - ((my - v.oy) * s) / v.s };
    schedule();
  };

  const onDown = (e: React.PointerEvent) => {
    const d = draftRef.current;
    if (!d) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    const p = toKm(e.clientX, e.clientY);
    const base = { sx: e.clientX, sy: e.clientY, view: { ...view.current }, moved: false, at: p, button: e.button };
    if (e.button !== 0) {
      drag.current = { kind: 'pan', id: 0, ...base };
      return;
    }
    if (tool === 'select' || tool === 'sea') {
      const z = seaHit(d, p);
      if (z !== null) { drag.current = { kind: 'sea', id: z, ...base }; return; }
    }
    if (tool === 'select') {
      const c = cityHit(d, p);
      if (c !== null && !e.ctrlKey) { drag.current = { kind: 'city', id: c, ...base }; return; }
    }
    if (tool === 'vertex') {
      const v = nearestVertex(d, p[0], p[1], px(SNAP_PX));
      if (v !== null) { drag.current = { kind: 'vertex', id: v, ...base }; return; }
    }
    drag.current = { kind: 'pan', id: 0, ...base };
  };

  const onMove = (e: React.PointerEvent) => {
    const d = draftRef.current;
    if (!d) return;
    const p = toKm(e.clientX, e.clientY);
    mouse.current = p;
    const dr = drag.current;
    if (dr) {
      if (!dr.moved && Math.hypot(e.clientX - dr.sx, e.clientY - dr.sy) > 4) dr.moved = true;
      if (dr.moved) {
        if (dr.kind === 'pan') {
          view.current = { ...dr.view, ox: dr.view.ox + e.clientX - dr.sx, oy: dr.view.oy + e.clientY - dr.sy };
        } else if (dr.kind === 'vertex') {
          // auf anderen Punkt einrasten
          const other = nearestVertex(d, p[0], p[1], px(SNAP_PX), new Set([dr.id]));
          dr.at = other !== null ? d.verts[other] : p;
          snap.current = other !== null ? { v: other } : null;
        } else {
          dr.at = p;
        }
      }
    } else if (tool === 'vertex' || tool === 'draw' || tool === 'split') {
      snap.current = snapAt(d, p);
    } else {
      snap.current = null;
    }
    // Statuszeile
    const z = seaHit(d, p);
    const q = z === null ? provinceAt(d, p[0], p[1]) : null;
    const nation = q?.nation ? d.nations.find((n) => n.id === q.nation)?.name ?? q.nation : null;
    setHover(`${Math.round(p[0])} / ${Math.round(p[1])} km` + (z !== null ? ` · ${d.seas.find((x) => x.id === z)?.name}` : q ? ` · ${q.name}${nation ? ` (${nation})` : ''}${q.resource ? ` · ${RES_NAMES[q.resource]}${q.double ? ' ×2' : ''}` : ''}` : ''));
    schedule();
  };

  const onUp = (e: React.PointerEvent) => {
    const d = draftRef.current;
    const dr = drag.current;
    drag.current = null;
    if (!d || !dr) return;
    if (dr.moved) {
      if (dr.kind === 'vertex') {
        const other = nearestVertex(d, dr.at[0], dr.at[1], 0.0001, new Set([dr.id]));
        if (other !== null) commit((x) => weldVertex(x, dr.id, other));
        else commit((x) => moveVertex(x, dr.id, dr.at));
        snap.current = null;
      } else if (dr.kind === 'sea') {
        commit((x) => { const z = x.seas.find((q) => q.id === dr.id); if (z) z.at = [Math.round(dr.at[0] * 10) / 10, Math.round(dr.at[1] * 10) / 10]; });
      } else if (dr.kind === 'city') {
        const q = getProvince(d, dr.id);
        if (q && !provinceAt(d, dr.at[0], dr.at[1])) setStatus('Die Stadt muss in ihrer Provinz liegen.');
        else if (q && provinceAt(d, dr.at[0], dr.at[1])?.id !== q.id) setStatus('Die Stadt muss in ihrer Provinz liegen.');
        else commit((x) => { const r = getProvince(x, dr.id); if (r) r.city = [Math.round(dr.at[0] * 10) / 10, Math.round(dr.at[1] * 10) / 10]; });
      }
      schedule();
      return;
    }
    click(d, toKm(e.clientX, e.clientY), dr.button, e);
    schedule();
  };

  // ---------------------------------------------------------------- Klicks je Werkzeug

  /** Klickpunkt für Zeichnen/Teilen: vorhandener Punkt, neuer Punkt auf einer Kante oder freier Punkt */
  const entryAt = (d: Draft, p: Pt): PathEntry | null => {
    const sn = snapAt(d, p);
    if (sn?.v !== undefined) return { v: sn.v, pt: d.verts[sn.v] };
    if (sn?.edge) {
      let v = -1;
      const ed = sn.edge;
      if (!commit((x) => { v = insertOnEdge(x, ed.a, ed.b, ed.at); })) return null;
      return { v, pt: ed.at };
    }
    return { pt: p };
  };

  const finishDraw = (entries: PathEntry[]) => {
    if (entries.length < 3) { setStatus('Eine Provinz braucht mindestens drei Punkte.'); return; }
    commit((x) => {
      const ids = entries.map((e) => e.v ?? addVertex(x, e.pt));
      const q = addProvince(x, ids, { nation: brushNation });
      setSel({ kind: 'prov', id: q.id });
    });
    setPath([]);
  };

  const finishSplit = (entries: PathEntry[]) => {
    const d = draftRef.current!;
    const u = entries[0].v!, v = entries[entries.length - 1].v!;
    // Provinz, deren Außenring beide Enden enthält und in der der erste Abschnitt verläuft
    const a = entries[0].pt, b = entries[1].pt;
    const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const cand = d.provinces.filter((q) => q.polys.some((part) => part[0].includes(u) && part[0].includes(v)));
    const target = cand.find((q) => provPts(d, q).some((part) => part.length && pointInside(part, mid))) ?? (cand.length === 1 ? cand[0] : null);
    if (!target) { setStatus('Anfang und Ende müssen auf dem Rand derselben Provinz liegen, der Schnitt in ihr.'); setPath([]); return; }
    commit((x) => {
      const ids = entries.map((e) => e.v ?? addVertex(x, e.pt));
      const r = splitProvince(x, target.id, ids);
      if (typeof r === 'string') return r;
      setSel({ kind: 'prov', id: r.id });
    });
    setPath([]);
  };

  const click = (d: Draft, p: Pt, button: number, e: React.PointerEvent) => {
    if (pick && image) {
      const ix = Math.floor((p[0] / d.width) * image.data.width), iy = Math.floor((p[1] / d.height) * image.data.height);
      if (ix >= 0 && iy >= 0 && ix < image.data.width && iy < image.data.height) {
        const o = (iy * image.data.width + ix) * 4;
        const hex = rgbToHex(image.data.data[o], image.data.data[o + 1], image.data.data[o + 2]);
        const slot = pick;
        commit((x) => { x.colors = { ...(x.colors ?? DEFAULT_COLORS), [slot]: hex }; });
        setStatus(`${COLOR_SLOTS.find((c) => c.key === slot)?.name}: ${hex}`);
      }
      setPick(null);
      return;
    }
    const right = button === 2;
    const prov = provinceAt(d, p[0], p[1]);
    switch (tool) {
      case 'select': {
        if (right) return;
        if (e.ctrlKey && prov) {
          commit((x) => { const q = getProvince(x, prov.id); if (q) q.city = [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]; });
          return;
        }
        const z = seaHit(d, p);
        setSel(z !== null ? { kind: 'sea', id: z } : prov ? { kind: 'prov', id: prov.id } : null);
        return;
      }
      case 'draw': {
        if (right) { setPath((pp) => pp.slice(0, -1)); return; }
        const first = path[0];
        if (path.length >= 3 && first && Math.hypot(first.pt[0] - p[0], first.pt[1] - p[1]) <= px(SNAP_PX)) { finishDraw(path); return; }
        const en = entryAt(draftRef.current!, p);
        if (!en) return;
        if (path.length >= 3 && en.v !== undefined && en.v === first.v) { finishDraw(path); return; }
        const prev = path[path.length - 1];
        const extra: PathEntry[] = [];
        if (prev?.v !== undefined && en.v !== undefined && !e.altKey) {
          const dd = draftRef.current!;
          const tr = tracePath(dd, prev.v, en.v);
          if (tr) extra.push(...tr.map((v) => ({ v, pt: dd.verts[v] })));
        }
        setPath((pp) => [...pp, ...extra, en]);
        return;
      }
      case 'split': {
        if (right) { setPath((pp) => pp.slice(0, -1)); return; }
        const en = entryAt(draftRef.current!, p);
        if (!en) return;
        if (!path.length) {
          if (en.v === undefined) { setStatus('Der Schnitt beginnt auf dem Rand einer Provinz (Punkt oder Kante anklicken).'); return; }
          setPath([en]);
          return;
        }
        if (en.v !== undefined) { finishSplit([...path, en]); return; }
        setPath((pp) => [...pp, en]);
        return;
      }
      case 'vertex': {
        const v = nearestVertex(d, p[0], p[1], px(SNAP_PX));
        if (right) {
          if (v !== null && !commit((x) => (deleteVertex(x, v) ? undefined : 'Der Ring hätte zu wenige Punkte.'))) return;
          return;
        }
        if (v === null) {
          const ed = nearestEdge(d, p[0], p[1], px(EDGE_PX));
          if (ed) commit((x) => { insertOnEdge(x, ed.a, ed.b, ed.at); });
        }
        return;
      }
      case 'merge': {
        if (right || !prov) { setMergeFrom(null); return; }
        if (mergeFrom === null) { setMergeFrom(prov.id); setStatus(`${prov.name}: jetzt die Provinz anklicken, die darin aufgeht.`); return; }
        const keep = mergeFrom;
        setMergeFrom(null);
        if (commit((x) => mergeProvinces(x, keep, prov.id) ?? undefined)) setSel({ kind: 'prov', id: keep });
        return;
      }
      case 'sea': {
        const z = seaHit(d, p);
        if (right) { if (z !== null) commit((x) => removeSea(x, z)); return; }
        if (z !== null) { setSel({ kind: 'sea', id: z }); return; }
        if (p[0] < 0 || p[1] < 0 || p[0] > d.width || p[1] > d.height) return;
        commit((x) => {
          const id = x.nextId++;
          x.seas.push({ id, name: `Seepunkt ${x.seas.length + 1}`, at: [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10] });
        });
        return;
      }
      case 'link': {
        if (right) {
          const l = linkHit(d, p);
          if (l) commit((x) => { toggleLink(x, l[0], l[1]); });
          return;
        }
        const z = seaHit(d, p);
        const node = z !== null ? seaRef(z) : prov ? provRef(prov.id) : null;
        if (!node) { setLinkFrom(null); return; }
        if (!linkFrom) { setLinkFrom(node); return; }
        if (node === linkFrom) { setLinkFrom(null); return; }
        const from = linkFrom;
        commit((x) => { toggleLink(x, from, node); });
        setLinkFrom(node);
        return;
      }
      case 'nation': {
        if (!prov) return;
        if (right) { commit((x) => { getProvince(x, prov.id)!.nation = null; }); return; }
        if (e.shiftKey) {
          if (!prov.nation) { setStatus('Die Provinz hat noch keine Nation.'); return; }
          commit((x) => { const n = x.nations.find((q) => q.id === prov.nation); if (n) n.capital = prov.id; });
          return;
        }
        if (!brushNation) { setStatus('Erst rechts eine Nation zum Malen wählen.'); return; }
        commit((x) => { getProvince(x, prov.id)!.nation = brushNation; });
        return;
      }
      case 'resource': {
        if (!prov) return;
        if (right) { commit((x) => { const q = getProvince(x, prov.id)!; q.double = !q.double; }); return; }
        commit((x) => { getProvince(x, prov.id)!.resource = e.shiftKey ? null : brushRes; });
        return;
      }
    }
  };

  // ---------------------------------------------------------------- Tastatur

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!draftRef.current || isTyping(e)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); return; }
      if (e.key === 'Escape') { setPath([]); setMergeFrom(null); setLinkFrom(null); setPick(null); return; }
      if (e.key === 'Enter' && tool === 'draw') { finishDraw(path); return; }
      if (e.key === 'Backspace' && path.length) { e.preventDefault(); setPath((pp) => pp.slice(0, -1)); return; }
      if (e.key === 'Delete' && sel) {
        if (sel.kind === 'prov') commit((x) => removeProvince(x, sel.id));
        else commit((x) => removeSea(x, sel.id));
        setSel(null);
        return;
      }
      if (e.key === 'f') { fit(); return; }
      const t = TOOLS.find((x) => x.key === e.key);
      if (t && !e.ctrlKey && !e.altKey) setTool(t.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ---------------------------------------------------------------- Laden, Speichern, Export

  const [drafts, setDrafts] = useState<{ id: string; name: string; updated: number }[]>([]);
  const [newForm, setNewForm] = useState({ id: '', name: '', w: '4800', h: '4600' });
  useEffect(() => {
    if (!draft) fetch('/__drafts/').then((r) => r.json()).then(setDrafts, () => setDrafts([]));
  }, [draft]);

  const open = async (id: string) => {
    setBusy('Lade Entwurf …');
    try {
      const r = await fetch(`/__drafts/${id}`);
      if (!r.ok) throw new Error((await r.json()).error);
      const saved = (await r.json()) as SavedDraft;
      setImage(saved.image ? await loadImage(saved.image) : null);
      setImgOpacity(saved.imageOpacity ?? 0.6);
      setImgVisible(saved.imageVisible ?? true);
      geomCache.current.clear();
      setDraft(saved.draft);
      setHistory([]);
      setFuture([]);
      setDirty(false);
      setStatus(`${saved.draft.name} geladen.`);
    } catch (err) {
      setStatus(`Laden fehlgeschlagen: ${String(err)}`);
    }
    setBusy('');
  };

  const create = () => {
    const id = newForm.id.trim().toLowerCase();
    const w = Number(newForm.w), h = Number(newForm.h);
    if (!/^[a-z0-9_-]+$/.test(id)) { setStatus('ID nur aus a–z, 0–9, _ und -.'); return; }
    if (!(w >= 100 && h >= 100 && w <= 40000 && h <= 40000)) { setStatus('Größe zwischen 100 und 40 000 km.'); return; }
    if (drafts.some((x) => x.id === id)) { setStatus(`Es gibt schon einen Entwurf ${id} – öffnen oder andere ID wählen.`); return; }
    geomCache.current.clear();
    setImage(null);
    setDraft(newDraft(id, newForm.name.trim() || id, w, h));
    setHistory([]);
    setFuture([]);
    setDirty(true);
    setStatus('Neuer Entwurf. Vorlage laden oder loszeichnen.');
  };

  const save = async (): Promise<boolean> => {
    const d = draftRef.current;
    if (!d) return false;
    const body: SavedDraft = { id: d.id, name: d.name, draft: d, image: image?.src ?? null, imageOpacity: imgOpacity, imageVisible: imgVisible };
    const r = await fetch(`/__drafts/${d.id}`, { method: 'POST', body: JSON.stringify(body) });
    if (!r.ok) { setStatus(`Speichern fehlgeschlagen: ${(await r.json()).error}`); return false; }
    setDirty(false);
    setStatus(`Entwurf gespeichert: data/drafts/${d.id}.json`);
    return true;
  };

  const runCheck = (): ReturnType<typeof exportDraft> | null => {
    const d = draftRef.current;
    if (!d) return null;
    const r = exportDraft(d);
    const nations = r.map ? r.map.nations.map((n) => {
      const c = checkNation(r.map!, n.id);
      const pct = (v: number) => `${Math.round(v * 100)} %`;
      return {
        id: n.id, name: n.name,
        text: `${c.provinces} Provinzen · Nahrung ${pct(c.shares.food)} · Baustoffe ${pct(c.shares.materials)} · Energie ${pct(c.shares.energy)} · ${c.doubles} doppelt`,
        // Meldungen der Rohstoffprüfung auf Deutsch
        problems: c.problems.map((p) => p
          .replace(/^(food|materials|energy)\b/, (k) => CATEGORY_NAMES[k as keyof typeof CATEGORY_NAMES])
          .replace(/^(grain|fish|iron|lumber|coal|oil|gas)\b/, (k) => RES_NAMES[k as Resource])
          .replace('Infinity km entfernt', 'fehlt auf der Karte')
          .replace(/ (\d+) km entfernt$/, ' $1 km bis zum nächsten Feld')),
      };
    }) : [];
    setCheck({ errors: r.errors, warnings: r.warnings, nations });
    return r;
  };

  const doExport = async (force = false) => {
    const d = draftRef.current;
    if (!d) return;
    setOverwrite(null);
    const r = runCheck();
    if (!r?.map) { setStatus('Export nicht möglich – siehe Prüfung.'); return; }
    await save();
    const res = await fetch(`/__drafts/${d.id}/export`, { method: 'POST', body: JSON.stringify({ map: r.map, name: d.name, description: d.description, force }) });
    const body = await res.json();
    if (res.status === 409) { setOverwrite(body.error); return; }
    if (!res.ok) { setStatus(`Export fehlgeschlagen: ${body.error}`); return; }
    forgetMap(d.id);
    setStatus(`Exportiert nach ${body.file} – im Hauptmenü wählbar.`);
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const src = await new Promise<string>((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result as string);
      fr.onerror = () => rej(fr.error);
      fr.readAsDataURL(file);
    });
    try {
      setImage(await loadImage(src));
      setImgVisible(true);
      setDirty(true);
      setStatus(`Vorlage ${file.name} geladen.`);
    } catch (err) {
      setStatus(`Bild nicht lesbar: ${String(err)}`);
    }
  };

  const runImport = () => {
    if (!image || !draft) return;
    setImportConfirm(false);
    setBusy('Lese Vorlage ein …');
    setTimeout(() => {
      try {
        const colors = draft.colors ?? DEFAULT_COLORS;
        const res = importRaster(image.data, { colors, ...importOpt }, draft.width, draft.height, draft.nextId);
        commit((x) => {
          x.verts = res.verts;
          x.provinces = res.provinces;
          x.seas = res.seas;
          x.links = res.links;
          x.nextId = res.nextId;
          for (const n of x.nations) n.capital = null;
        });
        geomCache.current.clear();
        setSel(null);
        setImportNotes([`${res.provinces.length} Provinzen, ${res.seas.length} Seepunkte, ${res.links.length} Verbindungen, ${Object.keys(res.verts).length} Grenzpunkte.`, ...res.warnings]);
        setStatus('Vorlage eingelesen.');
      } catch (err) {
        setStatus(`Einlesen fehlgeschlagen: ${String(err)}`);
      }
      setBusy('');
    }, 30);
  };

  // ---------------------------------------------------------------- Oberfläche

  if (!draft) {
    return (
      <div className="editor">
        <div className="editor-bar">
          <button className="btn small" onClick={onExit}>Zurück</button>
          <b>Karten-Zeichner</b>
          <span className="editor-status small">{busy || status}</span>
        </div>
        <div className="drafter-start">
          <section>
            <h3>Neue Karte</h3>
            <p className="small muted">Die Größe in km legt den Maßstab fest (Marschzeiten, Reichweiten). Eine Vorlage wird auf diese Fläche gestreckt.</p>
            <label>ID (Dateiname)<input value={newForm.id} placeholder="z. B. europa_real" onChange={(e) => setNewForm({ ...newForm, id: e.target.value })} /></label>
            <label>Name<input value={newForm.name} placeholder="Europa 1914 – eigene Karte" onChange={(e) => setNewForm({ ...newForm, name: e.target.value })} /></label>
            <div className="drafter-size">
              <label>Breite (km)<input type="number" min={100} value={newForm.w} onChange={(e) => setNewForm({ ...newForm, w: e.target.value })} /></label>
              <label>Höhe (km)<input type="number" min={100} value={newForm.h} onChange={(e) => setNewForm({ ...newForm, h: e.target.value })} /></label>
            </div>
            <button className="btn primary" onClick={create}>Anlegen</button>
          </section>
          <section>
            <h3>Entwürfe</h3>
            {!drafts.length && <p className="small muted">Noch keine gespeicherten Entwürfe (data/drafts).</p>}
            {drafts.map((x) => (
              <button key={x.id} className="editor-link" onClick={() => void open(x.id)}>
                <b>{x.name}</b> <span className="muted small">{x.id} · {new Date(x.updated).toLocaleString('de-DE')}</span>
              </button>
            ))}
          </section>
        </div>
      </div>
    );
  }

  const selProv = sel?.kind === 'prov' ? getProvince(draft, sel.id) : undefined;
  const selSea = sel?.kind === 'sea' ? draft.seas.find((z) => z.id === sel.id) : undefined;
  const colors = draft.colors ?? DEFAULT_COLORS;
  const nationCount = (id: string) => draft.provinces.filter((p) => p.nation === id).length;
  const resCount = (r: Resource) => draft.provinces.reduce((t, p) => t + (p.resource === r ? (p.double ? 2 : 1) : 0), 0);
  const aspectImg = image ? image.data.width / image.data.height : null;
  const aspectMap = draft.width / draft.height;
  const toolInfo = TOOLS.find((t) => t.id === tool)!;
  const linkCount = (p: number) => draft.links.filter(([a, b]) => a === provRef(p) || b === provRef(p)).length;

  const field = (label: string, input: ReactNode) => <label className="drafter-field"><span>{label}</span>{input}</label>;

  return (
    <div className="editor">
      <div className="editor-bar">
        <button className="btn small" onClick={async () => {
          if (dirty && !(await save())) return;
          setDraft(null);
          setStatus('');
        }}>Entwürfe</button>
        <button className="btn small" onClick={onExit}>Hauptmenü</button>
        <span className="drafter-tools">
          {TOOLS.map((t) => (
            <button key={t.id} className={'btn small' + (tool === t.id ? ' active' : '')} title={`${t.help} (Taste ${t.key})`} onClick={() => setTool(t.id)}>{t.name}</button>
          ))}
        </span>
        <button className="btn small" disabled={!history.length} onClick={undo} title="Strg+Z">Rückgängig</button>
        <button className="btn small" disabled={!future.length} onClick={redo} title="Strg+Y">Wiederholen</button>
        <button className="btn small primary" onClick={() => void save()} title="Strg+S">Speichern</button>
        <button className="btn small primary" onClick={() => void doExport()}>Exportieren</button>
        <span className="editor-status small">{busy || (dirty ? 'ungespeichert · ' : '') + status}</span>
      </div>
      <div className="editor-main">
        <div className="editor-map" ref={wrapRef}>
          <canvas ref={canvasRef} onWheel={onWheel} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
            onPointerLeave={() => { mouse.current = null; schedule(); }} onContextMenu={(e) => e.preventDefault()}
            style={{ cursor: pick ? 'crosshair' : tool === 'select' ? 'default' : 'crosshair' }} />
          <div className="editor-hover small">{pick ? `Pipette: Farbe für „${COLOR_SLOTS.find((c) => c.key === pick)?.name}“ in der Vorlage anklicken` : hover}</div>
        </div>
        <aside className="editor-side drafter-side">
          <section>
            <h3>{toolInfo.name}</h3>
            <p className="small">{toolInfo.help}</p>
            {tool === 'draw' && path.length > 0 && <p className="small">{path.length} Punkte · Enter schließt</p>}
            {tool === 'nation' && <p className="small">Pinsel: <b>{draft.nations.find((n) => n.id === brushNation)?.name ?? '— keine Nation gewählt —'}</b></p>}
            {tool === 'resource' && (
              <div className="editor-res">
                {RESOURCES.map((r) => (
                  <button key={r} className={'btn small' + (brushRes === r ? ' active' : '')} onClick={() => setBrushRes(r)}>
                    <ResIcon res={r} size={16} /> {RES_NAMES[r]} <span className="muted">{resCount(r)}</span>
                  </button>
                ))}
              </div>
            )}
            <p className="small muted">Mausrad zoomt, rechte oder mittlere Taste zieht die Ansicht, F zeigt die ganze Karte.</p>
          </section>

          {selProv && (
            <section>
              <h3>Provinz</h3>
              {field('Name', <input value={selProv.name} onChange={(e) => { const v = e.target.value; commit((x) => { getProvince(x, selProv.id)!.name = v; }, `name${selProv.id}`); }} />)}
              {field('Nation', (
                <select value={selProv.nation ?? ''} onChange={(e) => { const v = e.target.value || null; commit((x) => { getProvince(x, selProv.id)!.nation = v; }); }}>
                  <option value="">— keine —</option>
                  {draft.nations.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
                </select>
              ))}
              {field('Rohstoff', (
                <select value={selProv.resource ?? ''} onChange={(e) => { const v = (e.target.value || null) as Resource | null; commit((x) => { getProvince(x, selProv.id)!.resource = v; }); }}>
                  <option value="">— keiner —</option>
                  {RESOURCES.map((r) => <option key={r} value={r}>{RES_NAMES[r]}</option>)}
                </select>
              ))}
              <label className="small"><input type="checkbox" checked={selProv.double} onChange={(e) => { const v = e.target.checked; commit((x) => { getProvince(x, selProv.id)!.double = v; }); }} /> Doppelprovinz</label>
              <label className="small"><input type="checkbox" checked={selProv.bigCity} onChange={(e) => { const v = e.target.checked; commit((x) => { getProvince(x, selProv.id)!.bigCity = v; }); }} /> Größere Stadt (mehr Siegpunkte)</label>
              <p className="small muted">{Math.round(provArea(draft, selProv)).toLocaleString('de-DE')} km² · {linkCount(selProv.id)} Verbindungen · Stadt {selProv.city ? 'gesetzt' : 'automatisch'}</p>
              <div className="editor-buttons">
                {selProv.nation && (
                  <button className="btn small" disabled={draft.nations.find((n) => n.id === selProv.nation)?.capital === selProv.id}
                    onClick={() => commit((x) => { const n = x.nations.find((q) => q.id === selProv.nation); if (n) n.capital = selProv.id; })}>Zur Hauptstadt machen</button>
                )}
                {selProv.city && <button className="btn small" onClick={() => commit((x) => { getProvince(x, selProv.id)!.city = null; })}>Stadt automatisch</button>}
                <button className="btn small danger" onClick={() => { commit((x) => removeProvince(x, selProv.id)); setSel(null); }}>Löschen</button>
              </div>
            </section>
          )}
          {selSea && (
            <section>
              <h3>Seepunkt</h3>
              {field('Name', <input value={selSea.name} onChange={(e) => { const v = e.target.value; commit((x) => { const z = x.seas.find((q) => q.id === selSea.id); if (z) z.name = v; }, `sea${selSea.id}`); }} />)}
              <p className="small muted">{draft.links.filter(([a, b]) => a === seaRef(selSea.id) || b === seaRef(selSea.id)).length} Verbindungen</p>
              <div className="editor-buttons">
                <button className="btn small danger" onClick={() => { commit((x) => removeSea(x, selSea.id)); setSel(null); }}>Löschen</button>
              </div>
            </section>
          )}

          <section>
            <h3>Nationen ({draft.nations.length})</h3>
            {draft.nations.map((n, i) => (
              <div key={i} className={'drafter-nation' + (brushNation === n.id ? ' active' : '')}>
                <input type="color" value={n.color} onChange={(e) => { const v = e.target.value; commit((x) => { x.nations[i].color = v; }, `ncol${i}`); }} />
                <input className="drafter-nid" value={n.id} title="Kürzel (z. B. DE) – bekannte Kürzel bekommen ihre Flagge" onChange={(e) => {
                  const v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
                  const old = n.id;
                  commit((x) => {
                    x.nations[i].id = v;
                    for (const p of x.provinces) if (p.nation === old) p.nation = v;
                  }, `nid${i}`);
                  if (brushNation === old) setBrushNation(v);
                }} />
                <input value={n.name} onChange={(e) => { const v = e.target.value; commit((x) => { x.nations[i].name = v; }, `nname${i}`); }} />
                <label className="small" title="Großmacht (sonst Kleinstaat)"><input type="checkbox" checked={n.major} onChange={(e) => { const v = e.target.checked; commit((x) => { x.nations[i].major = v; }); }} />Groß</label>
                <button className={'btn small' + (brushNation === n.id ? ' active' : '')} title="Zum Malen wählen" onClick={() => { setBrushNation(n.id); setTool('nation'); }}>✎</button>
                <button className="btn small" title="Nation löschen (Provinzen werden frei)" onClick={() => {
                  commit((x) => {
                    for (const p of x.provinces) if (p.nation === n.id) p.nation = null;
                    x.nations.splice(i, 1);
                  });
                  if (brushNation === n.id) setBrushNation(null);
                }}>✕</button>
                <div className="small muted drafter-nation-info">
                  {nationCount(n.id)} Provinzen · Hauptstadt: {n.capital !== null ? getProvince(draft, n.capital)?.name ?? '—' : '— (Umschalt+Klick beim Malen)'}
                </div>
              </div>
            ))}
            <div className="editor-buttons">
              <button className="btn small" onClick={() => commit((x) => {
                let k = x.nations.length + 1;
                while (x.nations.some((n) => n.id === `N${k}`)) k++;
                x.nations.push({ id: `N${k}`, name: `Nation ${k}`, color: NATION_COLORS[x.nations.length % NATION_COLORS.length], major: true, capital: null });
              })}>+ Nation</button>
            </div>
          </section>

          <section>
            <h3>Vorlage (PNG)</h3>
            <input type="file" accept="image/png,image/*" onChange={(e) => void onFile(e.target.files?.[0])} />
            {image && (
              <>
                <p className="small muted">{image.data.width} × {image.data.height} px · {(draft.width / image.data.width).toFixed(2)} km je Pixel</p>
                {aspectImg && Math.abs(aspectImg / aspectMap - 1) > 0.02 && (
                  <p className="small warn">Seitenverhältnis Bild {aspectImg.toFixed(3)}, Karte {aspectMap.toFixed(3)} – das Bild wird verzerrt.
                    <button className="btn small" onClick={() => commit((x) => rescaleDraft(x, x.width, Math.round(x.width / aspectImg)))}>Höhe anpassen</button></p>
                )}
                <label className="small"><input type="checkbox" checked={imgVisible} onChange={(e) => setImgVisible(e.target.checked)} /> anzeigen</label>
                <input type="range" min={0.1} max={1} step={0.05} value={imgOpacity} onChange={(e) => setImgOpacity(Number(e.target.value))} title="Deckkraft" />
                <div className="drafter-colors">
                  {COLOR_SLOTS.map((c) => (
                    <div key={c.key} className="editor-row small">
                      <span>{c.name}</span>
                      <span>
                        <input type="color" value={colors[c.key]} onChange={(e) => { const v = e.target.value; commit((x) => { x.colors = { ...(x.colors ?? DEFAULT_COLORS), [c.key]: v }; }, `col${c.key}`); }} />
                        <button className={'btn small' + (pick === c.key ? ' active' : '')} title="Farbe aus der Vorlage aufnehmen" onClick={() => setPick(pick === c.key ? null : c.key)}>Pipette</button>
                      </span>
                    </div>
                  ))}
                </div>
                {field('Farbtoleranz', <input type="number" min={0} max={200} value={importOpt.tolerance} onChange={(e) => setImportOpt({ ...importOpt, tolerance: Number(e.target.value) })} />)}
                {field('Vereinfachung (px)', <input type="number" min={0} max={10} step={0.1} value={importOpt.simplify} onChange={(e) => setImportOpt({ ...importOpt, simplify: Number(e.target.value) })} />)}
                {field('Mindestfläche (px)', <input type="number" min={1} value={importOpt.minArea} onChange={(e) => setImportOpt({ ...importOpt, minArea: Number(e.target.value) })} />)}
                <p className="small muted">Land = Provinzflächen, durch Grenzlinien getrennt. Hauptstadtpunkt = Stadt der Provinz, Seepunkt = Seeknoten, Linie zwischen zwei Punkten = Verbindung. Alles andere gilt als Wasser.</p>
                <div className="editor-buttons">
                  {!importConfirm
                    ? <button className="btn small primary" onClick={() => (draft.provinces.length ? setImportConfirm(true) : runImport())}>Einlesen</button>
                    : <>
                      <span className="small warn">Ersetzt alle Provinzen, Seepunkte und Verbindungen.</span>
                      <button className="btn small danger" onClick={runImport}>Ja, einlesen</button>
                      <button className="btn small" onClick={() => setImportConfirm(false)}>Abbrechen</button>
                    </>}
                </div>
                {importNotes.map((n) => <p key={n} className="small">{n}</p>)}
              </>
            )}
          </section>

          <section>
            <h3>Karte</h3>
            {field('ID', <input value={draft.id} onChange={(e) => { const v = e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''); commit((x) => { x.id = v; }, 'id'); }} />)}
            {field('Name', <input value={draft.name} onChange={(e) => { const v = e.target.value; commit((x) => { x.name = v; }, 'name'); }} />)}
            {field('Beschreibung', <textarea rows={2} value={draft.description} onChange={(e) => { const v = e.target.value; commit((x) => { x.description = v; }, 'desc'); }} />)}
            {!sizeEdit
              ? <p className="small">{draft.width.toLocaleString('de-DE')} × {draft.height.toLocaleString('de-DE')} km <button className="btn small" onClick={() => setSizeEdit({ w: String(draft.width), h: String(draft.height) })}>Ändern</button></p>
              : <div className="drafter-size">
                <input type="number" value={sizeEdit.w} onChange={(e) => setSizeEdit({ ...sizeEdit, w: e.target.value })} />
                <input type="number" value={sizeEdit.h} onChange={(e) => setSizeEdit({ ...sizeEdit, h: e.target.value })} />
                <button className="btn small" title="Alles wird mitgestreckt" onClick={() => {
                  const w = Number(sizeEdit.w), h = Number(sizeEdit.h);
                  if (w >= 100 && h >= 100) commit((x) => rescaleDraft(x, w, h));
                  setSizeEdit(null);
                }}>Übernehmen</button>
              </div>}
            <p className="small muted">{draft.provinces.length} Provinzen · {draft.seas.length} Seepunkte · {draft.links.length} Verbindungen</p>
            <div className="editor-buttons">
              <button className="btn small" title="Nachbarprovinzen verbinden, Küstenprovinzen ohne Hafen an den nächsten Seepunkt, benachbarte Seepunkte untereinander (fehlende ergänzen)"
                onClick={() => { let n = 0; commit((x) => { n = autoLinks(x); }); setStatus(`${n} Verbindungen ergänzt.`); }}>Verbindungen ergänzen</button>
              <button className="btn small" title="Alle Verbindungen löschen" onClick={() => commit((x) => { x.links = []; })}>Verbindungen leeren</button>
            </div>
          </section>

          <section>
            <h3>Prüfung</h3>
            <div className="editor-buttons">
              <button className="btn small" onClick={() => runCheck()}>Prüfen</button>
            </div>
            {overwrite && (
              <div>
                <p className="small warn">{overwrite}</p>
                <div className="editor-buttons">
                  <button className="btn small danger" onClick={() => void doExport(true)}>Trotzdem überschreiben</button>
                  <button className="btn small" onClick={() => setOverwrite(null)}>Abbrechen</button>
                </div>
              </div>
            )}
            {check && (
              <>
                {!check.errors.length && !check.warnings.length && <p className="small">Keine Fehler.</p>}
                {check.errors.map((x) => <p key={x} className="small warn">✕ {x}</p>)}
                {check.warnings.map((x) => <p key={x} className="small">⚠ {x}</p>)}
                {check.nations.map((n) => (
                  <p key={n.id} className="small"><b>{n.name}</b>: {n.text}{n.problems.length ? <span className="warn"> · {n.problems.join(', ')}</span> : null}</p>
                ))}
              </>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

function pointInside(part: Pt[][], p: Pt): boolean {
  const inRing = (r: Pt[]) => {
    let inside = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      if ((r[i][1] > p[1]) !== (r[j][1] > p[1]) && p[0] < ((r[j][0] - r[i][0]) * (p[1] - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) inside = !inside;
    }
    return inside;
  };
  return inRing(part[0]) && !part.slice(1).some(inRing);
}
