import fs from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { applyEdits } from './src/game/mapedits.ts';

/** Vorgaben lesbar formatieren: Punkte und Namenspaare je in einer Zeile */
function formatEdits(edits: unknown): string {
  return JSON.stringify(edits, null, 2)
    .replace(/\[\s+(-?[\d.]+),\s+(-?[\d.]+)\s+\]/g, '[$1, $2]')
    .replace(/\[\s+("[^"]*"),\s+("[^"]*")\s+\]/g, '[$1, $2]') + '\n';
}

/**
 * Karteneditor (nur Dev-Server): liest die Grundkarte und die Vorgaben, speichert Vorgaben und
 * schreibt die fertige Karte nach public/maps. GET/POST /__editor/<karte>/(base|edits)
 */
function mapEditor(): Plugin {
  const root = import.meta.dirname;
  const files = (id: string) => ({
    base: path.join(root, 'data', 'maps', `${id}.base.json`),
    edits: path.join(root, 'scripts', 'maps', `${id}.edits.json`),
    out: path.join(root, 'public', 'maps', `${id}.json`),
  });
  return {
    name: 'map-editor',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__editor/', (req, res) => {
        const m = /^\/([a-z0-9-]+)\/(base|edits)$/.exec(req.url ?? '');
        const send = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          res.end(typeof body === 'string' ? body : JSON.stringify(body));
        };
        if (!m) return send(404, { error: 'unbekannt' });
        const f = files(m[1]);
        if (req.method === 'GET') {
          if (m[2] === 'base') return fs.existsSync(f.base) ? send(200, fs.readFileSync(f.base, 'utf8')) : send(404, { error: 'Grundkarte fehlt – npm run map:europe' });
          return send(200, fs.existsSync(f.edits) ? fs.readFileSync(f.edits, 'utf8') : '{}');
        }
        if (req.method === 'POST' && m[2] === 'edits') {
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', () => {
            try {
              const edits = JSON.parse(body);
              const result = applyEdits(JSON.parse(fs.readFileSync(f.base, 'utf8')), edits);
              fs.writeFileSync(f.edits, formatEdits(edits));
              fs.writeFileSync(f.out, JSON.stringify(result.map));
              send(200, { warnings: result.warnings });
            } catch (e) {
              send(400, { error: String(e) });
            }
          });
          return;
        }
        send(405, { error: 'Methode nicht erlaubt' });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), mapEditor()],
  worker: { format: 'es' },
  // Simulationstests rechnen mehrere Spieltage; 5 s Standardlimit reicht unter Last nicht immer
  test: { include: ['tests/**/*.test.ts'], testTimeout: 20000 },
});
