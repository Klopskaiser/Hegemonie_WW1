import { useState } from 'react';
import { GameView } from './ui/GameView.tsx';
import { MainMenu } from './ui/MainMenu.tsx';
import { MapEditor } from './ui/MapEditor.tsx';
import type { SessionStart } from './ui/useSession.ts';

export function App() {
  const [session, setSession] = useState<{ start: SessionStart; key: number } | null>(null);
  const [editor, setEditor] = useState(() => import.meta.env.DEV && location.hash === '#editor');
  if (editor) {
    return <MapEditor onExit={() => {
      history.replaceState(null, '', location.pathname);
      setEditor(false);
    }} />;
  }
  if (session) return <GameView key={session.key} start={session.start} onExit={() => setSession(null)} />;
  return <MainMenu onOpen={(start) => setSession({ start, key: Date.now() })}
    onEditor={import.meta.env.DEV ? () => { location.hash = 'editor'; setEditor(true); } : undefined} />;
}
