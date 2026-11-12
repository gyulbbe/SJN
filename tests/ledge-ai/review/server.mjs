// The ledge AI trial's review screen: a 127.0.0.1-only server for one HTML page, the items built by
// build.mjs (which method made which picture stays in key.json, never served), the pictures of the
// trial's folder only, and the ratings, appended to ratings.jsonl as each one is given. Nothing leaves
// the PC.
//
//   node tests/ledge-ai/review/server.mjs --set r4 [--port 8794]
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUT, REVIEW } from '../paths.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const port = Number(arg('port', 8794));
const set = arg('set', 'r4');
if (!/^[a-z0-9-]+$/.test(set)) throw new Error('--set <name>');
const here = fileURLToPath(new URL('.', import.meta.url));
const dir = join(REVIEW, set);
const RATINGS = join(dir, 'ratings.jsonl');
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.png': 'image/png' };

createServer((request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'POST' && url.pathname === '/rate') {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        const row = JSON.parse(body);
        if (typeof row.id !== 'string' || !row.id.startsWith(set + '-')) {
          response.statusCode = 400;
          return response.end('bad id');
        }
        appendFileSync(RATINGS, JSON.stringify({ ...row, at: new Date().toISOString() }) + '\n');
        response.end('ok');
      });
      return;
    }
    if (url.pathname === '/') {
      response.setHeader('Content-Type', TYPES['.html']);
      return response.end(readFileSync(join(here, 'index.html')));
    }
    if (url.pathname === '/items.json' || url.pathname === '/ratings.jsonl') {
      const file = join(dir, url.pathname.slice(1));
      response.setHeader('Content-Type', 'application/json');
      return response.end(existsSync(file) ? readFileSync(file) : '');
    }
    if (url.pathname === '/file') {
      const path = resolve(OUT, url.searchParams.get('path') ?? '');
      // Only the trial's pictures: never key.json, the ledger or anything outside the folder.
      if (relative(resolve(OUT), path).startsWith('..') || extname(path).toLowerCase() !== '.png')
        throw new Error('not served');
      response.setHeader('Content-Type', TYPES['.png']);
      return response.end(readFileSync(path));
    }
    response.statusCode = 404;
    response.end('not found');
  } catch (error) {
    response.statusCode = 404;
    response.end(String(error));
  }
}).listen(port, '127.0.0.1', () => console.log(`review screen: http://127.0.0.1:${port}/ (${set})`));
