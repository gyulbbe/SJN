'use client';
import { useCallback, useEffect, useState } from 'react';
import { loadManagedLayouts, removeManagedLayout, updateManagedLayout } from '@/lib/catalog/client';
import type { ManagedLayout } from '@/lib/fixture-layout-contract';
import styles from './catalog.module.css';

/** 분류 관리's 기본 배치: their numbers, products, order, use and deletion. Registered in the editor. */
export default function FixtureLayoutsAdmin({ userId }: { userId?: string }) {
  const [layouts, setLayouts] = useState<ManagedLayout[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const reload = useCallback(async () => setLayouts(await loadManagedLayouts(userId)), [userId]);
  useEffect(() => {
    let dead = false;
    loadManagedLayouts(userId)
      .then((value) => {
        if (!dead) setLayouts(value);
      })
      .catch((e) => {
        if (!dead) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      dead = true;
    };
  }, [userId]);
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
    <section data-testid="fixture-layouts-admin" className="mt-8">
      <h2>기본 배치</h2>
      <p className={styles.muted}>
        이용자가 눌러서 제품을 놓는 세트예요. 등록과 자리 고치기는 편집 화면의 기본 배치 탭에서 해요. 자기
        프로젝트에 놓고 옮긴 뒤 같은 배치에 덮어쓰면 돼요.
      </p>
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
              <th>제품</th>
              <th>순서</th>
              <th>상태</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {layouts.length === 0 && (
              <tr>
                <td colSpan={6}>아직 등록한 기본 배치가 없어요.</td>
              </tr>
            )}
            {layouts.map((layout) => (
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
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => {
                      if (
                        window.confirm(`'${layout.name}' 기본 배치를 지울까요? 놓인 프로젝트는 그대로예요.`)
                      )
                        void act(() =>
                          removeManagedLayout({ id: layout.id, revision: layout.revision }, userId),
                        );
                    }}
                  >
                    삭제
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
