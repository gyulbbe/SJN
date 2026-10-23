'use client';
import { getMaterialImageAssetId, stripLegacyMaterialImages } from '@/lib/material-images';
import { isRetiredDirection } from '@/lib/product-direction';
import { cardMaterial, materialCard, type MaterialCard } from '@/lib/catalog/cards';
import type { MaterialPageQuery } from '@/lib/catalog/paging';
import { LoadMore } from './load-more';
import { ListImageBackfill } from './list-image-backfill';
import { useMaterialPages, useSettled } from './use-material-pages';

import Link from 'next/link';
import AdminLinks from '@/components/admin/admin-links';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Archive,
  ArrowUpRight,
  Copy,
  FolderOpen,
  Grid2X2,
  Layers,
  Package,
  Plus,
  Search,
} from 'lucide-react';
import { getRepositories } from '@/lib/repositories';
import { defaultMaterialPricing, QUOTE_UNIT_LABELS } from '@/lib/quote';
import {
  categoryLabels,
  type Material,
  type MaterialCategory,
  type MaterialInput,
  type MaterialVersion,
} from '@/lib/types';
import { StorageBadge, useAccess } from '@/components/app-provider';
import { AssetImage } from './asset-image';
import { MaterialForm } from './material-form';
import { useSharedCatalogAdmin } from './shared-access';
import styles from './materials.module.css';

type MaterialRow = { material: Material; version: MaterialVersion };
const noCounts = { all: 0, personal: 0, shared: 0, active: 0 };

