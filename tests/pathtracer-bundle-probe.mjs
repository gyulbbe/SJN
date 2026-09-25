/**
 * Bundle checks for the path-tracing spike. No app code imports the library yet.
 *   node tests/pathtracer-bundle-probe.mjs snapshot <label>   client files of the last Next and vinext builds
 *   node tests/pathtracer-bundle-probe.mjs compare <a> <b>    file-level difference of two snapshots
 *   node tests/pathtracer-bundle-probe.mjs probe              Vite build of a dynamic-import entry
 * Writes to test-results/pathtracer-spike/.
 */
import { build } from 'vite';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const output = resolve('test-results/pathtracer-spike');
await mkdir(output, { recursive: true });
// GLSL names that only the path tracer / its BVH shaders contain.
const MARKERS = ['bvhIntersectFirstHit', 'PhysicalPathTracingMaterial', 'sampleEquirect'];
const [command, ...args] = process.argv.slice(2);

async function files(root) {
  const found = [];
  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.(m?js|css)$/.test(entry.name)) found.push(path);
    }
  };
  await walk(root);
  return found.sort();
}

async function describe(root) {
  const result = [];
  for (const path of await files(root)) {
    const data = await readFile(path);
    const text = data.toString('utf8');
    result.push({
      file: relative(root, path).replaceAll('\\', '/'),
      bytes: data.length,
      gzip: gzipSync(data, { level: 9 }).length,
      sha1: createHash('sha1').update(data).digest('hex'),
      markers: MARKERS.filter((marker) => text.includes(marker)),
    });
  }
  return result;
}

const total = (list, key) => list.reduce((sum, item) => sum + item[key], 0);

if (command === 'snapshot') {
  const label = args[0];
  if (!/^[a-z0-9-]+$/.test(label ?? '')) throw new Error('snapshot <label>');
  const report = {};
  for (const [name, root] of [
    ['next', '.next/static'],
    ['vinext', 'dist/client'],
  ]) {
    const list = await describe(resolve(root));
    report[name] = {
      root,
      files: list.length,
      bytes: total(list, 'bytes'),
      gzip: total(list, 'gzip'),
      withMarkers: list.filter((item) => item.markers.length).map((item) => item.file),
      list,
    };
  }
  await writeFile(join(output, `bundle-${label}.json`), JSON.stringify(report, null, 2));
  for (const [name, value] of Object.entries(report))
    console.log(name, {
      files: value.files,
      bytes: value.bytes,
      gzip: value.gzip,
      withMarkers: value.withMarkers,
    });
} else if (command === 'compare') {
  const [a, b] = await Promise.all(
    args.map(async (label) => JSON.parse(await readFile(join(output, `bundle-${label}.json`), 'utf8'))),
  );
  const summary = {};
  for (const name of Object.keys(a)) {
    const before = new Map(a[name].list.map((item) => [item.sha1, item]));
    const after = new Map(b[name].list.map((item) => [item.sha1, item]));
    const removed = [...before.values()].filter((item) => !after.has(item.sha1));
    const added = [...after.values()].filter((item) => !before.has(item.sha1));
    summary[name] = {
      bytesDelta: b[name].bytes - a[name].bytes,
      gzipDelta: b[name].gzip - a[name].gzip,
      removed: removed.map(({ file, bytes, gzip }) => ({ file, bytes, gzip })),
      added: added.map(({ file, bytes, gzip, markers }) => ({ file, bytes, gzip, markers })),
      withMarkers: b[name].withMarkers,
    };
  }
  await writeFile(
    join(output, `bundle-compare-${args[0]}-${args[1]}.json`),
    JSON.stringify(summary, null, 2),
  );
  console.log(JSON.stringify(summary, null, 2));
} else if (command === 'probe') {
  // The editor already ships three; the entry mirrors that and reaches the library only through import().
  const entry = '\0pathtracer-probe-entry';
  const result = await build({
    configFile: false,
    logLevel: 'warn',
    root: process.cwd(),
    plugins: [
      {
        name: 'pathtracer-probe-entry',
        resolveId: (id) => (id === entry ? id : null),
        load: (id) =>
          id === entry
            ? // App builds drop unused entry exports, so publish both paths on globalThis.
              `import { Scene, WebGLRenderer } from 'three';
globalThis.probe = {
  raster: () => new WebGLRenderer().render(new Scene(), null),
  trace: async (renderer) => new (await import('three-gpu-pathtracer')).WebGLPathTracer(renderer),
};`
            : null,
      },
    ],
    build: {
      write: false,
      minify: true,
      target: 'es2022',
      rollupOptions: { input: entry, output: { format: 'es' } },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) => r.output);
  const chunks = outputs
    .filter((item) => item.type === 'chunk')
    .map((chunk) => {
      const packages = [
        ...new Set(
          chunk.moduleIds.map(
            (id) => /node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(id)?.[1] ?? 'local',
          ),
        ),
      ].sort();
      const data = Buffer.from(chunk.code);
      return {
        threeModules: chunk.moduleIds
          .map((id) => /node_modules[\\/]three[\\/](.+)$/.exec(id)?.[1]?.replaceAll('\\', '/'))
          .filter(Boolean),
        file: chunk.fileName,
        isEntry: chunk.isEntry,
        isDynamicEntry: chunk.isDynamicEntry,
        imports: chunk.imports,
        dynamicImports: chunk.dynamicImports,
        packages,
        modules: chunk.moduleIds.length,
        bytes: data.length,
        gzip: gzipSync(data, { level: 9 }).length,
      };
    });
  const entryChunk = chunks.find((c) => c.isEntry);
  const library = chunks.filter((c) => c.packages.includes('three-gpu-pathtracer'));
  const report = {
    vite: (await import('vite')).version,
    chunks,
    checks: {
      libraryOnlyInDynamicChunks: library.length > 0 && library.every((c) => !c.isEntry && c.isDynamicEntry),
      threeStaysInEntry: !!entryChunk?.packages.includes('three'),
      // Addons such as examples/jsm Pass.js may ride along; the core build must exist once.
      threeCoreOnlyInEntry: chunks.every(
        (c) => c.isEntry || !c.threeModules.some((id) => id.startsWith('build/')),
      ),
      xatlasBundled: chunks.some((c) => c.packages.includes('xatlas-web')),
    },
  };
  await writeFile(join(output, 'bundle-probe.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} else throw new Error('snapshot <label> | compare <a> <b> | probe');
