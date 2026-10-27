import type { Res } from '../game/balance.ts';

const svg = (body: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${body}</svg>`)}`;

export const RES_ICON: Record<Res, string> = {
  money: svg(
    '<circle cx="12" cy="12" r="9" fill="#e0b13c" stroke="#6e4c10" stroke-width="1.5"/>' +
      '<circle cx="12" cy="12" r="5.5" fill="none" stroke="#9a6d18" stroke-width="1.2"/>' +
      '<path d="M12 8.5v7M10 10.2h3.2a1.4 1.4 0 0 1 0 2.8h-2.4a1.4 1.4 0 0 0 0 2.8H14" fill="none" stroke="#6e4c10" stroke-width="1.1"/>',
  ),
  grain: svg(
    '<path d="M12 22V6" stroke="#7a5a1a" stroke-width="1.4"/>' +
      [6, 10, 14].map((y) =>
        `<ellipse cx="9.3" cy="${y}" rx="2" ry="3.2" transform="rotate(-30 9.3 ${y})" fill="#e3bd52" stroke="#8a6a1e" stroke-width=".8"/>` +
        `<ellipse cx="14.7" cy="${y}" rx="2" ry="3.2" transform="rotate(30 14.7 ${y})" fill="#e3bd52" stroke="#8a6a1e" stroke-width=".8"/>`).join('') +
      '<ellipse cx="12" cy="3.6" rx="1.7" ry="2.6" fill="#e3bd52" stroke="#8a6a1e" stroke-width=".8"/>',
  ),
  fish: svg(
    '<path d="M3 12c3-5 10-6 14 0-4 6-11 5-14 0z" fill="#79a7bf" stroke="#2f5568" stroke-width="1.2"/>' +
      '<path d="M17 12l5-4v8z" fill="#5d8ca5" stroke="#2f5568" stroke-width="1.2"/><circle cx="7" cy="11" r="1" fill="#1d3440"/>',
  ),
  iron: svg(
    '<path d="M3 17l3-7h12l3 7z" fill="#9aa1a8" stroke="#3f454a" stroke-width="1.3"/>' +
      '<path d="M6 10l2-4h8l2 4" fill="#b9c0c6" stroke="#3f454a" stroke-width="1.3"/>',
  ),
  lumber: svg(
    '<rect x="3" y="9" width="15" height="7" rx="1" fill="#9b6a38" stroke="#4f3216" stroke-width="1.2"/>' +
      '<ellipse cx="18" cy="12.5" rx="3" ry="3.5" fill="#d5a46c" stroke="#4f3216" stroke-width="1.2"/>' +
      '<ellipse cx="18" cy="12.5" rx="1.3" ry="1.6" fill="none" stroke="#8a5a2a" stroke-width=".8"/>',
  ),
  coal: svg(
    '<path d="M4 18l2-6 5-2 3 4-2 5z" fill="#2c2b29" stroke="#000" stroke-width=".8"/>' +
      '<path d="M11 19l2-6 5-3 3 5-3 4z" fill="#3b3a37" stroke="#000" stroke-width=".8"/>' +
      '<path d="M7 11l3-5 5 1 1 4-5 2z" fill="#47453f" stroke="#000" stroke-width=".8"/>' +
      '<path d="M9 8l2 1M14 13l2 1" stroke="#8b8a85" stroke-width=".8"/>',
  ),
  // Ölfass: Stahlfass mit Rippen, Deckel mit Spund und gelbem Etikett mit Öltropfen
  oil: svg(
    '<defs><linearGradient id="drum" x1="0" x2="1"><stop offset="0" stop-color="#2d3a46"/><stop offset=".35" stop-color="#6d7f8f"/><stop offset=".6" stop-color="#4a5b6a"/><stop offset="1" stop-color="#26313b"/></linearGradient></defs>' +
      '<rect x="5" y="3.5" width="14" height="17" rx="1.2" fill="url(#drum)" stroke="#151c22" stroke-width="1"/>' +
      '<ellipse cx="12" cy="3.6" rx="7" ry="1.4" fill="#8797a5" stroke="#151c22" stroke-width=".9"/>' +
      '<circle cx="15" cy="3.5" r=".8" fill="#151c22"/>' +
      '<path d="M5 8.5h14M5 15.5h14" stroke="#a9b6c1" stroke-width="1.3"/>' +
      '<path d="M5 9.4h14M5 16.4h14" stroke="#1d262e" stroke-width=".6"/>' +
      '<rect x="8.6" y="10.4" width="6.8" height="4.2" rx=".6" fill="#e2c35a" stroke="#5b4710" stroke-width=".5"/>' +
      '<path d="M12 10.9c-.7 1-1.2 1.6-1.2 2.2a1.2 1.2 0 0 0 2.4 0c0-.6-.5-1.2-1.2-2.2z" fill="#111"/>',
  ),
  gas: svg(
    '<path d="M12 2c1 4 6 6 6 12a6 6 0 0 1-12 0c0-3 2-5 3-6 0 2 1 3 2 3-1-3 0-6 1-9z" fill="#3f7fc0" stroke="#1d4570" stroke-width="1"/>' +
      '<path d="M12 12c1 2 3 3 3 5a3 3 0 0 1-6 0c0-1.5 1-2.5 3-5z" fill="#a6d2f4"/>',
  ),
};

const iconImages: Partial<Record<Res, HTMLImageElement>> = {};
/** Rohstoffsymbol als Bild für Canvas; ruft onLoad, sobald es geladen ist */
export function iconImage(r: Res, onLoad: () => void): HTMLImageElement {
  let img = iconImages[r];
  if (!img) {
    img = new Image();
    img.src = RES_ICON[r];
    iconImages[r] = img;
  }
  if (!img.complete) img.addEventListener('load', onLoad, { once: true });
  return img;
}

export function ResIcon({ res, size = 18 }: { res: Res; size?: number }) {
  return <img className="res-icon" src={RES_ICON[res]} width={size} height={size} alt="" draggable={false} />;
}
