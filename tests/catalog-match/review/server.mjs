// The catalog-match trial's review screen (round 5): a 127.0.0.1-only server for one HTML page, the
// items built by build.ts, the images they point at (results folder and the public corpus inputs
// only) and the ratings, appended to ratings.jsonl as each key is pressed. Nothing leaves the PC.
//
//   node tests/catalog-match/review/server.mjs [--port 8790] [--dir review-r9]
//
// `--dir` serves another set of items and ratings in the results folder (round 9: review-r9).
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORPUS_INPUTS, OUT } from '../paths.mjs';

const port = Number(process.argv[process.argv.indexOf('--port') + 1] || 8790) || 8790;
const here = fileURLToPath(new URL('.', import.meta.url));
const dirAt = process.argv.indexOf('--dir');
const dir = dirAt < 0 ? 'review' : process.argv[dirAt + 1];
if (!/^review(-[a-z0-9]+)?$/.test(dir)) throw new Error('--dir review or review-<name>');
const REVIEW = join(OUT, dir);
const RATINGS = join(REVIEW, 'ratings.jsonl');
const ROOTS = [resolve(OUT), resolve(CORPUS_INPUTS)];
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

createServer((request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'POST' && url.pathname === '/rate') {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        const row = JSON.parse(body);
        appendFileSync(RATINGS, JSON.stringify({ ...row, at: new Date().toISOString() }) + '\n');
        response.end('ok');
      });
      return;
    }
    if (url.pathname === '/') {
      response.setHeader('Content-Type', TYPES['.html']);
      response.end(readFileSync(join(here, 'index.html')));
      return;
    }
    if (url.pathname === '/items.json' || url.pathname === '/ratings.jsonl') {
      const file = join(REVIEW, url.pathname.slice(1));
      response.setHeader('Content-Type', 'application/json');
      response.end(existsSync(file) ? readFileSync(file) : '');
      return;
    }
    if (url.pathname === '/file') {
      const path = resolve(url.searchParams.get('path') ?? '');
      if (!ROOTS.some((root) => !relative(root, path).startsWith('..'))) throw new Error('not served');
      response.setHeader('Content-Type', TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream');
      response.end(readFileSync(path));
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  } catch (error) {
    response.statusCode = 404;
    response.end(String(error));
  }
}).listen(port, '127.0.0.1', () => console.log(`review screen: http://127.0.0.1:${port}/`));
