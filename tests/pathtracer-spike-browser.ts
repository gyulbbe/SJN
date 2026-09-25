/**
 * Path-tracing spike, stages 0–1: capabilities, raster vs path-traced export of one neutral room
 * with a standard toilet, convergence/time/silhouette/resource metrics. No AI, no network.
 * Usage: node tests/run-browser-test.mjs tests/pathtracer-spike-browser.ts <swiftshader|gpu> [--headed]
 *   [--lightings=A,B] [--max-seconds=N] [--cycles=3] [--label=name]
 * Writes test-results/pathtracer-spike/<label or env>/.
 */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { deltaE2000 } from './helpers/delta-e';

const environment = process.argv[3] ?? 'swiftshader';
if (environment !== 'swiftshader' && environment !== 'gpu') throw new Error('environment: swiftshader | gpu');
const headed = process.argv.includes('--headed');
const option = (name: string) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const software = environment === 'swiftshader';
// SwiftShader only answers "can automated tests use it"; the real GPU carries the time gate.
const CHECKPOINTS =
  option('checkpoints')?.split(',').map(Number) ?? (software ? [16, 32] : [16, 32, 64, 128, 256, 512]);
const MAX_SECONDS = Number(option('max-seconds') ?? (software ? 180 : 60));
const LIGHTINGS = (option('lightings') ?? 'A,B').split(',') as ('A' | 'B')[];
const CYCLES = Number(option('cycles') ?? 3);
const CYCLE_SAMPLES = software ? 2 : 32;
const label = option('label') ?? environment;
if (!/^[a-z0-9-]+$/.test(label) || !LIGHTINGS.every((l) => l === 'A' || l === 'B') || !(MAX_SECONDS > 0))
  throw new Error('check --label, --lightings and --max-seconds');
const output = `test-results/pathtracer-spike/${label}`;
await mkdir(`${output}/A`, { recursive: true });
await mkdir(`${output}/B`, { recursive: true });

type Spike = typeof import('./pathtracer-spike-page');
const bundle = await build({
  entryPoints: ['tests/pathtracer-spike-page.ts'],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'Spike',
  logLevel: 'warning',
});
const png = (url: string) => Buffer.from(url.split(',')[1], 'base64');
const power = (() => {
  try {
    // Read-only: 2 = on AC power. Laptop GPUs throttle on battery.
    return execFileSync(
      'powershell',
      ['-NoProfile', '-Command', '(Get-CimInstance Win32_Battery | Select-Object -First 1).BatteryStatus'],
      { encoding: 'utf8' },
    ).trim();
  } catch {
    return 'unknown';
  }
})();

// --angle picks the ANGLE backend for the gpu run (Chrome's Windows default is d3d11).
// --profile keeps a Chrome profile, and with it the GPU shader cache, between runs.
const angle = option('angle') ?? 'd3d11';
const profile = option('profile');
const launchOptions = {
  channel: 'chrome',
  headless: !headed,
  args: software
    ? ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
    : ['--enable-webgl', '--ignore-gpu-blocklist', `--use-angle=${angle}`, '--enable-gpu'],
};
const viewport = { width: 1300, height: 900 };
const browser = profile
  ? await chromium.launchPersistentContext(`test-results/pathtracer-spike/profiles/${profile}`, {
      ...launchOptions,
      viewport,
    })
  : await chromium.launch(launchOptions);
