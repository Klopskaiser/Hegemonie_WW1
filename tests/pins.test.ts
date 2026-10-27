import { describe, expect, it } from 'vitest';
import { separateHeads } from '../src/ui/MapCanvas.tsx';

type Head = { x: number; y: number; box: { x: number; y: number; w: number; h: number } };
const box = { x: -12, y: -11, w: 45, h: 22 };
const overlap = (p: Head, q: Head) =>
  Math.min(p.x + p.box.x + p.box.w, q.x + q.box.x + q.box.w) > Math.max(p.x + p.box.x, q.x + q.box.x)
  && Math.min(p.y + p.box.y + p.box.h, q.y + q.box.y + q.box.h) > Math.max(p.y + p.box.y, q.y + q.box.y);

describe('Nadelköpfe', () => {
  it('überdeckte Köpfe werden auseinandergeschoben (Kampf unten, Artillerie knapp darüber)', () => {
    // zwei aufgefächerte Köpfe der Kampfgruppe und ein Artilleriekopf, der genau auf dem rechten liegt
    const heads: Head[] = [
      { x: 90, y: 100, box }, { x: 130, y: 100, box }, { x: 131, y: 103, box },
    ];
    separateHeads(heads);
    for (let i = 0; i < heads.length; i++) for (let j = i + 1; j < heads.length; j++) expect(overlap(heads[i], heads[j]), `${i}/${j}`).toBe(false);
  });

  it('freie Köpfe bleiben, wo sie sind', () => {
    const heads: Head[] = [{ x: 0, y: 0, box }, { x: 200, y: 0, box }];
    separateHeads(heads);
    expect(heads.map((h) => [h.x, h.y])).toEqual([[0, 0], [200, 0]]);
  });
});
