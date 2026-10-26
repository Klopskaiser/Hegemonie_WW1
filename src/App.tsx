import { useState } from 'react';
import { GameView } from './ui/GameView.tsx';
import { MainMenu } from './ui/MainMenu.tsx';
import type { SessionStart } from './ui/useSession.ts';

export function App() {
  const [session, setSession] = useState<{ start: SessionStart; key: number } | null>(null);
  if (session) return <GameView key={session.key} start={session.start} onExit={() => setSession(null)} />;
  return <MainMenu onOpen={(start) => setSession({ start, key: Date.now() })} />;
}
