'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useAccess } from '../app-provider';
import { loadCatalog, saveCatalog } from '@/lib/catalog/client';
import { optionKinds, optionLabels, type CatalogData, type OptionKind } from '@/lib/catalog/contract';
import { categoryLabels, type MaterialCategory } from '@/lib/types';
import styles from './catalog.module.css';
const empty = () => ({
  id: undefined as string | undefined,
  kind: 'color' as OptionKind | 'subcategory',
  name: '',
  category: 'tile' as MaterialCategory,
  sortOrder: 0,
  active: true,
  colorHex: '',
});
export default function CatalogAdmin() {
  const { mode, userId } = useAccess(),
    [data, setData] = useState<CatalogData>({ options: [], subcategories: [] }),
    [form, setForm] = useState(empty),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let dead = false;
    loadCatalog(mode === 'local', userId)
      .then((value) => {
        if (!dead) setData(value);
      })
      .catch((e) => {
        if (!dead) setError(e.message);
      });
    return () => {
      dead = true;
    };
  }, [mode, userId]);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await saveCatalog(
        mode === 'local',
        { ...form, colorHex: form.kind === 'color' && form.colorHex ? form.colorHex : null },
        userId,
      );
      setData(await loadCatalog(mode === 'local', userId));
      setForm({ ...empty(), kind: form.kind });
    } catch (e) {
      setError(e instanceof Error ? e.message : '저장하지 못했어요.');
    } finally {
      setBusy(false);
    }
  }
  const rows =
    form.kind === 'subcategory' ? data.subcategories : data.options.filter((o) => o.kind === form.kind);
  return (
    <main className={styles.shell}>
      <nav className={styles.nav}>
        <Link href="/">내 프로젝트</Link>
        <Link href="/materials">공개 자재</Link>
        <Link href="/admin/materials">자재 관리</Link>
        <strong>분류 관리</strong>
      </nav>
      <h1>자재 분류 관리</h1>
      <p className={styles.muted}>
        자재 등록에서 선택할 항목을 관리해요. 사용하지 않는 항목은 비활성화하면 이전 프로젝트에는 그대로
        남아요.
      </p>
      {mode === 'local' && <p>로컬 개발용 목록 · 이 브라우저에만 저장돼요.</p>}
      <form className={styles.form} onSubmit={save}>
        <label className="field">
          종류
          <select
            className="input"
            disabled={!!form.id}
            value={form.kind}
            onChange={(e) => setForm({ ...empty(), kind: e.target.value as typeof form.kind })}
          >
            {optionKinds.map((k) => (
              <option key={k} value={k}>
                {optionLabels[k]}
              </option>
            ))}
            <option value="subcategory">하위 카테고리</option>
          </select>
        </label>
        {form.kind === 'subcategory' && (
          <label className="field">
            상위 카테고리
            <select
              className="input"
              disabled={!!form.id}
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value as MaterialCategory })}
            >
              {Object.entries(categoryLabels).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          항목 이름
          <input
            className="input"
            required
            maxLength={100}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        {form.kind === 'color' && (
          <label className="field">
            색상 HEX (선택)
            <input
              className="input"
              placeholder="#808080"
              pattern="#[0-9a-fA-F]{6}"
              value={form.colorHex}
              onChange={(e) => setForm({ ...form, colorHex: e.target.value })}
            />
          </label>
        )}
        <label className="field">
          표시 순서
          <input
            className="input"
            type="number"
            required
            min={0}
            max={100000}
            value={form.sortOrder}
            onChange={(e) => setForm({ ...form, sortOrder: Number(e.target.value) })}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={form.active}
            onChange={(e) => setForm({ ...form, active: e.target.checked })}
          />{' '}
          사용
        </label>
        <button className="btn primary" disabled={busy}>
          {busy ? '저장 중…' : form.id ? '변경 저장' : '항목 등록'}
        </button>
        {form.id && (
          <button type="button" className="btn" onClick={() => setForm({ ...empty(), kind: form.kind })}>
            수정 취소
          </button>
        )}
      </form>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <div className={styles.tableWrap}>
        <table className={styles.list}>
          <thead>
            <tr>
              <th>이름</th>
              <th>상위 종류</th>
              <th>순서</th>
              <th>상태</th>
              <th>관리</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.name}</td>
                <td>{'category' in row ? categoryLabels[row.category] : '—'}</td>
                <td>{row.sortOrder}</td>
                <td>{row.active ? '사용' : '비활성'}</td>
                <td>
                  <button
                    className="btn"
                    onClick={() =>
                      setForm({
                        id: row.id,
                        kind: 'kind' in row ? row.kind : 'subcategory',
                        name: row.name,
                        category: 'category' in row ? row.category : 'tile',
                        sortOrder: row.sortOrder,
                        active: row.active,
                        colorHex: 'colorHex' in row ? (row.colorHex ?? '') : '',
                      })
                    }
                  >
                    수정 · {row.name}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