try {
  const page = 'newContext' in browser ? await browser.newPage({ viewport }) : await browser.newPage();
  const errors: string[] = [];
  const warnings: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (e) => {
    if (e.type() === 'error') errors.push(e.text());
    if (e.type() === 'warning') warnings.push(e.text());
  });
  const requests: string[] = [];
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith('http://127.0.0.1:43207/'))
      return route.fulfill({ contentType: 'text/html', body: '<html><body style="margin:0"></body></html>' });
    requests.push(url);
    return route.abort();
  });
  await page.goto('http://127.0.0.1:43207/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const spike = <T>(fn: (lib: Spike, arg: never) => Promise<T> | T, arg?: unknown) =>
    page.evaluate(
      ([source, value]) => {
        const lib = (window as unknown as { Spike: Spike }).Spike;
        return new Function('lib', 'arg', `return (${source})(lib, arg);`)(lib, value);
      },
      [fn.toString(), arg] as const,
    ) as Promise<T>;

  const capabilities = await spike((lib) => lib.capabilities());
  console.log('capabilities', JSON.stringify(capabilities));
  if (!software && /swiftshader/i.test(capabilities.renderer))
    throw new Error('GPU run fell back to SwiftShader; rerun with --headed');
  await writeFile(`${output}/capabilities.json`, JSON.stringify({ ...capabilities, power, headed }, null, 2));

  const prepared = await spike((lib) => lib.prepare());
  await writeFile(`${output}/raster.png`, png(prepared.rasterPng));
  console.log('prepared', JSON.stringify({ ...prepared, rasterPng: undefined, diagnostics: undefined }));

  // --diagnose=<samples>[:debugMode[:variant]] only checks what the backend writes for a few samples.
  // --selftest runs the 64×64 fallback self-test first (it pays the first compile).
  const diagnoseOption = option('diagnose');
  const selfTestFirst = process.argv.includes('--selftest');
  if (diagnoseOption || selfTestFirst) {
    const started = Date.now();
    let selfTest: unknown;
    if (selfTestFirst) {
      selfTest = await spike((lib) => lib.selfTest(2));
      await writeFile(
        `${output}/selftest.json`,
        JSON.stringify({ angle, profile, selfTest, errors }, null, 2),
      );
      console.log('selftest', JSON.stringify(selfTest));
    }
    if (diagnoseOption) {
      // <samples>[:debugMode[:variant[:patch]]]
      const [samplesText, debugText = '0', variant = 'room', patch = ''] = diagnoseOption.split(':');
      const samples = Number(samplesText),
        debugMode = Number(debugText);
      if (!['room', 'minimal', 'room-simple', 'room-meters'].includes(variant))
        throw new Error('diagnose variant');
      if (!['', 'no-matte', 'show-material'].includes(patch)) throw new Error('diagnose patch');
      const result = await spike(
        (
          lib,
          arg: [
            number,
            number,
            'room' | 'minimal' | 'room-simple' | 'room-meters',
            '' | 'no-matte' | 'show-material',
          ],
        ) => lib.diagnose(...arg),
        [samples, debugMode, variant, patch],
      );
      const name = `diagnose-${variant}-${debugMode}${patch ? `-${patch}` : ''}`;
      await writeFile(`${output}/${name}.png`, png(result.png));
      const report = {
        angle,
        profile,
        power,
        capabilities,
        selfTest,
        wallSeconds: (Date.now() - started) / 1000,
        ...result,
        png: undefined,
        errors,
      };
      await writeFile(`${output}/${name}.json`, JSON.stringify(report, null, 2));
      console.log(
        'diagnose',
        JSON.stringify({ ...report, capabilities: capabilities.renderer, flags: undefined }),
      );
    }
    process.exitCode = errors.length ? 1 : 0;
  } else {
    const lightings: Record<string, unknown> = {};
    for (const lighting of LIGHTINGS) {
      const result = await spike(
        (lib, arg: ['A' | 'B', number[], number]) => lib.trace(...arg),
        [lighting, CHECKPOINTS, MAX_SECONDS],
      );
      for (const checkpoint of result.checkpoints) {
        const name = String(checkpoint.samples).padStart(3, '0');
        await writeFile(`${output}/${lighting}/spp-${name}.png`, png(checkpoint.png));
        if (checkpoint.denoisedPng)
          await writeFile(`${output}/${lighting}/spp-${name}-denoised.png`, png(checkpoint.denoisedPng));
      }
      await writeFile(`${output}/compare-${lighting}.png`, png(result.comparePng));
      const colour = Object.fromEntries(
        Object.entries(result.colour).map(([region, c]) => [
          region,
          { ...c, deltaE2000: c.traced ? Number(deltaE2000(c.raster, c.traced).toFixed(2)) : null },
        ]),
      );
      const within30 = result.checkpoints.filter((c) => c.seconds <= 30).at(-1);
      const converged = result.convergence.filter((c) => {
        const next = result.checkpoints.find((p) => p.samples === c.k * 2);
        return next && next.seconds <= 30 && c.whole <= 2 && c.backWall <= 2;
      });
      lightings[lighting] = {
        ...result,
        checkpoints: result.checkpoints.map(({ samples, seconds, sinceFirstSample }) => ({
          samples,
          seconds: +seconds.toFixed(2),
          sinceFirstSample: +sinceFirstSample.toFixed(2),
        })),
        comparePng: undefined,
        colour,
        samplesWithin30Seconds: within30?.samples ?? 0,
        convergedWithin30Seconds: converged[0] ?? null,
      };
      console.log(lighting, JSON.stringify(lightings[lighting]));
      await spike((lib) => lib.releaseTracer());
    }

    const silhouette = await spike((lib, samples: number) => lib.silhouette(samples), software ? 4 : 16);
    await writeFile(`${output}/mask-raster.png`, png(silhouette.rasterPng));
    await writeFile(`${output}/mask-traced.png`, png(silhouette.tracedPng));
    console.log('silhouette', JSON.stringify({ ...silhouette, rasterPng: undefined, tracedPng: undefined }));

    // Resource cycles, GC between them (same approach as room-viewer-resource-browser).
    const cdp = await page.context().newCDPSession(page);
    const prototypes: Record<string, string> = {};
    for (const name of ['WebGLRenderer', 'WebGLPathTracer'])
      prototypes[name] = (
        await cdp.send('Runtime.evaluate', {
          expression: `Spike.${name}.prototype`,
          objectGroup: 'spike-prototypes',
        })
      ).result.objectId!;
    const cycles: unknown[] = [];
    for (const mode of ['shared', 'deep', 'fresh'] as const)
      for (let i = 1; i <= CYCLES; i++) {
        // A new renderer per mode, so each mode's texture count starts from its own baseline.
        if (i === 1) await spike((lib) => lib.releaseTracer());
        const result = await spike(
          (lib, arg: ['shared' | 'deep' | 'fresh', number]) => lib.cycle(...arg),
          [mode, CYCLE_SAMPLES],
        );
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
        );
        await cdp.send('HeapProfiler.collectGarbage');
        const heap = await cdp.send('Runtime.getHeapUsage');
        const live: Record<string, number> = {};
        for (const [name, prototypeObjectId] of Object.entries(prototypes)) {
          const response = await cdp.send('Runtime.queryObjects', {
            prototypeObjectId,
            objectGroup: 'spike-cycle',
          });
          const count = await cdp.send('Runtime.callFunctionOn', {
            objectId: response.objects.objectId!,
            functionDeclaration: 'function(){return this.length;}',
            returnByValue: true,
          });
          live[name] = count.result.value as number;
        }
        await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'spike-cycle' });
        await writeFile(`${output}/cycle-${mode}-${i}.png`, png(result.thumbnailPng));
        cycles.push({ ...result, thumbnailPng: undefined, cycle: i, usedHeap: heap.usedSize, live });
        console.log('cycle', JSON.stringify(cycles.at(-1)));
      }
    await spike((lib) => lib.releaseTracer());
    await spike((lib) => lib.close());
    const contextEvents = await spike((lib) => lib.contextEvents());

    const report = {
      environment,
      label,
      maxSeconds: MAX_SECONDS,
      angle: software ? 'swiftshader' : angle,
      profile,
      headed,
      power,
      userAgent: await page.evaluate(() => navigator.userAgent),
      conditions:
        'DEFAULT_ROOM 2400mm, neutral faces, one reconstruction v2 toilet 400×750×680 #efefea lid closed; defaultRoomView; 1024×683',
      capabilities,
      prepared: { ...prepared, rasterPng: undefined },
      lightings,
      silhouette: { ...silhouette, rasterPng: undefined, tracedPng: undefined },
      cycles,
      contextEvents,
      errors,
      warnings,
      blockedRequests: requests,
    };
    await writeFile(`${output}/metrics.json`, JSON.stringify(report, null, 2));
    assert.deepEqual(errors, [], errors.join('\n'));
    assert.deepEqual(requests, [], 'no network requests');
    console.log(`wrote ${output}`);
  }
} finally {
  await browser.close();
}
