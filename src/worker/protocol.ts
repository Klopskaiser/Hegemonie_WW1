import type { Action, ActionResult } from '../game/actions.ts';
import type { NationRates } from '../game/economy.ts';
import type { Scenario } from '../game/state.ts';
import type { ControllerKind, Difficulty, GameState } from '../game/types.ts';

export interface CreateOptions {
  name: string;
  mapId: string;
  playerNation: string;
  speed: number;
  scenario: Scenario;
  difficulty: Difficulty;
}

export type BridgeStatus = 'off' | 'connecting' | 'open' | 'error';

export interface BridgeInfo {
  status: BridgeStatus;
  url: string;
  message?: string;
  /** Nachrichten seit Verbindungsaufbau */
  sent: number;
  received: number;
}

export type ToWorker =
  | { type: 'open'; gameId: string }
  | { type: 'create'; options: CreateOptions }
  | { type: 'action'; id: number; action: Action }
  | { type: 'setSpeed'; speed: number }
  | { type: 'setPaused'; paused: boolean }
  | { type: 'setController'; nation: string; controller: ControllerKind }
  | { type: 'setDifficulty'; difficulty: Difficulty }
  | { type: 'bridge'; url: string | null }
  | { type: 'save' }
  | { type: 'close' };

export type FromWorker =
  | { type: 'catchup'; done: number; total: number }
  | { type: 'snapshot'; state: GameState; rates: NationRates }
  | { type: 'actionResult'; id: number; result: ActionResult }
  | { type: 'bridge'; info: BridgeInfo }
  | { type: 'closed' }
  | { type: 'error'; message: string };
