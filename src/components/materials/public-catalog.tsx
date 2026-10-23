'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  ImageOff,
  Layers3,
  RotateCcw,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { useAccess } from '../app-provider';
import type { PublicMaterial } from '@/lib/catalog/public';
import { effectiveFacets, emptyFacets, hasFacets } from '@/lib/catalog/facets';
import { pageSearchParams, type MaterialPage, type MaterialPageQuery } from '@/lib/catalog/paging';
import { LoadMore } from './load-more';
import { useMaterialPages, useSettled, useVisible } from './use-material-pages';
import { categoryLabels } from '@/lib/types';
import WorkspaceNav from '@/components/workspace-nav';
import { MaterialFacets } from './material-facets';
import { noteServiceAnswer, serviceLimitMessage } from '@/lib/service-limit-notice';
import styles from './public-catalog.module.css';

function MaterialImage({
  src,
  alt,
  tile = false,
  eager = false,
}: {
  src?: string;
  alt: string;
  tile?: boolean;
  eager?: boolean;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [failedSource, setFailedSource] = useState<string>();
  // A card asks for its image only once it is on screen (the browser's lazy loading reads far ahead).
  const [seen, setSeen] = useState(eager);
  useVisible(frame, () => setSeen(true), { enabled: !seen });
  const failed = !!src && failedSource === src;
  return (
    <div className={styles.imageFrame} data-kind={tile ? 'tile' : 'product'} ref={frame}>
      {src && !failed ? (
        seen && <img src={src} alt={alt} onError={() => setFailedSource(src)} />
      ) : (
        <div className={styles.imageFallback}>
          <ImageOff size={28} strokeWidth={1.4} aria-hidden="true" />
          <span>{failed ? '이미지를 불러오지 못했어요' : '등록된 이미지가 없어요'}</span>
        </div>
      )}
    </div>
  );
}

function dimensions(material: PublicMaterial) {
  const values = [material.widthMm, material.heightMm, material.depthMm].filter((value) => value > 0);
  return values.length
    ? values.map((value) => value.toLocaleString('ko-KR')).join(' × ') + ' mm'
    : '규격 미지정';
}

function MaterialDetail({
  material,
  member,
  onClose,
}: {
  material: PublicMaterial;
  member: boolean;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [selectedImage, setSelectedImage] = useState(0);
  useEffect(() => {
    const node = dialog.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    node?.showModal();
    return () => {
      node?.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  const selected = material.images[selectedImage];
  return (
    <dialog
      ref={dialog}
      className={styles.detailDialog}
      aria-label="자재 상세"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={styles.detailBody}>
        <div className={styles.detailTop}>
          <span>
            <Layers3 size={17} aria-hidden="true" /> 자재 상세
          </span>
          <button className={styles.closeButton} onClick={onClose} aria-label="닫기" autoFocus>
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        <div className={styles.detailLayout}>
          <div className={styles.gallery}>
            <div className={styles.detailMainImage}>
              <MaterialImage
                src={selected?.url}
                alt={material.name + (selected?.label ? ' · ' + selected.label : '')}
                tile={material.category === 'tile'}
                eager
              />
            </div>
            {material.images.length > 1 && (
              <div className={styles.thumbnails} aria-label="자재 이미지 선택">
                {material.images.map((image, index) => (
                  <button
                    key={image.url}
                    className={styles.thumbnail}
                    aria-label={'이미지 ' + (index + 1) + ' · ' + image.label}
                    aria-pressed={selectedImage === index}
                    onClick={() => setSelectedImage(index)}
                  >
                    <MaterialImage src={image.url} alt={image.label} tile={material.category === 'tile'} />
                  </button>
                ))}
              </div>
            )}
            <p className={styles.imageNote}>화면의 색상과 질감은 실제 자재와 다를 수 있어요.</p>
          </div>
          <div className={styles.detailInfo}>
            <span className={styles.kind}>{categoryLabels[material.category]}</span>
            <p className={styles.brand}>{material.brand || '브랜드 미지정'}</p>
            <h2>{material.name}</h2>
            {material.description && <p className={styles.description}>{material.description}</p>}
            <dl className={styles.specifications}>
              {[
                ['브랜드', material.brand],
                [
                  '분류',
                  [categoryLabels[material.category], material.subcategoryName].filter(Boolean).join(' · '),
                ],
                ['색상', material.color],
                ['재질', material.composition],
                ['마감', material.finish],
                ['규격', dimensions(material)],
                ['제품 코드', material.code],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value || '미지정'}</dd>
                </div>
              ))}
            </dl>
            <Link className="btn primary" href={member ? '/' : '/try'}>
              {member ? '프로젝트 시작하기' : '빈 공간으로 체험하기'}{' '}
              <ArrowRight size={16} aria-hidden="true" />
            </Link>
            <p className={styles.imageNote}>공간을 연 뒤 자재 라이브러리에서 선택해 배치하세요.</p>
          </div>
        </div>
      </div>
    </dialog>
  );
}

async function fetchPublicPage(query: MaterialPageQuery, signal: AbortSignal) {
  const response = await fetch('/api/catalog/materials?' + pageSearchParams(query), {
    signal,
    cache: 'no-store',
  });
  const data = await response.json();
  // A spent daily limit says when the list comes back (and shows the banner).
  const limit = noteServiceAnswer(response.ok, data, 'db');
  if (limit) throw new Error(serviceLimitMessage(limit));
  if (!response.ok) throw new Error(data.error ?? '자재 목록을 불러오지 못했어요.');
  return data as MaterialPage<PublicMaterial>;
}

export default function PublicCatalog() {
  const access = useAccess();
  const member = !!access.userId && !access.expired;
  const [query, setQuery] = useState(''),
    [category, setCategory] = useState(''),
    [facets, setFacets] = useState(emptyFacets),
    [detail, setDetail] = useState<PublicMaterial>();
  const grid = useRef<HTMLDivElement>(null);
  const search = useSettled(query);
  const listQuery: MaterialPageQuery = {
    ...(category ? { category: category as MaterialPageQuery['category'] } : {}),
    ...(search.trim() ? { q: search } : {}),
    ...(hasFacets(facets) ? { facets } : {}),
    options: true,
  };
  const pages = useMaterialPages(fetchPublicPage, listQuery, JSON.stringify(listQuery));
  const rows = pages.items;
  const options = pages.facets ?? emptyFacets();
  const activeFacets = effectiveFacets(facets, options);
  const loading = pages.status === 'loading' && !rows.length;
  const error = !rows.length && pages.status === 'error' ? pages.error : '';
  const filtered = !!query.trim() || !!category || hasFacets(activeFacets);
  function clearFilters() {
    setQuery('');
    setCategory('');
    setFacets(emptyFacets());
  }
  return (
    <div className="home-shell">
      <WorkspaceNav active="materials" />
      <main className={'home-main ' + styles.main}>
        <header className={styles.heading}>
          <div>
            <p className="eyebrow">공간을 채우는 재료</p>
            <h1>내 공간을 완성할 자재</h1>
            <p className={styles.intro}>
              타일의 질감부터 제품의 형태까지, 공간에 어울리는 자재를 찾아보세요.
            </p>
          </div>
          <Link className="btn primary" href={member ? '/' : '/try'}>
            {member ? '프로젝트 만들기' : '빈 공간으로 체험하기'} <ArrowRight size={16} aria-hidden="true" />
          </Link>
        </header>
        <section className={styles.filters} aria-label="자재 검색 및 필터">
          <div className={styles.filterFields}>
            <label className={styles.searchField}>
              <span>자재 검색</span>
              <span className={styles.searchInput}>
                <Search size={18} aria-hidden="true" />
                <input
                  className="input"
                  value={query}
                  placeholder="이름, 브랜드, 색상, 재질"
                  onChange={(event) => setQuery(event.target.value)}
                />
              </span>
            </label>
            <label className={styles.categoryField}>
              <span>
                <SlidersHorizontal size={14} aria-hidden="true" /> 제품 종류
              </span>
              <select
                className="input"
                value={category}
                onChange={(event) => setCategory(event.target.value)}
              >
                <option value="">전체</option>
                {Object.entries(categoryLabels).map(([key, value]) => (
                  <option key={key} value={key}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <MaterialFacets className="mt-5" options={options} value={facets} onChange={setFacets} />
          <div className={styles.filterSummary}>
            <p role="status" aria-live="polite">
              {loading ? (
                '자재를 불러오는 중…'
              ) : error ? (
                '자재 연결을 확인해 주세요.'
              ) : (
                <>
                  전체 <strong>{(pages.total ?? rows.length).toLocaleString('ko-KR')}</strong>개 중{' '}
                  {rows.length.toLocaleString('ko-KR')}개
                </>
              )}
            </p>
            {filtered && (
              <button className={styles.resetButton} onClick={clearFilters}>
                <RotateCcw size={14} aria-hidden="true" /> 조건 초기화
              </button>
            )}
          </div>
        </section>
        {loading ? (
          <div className={styles.grid} aria-hidden="true">
            {Array.from({ length: 6 }, (_, index) => (
              <div className={styles.skeleton} key={index}>
                <div />
                <span />
                <span />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className={styles.empty} role="alert">
            <div className={styles.stateIcon}>
              <ImageOff size={26} aria-hidden="true" />
            </div>
            <h2>자재 목록을 불러오지 못했어요.</h2>
            <p>{error}</p>
            <button className="btn" onClick={pages.retry}>
              <RotateCcw size={16} aria-hidden="true" /> 다시 시도
            </button>
          </div>
        ) : !rows.length && !filtered ? (
          <div className={styles.empty}>
            <div className={styles.stateIcon}>
              <Layers3 size={26} aria-hidden="true" />
            </div>
            <h2>아직 등록된 자재가 없어요.</h2>
            <p>
              자재가 등록되면 이곳에서 이미지와 규격을 확인할 수 있어요.
              <br />
              먼저 빈 공간을 만들어 크기와 구도를 살펴보세요.
            </p>
            <Link className="btn" href={member ? '/' : '/try'}>
              {member ? '프로젝트 만들기' : '빈 공간으로 체험하기'}{' '}
              <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </div>
        ) : !rows.length ? (
          <div className={styles.empty}>
            <div className={styles.stateIcon}>
              <Search size={26} aria-hidden="true" />
            </div>
            <h2>조건에 맞는 자재가 없어요.</h2>
            <p>검색어·제품 종류·사이즈·색상·표면 조건을 바꿔보세요.</p>
          </div>
        ) : (
          <div className={styles.grid} ref={grid}>
            {rows.map((row) => (
              <button className={styles.card} key={row.id} data-page-item onClick={() => setDetail(row)}>
                <div className={styles.cardImage}>
                  <MaterialImage
                    src={row.images[0] && row.images[0].url + '&size=list'}
                    alt={row.name}
                    tile={row.category === 'tile'}
                  />
                  <span className={styles.imageKind}>{categoryLabels[row.category]}</span>
                  <span className={styles.cardArrow}>
                    <ArrowUpRight size={18} aria-hidden="true" />
                  </span>
                </div>
                <div className={styles.cardBody}>
                  <p className={styles.brand}>{row.brand || '브랜드 미지정'}</p>
                  <h2>{row.name}</h2>
                  <p className={styles.dimensions}>{dimensions(row)}</p>
                  <p className={styles.attributes}>
                    {[row.subcategoryName, row.color, row.composition, row.finish]
                      .filter(Boolean)
                      .join(' · ') || '상세 정보를 확인해 보세요'}
                  </p>
                </div>
              </button>
            ))}
            <LoadMore
              pages={pages}
              focusItem={(index) => grid.current?.querySelectorAll<HTMLElement>('[data-page-item]')[index]}
            />
          </div>
        )}
      </main>
      {detail && (
        <MaterialDetail
          key={detail.id}
          material={detail}
          member={member}
          onClose={() => setDetail(undefined)}
        />
      )}
    </div>
  );
}
