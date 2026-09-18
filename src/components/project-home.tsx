'use client';
import Link from 'next/link';
import WorkspaceNav from '@/components/workspace-nav';
import GuestHome from '@/components/guest/guest-home';
import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowUpRight,
  Plus,
  Copy,
  Trash2,
  FolderOpen,
  ArrowRight,
  Search,
  ImagePlus,
  Columns2 as Columns2Icon,
  FlaskConical,
} from 'lucide-react';
import { getRepositories } from '@/lib/repositories';
import { DEFAULT_COLOR, EMPTY_MASK, type LegacyProjectDocument, type ProjectSummary } from '@/lib/types';
import { importImage } from '@/lib/images';
import { BASE_ROOM_IMAGE } from '@/lib/base-room';
import { DEFAULT_ROOM, createRoomSurfaces } from '@/lib/room-geometry';
import { renderRoomBackground } from '@/lib/room-background';
import type { RoomDefinition } from '@/lib/room-types';
import RoomDialog from '@/components/rooms/room-dialog';
import ReconstructionDialog from '@/components/reconstruction/reconstruction-dialog';
import SummaryDesignThumbnail from '@/components/designs/summary-design-thumbnail';
import { AssetImage } from '@/components/materials/asset-image';
import { useAccess } from './app-provider';
export default function ProjectHome() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]),
    [projectsLoading, setProjectsLoading] = useState(true),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [search, setSearch] = useState(''),
    [roomOpen, setRoomOpen] = useState(false),
    [reconstructionOpen, setReconstructionOpen] = useState(false),
    [referenceFile, setReferenceFile] = useState<File | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const creating = useRef(false);
  const creationAttempt = useRef(0);
  const guestCreation = useRef<AbortController | null>(null);
  const router = useRouter();
  const { writable, ready, userId, expired } = useAccess();
  async function refresh() {
    setProjectsLoading(true);
    try {
      setProjects(await getRepositories().projects.list());
    } catch (e) {
      setError(String(e));
    } finally {
      setProjectsLoading(false);
    }
  }
  useEffect(() => {
    if (!ready || !userId || expired) {
      setProjects([]);
      return;
    }
    void refresh();
    const bc = new BroadcastChannel('gongganmiri');
    const attempts = creationAttempt;
    bc.onmessage = () => void refresh();
    return () => {
      bc.close();
      attempts.current++;
    };
  }, [ready, userId, expired]);
  useEffect(() => {
    const pending = guestCreation;
    return () => pending.current?.abort();
  }, []);
  function cancelRoom() {
    guestCreation.current?.abort();
    guestCreation.current = null;
    creationAttempt.current++;
    creating.current = false;
    setBusy(false);
    setRoomOpen(false);
  }
  async function create(file: File | null, room?: RoomDefinition) {
    if (!ready || !writable || !userId || creating.current) return;
    creating.current = true;
    const attempt = ++creationAttempt.current;
    const current = () => creationAttempt.current === attempt;
    setBusy(true);
    setError('');
    let navigating = false;
    try {
      if (room) {
        const rendered = await renderRoomBackground(room, { width: 4096, height: 2731 });
        if (!current()) return;
        file = new File([rendered.blob], '기본 공간.png', { type: 'image/png' });
      }
      if (!file) throw new Error('공간 사진을 선택해 주세요.');
      const repo = getRepositories();
      const { original, preview } = await importImage(file, 'original', repo.assets);
      if (!current()) return;
      const now = new Date().toISOString();
      const p: LegacyProjectDocument = {
        id: crypto.randomUUID(),
        ownerId: userId,
        name: room ? '기본 공간' : file.name.replace(/\.[^.]+$/, '') || '새 공간',
        schemaVersion: 1,
        editRevision: 0,
        storageRevision: 0,
        createdAt: now,
        updatedAt: now,
        scene: {
          originalAssetId: original.id,
          previewAssetId: preview.id,
          imageWidth: original.width,
          imageHeight: original.height,
          ...(room ? { room: structuredClone(room) } : {}),
          surfaces: room ? createRoomSurfaces(room, original.width / original.height) : [],
          protection: EMPTY_MASK(),
          fixtures: [],
          color: { ...DEFAULT_COLOR },
        },
        history: { past: [], future: [] },
        viewport: { zoom: 1, pan: { x: 0, y: 0 } },
      };
      await repo.projects.create(p);
      if (!current()) {
        await repo.projects.remove(p.id);
        return;
      }
      setRoomOpen(false);
      router.push(`/projects/${p.id}`);
      navigating = true;
    } catch (e) {
      if (!current()) return;
      if (room) throw e;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!navigating && current()) {
        creating.current = false;
        setBusy(false);
      }
    }
  }
  async function createRoom(room: RoomDefinition) {
    if (ready && userId && !expired) {
      if (!writable) throw new Error('계정에 저장할 준비가 되지 않았어요. 잠시 후 다시 시도해 주세요.');
      await create(null, room);
      return;
    }
    if (creating.current) return;
    creating.current = true;
    setBusy(true);
    const controller = new AbortController();
    guestCreation.current = controller;
    try {
      const { readGuestDraft, createGuestDraft } = await import('@/lib/guest/session');
      if (controller.signal.aborted) return;
      if (readGuestDraft() && !window.confirm('기존 체험 작업을 버리고 새 공간을 만들까요?')) return;
      await createGuestDraft(room, { replace: true, signal: controller.signal });
      if (controller.signal.aborted) return;
      setRoomOpen(false);
      router.push('/try');
    } catch (failure) {
      if (!controller.signal.aborted) throw failure;
    } finally {
      if (guestCreation.current === controller) {
        guestCreation.current = null;
        creating.current = false;
        setBusy(false);
      }
    }
  }
  function startFromPhoto(file: File | null = null) {
    if (!ready || !writable || busy) return;
    setReferenceFile(file);
    setReconstructionOpen(true);
  }
  async function action(id: string, kind: 'duplicate' | 'remove') {
    if (!writable) return;
    if (kind === 'remove' && !confirm('프로젝트를 삭제할까요? 이 작업은 되돌릴 수 없어요.')) return;
    try {
      const r = getRepositories();
      if (kind === 'duplicate') await r.projects.duplicate(id);
      else {
        await r.projects.remove(id);
        await r.assets.removeUnused();
      }
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }
  const matchingProjects = projects.filter((project) =>
    project.name.normalize('NFKC').toLowerCase().includes(search.normalize('NFKC').trim().toLowerCase()),
  );
  const home =
    !ready || !userId || expired ? (
      <GuestHome
        onNewProject={() => {
          setError('');
          setRoomOpen(true);
        }}
      />
    ) : (
      <div className="home-shell">
        <WorkspaceNav active="home" />
        <main className="home-main">
          <div className="page-heading">
            <div>
              <div className="eyebrow">나의 리모델링 작업실</div>
              <h1>내 공간에서 시작하세요.</h1>
              <p>사진은 Before로 준비하고, 새 디자인은 빈 After에서 시작하세요.</p>
            </div>
            <button
              className="btn primary"
              disabled={!ready || !writable || busy}
              onClick={() => {
                setError('');
                setRoomOpen(true);
              }}
            >
              <Plus size={18} />새 프로젝트
            </button>
          </div>
          <input
            ref={input}
            data-testid="project-upload"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            hidden
            onChange={(e) => {
              if (e.target.files?.[0]) void create(e.target.files[0]);
              e.target.value = '';
            }}
          />
          {error && (
            <div role="alert" className="error notice">
              {error}
            </div>
          )}
          <section
            className="start-card"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (e.dataTransfer.files[0]) startFromPhoto(e.dataTransfer.files[0]);
            }}
          >
            <div className="start-preview">
              <Image
                src={BASE_ROOM_IMAGE}
                loading="eager"
                width={1536}
                height={1024}
                unoptimized
                alt="벽과 바닥만 있는 빈 기본 공간 예시"
              />
              <span>기본 공간 예시</span>
            </div>
            <div className="start-copy">
              <span className="eyebrow">새 작업 시작</span>
              <h2>빈 공간부터 꾸며보세요</h2>
              <p>
                가로·깊이·높이를 입력해 나만의 빈 공간을 만들어요.
                <br />
                사진이 없으면 Before와 After 모두 빈 공간으로 시작해요.
              </p>
              <div className="start-actions">
                <button
                  className="btn"
                  disabled={!ready || !writable || busy}
                  onClick={() => startFromPhoto()}
                >
                  <Columns2Icon />
                  사진으로 비교 공간 만들기
                </button>
                <button
                  className="btn primary"
                  disabled={!ready || !writable || busy}
                  onClick={() => {
                    setError('');
                    setRoomOpen(true);
                  }}
                >
                  {busy ? '공간을 준비하고 있어요…' : '기본 공간으로 시작'}
                  <ArrowRight size={17} />
                </button>
                <Link href="/reconstruction-lab" className="btn">
                  <FlaskConical size={17} />
                  사진 재구성 테스트
                </Link>
              </div>
              <small className="start-hint">
                사진을 올리거나 끌어 놓으면 Before를 재구성하고 빈 After에서 시작해요. JPG · PNG · WebP / 최대
                25MB
              </small>
              <details style={{ marginTop: 14 }}>
                <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>
                  기존 사진 위에 직접 편집하기
                </summary>
                <button
                  className="text-button"
                  disabled={!ready || !writable || busy}
                  onClick={() => input.current?.click()}
                >
                  <ImagePlus size={15} /> 사진 위에 직접 편집
                </button>
              </details>
            </div>
            <div className="start-steps">
              <span>
                <b>01</b>기본 공간 또는 내 사진
              </span>
              <span>
                <b>02</b>자재를 골라 배치
              </span>
              <span>
                <b>03</b>비교하고 저장
              </span>
              <small>기본 크기는 2.4 × 2.4 × 2.4m예요.</small>
            </div>
          </section>
          <div className="section-heading">
            <h2>
              내 프로젝트 <span>{projects.length}</span>
            </h2>
            <label className="search-box">
              <Search size={16} />
              <input
                aria-label="프로젝트 검색"
                placeholder="프로젝트 검색"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
          </div>
          {projectsLoading && projects.length === 0 ? (
            <div className="empty-projects" role="status">
              프로젝트를 불러오고 있어요…
            </div>
          ) : projects.length === 0 ? (
            <div className="empty-projects">
              <FolderOpen size={29} strokeWidth={1.2} />
              <h3>첫 번째 공간을 기다리고 있어요</h3>
              <p>기본 공간으로 시작하거나 내 사진을 올려보세요.</p>
              <button
                className="btn primary"
                disabled={!ready || !writable || busy}
                onClick={() => setRoomOpen(true)}
              >
                새 공간 만들기
              </button>
            </div>
          ) : matchingProjects.length === 0 ? (
            <div className="empty-projects" role="status">
              <Search size={28} />
              <h3>검색한 프로젝트가 없어요</h3>
              <p>다른 이름으로 검색하거나 전체 프로젝트를 확인해 보세요.</p>
              <button className="btn" onClick={() => setSearch('')}>
                검색 초기화
              </button>
            </div>
          ) : (
            <div className="project-grid">
              {matchingProjects.map((p) => (
                <article className="project-card" key={p.id}>
                  <Link href={`/projects/${p.id}`} className="project-photo">
                    <SummaryDesignThumbnail
                      projectId={p.id}
                      designId={p.activeDesignId}
                      revision={p.activeDesignRevision}
                      sharedRevision={p.sharedRevision}
                      contextKey={p.designPreviewContextKey}
                      repositories={getRepositories()}
                      alt={p.name}
                      fallback={<AssetImage assetId={p.thumbnailAssetId || p.previewAssetId} alt={p.name} />}
                    />
                    <span className="photo-open">
                      편집하기 <ArrowUpRight size={15} />
                    </span>
                  </Link>
                  <div className="project-meta">
                    <Link href={`/projects/${p.id}`}>
                      <h3>{p.name}</h3>
                      <p>{new Date(p.updatedAt).toLocaleDateString('ko-KR')} 수정</p>
                    </Link>
                    <div className="row">
                      <button
                        className="icon-btn"
                        title="프로젝트 복제"
                        aria-label={`${p.name} 복제`}
                        disabled={!writable}
                        onClick={() => action(p.id, 'duplicate')}
                      >
                        <Copy size={16} />
                      </button>
                      <button
                        className="icon-btn"
                        title="프로젝트 삭제"
                        aria-label={`${p.name} 삭제`}
                        disabled={!writable}
                        onClick={() => action(p.id, 'remove')}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
          <footer className="home-footer">
            <span>
              기본 분석은 기기에서 실행해요. 정밀 분석을 선택하면 설비 분석용 사진을 Cloudflare로 전송해요.
            </span>
            <span>가상 시공 결과의 색상·치수·설치 가능 여부는 현장 확인이 필요합니다.</span>
          </footer>
        </main>
        {reconstructionOpen && (
          <ReconstructionDialog
            initialFile={referenceFile}
            onClose={() => setReconstructionOpen(false)}
            onCreated={(id) => router.push('/projects/' + id)}
          />
        )}
      </div>
    );
  return (
    <>
      {home}
      {roomOpen && (
        <RoomDialog initial={DEFAULT_ROOM} mode="create" onApply={createRoom} onClose={cancelRoom} />
      )}
    </>
  );
}