export default function MaterialManager() {
  const { writable, ready } = useAccess();
  const isAdmin = useSharedCatalogAdmin();
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState<'all' | 'personal' | 'shared'>('all');
  const [category, setCategory] = useState<'all' | MaterialCategory>('all');
  const [inactive, setInactive] = useState(false);
  const [form, setForm] = useState<'new' | MaterialVersion>();
  const [detail, setDetail] = useState<MaterialRow>();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const grid = useRef<HTMLDivElement>(null);
  const settled = useSettled(search);
  const listQuery: MaterialPageQuery = {
    ...(category === 'all' ? {} : { category }),
    ...(settled.trim() ? { q: settled } : {}),
  };
  const key = JSON.stringify([listQuery, scope, inactive, reload]);
  const fetchPage = useCallback(
    (query: MaterialPageQuery) =>
      getRepositories().materials.page(query, { view: 'library', scope, active: !inactive }),
    [scope, inactive],
  );
  const pages = useMaterialPages(fetchPage, listQuery, key, ready);
  // A change made here moves the counts without asking for the list again.
  const [moved, setMoved] = useState({ key: '', ...noCounts });
  const shift = moved.key === key ? moved : { key, ...noCounts };
  const counts = pages.counts
    ? {
        all: pages.counts.all + shift.all,
        personal: pages.counts.personal + shift.personal,
        shared: pages.counts.shared + shift.shared,
        active: pages.counts.active + shift.active,
      }
    : undefined;
  const loading = pages.status === 'loading' && !pages.items.length;

  useEffect(() => {
    // Another tab saved a material: show the list again from the first page.
    const channel = new BroadcastChannel('gongganmiri');
    channel.onmessage = () => setReload((value) => value + 1);
    return () => channel.close();
  }, []);
  /** The whole version of a card (detail, edit and duplicate read it only then). */
  const versionOf = async (card: MaterialCard) => {
    const [version] = (await getRepositories().materials.getVersions([card.versionId])).versions;
    if (!version) throw new Error('자재 정보를 불러오지 못했어요.');
    return version;
  };
  const open = async (card: MaterialCard, action: (row: MaterialRow) => void) => {
    setError('');
    try {
      action({ material: cardMaterial(card), version: await versionOf(card) });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '자재 정보를 불러오지 못했어요.');
    }
  };
  const duplicate = async (version: MaterialVersion) => {
    if (!writable || !isAdmin) return;
    setBusy(version.materialId);
    setError('');
    try {
      // Keep immutable assets shared; later edits create new asset IDs and versions.
      const input: MaterialInput = stripLegacyMaterialImages({
        ...version,
        name: `${version.name} (복사)`,
        scope: 'shared',
      });
      const result = await getRepositories().materials.create(input);
      setNotice('새 공용 자재로 복제했어요. 원래 자재에 영향을 주지 않고 수정할 수 있어요.');
      setDetail(undefined);
      setForm(result);
      setReload((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '자재를 복제하지 못했어요.');
    } finally {
      setBusy('');
    }
  };
  const toggleActive = async (card: MaterialCard) => {
    if (!writable || !isAdmin) return;
    setBusy(card.materialId);
    setError('');
    try {
      await getRepositories().materials.setActive(card.materialId, !card.active);
      setNotice(
        card.active
          ? '자재를 비활성화했어요. 기존 프로젝트에 적용한 모습은 유지돼요.'
          : '자재를 다시 사용할 수 있어요.',
      );
      setDetail(undefined);
      // It leaves this list (active or deactivated ones); only the counts move.
      pages.update((items) => items.filter((item) => item.materialId !== card.materialId));
      setMoved({
        key,
        all: shift.all - 1,
        personal: shift.personal - (card.scope === 'personal' ? 1 : 0),
        shared: shift.shared - (card.scope === 'shared' ? 1 : 0),
        active: shift.active + (card.active ? -1 : 1),
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '자재 상태를 변경하지 못했어요.');
    } finally {
      setBusy('');
    }
  };
  const detailPricing = detail
    ? (detail.version.pricing ?? defaultMaterialPricing(detail.version.category))
    : undefined;

  return (
    <div className="home-shell">
      <aside className="app-nav">
        <Link href="/" className="brand">
          <span className="brand-mark">
            <Layers size={21} />
          </span>
          공간미리<span className="beta">BETA</span>
        </Link>
        <div className="nav-section">작업 공간</div>
        <Link href="/" className="nav-item">
          <FolderOpen size={18} />내 프로젝트
        </Link>
        <Link href="/materials" className="nav-item active">
          <Grid2X2 size={18} />
          자재 라이브러리
        </Link>
        {isAdmin && (
          <Link href="/admin/catalog" className="nav-item">
            분류·속성 관리
          </Link>
        )}
        <AdminLinks className="nav-item" />
        <div className="nav-bottom">
          <StorageBadge />
          <p>로그인 계정의 서버 저장소를 사용해요.</p>
          <span className="version">공간미리 · 0.1</span>
        </div>
      </aside>
      <main className="home-main">
        <div className="home-topline">
          <span>WORKSPACE / MATERIAL LIBRARY</span>
          <StorageBadge />
        </div>
        <div className="page-heading">
          <div>
            <div className="eyebrow">내 공간을 완성할 재료들</div>
            <h1>자재 라이브러리</h1>
            <p>마음에 드는 타일과 제품을 모으고, 내 사진에 직접 적용해 보세요.</p>
          </div>
          <button className="btn primary" disabled={!ready || !writable} onClick={() => setForm('new')}>
            <Plus size={18} />
            자재 등록
          </button>
        </div>
        <section className={styles.libraryIntro}>
          <div className={styles.libraryIcon}>
            <Grid2X2 size={30} strokeWidth={1.25} />
          </div>
          <div>
            <h2>제품 그대로, 공간 위에.</h2>
            <p>타일 한 장의 무늬와 제품 사진을 등록하면 실제 규격을 기준으로 배치할 수 있어요.</p>
          </div>
          <div className={styles.libraryCount}>
            <strong>{(counts?.active ?? 0).toString().padStart(2, '0')}</strong>
            <span>사용 가능한 자재</span>
          </div>
        </section>
        {isAdmin && (
          <section className="mb-6">
            <ListImageBackfill disabled={!writable} />
          </section>
        )}
        {error && (
          <div className={`notice error ${styles.message}`} role="alert">
            {error}
            <button
              className={styles.textButton}
              onClick={() => {
                setError('');
                if (pages.status === 'error') pages.retry();
              }}
            >
              다시 불러오기
            </button>
          </div>
        )}
        {notice && (
          <div role="status" className={styles.success}>
            {notice}
            <button aria-label="알림 닫기" onClick={() => setNotice('')}>
              ×
            </button>
          </div>
        )}
        <div className={styles.filterTop}>
          <div className={styles.scopeTabs}>
            {(
              [
                ['all', '전체 자재'],
                ['personal', '내 자재'],
                ['shared', '공용 자재'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                className={scope === value ? styles.scopeActive : ''}
                onClick={() => setScope(value)}
              >
                {label}
                <span>{counts ? counts[value] : '–'}</span>
              </button>
            ))}
          </div>
          <label className="search-box">
            <Search size={16} />
            <input
              placeholder="상품명 · 브랜드 · 코드 검색"
              aria-label="자재 검색"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
        </div>
        <div className={styles.filterBottom}>
          <div className={styles.categoryTabs}>
            <button
              className={category === 'all' ? styles.categoryActive : ''}
              onClick={() => setCategory('all')}
            >
              전체
            </button>
            {Object.entries(categoryLabels).map(([value, label]) => (
              <button
                key={value}
                className={category === value ? styles.categoryActive : ''}
                onClick={() => setCategory(value as MaterialCategory)}
              >
                {label}
              </button>
            ))}
          </div>
          <label className={styles.archiveToggle}>
            <input
              type="checkbox"
              checked={inactive}
              onChange={(event) => setInactive(event.target.checked)}
            />
            비활성 자재
          </label>
        </div>
        {scope === 'shared' && (
          <p className={styles.sharedNote}>
            공용 자재는 새 공용 자재로 복제하면 개인 버전으로 수정할 수 있어요.
          </p>
        )}
        {pages.status === 'error' && !pages.items.length ? (
          <div className={`notice error ${styles.message}`} role="alert">
            {pages.error}
            <button className={styles.textButton} onClick={pages.retry}>
              다시 불러오기
            </button>
          </div>
        ) : loading ? (
          <div className={styles.empty} role="status">
            <Package size={30} strokeWidth={1.2} />
            <p>자재 라이브러리를 불러오고 있어요…</p>
          </div>
        ) : !pages.items.length ? (
          <div className={styles.empty}>
            <Package size={35} strokeWidth={1.15} />
            <h3>
              {search || category !== 'all'
                ? '조건에 맞는 자재가 없어요'
                : inactive
                  ? '비활성화한 자재가 없어요'
                  : '첫 번째 자재를 등록해 보세요'}
            </h3>
            <p>
              {search || category !== 'all'
                ? '다른 검색어나 카테고리로 찾아보세요.'
                : '상품 사진과 실제 규격을 준비하면 바로 시작할 수 있어요.'}
            </p>
            {!inactive && !search && (
              <button className="btn" disabled={!writable} onClick={() => setForm('new')}>
                <Plus size={16} />내 자재 등록
              </button>
            )}
          </div>
        ) : (
          <div className={styles.materialGrid} ref={grid}>
            {pages.items.map((row) => (
              <article
                key={row.materialId}
                className={`${styles.materialCard} ${!row.active ? styles.inactiveCard : ''}`}
              >
                <button
                  className={styles.cardImage}
                  data-page-item
                  onClick={() => void open(row, setDetail)}
                  aria-label={`${row.name} 상세 보기`}
                >
                  <AssetImage
                    lazy
                    size="list"
                    assetId={row.imageAssetId}
                    alt={row.name}
                    style={{ objectFit: row.category === 'tile' ? 'cover' : 'contain' }}
                  />
                  <span className={styles.cardCategory}>{categoryLabels[row.category]}</span>
                  <span className={styles.cardExpand}>
                    <ArrowUpRight size={16} />
                  </span>
                </button>
                <div className={styles.cardBody}>
                  <div className={styles.cardLabel}>
                    <span>{row.brand || (row.scope === 'shared' ? '공용 자재' : '나의 자재')}</span>
                    <span>v{row.version}</span>
                  </div>
                  <button className={styles.cardTitle} onClick={() => void open(row, setDetail)}>
                    {row.name}
                  </button>
                  <p>
                    {row.widthMm} × {row.heightMm}
                    {row.category !== 'tile' ? ` × ${row.depthMm}` : ''} mm
                    <span> · {row.finish || categoryLabels[row.category]}</span>
                  </p>
                  <div className={styles.cardTags}>
                    <span className={`badge ${row.scope === 'shared' ? '' : 'green'}`}>
                      {row.scope === 'shared' ? '공용' : '내 자재'}
                    </span>
                    <span className="badge">
                      {row.category === 'tile' ? `텍스처 ${row.textureCount}장` : `2D · ${row.viewCount}방향`}
                    </span>
                    {!row.active && <span className="badge amber">비활성</span>}
                  </div>
                </div>
                <div className={styles.cardFooter}>
                  <button
                    className={styles.textButton}
                    disabled={!writable || !!busy}
                    onClick={() =>
                      void open(row, ({ version }) =>
                        row.scope === 'personal' || isAdmin ? setForm(version) : void duplicate(version),
                      )
                    }
                  >
                    {row.scope === 'personal' || isAdmin ? '정보 수정' : '새 공용 자재로 복제'}
                  </button>
                  <div className={styles.toolbar}>
                    {(row.scope === 'personal' || isAdmin) && (
                      <>
                        <button
                          className="icon-btn"
                          aria-label={`${row.name} 복제`}
                          title="복제"
                          disabled={!writable || !!busy}
                          onClick={() => void open(row, ({ version }) => void duplicate(version))}
                        >
                          <Copy size={14} />
                        </button>
                        <button
                          className="icon-btn"
                          aria-label={`${row.name} ${row.active ? '비활성화' : '다시 활성화'}`}
                          title={row.active ? '비활성화' : '다시 활성화'}
                          disabled={!writable || !!busy}
                          onClick={() => void toggleActive(row)}
                        >
                          <Archive size={14} />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </article>
            ))}
            <LoadMore
              pages={pages}
              focusItem={(index) => grid.current?.querySelectorAll<HTMLElement>('[data-page-item]')[index]}
            />
          </div>
        )}
        <footer className="home-footer">
          <span>공용 자재의 편집 권한은 서버에서 확인해요.</span>
          <span>기존 프로젝트는 적용 당시의 자재 버전을 유지합니다.</span>
        </footer>
      </main>
      {form && (
        <div
          className="modal"
          role="dialog"
          aria-modal="true"
          aria-label={form === 'new' ? '자재 등록' : '자재 수정'}
        >
          <div className={`modal-card ${styles.formModal}`}>
            <MaterialForm
              key={form === 'new' ? 'new' : form.id}
              initial={form === 'new' ? undefined : form}
              onCancel={() => setForm(undefined)}
              onSaved={(version) => {
                const edited =
                  form !== 'new' && pages.items.find((item) => item.materialId === version.materialId);
                setForm(undefined);
                setNotice(
                  `${version.name} · v${version.version} 저장 완료. 편집기에서 바로 선택할 수 있어요.`,
                );
                // An edit replaces its card (now the newest); a new material shows the list again.
                if (edited)
                  pages.update((items) => [
                    materialCard(
                      { ...cardMaterial(edited), currentVersionId: version.id, updatedAt: version.createdAt },
                      version,
                    ),
                    ...items.filter((item) => item.materialId !== version.materialId),
                  ]);
                else setReload((value) => value + 1);
              }}
            />
          </div>
        </div>
      )}
      {detail && (
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby="material-detail-title">
          <div className={`modal-card ${styles.detailModal}`}>
            <div className={styles.formHeader}>
              <span className={styles.eyebrow}>MATERIAL DETAILS</span>
              <button className="btn" onClick={() => setDetail(undefined)}>
                닫기
              </button>
            </div>
            <div className={styles.detailGrid}>
              <AssetImage
                className={styles.detailImage}
                assetId={getMaterialImageAssetId(detail.version)}
                alt={detail.version.name}
              />
              <div>
                <div className="badge">
                  {categoryLabels[detail.version.category]} · v{detail.version.version}
                </div>
                <h2 id="material-detail-title">{detail.version.name}</h2>
                <p className="muted">
                  {detail.version.brand} {detail.version.code && `· ${detail.version.code}`}
                </p>
                <dl className={styles.specList}>
                  <dt>규격</dt>
                  <dd>
                    {detail.version.widthMm} × {detail.version.heightMm} × {detail.version.depthMm} mm
                  </dd>
                  <dt>색상</dt>
                  <dd>{detail.version.color || '미입력'}</dd>
                  <dt>재질·마감</dt>
                  <dd>{detail.version.finish || '미입력'}</dd>
                  {detailPricing && (
                    <>
                      <dt>판매 단위</dt>
                      <dd>{QUOTE_UNIT_LABELS[detailPricing.unit]}</dd>
                      <dt>기준 단가</dt>
                      <dd>
                        {detailPricing.unitPrice === null
                          ? '미등록 · 자재 수량·금액에서 확인'
                          : `${detailPricing.unitPrice.toLocaleString('ko-KR')}원 / ${QUOTE_UNIT_LABELS[detailPricing.unit]}`}
                      </dd>
                      {detailPricing.unit === 'box' && (
                        <>
                          <dt>박스당 면적</dt>
                          <dd>
                            {detailPricing.boxCoverageM2 === null
                              ? '미등록'
                              : `${detailPricing.boxCoverageM2.toLocaleString('ko-KR')}㎡`}
                          </dd>
                          <dt>박스당 수량</dt>
                          <dd>
                            {detailPricing.piecesPerBox === null
                              ? '미등록'
                              : `${detailPricing.piecesPerBox.toLocaleString('ko-KR')}장·개`}
                          </dd>
                        </>
                      )}
                    </>
                  )}
                  <dt>저장 위치</dt>
                  <dd>{detail.material.scope === 'personal' ? '내 자재' : '공용 자재'}</dd>
                  <dt>준비 상태</dt>
                  <dd>
                    {detail.version.category === 'tile'
                      ? `렌더링 텍스처 ${detail.version.textureAssetIds.length}장`
                      : `2D 제품 이미지 ${detail.version.views.filter((view) => !isRetiredDirection(view.direction)).length}방향`}
                  </dd>
                </dl>
                <p>{detail.version.description || '등록된 설명이 없어요.'}</p>
              </div>
            </div>
            <div className={styles.detailAssets}>
              <h3>{detail.version.category === 'tile' ? '시공용 타일 텍스처' : '촬영 방향과 배치 이미지'}</h3>
              <div className={styles.thumbnailRow}>
                {(detail.version.category === 'tile'
                  ? detail.version.textureAssetIds.map((assetId, i) => ({
                      assetId,
                      direction: `텍스처 ${i + 1}`,
                    }))
                  : [
                      ...(detail.version.coverAssetId
                        ? [{ assetId: detail.version.coverAssetId, direction: '대표 이미지' }]
                        : []),
                      // A retired 위·아래 photo is not shown as a direction photo.
                      ...detail.version.views.filter((view) => !isRetiredDirection(view.direction)),
                    ]
                ).map((view, i) => (
                  <div key={`${view.assetId}-${i}`}>
                    <AssetImage assetId={view.assetId} alt={view.direction} />
                    <p>{view.direction}</p>
                  </div>
                ))}
              </div>
            </div>
            <footer className={styles.formFooter}>
              <span className="muted">기존 프로젝트의 모습은 자재 수정으로 바뀌지 않아요.</span>
              <div className={styles.toolbar}>
                <button
                  className="btn"
                  disabled={!writable || !!busy}
                  onClick={() => void duplicate(detail.version)}
                >
                  새 공용 자재로 복제
                </button>
                {detail.material.scope === 'personal' && (
                  <button
                    className="btn primary"
                    disabled={!writable}
                    onClick={() => {
                      setForm(detail.version);
                      setDetail(undefined);
                    }}
                  >
                    정보 수정
                  </button>
                )}
              </div>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}
