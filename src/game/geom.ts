// Planare Geometrie-Helfer (Kartenkoordinaten in km, y nach unten).

export type Pt = [number, number];
export type Ring = Pt[];
export type Poly = Ring[]; // erster Ring außen, weitere Löcher
export type MultiPoly = Poly[];

export function ringArea(r: Ring): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
  }
  return a / 2;
}

export function polyArea(p: Poly): number {
  let a = Math.abs(ringArea(p[0]));
  for (let k = 1; k < p.length; k++) a -= Math.abs(ringArea(p[k]));
  return a;
}

export function multiArea(m: MultiPoly): number {
  let a = 0;
  for (const p of m) a += polyArea(p);
  return a;
}

export function ringCentroid(r: Ring): Pt {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const f = r[j][0] * r[i][1] - r[i][0] * r[j][1];
    a += f;
    cx += (r[j][0] + r[i][0]) * f;
    cy += (r[j][1] + r[i][1]) * f;
  }
  if (Math.abs(a) < 1e-9) return r[0];
  return [cx / (3 * a), cy / (3 * a)];
}

export function multiCentroid(m: MultiPoly): Pt {
  let ax = 0, ay = 0, at = 0;
  for (const p of m) {
    const a = polyArea(p);
    const c = ringCentroid(p[0]);
    ax += c[0] * a; ay += c[1] * a; at += a;
  }
  return at > 0 ? [ax / at, ay / at] : m[0][0][0];
}

export function pointInRing(x: number, y: number, r: Ring): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPoly(x: number, y: number, p: Poly): boolean {
  if (!pointInRing(x, y, p[0])) return false;
  for (let k = 1; k < p.length; k++) if (pointInRing(x, y, p[k])) return false;
  return true;
}

export function pointInMulti(x: number, y: number, m: MultiPoly): boolean {
  for (const p of m) if (pointInPoly(x, y, p)) return true;
  return false;
}

export function distSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx - px, qy = ay + t * dy - py;
  return Math.sqrt(qx * qx + qy * qy);
}

export function bboxOf(m: MultiPoly): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of m) for (const [x, y] of p[0]) {
    if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** Punkt mit größtem Abstand zum Rand des größten Teils (Mitte für Symbole). */
export function interiorPoint(shape: MultiPoly): Pt {
  const main = shape.reduce((a, b) => (polyArea(a) > polyArea(b) ? a : b));
  const edgeDist = (x: number, y: number) => {
    let d = Infinity;
    for (const ring of main) for (let k = 0; k + 1 < ring.length; k++) {
      d = Math.min(d, distSegment(x, y, ring[k][0], ring[k][1], ring[k + 1][0], ring[k + 1][1]));
    }
    return d;
  };
  const [x0, y0, x1, y1] = bboxOf([main]);
  let best = ringCentroid(main[0]), bd = pointInPoly(best[0], best[1], main) ? edgeDist(best[0], best[1]) : -1;
  let step = Math.max(x1 - x0, y1 - y0) / 20;
  let cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, span = 10;
  for (let pass = 0; pass < 3; pass++) {
    for (let ix = -span; ix <= span; ix++) for (let iy = -span; iy <= span; iy++) {
      const x = cx + ix * step, y = cy + iy * step;
      if (!pointInPoly(x, y, main)) continue;
      const d = edgeDist(x, y);
      if (d > bd) { bd = d; best = [x, y]; }
    }
    cx = best[0]; cy = best[1]; step /= 4; span = 6;
  }
  return best;
}
