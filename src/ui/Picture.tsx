import { useEffect, useState } from 'react';
import { UNIT_ORDER, UNITS, type UnitType } from '../game/balance.ts';
import type { Army } from '../game/types.ts';

/**
 * Quadratisches Bild aus public/images; fehlt die Datei, wird `fallback` versucht, danach erscheint ein
 * Platzhalter mit Beschriftung. Erwartete Dateien: public/images/README.md
 */
export function Picture({ src, label, size = 56, className = '', fallback }: { src: string; label: string; size?: number; className?: string; fallback?: string }) {
  const [stage, setStage] = useState(0); // 0 = src, 1 = fallback, 2 = Platzhalter
  useEffect(() => setStage(0), [src, fallback]);
  if (stage === 2 || (stage === 1 && !fallback)) {
    return (
      <div className={'picture placeholder ' + className} style={{ width: size, height: size }} title={`Bild folgt: ${src}`}>
        <span>{label}</span>
      </div>
    );
  }
  const url = stage === 0 ? src : fallback!;
  return <img className={'picture ' + className} src={url} width={size} height={size} alt={label}
    onError={() => setStage((s) => (s === 0 && fallback ? 1 : 2))} />;
}

export const unitImage = (unit: string) => `/images/units/${unit}.png`;
export const buildingImage = (building: string) => `/images/buildings/${building}.png`;
export const newsImage = (kind: string, variant: number) => `/images/news/${kind}-${variant}.png`;

/** Infanterie mit Truppenmoral unter dieser Schwelle zeigt ein eigenes Bild (units/infantry_low.png) */
export const LOW_MORALE_PICTURE = 0.3;

/**
 * Portrait-Einheit einer Armee: der Maschinentyp mit der größten Gesamtstärke (Anzahl × Kampfkraft je Einheit wie
 * armyPower) – 10 Panzerwagen schlagen 1 Artillerie; Infanterie nur ohne Maschinen.
 */
export function portraitUnit(a: Army): UnitType | null {
  let best: UnitType | null = null, bv = 0;
  for (const u of UNIT_ORDER) {
    const n = a.units[u] ?? 0;
    if (u === 'infantry' || n <= 0) continue;
    const v = n * ((UNITS[u].attack + UNITS[u].defense) / 2) * (UNITS[u].hp / 20);
    if (v > bv) { bv = v; best = u; }
  }
  return best ?? ((a.units.infantry ?? 0) > 0 ? 'infantry' : null);
}

/**
 * Großes Portrait im Armeefenster: kämpfende Truppen (gleich welcher Art) und eingeschiffte Landtruppen haben je ein
 * eigenes Bild (units/combat.png, units/embarked.png); fehlt es, gilt das Bild der Portrait-Einheit.
 */
export function portraitImage(a: Army, morale: number, situation: { fighting: boolean; embarked: boolean }): { src: string; fallback?: string } | null {
  const main = portraitUnit(a);
  if (!main) return null;
  const normal = armyUnitImage(a, main, morale);
  if (situation.fighting) return { src: unitImage('combat'), fallback: unitImage(main) };
  if (situation.embarked && main !== 'battleship') return { src: unitImage('embarked'), fallback: unitImage(main) };
  return normal;
}

/** Bild einer Einheit in dieser Armee: Infanterie unter 30 % Moral mit eigenem Bild (Ersatz: das normale) */
export function armyUnitImage(a: Army, u: UnitType, morale: number): { src: string; fallback?: string } {
  if (u === 'infantry' && morale < LOW_MORALE_PICTURE) return { src: unitImage('infantry_low'), fallback: unitImage('infantry') };
  return { src: unitImage(u) };
}
