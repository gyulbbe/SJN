// A contact sheet of the four-direction AI inputs (capture-views.mjs): one row per project label, one column
// per view (정면 · 오른쪽 · 뒤 · 왼쪽), with the stand-in notes of each view under the row's label.
// Usage: node tests/product-representation/sheet-four-views.mjs <out.png> <label> [label ...]
import { existsSync, readFileSync } from 'node:fs';
import { ROOT } from './lib.mjs';
import { sheet } from './sheet.mjs';
const [out, ...labels] = process.argv.slice(2);
const VIEWS = ['정면', '오른쪽', '뒤', '왼쪽'];
const rows = labels.map((label) => {
  const notes = existsSync(`${ROOT}/views/${label}-notes.txt`)
    ? Object.fromEntries(
        readFileSync(`${ROOT}/views/${label}-notes.txt`, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => [line.split(': ')[0], line.split(': ').slice(1).join(': ')]),
      )
    : {};
  return VIEWS.map((view) => ({
    file: existsSync(`${ROOT}/views/${label}-${view}.png`) ? `${ROOT}/views/${label}-${view}.png` : undefined,
    label: `${label} · ${view}${notes[view] ? ' · 대체 안내 있음' : ''}`,
  }));
});
await sheet(rows, out, {
  cellW: 520,
  cellH: 350,
  title: '네 방향 AI 입력(미리보기와 같은 화면, AI 호출 없음)',
});
console.log('wrote', out);
