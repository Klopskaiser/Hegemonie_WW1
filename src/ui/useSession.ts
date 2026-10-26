import { useCallback, useEffect, useRef, useState } from 'react';
import type { Action, ActionResult } from '../game/actions.ts';
import type { NationRates } from '../game/economy.ts';
import type { MapData } from '../game/mapdata.ts';
import type { ControllerKind, Difficulty, GameState } from '../game/types.ts';
import type { BridgeInfo, CreateOptions, FromWorker, ToWorker } from '../worker/protocol.ts';
import { loadMap } from './maps.ts';

export type SessionStart = { kind: 'open'; gameId: string } | { kind: 'create'; options: CreateOptions };

export interface Session {
  state: GameState | null;
  rates: NationRates | null;
  map: MapData | null;
  catchup: { done: number; total: number } | null;
  error: string | null;
  bridge: BridgeInfo;
  act(action: Action): Promise<ActionResult>;
  setController(nation: string, controller: ControllerKind): void;
  setDifficulty(difficulty: Difficulty): void;
  /** Verbindung zu externen Modellen herstellen (null = trennen) */
  setBridge(url: string | null): void;
  setSpeed(speed: number): void;
  setPaused(paused: boolean): void;
  close(): Promise<void>;
}

export function useSession(start: SessionStart): Session {
  const workerRef = useRef<Worker | null>(null);
  const pending = useRef(new Map<number, (r: ActionResult) => void>());
  const closing = useRef<(() => void) | null>(null);
  const nextId = useRef(1);
  const [state, setState] = useState<GameState | null>(null);
  const [rates, setRates] = useState<NationRates | null>(null);
  const [map, setMap] = useState<MapData | null>(null);
  const [catchup, setCatchup] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bridge, setBridgeInfo] = useState<BridgeInfo>({ status: 'off', url: '', sent: 0, received: 0 });

  useEffect(() => {
    const worker = new Worker(new URL('../worker/simWorker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      switch (m.type) {
        case 'catchup':
          setCatchup({ done: m.done, total: m.total });
          break;
        case 'snapshot':
          setCatchup(null);
          setState(m.state);
          setRates(m.rates);
          break;
        case 'actionResult':
          pending.current.get(m.id)?.(m.result);
          pending.current.delete(m.id);
          break;
        case 'bridge':
          setBridgeInfo(m.info);
          break;
        case 'closed':
          closing.current?.();
          break;
        case 'error':
          setError(m.message);
          break;
      }
    };
    const msg: ToWorker = start.kind === 'open' ? { type: 'open', gameId: start.gameId } : { type: 'create', options: start.options };
    worker.postMessage(msg);
    const onHide = () => {
      if (document.visibilityState === 'hidden') worker.postMessage({ type: 'save' } satisfies ToWorker);
    };
    document.addEventListener('visibilitychange', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      worker.terminate();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (state && (!map || map.id !== state.mapId)) loadMap(state.mapId).then(setMap, (e) => setError(String(e)));
  }, [state, map]);

  const send = (m: ToWorker) => workerRef.current?.postMessage(m);

  const act = useCallback((action: Action) => new Promise<ActionResult>((resolve) => {
    const id = nextId.current++;
    pending.current.set(id, resolve);
    send({ type: 'action', id, action });
  }), []);

  const close = useCallback(() => new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 3000);
    closing.current = () => {
      clearTimeout(t);
      resolve();
    };
    send({ type: 'close' });
  }), []);

  return {
    state, rates, map, catchup, error, bridge, act, close,
    setController: (nation, controller) => send({ type: 'setController', nation, controller }),
    setDifficulty: (difficulty) => send({ type: 'setDifficulty', difficulty }),
    setBridge: (url) => send({ type: 'bridge', url }),
    setSpeed: (speed) => send({ type: 'setSpeed', speed }),
    setPaused: (paused) => send({ type: 'setPaused', paused }),
  };
}
