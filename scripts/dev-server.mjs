// Servidor de desenvolvimento: serve public/ e executa api/bps.js como na Vercel.
//
//   NODE_USE_ENV_PROXY=1 node scripts/dev-server.mjs      (PORT=5173 por padrão)
//
// As respostas do BPS ficam em cache em disco por 1 h (BPS_CACHE_DIR), fazendo o
// papel da CDN: evita repetir chamadas lentas à API oficial durante os testes.
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import handler from '../api/bps.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.env.PORT || 5173);
const CACHE_DIR = process.env.BPS_CACHE_DIR || path.join(os.tmpdir(), 'painel-bps-cache');
const CACHE_TTL_MS = 60 * 60 * 1000;
// Se api/bps.js mudar, o cache antigo deixa de valer.
const VERSAO = createHash('sha1')
  .update(await readFile(new URL('../api/bps.js', import.meta.url)))
  .digest('hex')
  .slice(0, 10);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.gz': 'application/gzip',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

async function api(url) {
  const key = createHash('sha1').update(url.search).digest('hex');
  const file = path.join(CACHE_DIR, `${VERSAO}-${key}.json`);
  try {
    const st = await stat(file);
    if (Date.now() - st.mtimeMs < CACHE_TTL_MS) {
      return { status: 200, body: await readFile(file), hit: true };
    }
  } catch {
    /* sem cache */
  }
  const resp = await handler(new Request(url, { method: 'GET' }));
  const body = Buffer.from(await resp.arrayBuffer());
  if (resp.status === 200) {
    await mkdir(CACHE_DIR, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, file);
  }
  return { status: resp.status, body, hit: false };
}

async function estatico(pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const candidatos = [rel, `${rel}.html`];
  for (const c of candidatos) {
    const file = path.join(ROOT, c);
    if (!file.startsWith(ROOT + path.sep)) return null;
    try {
      const st = await stat(file);
      if (st.isFile()) return { file, body: await readFile(file) };
    } catch {
      /* tenta o próximo */
    }
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  try {
    // "//caminho" seria lido como outro host (e "//" nem é uma URL válida): normaliza antes.
    const url = new URL(String(req.url || '/').replace(/^\/+/, '/'), 'http://localhost');
    if (url.pathname === '/api/bps') {
      const r = await api(url);
      res.writeHead(r.status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-dev-cache': r.hit ? 'HIT' : 'MISS',
      });
      res.end(r.body);
      return;
    }
    const achado = await estatico(url.pathname);
    if (!achado) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Não encontrado');
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(achado.file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(achado.body);
  } catch (e) {
    const invalida = e instanceof URIError || (e && e.code === 'ERR_INVALID_URL');
    res.writeHead(invalida ? 400 : 500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ erro: String((e && e.message) || e) }));
  }
});

server.listen(PORT, () => {
  console.log(`Painel em http://localhost:${PORT}  (cache do BPS: ${CACHE_DIR})`);
});
