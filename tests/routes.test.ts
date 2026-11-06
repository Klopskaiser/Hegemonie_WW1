// Regressiontest für das Seewege-Bündeln (scripts/routes.ts):
// Kreuzungen waren massenhaft auf geraden Strecken (Phantomkreuzungen) und mehrfach doppelt.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { markBranchJunctions, snapSeaLanes } from '../scripts/routes.ts';
import type { MapData } from '../src/game/mapdata.ts';

const base: MapData = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, '..', 'data', 'maps', 'europe.base.json'), 'utf8'),
);

/** Knickwinkel (°) des Wegs pts am Punkt i (0 = geradeaus) */
function cornerDeg(pts: number[], i: number): number {
  const ax = pts[2 * i] - pts[2 * i - 2], ay = pts[2 * i + 1] - pts[2 * i - 1];
  const bx = pts[2 * i + 2] - pts[2 * i], by = pts[2 * i + 3] - pts[2 * i + 1];
  const d = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1);
  return (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI;
}

describe('Seewege zusammenlegen', () => {
  const r = snapSeaLanes(base);

  it('legt keine Kreuzung doppelt (mindestens 3 km Abstand)', () => {
    for (let i = 0; i < r.junctions.length; i++)
      for (let k = i + 1; k < r.junctions.length; k++)
        expect(Math.hypot(r.junctions[i].x - r.junctions[k].x, r.junctions[i].y - r.junctions[k].y)).toBeGreaterThanOrEqual(3);
  });

  it('setzt Kreuzungen nur dort, wo ein Weg tatsächlich abzweigt (Knick ≥ 20°)', () => {
    for (const j of r.junctions) {
      // gekreuzte Wege liegen auf den neuen Verläufen, Knotenpunkte ungeänderter Bahnen auf denen der Grundkarte
      let maxCorner = -1;
      for (const roads of [r.roads, base.roads ?? []]) {
        for (const rd of roads) {
          const p = rd.pts;
          for (let i = 1; i + 1 < p.length / 2; i++)
            if (Math.hypot(p[2 * i] - j.x, p[2 * i + 1] - j.y) < 2) maxCorner = Math.max(maxCorner, cornerDeg(p, i));
        }
        if (maxCorner >= 20) break;
      }
      expect(maxCorner, `Phantomkreuzung bei ${j.x},${j.y}`).toBeGreaterThanOrEqual(20);
    }
  });
});

describe('Knotenpunkte auf fertiger Geometrie (markBranchJunctions)', () => {
  const m = structuredClone(base) as MapData;
  m.junctions = [];
  const added = markBranchJunctions(m);
  const lines = [...(m.roads ?? []), ...(m.shortcuts ?? [])].map((r) => r.pts);

  it('setzt Punkte auf der ausgelieferten Karte', () => {
    expect(added).toBeGreaterThan(0);
  });

  it('trifft nur echte Abzweige: Knick ≥ 20° und ein anderer Weg ≤ 2 km', () => {
    for (const j of m.junctions!) {
      let hit = false;
      for (let li = 0; li < lines.length && !hit; li++) {
        const p = lines[li];
        for (let i = 1; i + 1 < p.length / 2; i++) {
          if (Math.hypot(p[2 * i] - j.x, p[2 * i + 1] - j.y) > 2 || cornerDeg(p, i) < 20) continue;
          // anderer Weg im Umkreis?
          for (let oi = 0; oi < lines.length; oi++) {
            if (oi === li) continue;
            const o = lines[oi];
            for (let k = 0; k + 3 < o.length; k += 2) {
              const ax = o[k], ay = o[k + 1], dx = o[k + 2] - ax, dy = o[k + 3] - ay;
              const l2 = dx * dx + dy * dy;
              const t = l2 > 0 ? Math.max(0, Math.min(1, ((j.x - ax) * dx + (j.y - ay) * dy) / l2)) : 0;
              if (Math.hypot(j.x - (ax + t * dx), j.y - (ay + t * dy)) <= 2) { hit = true; break; }
            }
            if (hit) break;
          }
          if (hit) break;
        }
      }
      expect(hit, `Knotenpunkt bei ${j.x},${j.y} an keiner Abzweigung`).toBe(true);
    }
  });

  it('setzt nicht doppelt (mindestens 4 km Abstand) und ist zweimal ausgeführt leer', () => {
    const js = m.junctions!;
    for (let i = 0; i < js.length; i++)
      for (let k = i + 1; k < js.length; k++)
        expect(Math.hypot(js[i].x - js[k].x, js[i].y - js[k].y)).toBeGreaterThanOrEqual(4);
    expect(markBranchJunctions(m)).toBe(0);
  });
});
