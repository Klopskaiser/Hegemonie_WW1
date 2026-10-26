import { useEffect, useState } from 'react';

/**
 * Quadratisches Bild aus public/images; fehlt die Datei, erscheint ein Platzhalter mit Beschriftung.
 * Erwartete Dateien: public/images/README.md
 */
export function Picture({ src, label, size = 56, className = '' }: { src: string; label: string; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (failed) {
    return (
      <div className={'picture placeholder ' + className} style={{ width: size, height: size }} title={`Bild folgt: ${src}`}>
        <span>{label}</span>
      </div>
    );
  }
  return <img className={'picture ' + className} src={src} width={size} height={size} alt={label} onError={() => setFailed(true)} />;
}

export const unitImage = (unit: string) => `/images/units/${unit}.png`;
export const buildingImage = (building: string) => `/images/buildings/${building}.png`;
export const newsImage = (kind: string, variant: number) => `/images/news/${kind}-${variant}.png`;
