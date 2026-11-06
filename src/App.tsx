import { lazy, Suspense, useState } from 'react';
import { GameView } from './ui/GameView.tsx';
import { MainMenu } from './ui/MainMenu.tsx';
import { MapEditor } from './ui/MapEditor.tsx';
import type { SessionStart } from './ui/useSession.ts';

// Karten-Zeichner nur im Dev-Server und erst bei Bedarf laden
const MapDrafter = lazy(() => import('./ui/MapDrafter.tsx').then((m) => ({ default: m.MapDrafter })));

type Tool = 'editor' | 'zeichner' | null;

export function App() {
  const [session, setSession] = useState<{ start: SessionStart; key: number } | null>(null);
  const [tool, setTool] = useState<Tool>(() => {
    if (!import.meta.env.DEV) return null;
    return location.hash === '#editor' ? 'editor' : location.hash === '#zeichner' ? 'zeichner' : null;
  });
  const exitTool = () => {
    history.replaceState(null, '', location.pathname);
    setTool(null);
  };
  if (tool === 'editor') return <MapEditor onExit={exitTool} />;
  if (tool === 'zeichner') {
    return (
      <Suspense fallback={<div className="editor"><div className="editor-error">Lade Karten-Zeichner …</div></div>}>
        <MapDrafter onExit={exitTool} />
      </Suspense>
    );
  }
  if (session) return <GameView key={session.key} start={session.start} onExit={() => setSession(null)} />;
  return <MainMenu onOpen={(start) => setSession({ start, key: Date.now() })}
    onEditor={import.meta.env.DEV ? () => { location.hash = 'editor'; setTool('editor'); } : undefined}
    onDrafter={import.meta.env.DEV ? () => { location.hash = 'zeichner'; setTool('zeichner'); } : undefined} />;
}
