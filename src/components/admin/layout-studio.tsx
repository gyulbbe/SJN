'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useAccess } from '@/components/app-provider';
import Editor from '@/components/editor/editor';
import { RepositoryProvider } from '@/components/repository-context';
import RoomDialog from '@/components/rooms/room-dialog';
import { createManagedLayout, loadManagedLayouts, overwriteManagedLayout } from '@/lib/catalog/client';
import type { PublicPlacement } from '@/lib/catalog/placement-contract';
import { getActiveDesign } from '@/lib/designs';
import { useEditor } from '@/lib/editor-store';
import { MAX_LAYOUT_ITEMS, type ManagedLayout } from '@/lib/fixture-layout-contract';
import { layoutItemsFromScene, layoutNotes, placeLayout } from '@/lib/fixture-layouts';
import { prepareLayoutItems } from '@/lib/fixture-layouts-client';
import { createLayoutStudioSession } from '@/lib/guest/session';
import { DEFAULT_ROOM } from '@/lib/room-geometry';
import type { RoomDefinition } from '@/lib/room-types';

type Session = NonNullable<
  Awaited<ReturnType<ReturnType<typeof createLayoutStudioSession>['openGuestSession']>>
>;
const noLogin = { requestLogin: () => {} };

/**
 * A room of its own to place a 기본 배치 in: the project editor over a working room in memory (public
 * products only, nothing saved until 저장, no project in D1). `?id=` opens a layout; none makes a new one.
 */
