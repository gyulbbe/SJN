// Draws plain side and back pictures of a toilet (transparent background), so a product can be
// registered with four real directions for the four-direction views (docs/room-dimensions.md, "네 방향 시점").
// The side picture is as wide as the product is deep, so its size in the room can be checked by eye; a red dot
// marks the FRONT of the product (where it faces), a blue band the back/tank side.
// Usage: node tests/product-representation/make-sides.mjs
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
const OUT = 'test-results/product-representation/input';
mkdirSync(OUT, { recursive: true });
// Product: 370 wide, 660 high, 640 deep, so the side picture is 640 x 660 (depth x height) and the back 370 x 660.
const body = '#e9e9ec',
  line = '#555',
  front = '#d62d20',
  back = '#2a5bd7';
const side = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="660" viewBox="0 0 640 660">
  <rect x="0" y="40" width="170" height="330" rx="24" fill="${body}" stroke="${line}" stroke-width="6"/>
  <rect x="0" y="40" width="40" height="330" rx="18" fill="${back}"/>
  <path d="M120 360 H600 Q640 360 640 400 V470 Q640 520 590 520 H420 Q340 520 300 600 V660 H160 V470 Z" fill="${body}" stroke="${line}" stroke-width="6"/>
  <circle cx="598" cy="440" r="26" fill="${front}"/>
  <rect x="160" y="600" width="140" height="60" fill="${body}" stroke="${line}" stroke-width="6"/>
</svg>`;
const rear = `<svg xmlns="http://www.w3.org/2000/svg" width="370" height="660" viewBox="0 0 370 660">
  <rect x="20" y="40" width="330" height="330" rx="26" fill="${body}" stroke="${line}" stroke-width="6"/>
  <rect x="20" y="40" width="330" height="60" rx="22" fill="${back}"/>
  <rect x="85" y="370" width="200" height="290" fill="${body}" stroke="${line}" stroke-width="6"/>
</svg>`;
await sharp(Buffer.from(side)).png().toFile(`${OUT}/sided-toilet-right.png`);
await sharp(Buffer.from(side)).flop().png().toFile(`${OUT}/sided-toilet-left.png`);
await sharp(Buffer.from(rear)).png().toFile(`${OUT}/sided-toilet-back.png`);
console.log('wrote sided-toilet-right/left/back.png in', OUT);
