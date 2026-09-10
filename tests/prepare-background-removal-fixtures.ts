/** Download real, openly licensed QA photos only into ignored local test output. */
import { mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

const fixtures = [
  {
    file: 'white-toilet.jpg',
    url: 'https://upload.wikimedia.org/wikipedia/commons/1/1d/White_toilet.JPG',
    page: 'https://commons.wikimedia.org/wiki/File:White_toilet.JPG',
    author: 'Doug Coldwell',
    license: 'CC BY-SA 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    purpose: 'White ceramic toilet with bathroom clutter',
  },
  {
    file: 'retro-desk-lamp.jpg',
    url: 'https://upload.wikimedia.org/wikipedia/commons/5/5b/Retro_desk_lamp.jpg',
    page: 'https://commons.wikimedia.org/wiki/File:Retro_desk_lamp.jpg',
    author: 'WANGYIFAN2024',
    license: 'CC0 1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    purpose: 'Thin lamp stand, reflection and complex background',
  },
  {
    file: 'garden-chair.jpg',
    url: 'https://upload.wikimedia.org/wikipedia/commons/b/b9/Cast_iron_garden_chair_at_Boreham,_Essex,_England.jpg',
    page: 'https://commons.wikimedia.org/wiki/File:Cast_iron_garden_chair_at_Boreham,_Essex,_England.jpg',
    author: 'Acabashi',
    license: 'CC BY-SA 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    purpose: 'Openwork metal chair against stacked wood and gravel',
  },
];
const directory = path.resolve('test-results/background-removal/fixtures');
await mkdir(directory, { recursive: true });
for (const fixture of fixtures) {
  const destination = path.join(directory, fixture.file);
  if ((await stat(destination).catch(() => undefined))?.size) {
    console.log(`Already present: ${fixture.file}`);
    continue;
  }
  const response = await fetch(fixture.url, {
    headers: { 'User-Agent': 'SJNBackgroundRemovalQA/1.0 (local testing; photo attribution retained)' },
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok)
    throw new Error(`${fixture.file}: HTTP ${response.status}. Retry later if Wikimedia is rate limiting.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  await writeFile(destination, bytes);
  console.log(`${fixture.file}: ${bytes.length} bytes`);
}
await writeFile(path.join(directory, 'sources.json'), JSON.stringify(fixtures, null, 2));