export default function LayoutStudio() {
  const { userId } = useAccess();
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null),
    [askRoom, setAskRoom] = useState(false),
    [target, setTarget] = useState<{ id: string; revision: number } | null>(null),
    [name, setName] = useState(''),
    [saved, setSaved] = useState({ name: '', editRevision: 0 }),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [error, setError] = useState('');
  const started = useRef(false);

  async function openRoom(room: RoomDefinition, layout?: ManagedLayout, placements: PublicPlacement[] = []) {
    const manager = createLayoutStudioSession();
    await manager.createGuestDraft(room);
    let opened = (await manager.openGuestSession())!;
    let notes: string[] = [];
    if (layout) {
      manager.rememberPlacements(placements);
      const reading = await prepareLayoutItems(layout, placements, {}, opened.repositories);
      const document = structuredClone(opened.draft.document);
      const scene = getActiveDesign(document)!.scene;
      const placed = placeLayout({
        room,
        aspect: scene.imageWidth / scene.imageHeight,
        registeredRoom: layout.room,
        items: reading.prepared,
        kept: [],
        materials: reading.materials,
        newId: () => crypto.randomUUID(),
      });
      scene.fixtures = placed.fixtures;
      await manager.checkpointGuestDraft(document);
      opened = (await manager.openGuestSession())!;
      notes = layoutNotes({
        replaced: 0,
        missing: reading.missing,
        otherPhoto: reading.otherPhoto,
        tooBig: placed.tooBig,
        crowded: placed.crowded,
      });
    }
    setSaved({ name: layout?.name ?? '', editRevision: opened.draft.document.editRevision });
    setSession(opened);
    setNotice(notes.join(' '));
  }
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const id = new URLSearchParams(window.location.search).get('id');
    if (!id) {
      setAskRoom(true);
      return;
    }
    void (async () => {
      try {
        const { layouts, placements } = await loadManagedLayouts(userId);
        const layout = layouts.find((candidate) => candidate.id === id);
        if (!layout) throw new Error('이 기본 배치를 찾지 못했어요. 목록에서 다시 열어 주세요.');
        setTarget({ id: layout.id, revision: layout.revision });
        setName(layout.name);
        await openRoom(
          {
            kind: 'parametric',
            version: 1,
            widthMm: Math.round(layout.room.widthMm),
            depthMm: Math.round(layout.room.depthMm),
            heightMm: Math.round(layout.room.heightMm),
          },
          layout,
          placements,
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [userId]);

  const editRevision = useEditor((state) =>
    state.project?.id === session?.draft.document.id ? state.project?.editRevision : undefined,
  );
  const dirty =
    !!session && (name !== saved.name || (editRevision !== undefined && editRevision !== saved.editRevision));
  useEffect(() => {
    if (!dirty) return;
    const before = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', before);
    return () => window.removeEventListener('beforeunload', before);
  }, [dirty]);
  const back = () => {
    if (dirty && !window.confirm('저장하지 않은 변경이 있어요. 저장하지 않고 나갈까요?')) return;
    router.push('/admin/layouts');
  };
  async function save() {
    if (!session) return;
    setError('');
    setNotice('');
    const trimmed = name.trim();
    if (!trimmed) {
      setError('이름을 입력해 주세요.');
      return;
    }
    setBusy(true);
    try {
      useEditor.getState().commit();
      const project = useEditor.getState().project!;
      const scene = getActiveDesign(project)!.scene;
      const { versions } = await session.repositories.materials.getVersions(
        scene.fixtures.map((fixture) => fixture.materialVersionId),
      );
      const { items, refused, asPhoto } = layoutItemsFromScene(
        scene,
        Object.fromEntries(versions.map((version) => [version.id, version])),
      );
      if (refused.length) throw new Error(`공용이 아닌 제품은 저장할 수 없어요: ${refused.join(', ')}`);
      if (!items.length) throw new Error('먼저 제품을 놓아 주세요.');
      if (items.length > MAX_LAYOUT_ITEMS)
        throw new Error(`제품은 ${MAX_LAYOUT_ITEMS}개까지 담을 수 있어요.`);
      const room = {
        widthMm: scene.room!.widthMm,
        depthMm: scene.room!.depthMm,
        heightMm: scene.room!.heightMm,
      };
      if (target) {
        await overwriteManagedLayout({ ...target, name: trimmed, items, room }, userId);
        setTarget({ id: target.id, revision: target.revision + 1 });
      } else {
        const { id } = await createManagedLayout(
          { name: trimmed, sortOrder: null, active: true, items, room },
          userId,
        );
        setTarget({ id, revision: 1 });
        window.history.replaceState(null, '', `/admin/layouts/studio?id=${id}`);
      }
      setName(trimmed);
      setSaved({ name: trimmed, editRevision: project.editRevision });
      setNotice(
        asPhoto.length
          ? `저장했어요. 표준 모형으로 보는 제품은 사진 제품으로 저장돼요: ${asPhoto.join(', ')}`
          : '',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  if (askRoom)
    return (
      <RoomDialog
        initial={DEFAULT_ROOM}
        mode="create"
        onClose={() => router.push('/admin/layouts')}
        onApply={async (room) => {
          await openRoom(room);
          setAskRoom(false);
        }}
      />
    );
  if (!session)
    return (
      <main className="guest-setup">
        {error ? (
          <>
            <p role="alert" className="error">
              {error}
            </p>
            <Link className="btn" href="/admin/layouts">
              기본 배치 목록으로
            </Link>
          </>
        ) : (
          <p role="status">기본 배치를 준비하고 있어요…</p>
        )}
      </main>
    );
  return (
    <div className="guest-workspace" data-testid="layout-studio">
      {(notice || error) && (
        <div role={error ? 'alert' : 'status'} className={error ? 'error notice' : 'notice'}>
          {error || notice}
        </div>
      )}
      <RepositoryProvider value={session.repositories}>
        <Editor
          key={session.draft.document.id}
          id={session.draft.document.id}
          guestContext={noLogin}
          layoutStudio={{
            onBack: back,
            bar: (
              <>
                <div className="top-project">
                  <input
                    className="editor-title"
                    aria-label="기본 배치 이름"
                    placeholder="기본 배치 이름"
                    maxLength={100}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                  <span className="save-state" data-testid="layout-save-status">
                    {busy
                      ? '저장 중…'
                      : dirty
                        ? '저장하지 않은 변경이 있어요'
                        : target
                          ? '저장됨 · 이용자에게 보여요'
                          : '제품을 놓고 이름을 넣어 저장하세요'}
                  </span>
                </div>
                <button
                  type="button"
                  className="btn primary shrink-0"
                  data-testid="layout-save"
                  disabled={busy}
                  onClick={() => void save()}
                >
                  저장
                </button>
              </>
            ),
          }}
        />
      </RepositoryProvider>
    </div>
  );
}
