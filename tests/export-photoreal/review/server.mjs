// The export-photoreal trial's review screen: a 127.0.0.1-only server for one HTML page, the items
// built by build.ts (which method made which picture stays in key.json, never served), the pictures
// in the trial's results folder only, and the ratings, appended to ratings.jsonl as each key is
// pressed. Nothing leaves the PC.
//
//   node tests/export-photoreal/review/server.mjs --set r2 [--port 8793]
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUT } from '../paths.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const port = Number(arg('port', 8793));
const set = arg('set', 'r2');
if (!/^[a-z0-9-]+$/.test(set)) throw new Error('--set <name>');
const here = fileURLToPath(new URL('.', import.meta.url));
const REVIEW = join(OUT, 'review', set);
const RATINGS = join(REVIEW, 'ratings.jsonl');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
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
      const path = resolve(OUT, url.searchParams.get('path') ?? '');
      if (relative(resolve(OUT), path).startsWith('..')) throw new Error('not served');
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
}).listen(port, '127.0.0.1', () => console.log(`review screen: http://127.0.0.1:${port}/ (${set})`));
