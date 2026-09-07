import { remapMaterialUsage } from './material-usage';
import type { QuoteDocument } from './quote-types';
import type { DesignDocument, ProjectDocument, ProjectFrame, ProjectInput, Scene } from './types';
import { duplicateQuote } from './quote';
import {
  MAX_DESIGNS,
  blankSceneFrom,
  normalizeProjectDocument,
  projectScenes,
  projectComparisons,
  projectWorkspaces,
} from './comparison';
export {
  MAX_DESIGNS,
  MAX_COMPARISON_DESIGNS,
  HISTORY_LIMIT,
  DESIGN_LIMIT_MESSAGE,
  COMPARISON_LIMIT_MESSAGE,
  getActiveDesign,
  getActiveScene,
  getActiveQuote,
  getComparison,
} from './comparison';

export function nextDesignName(designs: Pick<DesignDocument, 'name'>[]): string {
  const names = new Set(designs.map((design) => design.name));
  for (const suffix of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.slice(0, MAX_DESIGNS))
    if (!names.has('시안 ' + suffix)) return '시안 ' + suffix;
  return '새 시안';
}
export function validDesignName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 100) throw new Error('시안 이름은 1~100자로 입력해 주세요.');
  return trimmed;
}
export function createBlankDesign(project: ProjectDocument, name?: string): DesignDocument {
  const timestamp = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: validDesignName(name ?? nextDesignName(project.designs)),
    scene: blankSceneFrom(project.shared.baseline),
    revision: 0,
    renderRevision: 0,
    history: { past: [], future: [] },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
function idMapper() {
  const ids = new Map<string, string>();
  return (id: string) => {
    if (!ids.has(id)) ids.set(id, crypto.randomUUID());
    return ids.get(id)!;
  };
}
function remapScene(scene: Scene, id: (value: string) => string, seen = new WeakSet<object>()): void {
  scene.surfaces.forEach((surface) => {
    if (seen.has(surface)) return;
    seen.add(surface);
    surface.id = id(surface.id);
  });
  scene.fixtures.forEach((fixture) => {
    if (seen.has(fixture)) return;
    seen.add(fixture);
    fixture.id = id(fixture.id);
  });
}
/** Remap provenance without marking a previously stale quote as synchronized. */
export function remapQuoteSignature(signature: string, id: (value: string) => string): string {
  try {
    const parsed = JSON.parse(signature) as { surfaces: string[][]; fixtures: string[][] };
    if (!Array.isArray(parsed.surfaces) || !Array.isArray(parsed.fixtures)) return signature;
    const remap = (rows: string[][]) =>
      rows
        .map((row) => {
          if (!Array.isArray(row) || row.length !== 2 || row.some((value) => typeof value !== 'string'))
            throw new Error('signature');
          return [id(row[0]), row[1]];
        })
        .sort((a, b) => {
          const x = JSON.stringify(a),
            y = JSON.stringify(b);
          return x < y ? -1 : x > y ? 1 : 0;
        });
    return JSON.stringify({ surfaces: remap(parsed.surfaces), fixtures: remap(parsed.fixtures) });
  } catch {
    return signature;
  }
}
function remapQuote(
  quote: QuoteDocument,
  id: (value: string) => string,
  metadata?: Pick<QuoteDocument, 'id' | 'number' | 'createdAt' | 'updatedAt'>,
): QuoteDocument {
  const copy = metadata ? { ...structuredClone(quote), ...metadata } : duplicateQuote(quote);
  copy.lines = copy.lines.map((line) => ({
    ...line,
    id: id(line.id),
    ...(line.sourceSurfaceIds ? { sourceSurfaceIds: line.sourceSurfaceIds.map(id) } : {}),
  }));
  copy.sourceSignature = remapQuoteSignature(quote.sourceSignature, id);
  return copy;
}
/** Start a new independent timeline from the latest supplied committed state. Assets remain references. */
export function copyDesignDocument(source: DesignDocument, name?: string): DesignDocument {
  const timestamp = new Date().toISOString(),
    id = idMapper();
  const scene = structuredClone(source.scene);
  remapScene(scene, id);
  const quote = source.quote ? remapQuote(source.quote, id) : undefined;
  const materialUsage = source.materialUsage ? remapMaterialUsage(source.materialUsage, id, id) : undefined;
  if (quote && materialUsage && materialUsage.migratedQuoteId === source.quote?.id) materialUsage.migratedQuoteId = quote.id;
  return {
    id: crypto.randomUUID(),
    sourceDesignId: source.id,
    name: validDesignName(name ?? (source.name + ' 복사본').slice(0, 100)),
    scene,
    ...(quote ? { quote } : {}),
    ...(materialUsage ? { materialUsage } : {}),
    revision: 0,
    renderRevision: 0,
    history: { past: [], future: [] },
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(source.thumbnailAssetId ? { thumbnailAssetId: source.thumbnailAssetId } : {}),
  };
}
/** Used by repository-level project duplication, including hidden room-change backups. */
export function duplicateProjectDocument(input: ProjectInput): ProjectDocument {
  const project = structuredClone(normalizeProjectDocument(input));
  const id = idMapper(),
    designId = idMapper(),
    quoteMetadata = new Map<string, Pick<QuoteDocument, 'id' | 'number' | 'createdAt' | 'updatedAt'>>();
  const scenes = new Set(projectScenes(project));
  const seenEntities = new WeakSet<object>();
  scenes.forEach((scene) => remapScene(scene, id, seenEntities));
  for (const comparison of new Set(projectComparisons(project)))
    comparison.review?.candidates.forEach((candidate) => {
      if (candidate.fixtureId) candidate.fixtureId = id(candidate.fixtureId);
    });
  for (const workspace of projectWorkspaces(project)) {
    workspace.activeDesignId = workspace.activeDesignId ? designId(workspace.activeDesignId) : null;
    workspace.comparisonDesignIds = workspace.comparisonDesignIds.map(designId);
    workspace.designs.forEach((design) => {
      design.id = designId(design.id);
      if (design.sourceDesignId) design.sourceDesignId = designId(design.sourceDesignId);
      for (const frame of [design, ...design.history.past, ...design.history.future]) {
        if (frame.materialUsage) frame.materialUsage = remapMaterialUsage(frame.materialUsage, id, id);
        if (!frame.quote) continue;
        const oldId = frame.quote.id;
        let metadata = quoteMetadata.get(oldId);
        if (!metadata) {
          const fresh = duplicateQuote(frame.quote);
          metadata = {
            id: fresh.id,
            number: fresh.number,
            createdAt: fresh.createdAt,
            updatedAt: fresh.updatedAt,
          };
          quoteMetadata.set(oldId, metadata);
        }
        frame.quote = remapQuote(frame.quote, id, metadata);
        if (frame.materialUsage?.migratedQuoteId === oldId)
          frame.materialUsage.migratedQuoteId = frame.quote.id;
      }
    });
  }
  const timestamp = new Date().toISOString();
  project.id = crypto.randomUUID();
  project.name = (input.name + ' 복사본').slice(0, 200);
  project.editRevision = 0;
  project.storageRevision = 0;
  project.createdAt = timestamp;
  project.updatedAt = timestamp;
  return project;
}
/** Restore one explicitly chosen legacy frame into a separate project, leaving this workspace untouched. */
export function createProjectFromLegacyFrame(project: ProjectDocument, frame: ProjectFrame): ProjectDocument {
  const timestamp = new Date().toISOString();
  const { comparison, ...scene } = structuredClone(frame);
  return normalizeProjectDocument({
    id: crypto.randomUUID(),
    ownerId: project.ownerId,
    name: (project.name + ' · 이전 기록').slice(0, 200),
    schemaVersion: 2,
    editRevision: 0,
    storageRevision: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    scene,
    ...(comparison ? { comparison } : {}),
    history: { past: [], future: [] },
    viewport: { zoom: 1, pan: { x: 0, y: 0 } },
  });
}
