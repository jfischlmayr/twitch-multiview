// Tiny static server for local development: `npm start` (or `node scripts/serve.mjs [port]`).
// `python3 -m http.server` works just as well; this only adds correct MIME types and no caching.
import { fileURLToPath } from 'node:url';
import { startServer } from './static-server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.argv[2] ?? process.env.PORT ?? 8000);
const { url } = await startServer(root, port);
console.log(`Multiview running at ${url} (Ctrl+C to stop)`);
