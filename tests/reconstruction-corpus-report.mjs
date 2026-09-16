// Offline-only report generation. This script performs no inference or network requests.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { collectCorpusReport, writeCorpusReport } from './helpers/reconstruction-corpus-report.mjs';

const root = process.cwd();
const directory = path.resolve(process.argv[2] ?? 'test-results/reconstruction-corpus-final');
const relative = path.relative(path.resolve('test-results'), directory);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
  throw new Error('Result directory must be inside ignored test-results.');
const manifestPath = path.resolve('tests/fixtures/reconstruction-corpus-v1.json');
const manifestBytes = await fs.readFile(manifestPath);
const manifestHash = crypto.createHash('sha256').update(manifestBytes).digest('hex');
const expected = (await fs.readFile(manifestPath.replace('.json', '.sha256'), 'utf8')).trim().split(/\s+/)[0];
if (manifestHash !== expected) throw new Error('Frozen manifest has changed.');
const snapshot = await collectCorpusReport(
  JSON.parse(manifestBytes.toString('utf8')),
  manifestHash,
  directory,
  root,
);
const result = await writeCorpusReport(snapshot, manifestBytes, directory);
console.log(JSON.stringify(result, null, 2));
if (!snapshot.aggregationAllowed) process.exitCode = 1;
