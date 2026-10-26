// Spielstände in IndexedDB (im Hauptthread und im Worker nutzbar).
// "meta" hält kleine Listeneinträge fürs Hauptmenü, "saves" den vollen Zustand.

import type { GameMeta, GameState } from '../game/types.ts';

const DB_NAME = 'hegemonie1914';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('saves')) db.createObjectStore('saves', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveGame(state: GameState, meta: GameMeta): Promise<void> {
  const db = await open();
  const tx = db.transaction(['meta', 'saves'], 'readwrite');
  tx.objectStore('saves').put(state);
  tx.objectStore('meta').put(meta);
  await done(tx);
}

export async function loadGame(id: string): Promise<GameState | undefined> {
  const db = await open();
  return request(db.transaction('saves').objectStore('saves').get(id));
}

export async function listGames(): Promise<GameMeta[]> {
  const db = await open();
  const all: GameMeta[] = await request(db.transaction('meta').objectStore('meta').getAll());
  return all.sort((a, b) => b.lastRealTime - a.lastRealTime);
}

export async function deleteGame(id: string): Promise<void> {
  const db = await open();
  const tx = db.transaction(['meta', 'saves'], 'readwrite');
  tx.objectStore('saves').delete(id);
  tx.objectStore('meta').delete(id);
  await done(tx);
}
