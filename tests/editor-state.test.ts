import { getActiveDesign } from '../src/lib/designs';
import { beforeEach, describe, expect, it } from 'vitest';
import { useEditor } from '../src/lib/editor-store';
import { DEFAULT_COLOR, EMPTY_MASK, type LegacyProjectDocument as ProjectDocument } from '../src/lib/types';
function project(): ProjectDocument {
  return {
    id: 'p',
    ownerId: 'local',
    name: '테스트',
    schemaVersion: 1,
    editRevision: 0,
    storageRevision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    scene: {
      originalAssetId: 'a',
      previewAssetId: 'b',
      imageWidth: 800,
      imageHeight: 600,
      surfaces: [],
      fixtures: [],
      protection: EMPTY_MASK(),
      color: { ...DEFAULT_COLOR },
    },
    history: { past: [], future: [] },
    viewport: { zoom: 1, pan: { x: 0, y: 0 } },
  };
}
beforeEach(() => useEditor.getState().load(project()));
describe('편집 상태 계약', () => {
  it('Before/After와 선택 전환은 편집 상태와 revision을 바꾸지 않는다', () => {
    const st = useEditor.getState();
    st.change((s) => (s.color.exposure = 0.6));
    const before = structuredClone(useEditor.getState().project);
    st.setMode('before');
    st.select('arbitrary');
    st.setMode('after');
    expect(useEditor.getState().project).toEqual(before);
  });
  it('슬라이더의 여러 미리보기를 한 번의 명령으로 확정하고 undo/redo한다', () => {
    const st = useEditor.getState();
    st.preview((s) => (s.color.saturation = 0.5));
    st.preview((s) => (s.color.saturation = 0.3));
    expect(useEditor.getState().project!.editRevision).toBe(0);
    st.commit();
    expect(getActiveDesign(useEditor.getState().project!)!.history.past).toHaveLength(1);
    expect(getActiveDesign(useEditor.getState().project!)!.scene.color.saturation).toBe(0.3);
    st.undo();
    expect(getActiveDesign(useEditor.getState().project!)!.scene.color.saturation).toBe(1);
    expect(useEditor.getState().project!.editRevision).toBe(2);
    st.redo();
    expect(getActiveDesign(useEditor.getState().project!)!.scene.color.saturation).toBe(0.3);
    expect(useEditor.getState().project!.editRevision).toBe(3);
  });
  it('이전 저장 응답이 더 최신 편집을 덮어쓰거나 저장 완료로 표시하지 않는다', () => {
    const st = useEditor.getState();
    st.change((s) => (s.color.exposure = 0.2));
    const pending = structuredClone(useEditor.getState().project!);
    st.saving();
    st.change((s) => (s.color.exposure = 0.8));
    st.saved({ ...pending, storageRevision: 2 });
    expect(getActiveDesign(useEditor.getState().project!)!.scene.color.exposure).toBe(0.8);
    expect(useEditor.getState().project!.storageRevision).toBe(2);
    expect(useEditor.getState().saveStatus).toBe('dirty');
  });
  it('새 편집은 redo를 비우고 이력을 50개로 제한한다', () => {
    const st = useEditor.getState();
    for (let i = 0; i < 60; i++) st.change((s) => (s.color.exposure = i / 100));
    expect(getActiveDesign(useEditor.getState().project!)!.history.past).toHaveLength(50);
    st.undo();
    st.change((s) => (s.color.warmth = 0.1));
    expect(getActiveDesign(useEditor.getState().project!)!.history.future).toHaveLength(0);
  });
  it('줌 상태는 저장하되 편집 revision은 증가하지 않고 실패해도 장면을 유지한다', () => {
    const st = useEditor.getState();
    st.viewport(2, { x: 10, y: 20 });
    expect(useEditor.getState().project!.editRevision).toBe(0);
    const before = structuredClone(useEditor.getState().project);
    st.failed('용량 부족');
    expect(useEditor.getState().project).toEqual(before);
    expect(useEditor.getState().saveStatus).toBe('error');
  });
});
