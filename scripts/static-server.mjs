// Minimal static file server for the end-to-end tests (no dependencies).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export function startServer(root, port = 0) {
  const base = resolve(root);
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = normalize(join(base, path.endsWith('/') ? `${path}index.html` : path));
    if (file !== base && !file.startsWith(base + sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((done) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: actual } = server.address();
      done({ url: `http://localhost:${actual}/`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}
