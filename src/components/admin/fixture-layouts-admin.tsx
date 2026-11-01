'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccess } from '@/components/app-provider';
import { LayoutPlan } from '@/components/editor/fixture-layouts-panel';
import { loadManagedLayouts, removeManagedLayout, updateManagedLayout } from '@/lib/catalog/client';
import type { ManagedLayout, ManagedLayouts } from '@/lib/fixture-layout-contract';
import AdminShell from './admin-shell';
import styles from '../materials/catalog.module.css';

/** The 기본 배치 tab: numbers, products, order, use and deletion; 열기 and 새 배치 go to the editor. */
export default function FixtureLayoutsAdmin() {
  const { userId } = useAccess();
  const [data, setData] = useState<ManagedLayouts>({ layouts: [], placements: [] }),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const reload = useCallback(async () => setData(await loadManagedLayouts(userId)), [userId]);
  useEffect(() => {
    let dead = false;
    loadManagedLayouts(userId)
      .then((value) => {
        if (!dead) setData(value);
      })
      .catch((e) => {
        if (!dead) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!dead) setLoaded(true);
      });
    return () => {
      dead = true;
    };
  }, [userId]);
  const sizes = useMemo(
    () => new Map(data.placements.map((placement) => [placement.materialId, placement])),
    [data.placements],
  );
  async function act(task: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await task();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : '저장하지 못했어요.');
    } finally {
      setBusy(false);
    }
  }
  const update = (
    layout: ManagedLayout,
    change: Partial<Pick<ManagedLayout, 'name' | 'sortOrder' | 'active'>>,
  ) =>
    act(() =>
      updateManagedLayout(
        {
          id: layout.id,
          revision: layout.revision,
          name: layout.name,
          sortOrder: layout.sortOrder,
          active: layout.active,
          ...change,
        },
        userId,
      ),
    );
  // A number is a place among the layouts in use: a hidden one has none and moves the rest up.
  let shown = 0;
  return (
    <AdminShell title="기본 배치">
      <section data-testid="fixture-layouts-admin">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <p className={styles.muted}>
            이용자가 프로젝트에서 눌러 제품을 놓는 세트예요. 저장하면 바로 모든 이용자에게 보여요.
          </p>
          <Link className="btn primary" href="/admin/layouts/studio">
            새 배치
          </Link>
        </div>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <div className={styles.tableWrap}>
          <table className={styles.list}>
            <thead>
              <tr>
                <th>번호</th>
                <th>이름</th>
                <th>자리</th>
                <th>제품</th>
                <th>순서</th>
                <th>상태</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {loaded && data.layouts.length === 0 && (
                <tr>
                  <td colSpan={7}>아직 등록한 기본 배치가 없어요.</td>
                </tr>
              )}
              {data.layouts.map((layout) => (
                <tr key={`${layout.id}:${layout.revision}`} data-testid="managed-layout">
                  <td>{layout.active && layout.products.length ? `${++shown}번` : '-'}</td>
                  <td>
                    <input
                      className="input"
                      aria-label={`${layout.name} 이름`}
                      defaultValue={layout.name}
                      maxLength={100}
                      disabled={busy}
                      onBlur={(e) => {
                        const name = e.target.value.trim();
                        if (name && name !== layout.name) void update(layout, { name });
                      }}
                    />
                  </td>
                  <td>
                    <LayoutPlan room={layout.room} items={layout.items} sizes={sizes} />
                  </td>
                  <td>
                    {layout.products.join(' · ')}
                    {layout.missing > 0 && (
                      <strong className="ml-1 text-amber-700">빠진 제품 {layout.missing}개</strong>
                    )}
                  </td>
                  <td>
                    <input
                      className="input"
                      aria-label={`${layout.name} 표시 순서`}
                      type="number"
                      min={0}
                      max={9999}
                      step={1}
                      defaultValue={layout.sortOrder ?? ''}
                      disabled={busy}
                      onBlur={(e) => {
                        const value = e.target.value === '' ? null : Number(e.target.value);
                        if (value !== layout.sortOrder) void update(layout, { sortOrder: value });
                      }}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() => void update(layout, { active: !layout.active })}
                    >
                      {layout.active ? '사용 중 · 숨기기' : '숨김 · 사용하기'}
                    </button>
                  </td>
                  <td>
                    <div className="flex gap-2">
                      <Link
                        className="btn"
                        aria-label={`${layout.name} 열기`}
                        href={`/admin/layouts/studio?id=${layout.id}`}
                      >
                        열기
                      </Link>
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={() => {
                          if (
                            window.confirm(
                              `'${layout.name}' 기본 배치를 지울까요? 이미 놓인 프로젝트는 그대로예요.`,
                            )
                          )
                            void act(() =>
                              removeManagedLayout({ id: layout.id, revision: layout.revision }, userId),
                            );
                        }}
                      >
                        삭제
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </AdminShell>
  );
}
