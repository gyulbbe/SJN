/** Replay only saved real DeepLab components. No browser model or image inference. */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { inspectBasinShape } from '../src/lib/reconstruction/basin-observations';
import type { BasinComponentCapture } from '../src/lib/reconstruction/basin-observations';
const source = resolve(
  process.env.BASIN_REPLAY_SOURCE ?? 'test-results/reconstruction-basin-shape-investigation-20260913/raw-v1',
);
const output = resolve(
  process.env.BASIN_REPLAY_OUTPUT ??
    'test-results/reconstruction-basin-shape-investigation-20260913/replay-v2',
);
for (const path of [source, output])
  if (relative(resolve('test-results'), path).startsWith('..'))
    throw Error('Keep private raw/replay files under test-results.');
await mkdir(output, { recursive: true });
const cases = [];
for (const id of ['user-01', 'user-02', 'user-03', 'user-04']) {
  const directory = resolve(output, id);
  await mkdir(directory, { recursive: true });
  const changes = [];
  for (const file of (await readdir(resolve(source, id))).filter((f) => /^pass-\d+\.json$/.test(f)).sort()) {
    const raw = await readFile(resolve(source, id, file));
    const pass = JSON.parse(raw.toString('utf8')) as {
      width: number;
      height: number;
      context: string;
      flipped: boolean;
      rgbaFile: string;
      components: BasinComponentCapture[];
    };
    const rgbaBytes = await readFile(resolve(source, id, pass.rgbaFile)),
      rgba = new Uint8ClampedArray(rgbaBytes);
    const revised = [];
    for (const component of pass.components) {
      const pixels: number[] = [];
      for (let i = 0; i < component.pixelRuns.length; i += 2)
        for (let n = 0; n < component.pixelRuns[i + 1]; n++) pixels.push(component.pixelRuns[i] + n);
      const inspection = inspectBasinShape(
        pixels,
        pass.width,
        pass.height,
        component.bounds,
        component.hasPedestal,
        true,
        rgba,
      );
      revised.push({ ...component, inspection });
      const item = {
        pass: file,
        context: pass.context,
        id: component.id,
        hasPedestal: component.hasPedestal,
        before: component.inspection.evidence ?? null,
        after: inspection.evidence ?? null,
        beforeRejection: component.inspection.diagnostic.rejectedBy,
        afterRejection: inspection.diagnostic.rejectedBy,
      };
      changes.push(item);
      if (component.hasPedestal) {
        const name = file.replace('.json', '') + '-' + component.id;
        const photograph = await sharp(rgbaBytes, {
          raw: { width: pass.width, height: pass.height, channels: 4 },
        })
          .png()
          .toBuffer();
        const svg = [
          `<svg xmlns="http://www.w3.org/2000/svg" width="${pass.width * 2}" height="${pass.height * 2}" viewBox="0 0 ${pass.width} ${pass.height}"><image width="${pass.width}" height="${pass.height}" href="data:image/png;base64,${photograph.toString('base64')}"/>`,
        ];
        const diagnostic = inspection.diagnostic,
          x0 = Math.floor(component.bounds.left * pass.width),
          span = diagnostic.span!;
        for (const point of diagnostic.rim?.points ?? [])
          svg.push(
            `<circle cx="${x0 + (point.x + 0.5) * span}" cy="${point.y * span}" r=".75" fill="#f72"/>`,
          );
        for (const [index, line] of [diagnostic.rim?.left, diagnostic.rim?.right].entries())
          if (line) {
            const a = index === 0 ? -0.42 : 0.05,
              b = index === 0 ? -0.05 : 0.42;
            svg.push(
              `<path d="M${x0 + (a + 0.5) * span} ${(line.intercept + line.slope * a) * span} L${x0 + (b + 0.5) * span} ${(line.intercept + line.slope * b) * span}" stroke="#06f" stroke-width="1.2"/>`,
            );
          }
        const cross = diagnostic.rim?.intersection;
        if (cross) svg.push(`<circle cx="${x0 + cross.x * span}" cy="${cross.y}" r="2" fill="#0ff"/>`);
        svg.push('</svg>');
        await sharp(Buffer.from(svg.join('')))
          .png()
          .toFile(resolve(directory, name + '.png'));
      }
    }
    await writeFile(
      resolve(directory, file),
      JSON.stringify(
        {
          ...pass,
          inputSha256: createHash('sha256').update(raw).digest('hex'),
          rgbaSha256: createHash('sha256').update(rgbaBytes).digest('hex'),
          components: revised,
        },
        null,
        2,
      ),
    );
  }
  const summary = { id, changes };
  cases.push(summary);
  await writeFile(resolve(directory, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(
    JSON.stringify({
      id,
      total: changes.length,
      changes: changes.filter((c) => JSON.stringify(c.before) !== JSON.stringify(c.after)),
    }),
  );
}
await writeFile(
  resolve(output, 'summary.json'),
  JSON.stringify(
    { scope: 'Same recorded components/RGB, pure algorithm replay, no new inference', cases },
    null,
    2,
  ),
);
