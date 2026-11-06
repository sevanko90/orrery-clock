import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';

/**
 * Dev-server telemetry for testing on a headset. The page POSTs samples and
 * markers to /__telemetry, which appends them as JSON lines to
 * .telemetry/log.jsonl; it polls /__telemetry/commands?since=N for new lines
 * of .telemetry/commands.jsonl (a fixed vocabulary the page understands, so
 * a test session can be steered from the workstation). Dev server only.
 */
export function telemetry(root: string): Plugin {
  const dir = join(root, '.telemetry');
  const log = join(dir, 'log.jsonl');
  const commands = join(dir, 'commands.jsonl');
  return {
    name: 'orrery-telemetry',
    apply: 'serve',
    configureServer(server) {
      mkdirSync(dir, { recursive: true });
      if (!existsSync(commands)) writeFileSync(commands, '');
      server.middlewares.use('/__telemetry', (req, res) => {
        // Frame captures from the scrunch debug tools (a PNG data URL) → .telemetry/captures/<name>.png
        if (req.method === 'POST' && req.url?.startsWith('/capture')) {
          const name = (new URL(req.url, 'http://x').searchParams.get('name') ?? 'frame').replace(/[^\w.-]/g, '_');
          const chunks: Buffer[] = [];
          req.on('data', (c: Buffer) => chunks.push(c));
          req.on('end', () => {
            const url = Buffer.concat(chunks).toString('utf8');
            const b64 = url.slice(url.indexOf(',') + 1);
            mkdirSync(join(dir, 'captures'), { recursive: true });
            writeFileSync(join(dir, 'captures', `${name}.png`), Buffer.from(b64, 'base64'));
            res.statusCode = 204;
            res.end();
          });
          return;
        }
        if (req.method === 'POST') {
          let body = '';
          req.on('data', (c) => {
            body += c;
            if (body.length > 1_000_000) req.destroy();
          });
          req.on('end', () => {
            try {
              const items = JSON.parse(body);
              const at = new Date().toISOString();
              const lines = (Array.isArray(items) ? items : [items]).map((i) => JSON.stringify({ at, ...i })).join('\n');
              if (lines) appendFileSync(log, lines + '\n');
              res.statusCode = 204;
            } catch {
              res.statusCode = 400;
            }
            res.end();
          });
          return;
        }
        if (req.method === 'GET' && req.url?.startsWith('/commands')) {
          const since = Number(new URL(req.url, 'http://x').searchParams.get('since') ?? 0);
          const all = readFileSync(commands, 'utf8')
            .split('\n')
            .filter((l) => l.trim());
          const fresh: unknown[] = [];
          all.slice(since).forEach((l) => {
            try {
              fresh.push(JSON.parse(l));
            } catch {
              /* skip a malformed line */
            }
          });
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ next: all.length, commands: fresh }));
          return;
        }
        res.statusCode = 404;
        res.end();
      });
    },
  };
}
