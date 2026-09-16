import { normalizeProjectDocument, projectScenes, projectWriteError } from '../comparison';
import { duplicateProjectDocument } from '../designs';
import { projectReferences } from '../repositories/references';
import { createProjectSummary, readCurrentProjectSummary } from '../repositories/project-summary';
import { identifierSchema, projectSchema, storedProjectSchema } from '../supabase/validation';
import type { ProjectDocument, ProjectInput, ProjectSummary } from '../types';
import { z } from 'zod';
import {
  assetAssertion,
  assertion,
  batch,
  committedObject,
  mutationStatement,
  queueObject,
  readDocument,
  referenceJson,
  sql,
  stageObject,
  stamp,
  versionAssertion,
  validateReferences,
  type Context,
} from './database';
import { boundedDocument, conflict, invalid, notFound } from './http';

interface ProjectRow {
  id: string;
  owner_id: string;
  object_key: string;
  storage_revision: number;
  created_at: string;
  updated_at: string;
  summary_json: string;
}
async function rowFor(ctx: Context, id: string): Promise<ProjectRow> {
  const row = await sql(
    ctx,
    'SELECT * FROM d1_projects WHERE id=? AND owner_id=?',
    id,
    ctx.actor.id,
  ).first<ProjectRow>();
  if (!row) throw notFound();
  return row;
}
async function writeProject(
  ctx: Context,
  input: ProjectInput,
  expected: number | null,
): Promise<ProjectDocument> {
  const document = normalizeProjectDocument(input);
  const previous = expected === null ? null : await rowFor(ctx, document.id);
  if (previous && previous.storage_revision !== expected) throw conflict();
  const previousDoc = previous ? await readDocument<ProjectDocument>(ctx, previous.object_key) : undefined;
  const error = projectWriteError(document, previousDoc);
  if (error) throw invalid(error);
  const saved: ProjectDocument = {
    ...document,
    ownerId: ctx.actor.id,
    storageRevision: expected === null ? 1 : expected + 1,
    createdAt: previous?.created_at ?? stamp(),
    updatedAt: stamp(),
  };
  const refs = projectReferences(saved);
  const assetIds = referenceJson(refs.assets),
    versionIds = referenceJson(refs.versions);
  // Repeat permission/liveness checks in the committing transaction after the R2 upload.
  await validateReferences(ctx, assetIds, versionIds);
  const versions = await sql(
    ctx,
    `SELECT v.id,v.category,v.view_count FROM d1_material_versions v
    JOIN json_each(?) r ON r.value=v.id`,
    versionIds,
  ).all<{ id: string; category: string; view_count: number }>();
  const versionMap = new Map(versions.results.map((version) => [version.id, version]));
  for (const scene of projectScenes(saved))
    for (const fixture of scene.fixtures) {
      const version = versionMap.get(fixture.materialVersionId);
      if (!version || version.category === 'tile' || fixture.viewIndex >= Math.max(1, version.view_count))
        throw invalid('제품 자재와 사진 방향의 연결을 확인해 주세요.');
    }
  const text = boundedDocument(saved);
  const summaryJson = JSON.stringify(await createProjectSummary(saved));
  const key = `projects/${encodeURIComponent(ctx.actor.id)}/${saved.id}/${crypto.randomUUID()}.json`;
  await stageObject(ctx, key, text, 'application/json');
  const checks =
    expected === null
      ? assertion(ctx, 'conflict', 'NOT EXISTS(SELECT 1 FROM d1_projects WHERE id=?)', saved.id)
      : assertion(
          ctx,
          'conflict',
          'EXISTS(SELECT 1 FROM d1_projects WHERE id=? AND owner_id=? AND storage_revision=?)',
          saved.id,
          ctx.actor.id,
          expected,
        );
  const change =
    expected === null
      ? sql(
          ctx,
          `INSERT INTO d1_projects(id,owner_id,name,storage_revision,object_key,byte_size,summary_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)`,
          saved.id,
          ctx.actor.id,
          saved.name,
          saved.storageRevision,
          key,
          new TextEncoder().encode(text).length,
          summaryJson,
          saved.createdAt,
          saved.updatedAt,
        )
      : sql(
          ctx,
          `UPDATE d1_projects SET name=?,storage_revision=?,object_key=?,byte_size=?,summary_json=?,updated_at=?
        WHERE id=? AND owner_id=? AND storage_revision=?`,
          saved.name,
          saved.storageRevision,
          key,
          new TextEncoder().encode(text).length,
          summaryJson,
          saved.updatedAt,
          saved.id,
          ctx.actor.id,
          expected,
        );
  await batch(ctx, [
    checks,
    assetAssertion(ctx, assetIds),
    versionAssertion(ctx, versionIds),
    change,
    sql(
      ctx,
      'DELETE FROM d1_project_assets WHERE project_id=? AND asset_id NOT IN (SELECT value FROM json_each(?))',
      saved.id,
      assetIds,
    ),
    sql(
      ctx,
      'INSERT OR IGNORE INTO d1_project_assets(project_id,asset_id) SELECT ?,value FROM json_each(?)',
      saved.id,
      assetIds,
    ),
    sql(
      ctx,
      'DELETE FROM d1_project_versions WHERE project_id=? AND version_id NOT IN (SELECT value FROM json_each(?))',
      saved.id,
      versionIds,
    ),
    sql(
      ctx,
      'INSERT OR IGNORE INTO d1_project_versions(project_id,version_id) SELECT ?,value FROM json_each(?)',
      saved.id,
      versionIds,
    ),
    ...(previous ? [queueObject(ctx, previous.object_key)] : []),
    committedObject(ctx, key),
    ...mutationStatement(ctx, { key }),
  ]);
  return saved;
}
export async function projects(ctx: Context, body: Record<string, unknown>): Promise<unknown> {
  switch (body.operation) {
    case 'list': {
      const rows = await sql(
        ctx,
        'SELECT object_key,summary_json FROM d1_projects WHERE owner_id=? ORDER BY updated_at DESC',
        ctx.actor.id,
      ).all<{ object_key: string; summary_json: string }>();
      const summaries: ProjectSummary[] = [];
      // Normal writes commit the document pointer and derived summary in one transaction.
      // Only legacy/outdated summaries need an R2 read; listing never rewrites stored data.
      // Sequential fallback reads bound simultaneous full-document parsing.
      for (const row of rows.results) {
        const cached = readCurrentProjectSummary(row.summary_json);
        if (cached) {
          summaries.push(cached);
          continue;
        }
        const stored = await readDocument<ProjectInput>(ctx, row.object_key);
        storedProjectSchema.parse(stored);
        // Keep load()'s exact field order/values: the disposable context hash includes serialized scenes.
        const document = normalizeProjectDocument(stored);
        summaries.push(await createProjectSummary(document));
      }
      return summaries;
    }
    case 'load': {
      const row = await rowFor(ctx, identifierSchema.parse(body.id));
      return readDocument<ProjectDocument>(ctx, row.object_key);
    }
    case 'create':
      return writeProject(ctx, projectSchema.parse(body.document), null);
    case 'save':
      return writeProject(
        ctx,
        storedProjectSchema.parse(body.document),
        z.number().int().nonnegative().parse(body.expectedStorageRevision),
      );
    case 'duplicate': {
      const row = await rowFor(ctx, identifierSchema.parse(body.id));
      return writeProject(
        ctx,
        duplicateProjectDocument(await readDocument<ProjectDocument>(ctx, row.object_key)),
        null,
      );
    }
    case 'remove': {
      const id = identifierSchema.parse(body.id);
      const row = await rowFor(ctx, id);
      await batch(ctx, [
        assertion(
          ctx,
          'conflict',
          'EXISTS(SELECT 1 FROM d1_projects WHERE id=? AND owner_id=? AND storage_revision=?)',
          id,
          ctx.actor.id,
          row.storage_revision,
        ),
        queueObject(ctx, row.object_key),
        sql(ctx, 'DELETE FROM d1_projects WHERE id=? AND owner_id=?', id, ctx.actor.id),
        ...mutationStatement(ctx, { value: null }),
      ]);
      return null;
    }
    default:
      throw invalid('지원하지 않는 프로젝트 작업이에요.');
  }
}
