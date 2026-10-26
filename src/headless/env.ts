// Headless-Umgebung für Training und Auswertung externer Entscheidungsmodelle:
// reset/step wie bei Reinforcement-Learning-Umgebungen, ohne Browser und Echtzeit.
// Agenten-Nationen werden nur über step() gesteuert, alle anderen von der eingebauten KI.

import type { Action, ActionResult } from '../game/actions.ts';
import { HOUR, DAY } from '../game/balance.ts';
import { observe, QueuedController, type Controller, type NationView, type Observation } from '../game/controller.ts';
import { provincePoints } from '../game/economy.ts';
import type { MapData } from '../game/mapdata.ts';
import { Simulation } from '../game/sim.ts';
import { createGame, type Scenario } from '../game/state.ts';
import type { Difficulty } from '../game/types.ts';

export interface EnvOptions {
  /** vom Agenten gesteuerte Nationen (leer = reine KI-Partie) */
  agents?: string[];
  seed?: number;
  difficulty?: Difficulty;
  scenario?: Scenario;
  /** Spielstunden je step() */
  stepHours?: number;
  /** Partie endet spätestens nach so vielen Spieltagen */
  maxDays?: number;
}

export interface StepInfo {
  time: number;
  day: number;
  winner: string | null;
  /** Ergebnis jeder übergebenen Aktion, je Nation in Reihenfolge */
  results: Record<string, ActionResult[]>;
  /** aktuelle Punktzahl (Provinzwerte, laufend berechnet) */
  score: Record<string, number>;
  provinces: Record<string, number>;
}

export interface StepResult {
  obs: Record<string, Observation>;
  /** Punktzuwachs seit dem letzten Schritt */
  reward: Record<string, number>;
  done: boolean;
  info: StepInfo;
}

export class HeadlessEnv {
  sim!: Simulation;
  private lastScore: Record<string, number> = {};
  readonly agents: string[];
  readonly stepHours: number;
  readonly maxDays: number;

  constructor(readonly map: MapData, readonly options: EnvOptions = {}) {
    this.agents = options.agents ?? [];
    for (const a of this.agents) if (!map.nations.some((n) => n.id === a)) throw new Error(`Unbekannte Nation: ${a}`);
    this.stepHours = options.stepHours ?? 6;
    this.maxDays = options.maxDays ?? 120;
  }

  /** Neue Partie; liefert die erste Beobachtung je Agent. */
  reset(seed = this.options.seed ?? 1, wrap?: (nation: string, ctrl: Controller) => Controller): Record<string, Observation> {
    const state = createGame(this.map, {
      id: `headless-${seed}`, name: `Headless ${seed}`, playerNation: this.agents[0] ?? this.map.nations[0].id,
      speed: 1, seed, now: 0, scenario: this.options.scenario, difficulty: this.options.difficulty,
    });
    for (const n of Object.values(state.nations)) n.controller = this.agents.includes(n.id) ? 'external' : 'ai';
    state.paused = false;
    this.sim = new Simulation(state, this.map);
    // Agenten handeln nur über step(); ein leerer Controller verhindert den KI-Fallback
    for (const a of this.agents) this.sim.controllers.set(a, new QueuedController());
    if (wrap) {
      for (const n of this.map.nations) {
        const ctrl = this.sim.controllerOf(n.id);
        if (ctrl) this.sim.controllers.set(n.id, wrap(n.id, ctrl));
      }
    }
    this.lastScore = this.scores();
    return this.observations();
  }

  /** Aktionen ausführen, dann `stepHours` Spielzeit simulieren. */
  step(actions: Record<string, Action[]> = {}): StepResult {
    const results: Record<string, ActionResult[]> = {};
    for (const [nation, list] of Object.entries(actions)) {
      if (!this.agents.includes(nation)) {
        results[nation] = list.map((): ActionResult => ({ ok: false, error: `${nation} ist kein Agent` }));
        continue;
      }
      results[nation] = list.map((a) => this.sim.apply(nation, a));
    }
    this.sim.advance(this.stepHours * HOUR);
    const score = this.scores();
    const reward: Record<string, number> = {};
    for (const n of this.map.nations) reward[n.id] = round(score[n.id] - (this.lastScore[n.id] ?? 0));
    this.lastScore = score;
    const s = this.sim.state;
    const provinces: Record<string, number> = {};
    for (const ps of s.provinces) provinces[ps.owner] = (provinces[ps.owner] ?? 0) + 1;
    const agentsDead = this.agents.length > 0 && this.agents.every((a) => !s.nations[a].alive);
    return {
      obs: this.observations(),
      reward,
      done: !!s.winner || agentsDead || s.time >= this.maxDays * DAY,
      info: { time: s.time, day: Math.floor(s.time / DAY) + 1, winner: s.winner, results, score, provinces },
    };
  }

  /** Beobachtungen der Agenten (lebende) */
  observations(): Record<string, Observation> {
    const out: Record<string, Observation> = {};
    for (const a of this.agents) if (this.sim.state.nations[a].alive) out[a] = this.sim.observation(a);
    return out;
  }

  /** Laufender Punktestand je Nation (Provinzwerte wie beim Tageswechsel) */
  scores(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const n of this.map.nations) out[n.id] = 0;
    this.sim.state.provinces.forEach((ps, i) => {
      if (ps.owner in out) out[ps.owner] += provincePoints(this.map, ps, i);
    });
    for (const k of Object.keys(out)) out[k] = round(out[k]);
    return out;
  }
}

const round = (v: number) => Math.round(v * 100) / 100;

/** Zeichnet die Entscheidungen eines Controllers auf (z. B. für Imitationslernen). */
export class RecordingController implements Controller {
  readonly name: string;

  constructor(
    private readonly inner: Controller,
    private readonly sink: (rec: { time: number; nation: string; actions: Action[]; obs?: Observation }) => void,
    private readonly withObs = false,
  ) {
    this.name = `${inner.name} (aufgezeichnet)`;
  }

  decide(view: NationView): Action[] {
    const actions = this.inner.decide(view);
    if (actions.length || this.withObs) {
      this.sink({ time: view.state.time, nation: view.nation, actions, obs: this.withObs ? observe(view) : undefined });
    }
    return actions;
  }
}
