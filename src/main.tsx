import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';

// Ohne StrictMode: dessen doppelte Effekte würden beim Anlegen eines Spiels
// zwei Worker starten und das Spiel doppelt speichern.
createRoot(document.getElementById('root')!).render(<App />);
