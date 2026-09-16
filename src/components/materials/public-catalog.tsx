'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useAccess } from '../app-provider';
import { useSharedCatalogAdmin } from './shared-access';
import type { PublicMaterial } from '@/lib/catalog/public';
import { categoryLabels } from '@/lib/types';
import MaterialManager from './material-manager';
import styles from './catalog.module.css';
export default function PublicCatalog() {
  const access = useAccess(),
    admin = useSharedCatalogAdmin();
  const [rows, setRows] = useState<PublicMaterial[]>([]),
    [query, setQuery] = useState(''),
    [category, setCategory] = useState(''),
    [detail, setDetail] = useState<PublicMaterial>(),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!access.status || access.mode === 'local') return;
    const controller = new AbortController();
    setLoading(true);
    fetch('/api/catalog/materials', { signal: controller.signal, cache: 'no-store' })
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error ?? '자재 목록을 불러오지 못했어요.');
        if (!controller.signal.aborted) {
          setRows(data.materials);
          setError('');
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [access.mode, access.status, attempt]);
  if (access.status && access.mode === 'local')
    return access.ready ? <MaterialManager /> : <p role="status">작업 공간을 준비하고 있어요…</p>;
  const matching = rows.filter(
    (row) =>
      (!category || row.category === category) &&
      [row.name, row.brand, row.code, row.subcategoryName, row.color, row.composition, row.finish]
        .join(' ')
        .normalize('NFKC')
        .toLowerCase()
        .includes(query.normalize('NFKC').trim().toLowerCase()),
  );
  return (
    <main className={styles.shell}>
      <nav className={styles.nav}>
        <Link href="/">공간미리</Link>
        <strong>자재 라이브러리</strong>
        {admin && (
          <>
            <Link href="/admin/materials">자재 관리</Link>
            <Link href="/admin/catalog">분류 관리</Link>
          </>
        )}
        {access.userId ? (
          <>
            <Link href="/">내 프로젝트</Link>
            <button className="btn" onClick={() => void access.signOut()}>
              로그아웃
            </button>
          </>
        ) : (
          <Link className="btn" href="/login">
            Google로 시작하기
          </Link>
        )}
      </nav>
      <h1>내 공간을 완성할 자재</h1>
      <p className={styles.muted}>
        자재는 로그인 없이 둘러볼 수 있어요. 프로젝트를 만들고 저장하려면 Google로 시작해 주세요.
      </p>
      <Link className="btn primary" href={access.userId ? '/' : '/login'}>
        프로젝트 만들기
      </Link>
      <div className={styles.form}>
        <label className="field">
          자재 검색
          <input
            className="input"
            value={query}
            placeholder="이름, 브랜드, 색상, 재질"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <label className="field">
          제품 종류
          <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">전체</option>
            {Object.entries(categoryLabels).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
      </div>
      {loading && <p role="status">자재를 불러오는 중…</p>}
      {error && (
        <p role="alert" className={styles.error}>
          {error} <button onClick={() => setAttempt((x) => x + 1)}>다시 시도</button>
        </p>
      )}
      <div className={styles.grid}>
        {matching.map((row) => (
          <button className={styles.card} key={row.id} onClick={() => setDetail(row)}>
            {row.images[0] && <img src={row.images[0].url} alt={row.name} />}
            <h2>{row.name}</h2>
            <p>{row.brand || '브랜드 미지정'}</p>
            <p className={styles.muted}>
              {[categoryLabels[row.category], row.subcategoryName, row.color, row.finish]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </button>
        ))}
      </div>
      {!loading && !error && !matching.length && <p>조건에 맞는 자재가 없어요.</p>}
      {detail && (
        <div className="modal" role="dialog" aria-modal="true" aria-label="자재 상세">
          <div className="modal-card">
            <div className="modal-header">
              <h2>{detail.name}</h2>
              <button className="btn" onClick={() => setDetail(undefined)}>
                닫기
              </button>
            </div>
            <div className={styles.detailImages}>
              {detail.images.map((image, i) => (
                <img key={i} src={image.url} alt={image.label} />
              ))}
            </div>
            <p>{detail.description}</p>
            <dl>
              {[
                ['브랜드', detail.brand],
                ['분류', `${categoryLabels[detail.category]} ${detail.subcategoryName}`],
                ['색상', detail.color],
                ['재질', detail.composition],
                ['마감', detail.finish],
                ['규격', `${detail.widthMm} × ${detail.heightMm} × ${detail.depthMm} mm`],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v || '미지정'}</dd>
                </div>
              ))}
            </dl>
            <Link className="btn primary" href={access.userId ? '/' : '/login'}>
              프로젝트 시작하기
            </Link>
          </div>
        </div>
      )}
    </main>
  );
}
