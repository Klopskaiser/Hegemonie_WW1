// Karten-Zeichner (nur Dev-Server): Entwürfe unter data/drafts/<id>.json speichern und laden, fertige Karten
// nach public/maps/<id>.json exportieren und in public/maps/custom.json für das Hauptmenü eintragen.
//   GET  /__drafts/            Liste der Entwürfe
//   GET  /__drafts/<id>        Entwurf (mit Vorlagebild)
//   POST /__drafts/<id>        Entwurf speichern
//   POST /__drafts/<id>/export Karte schreiben ({ map, name, description, force })

import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

interface CustomEntry { id: string; name: string; description: string }

export function mapDrafts(root: string): Plugin {
  const dir = path.join(root, 'data', 'drafts');
  const mapsDir = path.join(root, 'public', 'maps');
  const listFile = path.join(mapsDir, 'custom.json');
  const readList = (): CustomEntry[] => (fs.existsSync(listFile) ? JSON.parse(fs.readFileSync(listFile, 'utf8')) : []);
  return {
    name: 'map-drafts',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__drafts/', (req, res) => {
        const send = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          res.end(typeof body === 'string' ? body : JSON.stringify(body));
        };
        const url = (req.url ?? '').split('?')[0];
        const readBody = (fn: (body: string) => void) => {
          let body = '';
          req.setEncoding('utf8');
          req.on('data', (c: string) => (body += c));
          req.on('end', () => {
            try {
              fn(body);
            } catch (e) {
              send(400, { error: String(e) });
            }
          });
        };
        if (url === '/' || url === '') {
          if (req.method !== 'GET') return send(405, { error: 'Methode nicht erlaubt' });
          if (!fs.existsSync(dir)) return send(200, []);
          const list = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
            const file = path.join(dir, f);
            let name = f.replace(/\.json$/, '');
            try {
              // Name steht vorn in der Datei; nicht das ganze (große) Bild parsen
              const head = fs.readFileSync(file, 'utf8').slice(0, 4000);
              name = /"name"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head)?.[1] ?? name;
            } catch { /* Name bleibt die ID */ }
            return { id: f.replace(/\.json$/, ''), name, updated: fs.statSync(file).mtimeMs };
          }).sort((a, b) => b.updated - a.updated);
          return send(200, list);
        }
        const m = /^\/([a-z0-9_-]+)(\/export)?$/.exec(url);
        if (!m) return send(404, { error: 'unbekannt' });
        const id = m[1];
        const file = path.join(dir, `${id}.json`);
        if (!m[2]) {
          if (req.method === 'GET') return fs.existsSync(file) ? send(200, fs.readFileSync(file, 'utf8')) : send(404, { error: `Entwurf ${id} fehlt` });
          if (req.method === 'POST') {
            return readBody((body) => {
              JSON.parse(body); // nur gültiges JSON schreiben
              fs.mkdirSync(dir, { recursive: true });
              fs.writeFileSync(file, body);
              send(200, { ok: true });
            });
          }
          return send(405, { error: 'Methode nicht erlaubt' });
        }
        if (req.method !== 'POST') return send(405, { error: 'Methode nicht erlaubt' });
        readBody((body) => {
          const { map, name, description, force } = JSON.parse(body) as { map: { id: string }; name: string; description: string; force?: boolean };
          if (map.id !== id) return send(400, { error: 'Karten-ID passt nicht' });
          const out = path.join(mapsDir, `${id}.json`);
          const list = readList();
          const own = list.some((e) => e.id === id);
          // vorhandene Karte, die nicht aus dem Zeichner stammt (z. B. Kartenpipeline): nur nach Bestätigung
          if (fs.existsSync(out) && !own && !force) return send(409, { error: `public/maps/${id}.json stammt nicht aus dem Karten-Zeichner und würde überschrieben.` });
          fs.writeFileSync(out, JSON.stringify(map));
          const entry = { id, name, description };
          fs.writeFileSync(listFile, JSON.stringify(own ? list.map((e) => (e.id === id ? entry : e)) : [...list, entry], null, 2) + '\n');
          send(200, { ok: true, file: `public/maps/${id}.json` });
        });
      });
    },
  };
}
