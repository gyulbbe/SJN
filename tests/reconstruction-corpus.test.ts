import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';

const manifestPath = path.resolve('tests/fixtures/reconstruction-corpus-v1.json');
const bytes = fs.readFileSync(manifestPath);
const manifest = JSON.parse(bytes.toString('utf8')) as {
  schemaVersion: number;
  annotationBasis: string;
  cases: Array<{
    id: string;
    split: string;
    groupId: string;
    source: { page: string; pageId: number; license: string; author: string; downloadUrl: string };
    input: { path: string; sha256: string; width: number; height: number };
    roomMm: { width: number; depth: number; height: number; basis: string };
    annotation: {
      fixtures: Array<{
        id: string;
        kind: string;
        mounting: string;
        installationWall: string;
        shape: string;
        bounds: number[];
        basinVariant?: string;
        toiletLid?: string;
      }>;
      reflections: Array<{ bounds: number[]; reflectorId: string }>;
      relations: Array<{ from: string; to: string; relation: string }>;
      ignore: Array<{ bounds: number[] }>;
    };
  }>;
};

const validBounds = (bounds: number[]) =>
  bounds.length === 4 &&
  bounds.every((v) => Number.isFinite(v) && v >= 0 && v <= 1) &&
  bounds[0] < bounds[2] &&
  bounds[1] < bounds[3];

describe('frozen licensed reconstruction corpus', () => {
  it('keeps the source-only annotation seal intact', () => {
    const expected = fs.readFileSync(manifestPath.replace('.json', '.sha256'), 'utf8').split(/\s+/)[0];
    expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(expected);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.annotationBasis).toContain('Not human-adjudicated');
  });

  it('has 36 unique real-photo inputs split by source scene, not candidate results', () => {
    expect(manifest.cases).toHaveLength(36);
    expect(new Set(manifest.cases.map((entry) => entry.id)).size).toBe(36);
    expect(new Set(manifest.cases.map((entry) => entry.source.pageId)).size).toBe(36);
    expect(new Set(manifest.cases.map((entry) => entry.input.sha256)).size).toBe(36);
    expect(manifest.cases.filter((entry) => entry.split === 'development')).toHaveLength(24);
    expect(manifest.cases.filter((entry) => entry.split === 'heldout')).toHaveLength(12);
    const groupSplits = new Map<string, string>();
    for (const entry of manifest.cases) {
      const prior = groupSplits.get(entry.groupId);
      if (prior) expect(entry.split).toBe(prior);
      groupSplits.set(entry.groupId, entry.split);
    }
  });

  it('preserves public reuse provenance and fixed equal, non-measured inputs', () => {
    for (const entry of manifest.cases) {
      expect(entry.source.license).toMatch(/^(CC BY(?:-SA)? [0-9.]+|CC0|Public domain)$/);
      expect(entry.source.author.length).toBeGreaterThan(0);
      expect(new URL(entry.source.page).hostname).toBe('commons.wikimedia.org');
      expect(['upload.wikimedia.org', 'thumb.wikimedia.org']).toContain(
        new URL(entry.source.downloadUrl).hostname,
      );
      expect(entry.input.path).toBe(`test-results/reconstruction-corpus/inputs/${entry.id}.jpg`);
      expect(entry.input.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(Math.max(entry.input.width, entry.input.height)).toBeLessThanOrEqual(1000);
      expect(entry.roomMm).toMatchObject({ width: 2400, depth: 2400, height: 2400 });
      expect(entry.roomMm.basis).toContain('not measured');
    }
  });

  it('has valid approximate bounds and referentially valid physical/reflection observations', () => {
    for (const entry of manifest.cases) {
      const ids = new Set(entry.annotation.fixtures.map((fixture) => fixture.id));
      expect(ids.size).toBe(entry.annotation.fixtures.length);
      for (const fixture of entry.annotation.fixtures) {
        expect(validBounds(fixture.bounds)).toBe(true);
        expect(['wall', 'floor', 'unknown']).toContain(fixture.mounting);
        expect(['left', 'back', 'right', 'unknown']).toContain(fixture.installationWall);
      }
      for (const reflection of entry.annotation.reflections) {
        expect(validBounds(reflection.bounds)).toBe(true);
        expect(ids.has(reflection.reflectorId)).toBe(true);
      }
      for (const relation of entry.annotation.relations) {
        expect(ids.has(relation.from)).toBe(true);
        expect(ids.has(relation.to)).toBe(true);
        expect(relation.from).not.toBe(relation.to);
      }
      for (const ignored of entry.annotation.ignore) expect(validBounds(ignored.bounds)).toBe(true);
    }
  });

  it('includes hard cases and leaves unobservable mounting/shape unknown', () => {
    const fixtures = manifest.cases.flatMap((entry) => entry.annotation.fixtures);
    expect(fixtures).toHaveLength(114);
    for (const kind of [
      'basin',
      'toilet',
      'bath',
      'mirror',
      'mirrorCabinet',
      'glassPartition',
      'shelf',
      'door',
      'window',
    ]) {
      expect(fixtures.some((fixture) => fixture.kind === kind)).toBe(true);
    }
    for (const basinVariant of ['wall', 'pedestal', 'vanity', 'unknown']) {
      expect(
        fixtures.some((fixture) => fixture.kind === 'basin' && fixture.basinVariant === basinVariant),
      ).toBe(true);
    }
    for (const toiletLid of ['open', 'closed', 'unknown']) {
      expect(fixtures.some((fixture) => fixture.kind === 'toilet' && fixture.toiletLid === toiletLid)).toBe(
        true,
      );
    }
    expect(fixtures.some((fixture) => fixture.mounting === 'unknown')).toBe(true);
    expect(fixtures.some((fixture) => fixture.shape === 'unknown')).toBe(true);
    expect(manifest.cases.some((entry) => entry.annotation.reflections.length > 0)).toBe(true);
  });
});
