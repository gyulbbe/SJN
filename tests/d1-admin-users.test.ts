import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { handleAdminUsers } from '@/lib/admin/users';
import { adminAuditStatement, adminBatch, requireActiveAdmin } from '@/lib/admin/access';
import type { AdminPage, AdminUser } from '@/lib/admin/contracts';
import type { D1Actor, D1Bindings } from '@/lib/d1/types';
import { allD1Migrations, applyD1Migrations } from './helpers/d1-migrations';

let worker: Miniflare;
let env: D1Bindings;
const adminId = '10000000-0000-4000-8000-000000000001';
const memberId = '20000000-0000-4000-8000-000000000002';
const secondId = '30000000-0000-4000-8000-000000000003';
const admin: D1Actor = { id: adminId, isAdmin: true };
const origin = 'https://admin.test';
const at = '2026-09-17T00:00:00.000Z';
async function addUser(id: string, name = '회원', email = `${id}@test.invalid`, administrator = false) {
  await env.DB.prepare(
    'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)',
  )
    .bind(id, name, email, at, at)
    .run();
  if (administrator) await env.DB.prepare('INSERT INTO admin_roles(user_id) VALUES(?)').bind(id).run();
}
const post = (
  body: unknown,
  key: string | null = crypto.randomUUID(),
  actor: D1Actor | null = admin,
  bindings = env,
  source: string | null = origin,
) =>
  handleAdminUsers(
    new Request(`${origin}/api/admin/users`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key ? { 'x-idempotency-key': key } : {}),
        ...(source ? { origin: source } : {}),
      },
      body: JSON.stringify(body),
    }),
    bindings,
    actor,
  );
const role = (userId = memberId, expectedRevision = 0, value = 'admin') => ({
  operation: 'setRole',
  userId,
  expectedRevision,
  role: value,
});
const status = (userId = memberId, expectedRevision = 0, value = 'suspended') => ({
  operation: 'setStatus',
  userId,
  expectedRevision,
  status: value,
});
const get = (query = '', actor: D1Actor | null = admin) =>
  handleAdminUsers(new Request(`${origin}/api/admin/users${query}`), env, actor);
async function state(id = memberId) {
  return env.DB.prepare('SELECT status,revision FROM d1_user_management WHERE user_id=?').bind(id).first();
}
async function count(table: string) {
  return (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
}
const makeWorker = (name: string) =>
  new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("test") } }',
      compatibilityDate: '2026-09-01',
      d1Databases: { DB: name },
      r2Buckets: ['ASSET_BUCKET'],
    }),
  );
beforeAll(async () => {
  worker = makeWorker('admin-users-tests');
  env = {
    DB: await worker.getD1Database('DB'),
    ASSET_BUCKET: await worker.getR2Bucket('ASSET_BUCKET'),
  } as unknown as D1Bindings;
  await applyD1Migrations(env.DB, allD1Migrations);
}, 30000);
beforeEach(async () => {
  for (const table of ['d1_admin_audit', 'd1_mutations', 'd1_projects', 'admin_roles', 'session', 'user'])
    await env.DB.prepare(`DELETE FROM "${table}"`).run();
  await addUser(adminId, '관리자', 'admin@test.invalid', true);
  await addUser(memberId, '그레이 회원', 'member@test.invalid');
});
afterAll(async () => {
  await worker?.dispose();
});

