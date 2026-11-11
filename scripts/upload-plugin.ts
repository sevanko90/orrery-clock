import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { Plugin } from 'vite';

/**
 * Dev server only: a page for sending files from a headset (or phone) to
 * this machine over Wi-Fi, e.g. Quest recordings without developer mode or
 * a cable. Open /upload in the headset's browser, choose files; each is
 * streamed into quest-uploads/ in the project folder (git-ignored). A file
 * already there under the same name gets a numbered copy, never overwritten.
 */
export function upload(root: string): Plugin {
  const dir = join(root, 'quest-uploads');
  return {
    name: 'orrery-upload',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/upload', (req, res) => {
        if (req.method === 'GET' && (req.url === '/' || req.url === '' || req.url?.startsWith('/?'))) {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(PAGE);
          return;
        }
        if (req.method === 'POST' && req.url?.startsWith('/file')) {
          const raw = new URL(req.url, 'http://x').searchParams.get('name') ?? 'upload';
          // A plain file name only (no folders), kept readable.
          const safe = basename(raw).replace(/[^\w.\- ()]/g, '_') || 'upload';
          mkdirSync(dir, { recursive: true });
          let target = join(dir, safe);
          for (let n = 2; existsSync(target); n++) {
            const ext = extname(safe);
            target = join(dir, `${safe.slice(0, safe.length - ext.length)} (${n})${ext}`);
          }
          // Into a temporary name first, so an interrupted upload never looks finished.
          const part = `${target}.part`;
          const out = createWriteStream(part);
          req.pipe(out);
          // Exactly one answer per upload: an abort and a write error can both fire.
          let settled = false;
          const fail = (why: string) => {
            if (settled) return;
            settled = true;
            out.destroy();
            rmSync(part, { force: true });
            if (!res.headersSent) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
            }
            res.end(JSON.stringify({ ok: false, why }));
          };
          req.on('aborted', () => fail('aborted'));
          out.on('error', (e) => fail(String(e)));
          out.on('finish', () => {
            if (settled) return;
            // A throw here (disk full, permissions) would be uncaught and take down the dev server.
            try {
              renameSync(part, target);
            } catch (e) {
              fail(String(e));
              return;
            }
            settled = true;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, saved: basename(target) }));
          });
          return;
        }
        res.statusCode = 404;
        res.end();
      });
    },
  };
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Send to Mac</title>
<style>
  :root { --ink:#f3e6cc; --dim:#b9a582; --brass:#d4a94f; --amber:#ffb04a; --panel:rgba(16,12,9,.85); --edge:rgba(212,169,79,.35); color-scheme: dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#0b0a09; color:var(--ink); font:18px/1.4 Georgia, serif; }
  main { width:min(640px, calc(100% - 32px)); padding:28px; border:1px solid var(--edge); border-radius:18px; background:var(--panel); }
  h1 { margin:0 0 6px; font-size:26px; letter-spacing:.06em; color:var(--brass); text-transform:uppercase; }
  p { margin:0 0 20px; color:var(--dim); }
  label.pick { display:inline-block; padding:16px 28px; border-radius:999px; border:1px solid var(--brass); color:var(--brass); font-size:20px; letter-spacing:.08em; text-transform:uppercase; cursor:pointer; }
  label.pick:hover { color:var(--amber); border-color:var(--amber); }
  input { display:none; }
  ul { list-style:none; padding:0; margin:22px 0 0; display:grid; gap:12px; }
  li { padding:12px 14px; border:1px solid var(--edge); border-radius:12px; }
  .name { overflow-wrap:anywhere; }
  .bar { height:8px; margin-top:8px; border-radius:4px; background:rgba(212,169,79,.15); overflow:hidden; }
  .bar i { display:block; height:100%; width:0; background:var(--brass); transition:width .2s; }
  .note { margin-top:6px; font-size:15px; color:var(--dim); }
  .done .bar i { background:#7fc98a; } .failed .bar i { background:#d06a5a; }
</style>
</head>
<body>
<main>
  <h1>Send to Mac</h1>
  <p>Choose recordings or screenshots on this device. They're copied over Wi-Fi into <b>quest-uploads</b> in the project folder on the Mac.</p>
  <label class="pick">Choose files<input id="files" type="file" multiple accept="video/*,image/*" /></label>
  <ul id="list"></ul>
</main>
<script>
  const list = document.getElementById('list');
  const mb = (n) => (n / 1048576).toFixed(n > 1e8 ? 0 : 1) + ' MB';
  function send(file) {
    const li = document.createElement('li');
    li.innerHTML = '<div class="name"></div><div class="bar"><i></i></div><div class="note">Waiting…</div>';
    li.querySelector('.name').textContent = file.name + ' · ' + mb(file.size);
    list.prepend(li);
    const bar = li.querySelector('.bar i'), note = li.querySelector('.note');
    return new Promise((done) => {
      const x = new XMLHttpRequest();
      // (An absolute path: relative to /upload without its slash, 'file' meant /file.)
      x.open('POST', '/upload/file?name=' + encodeURIComponent(file.name));
      x.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        bar.style.width = (100 * e.loaded / e.total).toFixed(1) + '%';
        note.textContent = mb(e.loaded) + ' of ' + mb(e.total);
      };
      x.onload = () => {
        let r = {}; try { r = JSON.parse(x.responseText); } catch {}
        if (x.status === 200 && r.ok) { li.className = 'done'; bar.style.width = '100%'; note.textContent = 'Saved as ' + r.saved; }
        else { li.className = 'failed'; note.textContent = 'Failed: ' + (r.why || x.status); }
        done();
      };
      x.onerror = () => { li.className = 'failed'; note.textContent = 'Failed: connection lost'; done(); };
      x.send(file);
    });
  }
  document.getElementById('files').addEventListener('change', async (e) => {
    // One at a time: steadier over Wi-Fi than all at once.
    for (const f of e.target.files) await send(f);
    e.target.value = '';
  });
</script>
</body>
</html>`;
