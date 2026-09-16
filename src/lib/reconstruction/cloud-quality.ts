import { runQualityPipeline, type QualityRunInput, type QualityDependencies } from './quality-core';
import {
  analyzeExtendedScene, analyzeIdentity, analyzeInstallation, analyzeLayout,
  analyzeFixtureAppearance, analyzeShowerDetails, analyzeShowerInstallations, analyzeDividerMaterials, analyzeReflectionRechecks,
} from './analysis-client';
import { analyzeGeometryInBrowser } from './geometry-browser-client';
import { segmentReconstructionCached } from './segmentation-cache';
import { cloudStageUsage, summarizeCloudUsage, type CloudStageUsage } from './cloud-usage';
import type { LocalModelMeasurement } from './lab-engine';
import type { MogeExecutionMode, MogeBrowserResult } from './moge-browser/client';

/** Same reviewed placement/model pipeline; only observation providers differ. Never contacts a local AI server. */
export async function runCloudBrowserQuality(input: QualityRunInput, options: {
  mode?: MogeExecutionMode;
  onGeometry?: (result: MogeBrowserResult) => void;
} = {}) {
  const provider = 'cloudflare-workers-ai' as const;
  const usage: CloudStageUsage[] = [];
  function record(stage: string, measurement: LocalModelMeasurement) {
    usage.push(cloudStageUsage(stage, measurement));
    input.onCheckpoint?.('cloudUsage', summarizeCloudUsage(structuredClone(usage)));
  }
  async function track<T>(stage: string, work: Promise<T>, collectResult = true): Promise<T> {
    try {
      const value = await work;
      const measured = value as { measurement?: LocalModelMeasurement; measurements?: { candidateId: string; measurement: LocalModelMeasurement }[] };
      if (collectResult && measured.measurement) record(stage, measured.measurement);
      if (collectResult) for (const item of measured.measurements ?? []) record(stage + ':' + item.candidateId, item.measurement);
      return value;
    } catch (error) {
      if (error && typeof error === 'object') {
        const failure = error as { diagnostics?: Record<string, unknown> };
        const diagnostics = failure.diagnostics ?? {};
        const measured = diagnostics.measurement ?? diagnostics;
        record(stage + ':failed', measured as LocalModelMeasurement);
        failure.diagnostics = { ...diagnostics, cloudUsage: summarizeCloudUsage(structuredClone(usage)) };
      }
      throw error;
    }
  }
  const dependencies: QualityDependencies = {
    inventory: (photo, signal) => track('inventory', analyzeExtendedScene(photo, signal, provider)),
    extendedInventory: (photo, signal) => track('extendedInventory', analyzeExtendedScene(photo, signal, provider)),
    identity: (photo, understanding, signal) => track('identity', analyzeIdentity(photo, understanding, signal, provider)),
    installation: (photo, understanding, signal) => track('installation', analyzeInstallation(photo, understanding, signal, provider)),
    layout: (photo, understanding, signal) => track('layout', analyzeLayout(photo, understanding, signal, provider)),
    appearance: (photo, understanding, signal) => track('appearance', analyzeFixtureAppearance(photo, understanding, signal, provider)),
    showerDetails: (photo, understanding, signal) => track('showerDetails', analyzeShowerDetails(photo, understanding, signal, provider)),
    showerInstallation: (photo, context, signal, revision) => track('showerInstallation', analyzeShowerInstallations(photo, context, signal, revision,
      (id, measurement) => record('showerInstallation:' + id, measurement)), false),
    dividerMaterials: (photo, understanding, targets, signal) => track('dividerMaterials', analyzeDividerMaterials(photo, understanding, targets, signal, provider)),
    reflectionRecheck: (photo, context, signal, revision) => track('reflectionRecheck', analyzeReflectionRechecks(photo, context, signal, revision, provider,
      (id, measurement) => record('reflectionRecheck:' + id, measurement)), false),
    segmentation: (photo, onStage, options) => segmentReconstructionCached(photo, onStage, options!.signal!),
    geometry: (photo, segmentation, understanding, signal) => analyzeGeometryInBrowser(photo, segmentation, understanding, signal, {
      mode: options.mode, onResult: options.onGeometry,
      onProgress: progress => input.onStage?.(progress.total && progress.loaded !== undefined
        ? `${progress.message} ${Math.round(progress.loaded / progress.total * 100)}%`
        : progress.message),
    }),
  };
  const result = await runQualityPipeline({ ...input, profile: 'cloud-browser-v1', estimatedLayout: true,
    refineAppearance: true, refineShowerDetails: true, refineShowerInstallation: true, refineDividerMaterials: true, refineReflection: true,
  }, dependencies);
  result.evidence.cloudUsage = summarizeCloudUsage(usage);
  return result;
}