describe('admin membership in real isolated D1', () => {
  it('upgrades existing auth rows and sessions without granting a role, and provisions new users', async () => {
    const upgrade = makeWorker('admin-upgrade-test');
    try {
      const db = (await upgrade.getD1Database('DB')) as unknown as D1Bindings['DB'];
      await applyD1Migrations(db, allD1Migrations.slice(0, 4));
      await db
        .prepare('INSERT INTO "user"(id,name,email,createdAt,updatedAt) VALUES(?,?,?,?,?)')
        .bind(adminId, '기존 관리자', 'old@test.invalid', at, at)
        .run();
      await db.prepare('INSERT INTO admin_roles(user_id) VALUES(?)').bind(adminId).run();
      await db
        .prepare('INSERT INTO session(id,userId,token,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)')
        .bind('old-session', adminId, 'test-only-token', '2099-01-01', at, at)
        .run();
      await applyD1Migrations(db, allD1Migrations.slice(4));
      expect(await db.prepare('SELECT * FROM d1_user_management').first()).toMatchObject({
        user_id: adminId,
        status: 'active',
        revision: 0,
      });
      expect(await db.prepare('SELECT COUNT(*) AS n FROM session').first()).toEqual({ n: 1 });
      expect(await db.prepare('SELECT COUNT(*) AS n FROM admin_roles').first()).toEqual({ n: 1 });
      expect(await db.prepare('PRAGMA foreign_key_check').all()).toMatchObject({ results: [] });
    } finally {
      await upgrade.dispose();
    }
    expect(await state()).toEqual({ status: 'active', revision: 0 });
    expect(await count('admin_roles')).toBe(1);
  }, 30000);
  it('returns only allowlisted member data, counts projects, and searches literal names/email/id', async () => {
    const projectId = crypto.randomUUID();
    await env.DB.prepare(
      'INSERT INTO d1_projects(id,owner_id,name,created_at,updated_at,storage_revision,object_key,summary_json,byte_size) VALUES(?,?,?,?,?,1,?,?,2)',
    )
      .bind(projectId, memberId, '회원 프로젝트', at, at, 'private-document', '{}')
      .run();
    for (const q of ['그레', 'member@', memberId.slice(0, 10)]) {
      const response = await get('?q=' + encodeURIComponent(q));
      expect(response.status).toBe(200);
      const page = (await response.json()) as AdminPage<AdminUser>;
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toEqual({
        id: memberId,
        name: '그레이 회원',
        email: 'member@test.invalid',
        emailVerified: true,
        createdAt: at,
        isAdmin: false,
        status: 'active',
        revision: 0,
        projectCount: 1,
      });
      expect(response.headers.get('cache-control')).toContain('no-store');
    }
    expect((await (await get('?q=%25')).json()).items).toEqual([]);
    expect((await (await get('?q=%27%20OR%201%3D1--')).json()).items).toEqual([]);
  });
  it('searches long literal email and names without the Workers LIKE pattern limit', async () => {
    const email = memberId + '@long-search-domain.example.test';
    await env.DB.prepare('UPDATE user SET email=? WHERE id=?').bind(email, memberId).run();
    for (const q of [email, memberId]) {
      const response = await get('?q=' + encodeURIComponent(q));
      expect(response.status).toBe(200);
      expect(((await response.json()) as AdminPage<AdminUser>).items.map((row) => row.id)).toEqual([
        memberId,
      ]);
    }
    const response = await get('?q=' + 'x'.repeat(200));
    expect(response.status).toBe(200);
    expect(((await response.json()) as AdminPage<AdminUser>).items).toEqual([]);
  });
  it('paginates 25 rows stably and rejects changed filters and malformed cursors', async () => {
    for (let i = 0; i < 27; i++) await addUser(crypto.randomUUID(), `검색 ${i}`);
    const first = (await (await get('?q=' + encodeURIComponent('검색'))).json()) as AdminPage<AdminUser>;
    expect(first.items).toHaveLength(25);
    expect(first.nextCursor).toBeTruthy();
    const second = (await (
      await get('?q=' + encodeURIComponent('검색') + '&cursor=' + first.nextCursor)
    ).json()) as AdminPage<AdminUser>;
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((u) => u.id)).size).toBe(27);
    expect((await get('?cursor=' + first.nextCursor)).status).toBe(400);
    expect((await get('?cursor=%25')).status).toBe(400);
    expect((await get('?role=superadmin')).status).toBe(400);
  }, 20000);
  it('ignores a forged cached admin flag, denies anonymous users, and rechecks demotion/suspension', async () => {
    expect((await get('', null)).status).toBe(401);
    expect((await get('', { id: memberId, isAdmin: true })).status).toBe(403);
    expect((await post(role(), undefined, { id: memberId, isAdmin: true })).status).toBe(403);
    await env.DB.prepare('DELETE FROM admin_roles WHERE user_id=?').bind(adminId).run();
    expect((await get()).status).toBe(403);
    await env.DB.prepare('INSERT INTO admin_roles(user_id) VALUES(?)').bind(adminId).run();
    await env.DB.prepare("UPDATE d1_user_management SET status='suspended' WHERE user_id=?")
      .bind(adminId)
      .run();
    expect((await get()).status).toBe(403);
    expect(await count('d1_admin_audit')).toBe(0);
  });
  it('promotes and demotes with persistent revisions and small atomic audits', async () => {
    const promoted = await post({ ...role(), reason: '지원 담당' }, 'promote');
    expect(promoted.status).toBe(200);
    expect(await promoted.json()).toMatchObject({ user: { id: memberId, isAdmin: true, revision: 1 } });
    expect((await post(role(memberId, 1, 'member'), 'demote')).status).toBe(200);
    expect(await state()).toEqual({ status: 'active', revision: 2 });
    expect(await count('admin_roles')).toBe(1);
    const audit = await env.DB.prepare('SELECT * FROM d1_admin_audit WHERE request_id=?')
      .bind('promote')
      .first<{ actor_id: string; before_json: string; after_json: string; reason: string }>();
    expect(audit?.actor_id).toBe(adminId);
    expect(audit?.reason).toBe('지원 담당');
    expect(JSON.parse(audit!.before_json)).toEqual({ isAdmin: false, status: 'active', revision: 0 });
    expect(JSON.parse(audit!.after_json)).toEqual({ isAdmin: true, status: 'active', revision: 1 });
    expect(await count('d1_admin_checks')).toBe(0);
  });
  it('does not advance revision for a no-op and filters role/status from current D1 state', async () => {
    expect((await post(role(memberId, 0, 'member'))).status).toBe(200);
    expect(await state()).toEqual({ status: 'active', revision: 0 });
    await post(status());
    expect(
      (await (await get('?role=member&status=suspended')).json()).items.map((u: AdminUser) => u.id),
    ).toEqual([memberId]);
    expect((await (await get('?role=admin&status=active')).json()).items.map((u: AdminUser) => u.id)).toEqual(
      [adminId],
    );
  });
  it('requires a bounded payload, explicit revision, valid identifiers, idempotency key and same origin', async () => {
    for (const body of [
      { ...role(), userId: '../user' },
      { ...role(), expectedRevision: -1 },
      { ...role(), expectedRevision: 0.5 },
      { ...role(), role: 'owner' },
      { ...role(), unexpected: 'x' },
      { ...role(), reason: 'x'.repeat(501) },
    ])
      expect((await post(body)).status).toBe(400);
    expect((await post(role(), null)).status).toBe(400);
    expect((await post(role(), undefined, admin, env, null)).status).toBe(403);
    expect((await post(role(), undefined, admin, env, 'https://hostile.test')).status).toBe(403);
    expect((await post(role(crypto.randomUUID()))).status).toBe(404);
    expect((await post({ ...role(), reason: 'x'.repeat(20000) })).status).toBe(413);
    expect(await count('d1_admin_audit')).toBe(0);
    expect(await state()).toEqual({ status: 'active', revision: 0 });
  });
  it('replays the same request once and rejects a key reused for different input', async () => {
    const a = await post(role(), 'stable-key'),
      b = await post(role(), 'stable-key');
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await a.json()).toEqual(await b.json());
    expect((await post(status(memberId, 1), 'stable-key')).status).toBe(409);
    expect(await state()).toEqual({ status: 'active', revision: 1 });
    expect(await count('d1_admin_audit')).toBe(1);
    expect(await count('d1_mutations')).toBe(1);
  });
  it('serializes concurrent same-key delivery into one revision and audit', async () => {
    const responses = await Promise.all([post(role(), 'duplicate'), post(role(), 'duplicate')]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(await responses[0].json()).toEqual(await responses[1].json());
    expect(await state()).toMatchObject({ revision: 1 });
    expect(await count('d1_admin_audit')).toBe(1);
  });
  it('rejects stale revisions and concurrent different changes without partial audit', async () => {
    const responses = await Promise.all([post(role(), 'race-role'), post(status(), 'race-status')]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await state()).toMatchObject({ revision: 1 });
    expect(await count('d1_admin_audit')).toBe(1);
    expect((await post(role(), 'stale')).status).toBe(409);
  });
  it('protects the last active admin even when another administrator is suspended', async () => {
    await addUser(secondId, '정지 관리자', 'second@test.invalid', true);
    await env.DB.prepare("UPDATE d1_user_management SET status='suspended' WHERE user_id=?")
      .bind(secondId)
      .run();
    const response = await post(role(adminId, 0, 'member'));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'LAST_ACTIVE_ADMIN' });
    expect(await count('admin_roles')).toBe(2);
    expect(await count('d1_admin_audit')).toBe(0);
  });
  it('blocks self suspension and allows self demotion only with another active admin', async () => {
    await addUser(secondId, '다른 관리자', 'second@test.invalid', true);
    const denied = await post(status(adminId));
    expect(denied.status).toBe(400);
    expect(await denied.json()).toMatchObject({ code: 'SELF_SUSPENSION' });
    expect((await post(role(adminId, 0, 'member'), 'self-demote')).status).toBe(200);
    expect((await post(role(adminId, 0, 'member'), 'self-demote')).status).toBe(403);
    expect((await get()).status).toBe(403);
  });
  it('keeps an active administrator under competing reciprocal demotions', async () => {
    await addUser(secondId, '다른 관리자', 'second@test.invalid', true);
    const responses = await Promise.all([
      post(role(secondId, 0, 'member')),
      post(role(adminId, 0, 'member'), undefined, { id: secondId, isAdmin: true }),
    ]);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 403 || r.status === 409)).toHaveLength(1);
    expect(await count('admin_roles')).toBe(1);
    expect(await count('d1_admin_audit')).toBe(1);
  });
  it('deletes every session on suspension, rejects racing session creation, and restores login eligibility', async () => {
    const session = () =>
      env.DB.prepare('INSERT INTO session(id,userId,token,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)')
        .bind(crypto.randomUUID(), memberId, crypto.randomUUID(), '2099-01-01', at, at)
        .run();
    await session();
    await session();
    expect((await post(status())).status).toBe(200);
    expect(await count('session')).toBe(0);
    await expect(session()).rejects.toThrow(/d1_account_suspended/);
    expect((await post(status(memberId, 1, 'active'))).status).toBe(200);
    await session();
    expect(await count('session')).toBe(1);
    expect(await state()).toEqual({ status: 'active', revision: 2 });
  });
  it('rechecks an administrator in the commit even after a successful preflight', async () => {
    const ctx = { env, actor: admin };
    await requireActiveAdmin(ctx);
    await env.DB.prepare('DELETE FROM admin_roles WHERE user_id=?').bind(adminId).run();
    await expect(
      adminBatch(ctx, [
        env.DB.prepare("UPDATE d1_user_management SET status='suspended' WHERE user_id=?").bind(memberId),
        adminAuditStatement(ctx, { action: 'user.status', requestId: 'revoked' }),
      ]),
    ).rejects.toMatchObject({ status: 403 });
    expect(await state()).toEqual({ status: 'active', revision: 0 });
    expect(await count('d1_admin_audit')).toBe(0);
  });
  it('rolls back role, revision, session deletion and request receipt if the audit cannot commit', async () => {
    await env.DB.prepare(
      "CREATE TRIGGER fail_admin_audit BEFORE INSERT ON d1_admin_audit BEGIN SELECT RAISE(ABORT,'test audit unavailable'); END",
    ).run();
    try {
      expect((await post(role(), 'audit-fails')).status).toBe(503);
      expect(await state()).toEqual({ status: 'active', revision: 0 });
      expect(await count('admin_roles')).toBe(1);
      expect(await count('d1_mutations')).toBe(0);
      await env.DB.prepare(
        'INSERT INTO session(id,userId,token,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)',
      )
        .bind('kept-session', memberId, 'kept-test-token', '2099-01-01', at, at)
        .run();
      expect((await post(status(), 'audit-fails-status')).status).toBe(503);
      expect(await state()).toEqual({ status: 'active', revision: 0 });
      expect(await count('session')).toBe(1);
      expect(await count('d1_admin_checks')).toBe(0);
    } finally {
      await env.DB.prepare('DROP TRIGGER fail_admin_audit').run();
    }
  });
});
