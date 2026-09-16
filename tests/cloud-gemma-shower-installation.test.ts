import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLOUD_GEMMA_CONTRACT_REVISION,
  CLOUD_GEMMA_IDENTITY,
  CLOUD_GEMMA_MODEL,
  CLOUD_GEMMA_OPERATIONS,
  CLOUD_GEMMA_REVISION,
  type CloudGemmaBinding,
} from '../src/lib/reconstruction/cloud-gemma-contract';
import { cloudOperationCacheIdentity } from '../src/lib/reconstruction/cloud-gemma-cache-contract';
import { runCloudGemmaModel } from '../src/lib/reconstruction/cloud-gemma-server';
import {
  SHOWER_INSTALLATION_CONTRACT,
  SHOWER_INSTALLATION_DECISION_REVISION,
  SHOWER_INSTALLATION_INPUT_REVISION,
  SHOWER_INSTALLATION_PROMPT_REVISION,
  createShowerInstallationReceipt,
  showerInstallationJsonSchema,
  showerInstallationPrompt,
} from '../src/lib/reconstruction/shower-installation-observation';
import {
  targetExistenceCropTransform,
  targetExistenceSha256,
} from '../src/lib/reconstruction/target-existence-observation';
import type { SceneCandidate } from '../src/lib/reconstruction/pipeline-contract';

vi.mock('../src/lib/auth/d1', () => ({ getD1Actor: vi.fn() }));
const origin = 'http://127.0.0.1:3000';
const candidate: SceneCandidate = {
  id: 'generic-fixture',
  kind: 'shower',
  bounds: { left: 0.16, top: 0.23, right: 0.63, bottom: 0.81 },
  mounting: 'unknown',
  wall: 'unknown',
  basinStyle: 'unknown',
  shape: 'unknown',
  reflection: 'physical',
  evidence: ['PRIOR_CATEGORY_NOTE_NEVER_SENT_TO_MODEL'],
  uncertainty: [],
};
const observed = {
  schemaVersion: 1,
  note: 'A mounted head body is visible with an attached hose; the outlet face is turned away.',
  visibleHardware: {
    recognizableSprayHeadBody: 'present',
    sprayOutletFace: 'uncertain',
    headMountOrSupport: 'present',
    finishedUserControl: 'uncertain',
    flexibleWaterHose: 'present',
    unfinishedPipeEnd: 'absent',
    looseServiceLoop: 'absent',
  },
  view: 'direct',
  scope: 'connected-assembly',
  installationState: 'installed-shower-hardware',
};
const raw = ' \n' + JSON.stringify(observed) + '\n ';
function jpeg(width: number, height: number) {
  // Header-only authored fixture: server contract tests do not perform image decoding or AI.
  const bytes = new Uint8Array(23);
  bytes.set([255, 216, 255, 192, 0, 17, 8]);
  const view = new DataView(bytes.buffer);
  view.setUint16(7, height);
  view.setUint16(9, width);
  return bytes;
}
async function fixture(responseText = raw) {
  const full = jpeg(400, 300);
  const transform = targetExistenceCropTransform({ width: 400, height: 300 }, candidate.bounds);
  const crop = jpeg(transform.width, transform.height);
  const receipt = await createShowerInstallationReceipt({
    photoBytes: full,
    normalizedFullBytes: full,
    cropBytes: crop,
    expectedPhotoFingerprint: await targetExistenceSha256(full),
    candidate,
    cropTransform: transform,
    sourceDecisionSignature: 'prior-decisions-remain-receipt-only',
    modelId: CLOUD_GEMMA_MODEL,
    modelRevision: CLOUD_GEMMA_REVISION,
  });
  const run = vi.fn<CloudGemmaBinding['run']>(async () =>
    Response.json({
      model: CLOUD_GEMMA_MODEL,
      choices: [{ finish_reason: 'stop', message: { content: responseText } }],
      usage: { prompt_tokens: 240, completion_tokens: 80, total_tokens: 320 },
    }),
  );
  const env = { platform: 'cloudflare' as const, APP_ENV: 'local', STORAGE_MODE: 'auto', AI: { run } };
  const request = (mutate?: (form: FormData) => void) => {
    const form = new FormData();
    form.set('operation', 'shower-installation');
    form.set('photo', new Blob([full], { type: 'image/jpeg' }), 'full.jpg');
    form.set('crop', new Blob([crop], { type: 'image/jpeg' }), 'crop.jpg');
    form.set('receipt', JSON.stringify(receipt));
    mutate?.(form);
    return new Request(origin + '/api/reconstruction/cloud', {
      method: 'POST',
      headers: { Origin: origin },
      body: form,
    });
  };
  return { full, crop, receipt, run, env, request };
}
afterEach(() => vi.restoreAllMocks());

