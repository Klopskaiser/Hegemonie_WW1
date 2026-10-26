import { useState } from 'react';
import type { MapData } from '../game/mapdata.ts';
import type { GameState } from '../game/types.ts';
import type { NewsItem } from '../game/types.ts';
import { Window } from './common.tsx';
import { Flag } from './Flag.tsx';
import { MapCanvas } from './MapCanvas.tsx';
import { newsImage, Picture } from './Picture.tsx';

const NewsPicture = ({ item, size }: { item: NewsItem; size: number }) => (
  <Picture src={newsImage(item.kind ?? 'other', item.variant ?? 1)} label={item.title} size={size} className="np-pic" />
);

/** Tageszeitung im Stil eines alten Blattes; blättern durch die letzten Ausgaben. */
export function NewspaperPanel({ map, state, onClose }: { map: MapData; state: GameState; onClose(): void }) {
  const papers = state.newspapers;
  const [index, setIndex] = useState(papers.length - 1);
  const i = Math.min(index, papers.length - 1);
  const paper = papers[i];
  const name = (id: string) => map.nations.find((n) => n.id === id)?.name ?? id;
  return (
    <Window title="Zeitung" onClose={onClose} className="side-panel newspaper-panel">
      {!paper ? (
        <p className="muted">Die erste Ausgabe erscheint zum nächsten Tageswechsel.</p>
      ) : (
        <article className="newspaper">
          <header className="np-masthead">
            <div className="np-title">Der Europäische Kurier</div>
            <div className="np-sub">
              <span>Ausgabe Tag {paper.day}</span>
              <span>Preis: 5 Pfennig</span>
            </div>
          </header>
          <figure className="np-map">
            <MapCanvas map={map} owners={paper.owners} compact />
            <figcaption>Die Lage in Europa zum Tag {paper.day}</figcaption>
          </figure>
          <h2 className="np-headline">{paper.items[0].title}</h2>
          <div className="np-lead-row">
            <NewsPicture item={paper.items[0]} size={110} />
            <p className="np-lead">{paper.items[0].text}</p>
          </div>
          <div className="np-columns">
            {paper.items.slice(1).map((it, k) => (
              <section key={k} className="np-item">
                <h3>{it.title}</h3>
                <NewsPicture item={it} size={52} />
                <p>{it.text}</p>
              </section>
            ))}
          </div>
          <div className="np-ranking">
            {paper.ranking.slice(0, 6).map((r, k) => (
              <span key={r.nation}><Flag nation={r.nation} height={11} /> {k + 1}. {name(r.nation)} {r.points}</span>
            ))}
          </div>
        </article>
      )}
      {papers.length > 1 && (
        <div className="np-nav">
          <button className="btn small" disabled={i <= 0} onClick={() => setIndex(i - 1)}>‹ Vorherige</button>
          <span className="small">{i + 1} / {papers.length}</span>
          <button className="btn small" disabled={i >= papers.length - 1} onClick={() => setIndex(i + 1)}>Nächste ›</button>
        </div>
      )}
    </Window>
  );
}
