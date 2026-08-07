/* ============================================================
   A static file server for browser verification
   ------------------------------------------------------------
   The smallest thing that serves the repository over http:// so
   the page can be checked the way a visitor meets it, rather
   than through file:// where the protocol itself changes what
   the config does.

   Dependency-free on purpose: the repository has no bundler, no
   framework and no dev server, and adding one to look at a page
   would be a larger change than the thing being looked at.

   Binds to 127.0.0.1 only. Serves GET and HEAD only. Refuses
   any path that escapes the repository root. It is a test
   fixture, not a deployment target.
   ============================================================ */

import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, extname, normalize, sep } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

export const startServer = ({ port = 0 } = {}) => new Promise((resolvePromise, reject) => {
  const server = createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return res.end();
    }

    const requested = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    const target = resolve(ROOT, `.${normalize(requested)}`);

    /* A path that escapes the root is refused, not clamped. */
    if (target !== ROOT && !target.startsWith(ROOT + sep)) {
      res.writeHead(403);
      return res.end('forbidden');
    }

    let stats;
    try {
      stats = statSync(target);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found');
    }
    if (stats.isDirectory()) {
      res.writeHead(403);
      return res.end('directory listing is not served');
    }

    res.writeHead(200, {
      'Content-Type': TYPES[extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(target).pipe(res);
  });

  server.on('error', reject);
  server.listen(port, '127.0.0.1', () => {
    const { port: actual } = server.address();
    resolvePromise({
      server,
      origin: `http://127.0.0.1:${actual}`,
      close: () => new Promise(done => server.close(done))
    });
  });
});

/* Runnable on its own, for looking at the page by hand. */
if (process.argv[1] && process.argv[1].endsWith('serve.mjs')) {
  const { origin } = await startServer({ port: Number(process.env.PORT) || 8787 });
  console.log(`Serving ${ROOT}\n  ${origin}/verticals/beauty-wellness-fitness/nails/service-mix/site/index.html`);
}
