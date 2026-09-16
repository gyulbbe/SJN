import type { LocalSceneAnalysis, LocalInstallationAnalysis } from './analysis-client';
import type { LocalIdentityAnalysis } from './identity-observation';
import type { LocalGeometryAnalysis } from './geometry-contract';
import type { SceneUnderstanding } from './pipeline-contract';

export type ReconstructionAnalysisProfile = 'browser-basic' | 'local-quality-v1' | 'cloud-browser-v1';
export type AnalysisProfile = ReconstructionAnalysisProfile;
export const CLOUD_BROWSER_QUALITY_REVISION = 'cloud-browser-v2-gemma-moge-classification-1';
export const LOCAL_QUALITY_REVISION = 'local-quality-v1-identity-geometry-4';
export type ReconstructionQualityEvidence = {
  version: 1;
  revision: string;
  photoFingerprint: string;
  image: { width: number; height: number };
  /** Unmodified first-stage inventory, never the installed/positioned candidates. */
  inventory: LocalSceneAnalysis;
  /** Missing only in historical evidence; never silently reused by the current engine. */
  identity?: LocalIdentityAnalysis;
  installation: LocalInstallationAnalysis;
  geometry: LocalGeometryAnalysis;
  effectiveUnderstanding: SceneUnderstanding;
  layout?: import('./layout-observation').LocalLayoutAnalysis;
  appearance?: import('./fixture-appearance-observation').LocalFixtureAppearanceAnalysis;
  showerDetails?: import('./analysis-client').LocalShowerAnalysis;
  showerInstallation?: import('./shower-installation-observation').ShowerInstallationRecord;
  dividerMaterials?: import('./analysis-client').LocalDividerAnalysis;
  dividerApplication?: import('./divider-application').DividerApplication;
  reflectionRecheck?: import('./reflection-recheck').ReflectionRecheckEvidence;
  classificationResolution?: import('./classification-resolution').ClassificationResolution;
  placementPolicy?: 'strict' | 'visible-relation-estimate';
  timing: {
    inventoryMs: number;
    identityMs?: number;
    installationMs: number;
    geometryMs: number;
    layoutMs?: number;
    appearanceMs?: number;
    showerDetailsMs?: number;
    showerInstallationMs?: number;
    dividerMaterialsMs?: number;
    reflectionRecheckMs?: number;
    placementMs: number;
    totalMs: number;
  };
  cloudUsage?: ReturnType<typeof import('./cloud-usage').summarizeCloudUsage>;
  reused: boolean;
};
export type ReconstructionAnalysisSummary = {
  profile: ReconstructionAnalysisProfile;
  revision: string;
  runId?: string;
  modelId?: string;
  modelRevision?: string;
  geometryModelId?: string;
  geometryModelRevision?: string;
  cameraStatus?: 'estimated' | 'held';
  placementPolicy?: 'strict' | 'visible-relation-estimate';
  layoutRevision?: string;
  estimated: true;
};
