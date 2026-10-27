import type { MapData } from '../game/mapdata.ts';
import type { GameState } from '../game/types.ts';
import { Flag } from './Flag.tsx';

/** Spielende: Sieg oder Niederlage mit Schlussrangliste. */
export function GameOver({ map, state, onMenu, onClose }: { map: MapData; state: GameState; onMenu(): void; onClose(): void }) {
  if (!state.winner) return null;
  const won = state.winner === state.playerNation;
  const winner = map.nations.find((n) => n.id === state.winner);
  const ranking = map.nations
    .map((n) => ({ n, provinces: state.provinces.filter((p) => p.owner === n.id).length, alive: state.nations[n.id].alive }))
    .sort((a, b) => b.provinces - a.provinces);
  return (
    <div className="gameover-backdrop">
      <section className="window gameover">
        <header className="window-title"><span>{won ? 'Sieg!' : 'Das Spiel ist entschieden'}</span></header>
        <div className="window-body">
          <p className="gameover-text">
            {won
              ? 'Euer Reich hat die Vorherrschaft errungen. Die Welt beugt sich Eurem Willen.'
              : state.nations[state.playerNation].alive
                ? `${winner?.name} hat die Vorherrschaft errungen.`
                : `Euer Reich ist untergegangen. ${winner?.name} führt die Rangliste an.`}
          </p>
          <table className="table">
            <thead><tr><th>#</th><th>Nation</th><th>Provinzen</th></tr></thead>
            <tbody>
              {ranking.map((r, i) => (
                <tr key={r.n.id} className={r.n.id === state.playerNation ? 'me' : ''}>
                  <td>{i + 1}</td>
                  <td><Flag nation={r.n.id} /> {r.n.name}{r.alive ? '' : ' (vernichtet)'}</td>
                  <td>{r.provinces}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="btn-row">
            <button className="btn primary" onClick={onMenu}>Zum Hauptmenü</button>
            <button className="btn" onClick={onClose}>Karte ansehen</button>
          </div>
        </div>
      </section>
    </div>
  );
}
