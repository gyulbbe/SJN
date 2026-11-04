// The direction-photo methods trial's review screen (docs section 7), for a person to grade or re-check
// a set made by review-build.mjs: one product and view at a time, its photo and its lettered candidates
// at 480 px, in the sheet's blind order. Keys: 1 옆 / 2 살짝 / 3 사선 (정면·뒤: 맞음 / 살짝 / 틀림),
// y / n 같은 제품, u / x 그대로 등록 가능 / 아님, b o c k 문제(배경·없던 물건·색·다른 종류), ← → 후보,
// Enter 다음 화면. Every key is appended to review/<set>/ratings-person.jsonl at once, so a stop loses
// nothing; the screen resumes where the file ends. 127.0.0.1 only; the method names never reach the page.
//
//   node tests/direction-photo-methods/review/server.mjs <set> [--port 8794]
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve, relative } from 'node:path';
import { OUT } from '../paths.mjs';

const set = process.argv[2];
const portAt = process.argv.indexOf('--port');
const PORT = portAt > 0 ? Number(process.argv[portAt + 1]) : 8794;
const dir = join(OUT, 'review', set);
const key = JSON.parse(readFileSync(join(dir, 'key.json'), 'utf8'));
const ratings = join(dir, 'ratings-person.jsonl');
// What the page may know: the screens and their letters, never the method or the seed.
const screens = Object.entries(key).map(([screen, items]) => {
  const [product, view] = [
    screen.slice(0, screen.lastIndexOf('-')),
    screen.slice(screen.lastIndexOf('-') + 1),
  ];
  return {
    screen,
    product,
    view,
    photo: join(OUT, 'prep', product, 'refs', '1.png'),
    letters: items.map((i) => i.letter),
  };
});
const files = new Map(
  Object.entries(key).flatMap(([screen, items]) => items.map((i) => [`${screen}/${i.letter}`, i.file])),
);

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(new URL('./index.html', import.meta.url)));
  } else if (url.pathname === '/screens.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(screens.map(({ photo, ...s }) => s)));
  } else if (url.pathname === '/ratings.jsonl') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(existsSync(ratings) ? readFileSync(ratings) : '');
  } else if (url.pathname === '/image') {
    const screen = screens.find((s) => s.screen === url.searchParams.get('screen'));
    const letter = url.searchParams.get('letter');
    const file = letter === 'photo' ? screen?.photo : files.get(`${screen?.screen}/${letter}`);
    if (!file || relative(resolve(OUT), resolve(file)).startsWith('..') || !existsSync(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(readFileSync(file));
  } else if (url.pathname === '/rate' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      appendFileSync(ratings, JSON.stringify({ ...JSON.parse(body), at: new Date().toISOString() }) + '\n');
      res.end('ok');
    });
  } else {
    res.writeHead(404);
    res.end();
  }
}).listen(PORT, '127.0.0.1', () => console.log(`review ${set}: http://127.0.0.1:${PORT}/`));