describe('Cloud shower-installation operation boundary (mocked binding; no AI)', () => {
  it('preserves the experimentally checked prompt/schema and full/crop order without exposing prior notes', async () => {
    const { full, crop, receipt, run, env, request } = await fixture();
    const result = await runCloudGemmaModel(request(), env);
    expect(run).toHaveBeenCalledTimes(1);
    const [model, payload, options] = run.mock.calls[0];
    expect(model).toBe(CLOUD_GEMMA_MODEL);
    expect(options).toMatchObject({
      gateway: { id: 'sjn-gateway', retries: { maxAttempts: 1 } },
      returnRawResponse: true,
    });
    expect(payload.messages[0].content).toEqual([
      { type: 'text', text: showerInstallationPrompt() },
      {
        type: 'image_url',
        image_url: { url: 'data:image/jpeg;base64,' + Buffer.from(full).toString('base64') },
      },
      {
        type: 'image_url',
        image_url: { url: 'data:image/jpeg;base64,' + Buffer.from(crop).toString('base64') },
      },
    ]);
    expect(JSON.stringify(payload)).not.toContain(candidate.id);
    expect(JSON.stringify(payload)).not.toContain(candidate.evidence[0]);
    expect(JSON.stringify(payload)).not.toContain(receipt.sourceDecisionSignature);
    expect(payload.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: SHOWER_INSTALLATION_CONTRACT.replaceAll('-', '_'),
        strict: true,
        schema: showerInstallationJsonSchema(),
      },
    });
    expect(receipt.promptSha256).toBe('ca7baf24d6f6bbba5b8743e900fcde97f15d21a8949f9b5e19aa7e3e12d73b82');
    expect(receipt.schemaSha256).toBe('6695a8db9f583c1b809e80acac942c50f4066b0e9eda210833c9bf9007c1a5c1');
    expect(result).toMatchObject({
      outputContract: SHOWER_INSTALLATION_CONTRACT,
      promptRevision: SHOWER_INSTALLATION_PROMPT_REVISION,
      modelIdentity: CLOUD_GEMMA_IDENTITY,
      receipt,
      rawText: raw,
      rawTextSha256: await targetExistenceSha256(raw),
      observation: observed,
      providerPromptSha256: receipt.promptSha256,
      providerSchemaSha256: receipt.schemaSha256,
      measurement: { inferenceCalls: 1, inputWidth: 400, inputHeight: 300 },
    });
    expect(result).toHaveProperty('rawText', raw);
  });

  it.each(['photo', 'crop'] as const)(
    'rejects substituted %s bytes before the binding is called',
    async (field) => {
      const f = await fixture();
      const changed = new Uint8Array(field === 'photo' ? f.full : f.crop);
      changed[22] = 1;
      await expect(
        runCloudGemmaModel(
          f.request((form) => form.set(field, new Blob([changed], { type: 'image/jpeg' }), 'changed.jpg')),
          f.env,
        ),
      ).rejects.toMatchObject({ code: 'invalid_input', status: 400 });
      expect(f.run).not.toHaveBeenCalled();
    },
  );

  it.each(['photo', 'crop', 'receipt'])('rejects a missing %s without inference', async (field) => {
    const f = await fixture();
    await expect(
      runCloudGemmaModel(
        f.request((form) => form.delete(field)),
        f.env,
      ),
    ).rejects.toMatchObject({ code: 'invalid_input', status: 400 });
    expect(f.run).not.toHaveBeenCalled();
  });

  it.each(['inventory', 'appearanceReceipt', 'targets'])(
    'rejects unrelated %s and never forwards a previous category',
    async (field) => {
      const f = await fixture();
      await expect(
        runCloudGemmaModel(
          f.request((form) => form.set(field, '{}')),
          f.env,
        ),
      ).rejects.toMatchObject({ code: 'invalid_input', status: 400 });
      expect(f.run).not.toHaveBeenCalled();
    },
  );

  it.each(['promptSha256', 'schemaSha256', 'inputSha256', 'sourceDecisionSignature', 'modelId'])(
    'rejects a changed receipt %s before inference',
    async (field) => {
      const f = await fixture();
      await expect(
        runCloudGemmaModel(
          f.request((form) =>
            form.set(
              'receipt',
              JSON.stringify({
                ...f.receipt,
                [field]: field.endsWith('Sha256') ? 'f'.repeat(64) : 'changed-value',
              }),
            ),
          ),
          f.env,
        ),
      ).rejects.toMatchObject({ code: 'invalid_input', status: 400 });
      expect(f.run).not.toHaveBeenCalled();
    },
  );

  it('does not accept the new receipt through the target-existence operation', async () => {
    const f = await fixture();
    await expect(
      runCloudGemmaModel(
        f.request((form) => form.set('operation', 'target-existence')),
        f.env,
      ),
    ).rejects.toMatchObject({ code: 'invalid_input', status: 400 });
    expect(f.run).not.toHaveBeenCalled();
  });

  it('rejects an installed-hardware result whose own head evidence is absent, while preserving diagnostics', async () => {
    const inconsistent = JSON.stringify({
      ...observed,
      visibleHardware: { ...observed.visibleHardware, recognizableSprayHeadBody: 'absent' },
    });
    const f = await fixture(inconsistent);
    await expect(runCloudGemmaModel(f.request(), f.env)).rejects.toMatchObject({
      code: 'invalid_response',
      status: 502,
      diagnostics: { rawText: inconsistent, inferenceCalls: 1 },
    });
    expect(f.run).toHaveBeenCalledTimes(1);
  });

  it('keeps the provider revision and old stages stable while giving only the new stage its decision/input revisions', () => {
    expect(CLOUD_GEMMA_CONTRACT_REVISION).toBe('sjn-gemma-v7');
    expect(CLOUD_GEMMA_OPERATIONS).toContain('shower-installation');
    const newIdentity = JSON.parse(cloudOperationCacheIdentity('shower-installation'));
    expect(newIdentity).toMatchObject({
      providerContract: 'sjn-gemma-v7',
      outputContract: SHOWER_INSTALLATION_CONTRACT,
      promptRevision: SHOWER_INSTALLATION_PROMPT_REVISION,
      inputRevision: SHOWER_INSTALLATION_INPUT_REVISION,
      decisionRevision: SHOWER_INSTALLATION_DECISION_REVISION,
    });
    for (const operation of CLOUD_GEMMA_OPERATIONS.filter((value) => value !== 'shower-installation')) {
      const existing = JSON.parse(cloudOperationCacheIdentity(operation));
      expect(existing.providerContract).toBe('sjn-gemma-v7');
      expect(existing).not.toHaveProperty('decisionRevision');
      expect(existing.inputRevision).toBe(
        operation === 'target-existence' ? 'normalized-source-full-crop-v1' : 'normalized-photo-max1600-v1',
      );
    }
    expect(new Set(CLOUD_GEMMA_OPERATIONS.map(cloudOperationCacheIdentity)).size).toBe(
      CLOUD_GEMMA_OPERATIONS.length,
    );
  });
});
