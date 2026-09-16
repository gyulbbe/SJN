import { build } from 'esbuild';
import { mkdir, unlink } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const entry = resolve(process.argv[2] ?? '');
if (
  !relative(resolve('tests'), entry) ||
  relative(resolve('tests'), entry).startsWith('..') ||
  !entry.endsWith('.ts')
)
  throw new Error('tests 폴더의 TypeScript 브라우저 검증 파일을 지정하세요.');
const directory = resolve('test-results/runners');
await mkdir(directory, { recursive: true });
const output = join(directory, `browser-${process.pid}-${Date.now()}.mjs`);
try {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    outfile: output,
    logLevel: 'warning',
  });
  await import(pathToFileURL(output).href);
} finally {
  await unlink(output).catch(() => {});
}
