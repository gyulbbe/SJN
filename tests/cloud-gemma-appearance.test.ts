import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CLOUD_GEMMA_APPEARANCE_METADATA,
  CLOUD_GEMMA_APPEARANCE_SCOPE,
  cloudGemmaFixtureAppearancePrompt,
  cloudGemmaFixtureAppearanceJsonSchemaFor,
  requireCloudGemmaAppearanceContract,
} from '../src/lib/reconstruction/cloud-gemma-appearance';
import { CLOUD_FIXTURE_CROP_PROMPT } from '../src/lib/reconstruction/cloud-fixture-crops';
import { cloudOperationCacheIdentity } from '../src/lib/reconstruction/cloud-gemma-cache-contract';
import { CLOUD_GEMMA_OPERATIONS } from '../src/lib/reconstruction/cloud-gemma-contract';
import {
  fixtureAppearanceKinds,
  fixtureAppearancePrompt,
  parseFixtureAppearance,
} from '../src/lib/reconstruction/fixture-appearance-observation';
import { parseFixtureInventory } from '../src/lib/reconstruction/inventory-observation';

const source = () =>
  parseFixtureInventory(
    JSON.stringify({
      items: [
        {
          kind: 'window',
          bbox_2d: [200, 100, 600, 400],
          view: 'direct',
          basin: null,
          note: 'Private earlier detector explanation must not bias this prompt.',
        },
      ],
    }),
  ).understanding;

describe('Cloudflare appearance scope contract (synthetic observations, no inference)', () => {
  it('pins the exact common probe addition after the output envelope and crop instruction', () => {
    const prompt = cloudGemmaFixtureAppearancePrompt(source());
    expect(createHash('sha256').update(CLOUD_GEMMA_APPEARANCE_SCOPE).digest('hex')).toBe(
      '4c1f9d528c88771aaf68fa3d169cc055aa2aa344206ef4b9705c29f69c667867',
    );
    expect(prompt.endsWith(CLOUD_FIXTURE_CROP_PROMPT + '\n' + CLOUD_GEMMA_APPEARANCE_SCOPE)).toBe(true);
    expect(prompt.split(CLOUD_FIXTURE_CROP_PROMPT)).toHaveLength(2);
    expect(prompt.split(CLOUD_GEMMA_APPEARANCE_SCOPE)).toHaveLength(2);
    expect(prompt).not.toContain('Private earlier detector explanation');
    expect(fixtureAppearancePrompt(source())).not.toContain(CLOUD_GEMMA_APPEARANCE_SCOPE);
    for (const kind of fixtureAppearanceKinds) expect(CLOUD_GEMMA_APPEARANCE_SCOPE).toContain(kind + ' =');
    const changed = source();
    changed.candidates[0].kind = 'toilet';
    changed.candidates[0].evidence = ['A different prior category is not ground truth.'];
    expect(cloudGemmaFixtureAppearancePrompt(changed)).toBe(prompt);
  });

  it.each([
    [undefined, undefined],
    ['gemma-fixed-candidate-appearance-v1', undefined],
    ['old', 2],
    ['gemma-fixed-candidate-appearance-v1', 1],
    ['gemma-fixed-candidate-appearance-v1', '2'],
  ])('rejects absent or stale operation metadata (%s, %s)', (contract, revision) => {
    expect(() =>
      requireCloudGemmaAppearanceContract({
        providerAppearanceContract: contract,
        providerAppearancePromptRevision: revision,
      }),
    ).toThrow();
  });

  it('accepts only current explicit metadata and changes only the appearance cache namespace', () => {
    expect(() => requireCloudGemmaAppearanceContract(CLOUD_GEMMA_APPEARANCE_METADATA)).not.toThrow();
    expect(() =>
      requireCloudGemmaAppearanceContract(Object.create(CLOUD_GEMMA_APPEARANCE_METADATA)),
    ).toThrow();
    for (const operation of CLOUD_GEMMA_OPERATIONS) {
      const identity = cloudOperationCacheIdentity(operation);
      const data = JSON.parse(identity);
      expect(data.providerContract).toBe('sjn-gemma-v7');
      if (operation === 'appearance') {
        expect(data).toMatchObject(CLOUD_GEMMA_APPEARANCE_METADATA);
        delete data.providerAppearanceContract;
        delete data.providerAppearancePromptRevision;
        expect(JSON.stringify(data)).not.toBe(identity);
      } else {
        expect(data).not.toHaveProperty('providerAppearanceContract');
        expect(data).not.toHaveProperty('providerAppearancePromptRevision');
      }
    }
  });

  it.each([
    ['wall_shelf', 'physical', 'wallShelf', 'physical'],
    ['window', 'physical', 'window', 'physical'],
    ['unknown', 'not-fixture', 'unknown', 'physical'],
  ] as const)(
    'parses supported scope %s without substituting the prior window kind',
    (kind, context, expectedKind, reflection) => {
      const inventory = source();
      expect(
        cloudGemmaFixtureAppearanceJsonSchemaFor(inventory).properties.observations.items.properties.kind
          .enum,
      ).toContain(kind);
      const rawText = JSON.stringify({
        schemaVersion: 1,
        observations: [
          {
            id: 'item_01',
            kind,
            context,
            note: 'Synthetic visible observation used to test the unchanged parser.',
            sameObjectAs: null,
            shape: 'unknown',
            counterSupport: 'unknown',
            pedestalShape: 'unknown',
          },
        ],
      });
      const parsed = parseFixtureAppearance(rawText, inventory);
      expect(parsed.observations[0]).toMatchObject({ kind, context });
      expect(parsed.understanding.candidates[0]).toMatchObject({ kind: expectedKind, reflection });
      expect(inventory.candidates[0].kind).toBe('window');
    },
  );
});
