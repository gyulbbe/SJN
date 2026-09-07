'use client';

import { useEffect, useRef, useState } from 'react';
import type { FixtureInstance, MaterialVersion, Scene, Surface } from '@/lib/types';
import { useEditor } from '@/lib/editor-store';
import { createReconstructionTile, updateReconstructionFixture } from '@/lib/reconstruction';
import { reconstructionLabels, type ReconstructionKind } from '@/lib/reconstruction/types';
import styles from './reconstruction.module.css';

export default function ReconstructionProperties({
  scene,
  fixture,
  surface,
  materials,
  onMaterialsChanged,
}: {
  scene: Scene;
  fixture?: FixtureInstance;
  surface?: Surface;
  materials: Record<string, MaterialVersion>;
  onMaterialsChanged: () => Promise<void>;
}) {
  const original = fixture?.reconstruction;
  const material = materials[surface?.materialVersionId || fixture?.materialVersionId || ''];
  const [kind, setKind] = useState<ReconstructionKind>((original?.kind as ReconstructionKind) || 'toilet');
  const [color, setColor] = useState(
    original?.color || (/^#[0-9a-f]{6}$/i.test(material?.color || '') ? material.color : '#ddddcf'),
  );
  const [width, setWidth] = useState(original?.widthMm || material?.widthMm || 300);
  const [height, setHeight] = useState(
    original?.heightMm || material?.heightMm || (surface?.kind === 'wall' ? 600 : 300),
  );
  const [depth, setDepth] = useState(original?.depthMm || 100);
  const [orientation, setOrientation] = useState<'back' | 'left' | 'right'>(original?.orientation || 'back');
  const [grout, setGrout] = useState(surface?.tile.groutWidth || 0);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  if (!scene.room || (!original && !surface)) return null;
  async function apply() {
    const state = useEditor.getState(),
      project = state.project;
    if (!project || state.draft || state.editing !== 'before' || busy) return;
    if (
      ![width, height, depth, grout].every(Number.isFinite) ||
      width < 1 ||
      height < 1 ||
      depth < 0 ||
      width > 20000 ||
      height > 6000 ||
      depth > 20000 ||
      grout < 0 ||
      grout > 15
    ) {
      setError('규격과 줄눈 범위를 확인해 주세요.');
      return;
    }
    setBusy(true);
    setError('');
    const current = () =>
      alive.current &&
      useEditor.getState().project?.id === project.id &&
      useEditor.getState().project?.editRevision === project.editRevision &&
      useEditor.getState().editing === 'before' &&
      !useEditor.getState().draft;
    try {
      if (fixture?.reconstruction) {
        const next = await updateReconstructionFixture(
          fixture,
          scene.room!,
          { kind, color, widthMm: width, heightMm: height, depthMm: depth, orientation },
          { aspect: scene.imageWidth / scene.imageHeight },
        );
        if (!current()) return;
        await onMaterialsChanged();
        if (!current()) return;
        useEditor.getState().change((s) => {
          const index = s.fixtures.findIndex((f) => f.id === fixture.id);
          if (index >= 0) s.fixtures[index] = next;
        });
      } else if (surface) {
        const version = await createReconstructionTile({
          color,
          kind: surface.kind,
          widthMm: width,
          heightMm: height,
          groutWidth: grout,
        });
        if (!current()) return;
        await onMaterialsChanged();
        if (!current()) return;
        useEditor.getState().change((s) => {
          const target = s.surfaces.find((v) => v.id === surface.id);
          if (target) {
            target.materialVersionId = version.id;
            target.tile.groutWidth = grout;
          }
        });
      }
    } catch (failure) {
      if (current()) setError(failure instanceof Error ? failure.message : '모형을 갱신하지 못했어요.');
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="property-section">
      <h4>{surface ? '기존 타일 색과 규격' : '재구성 모형 수정'}</h4>
      <p className="muted" style={{ fontSize: 11, marginBottom: 10 }}>
        사진을 참고해 조정하세요. 실제 상품 규격을 확인한 값은 아니에요.
      </p>
      {original?.appearanceAssetId && kind === original.kind && (
        <p className="muted" style={{ fontSize: 11, marginBottom: 10 }}>
          원본의 프레임·유리 디테일을 사용 중이에요. 색감은 아래 선택 자재의 밝기와 색감에서 조정하세요.
        </p>
      )}
      {original && (
        <label className={styles.control}>
          모형 종류
          <select
            aria-label="재구성 모형 종류"
            value={kind}
            onChange={(e) => setKind(e.target.value as ReconstructionKind)}
            disabled={busy || fixture?.locked}
          >
            {Object.entries(reconstructionLabels).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
      )}
      {original && fixture?.roomPlacement?.face === 'floor' && (
        <label className={styles.control}>
          기구가 놓인 벽 방향
          <select
            aria-label="재구성 설치 방향"
            value={orientation}
            disabled={busy || fixture?.locked}
            onChange={(e) => setOrientation(e.target.value as 'back' | 'left' | 'right')}
          >
            <option value="back">정면 벽</option>
            <option value="left">왼쪽 벽</option>
            <option value="right">오른쪽 벽</option>
          </select>
        </label>
      )}
      <fieldset disabled={busy || fixture?.locked} style={{ border: 0, padding: 0, margin: '10px 0' }}>
        <div className={styles.editGrid}>
          <label>
            대표 색상
            <input
              aria-label="재구성 대표 색상"
              disabled={!!original?.appearanceAssetId && kind === original.kind}
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
            />
          </label>
          <label>
            가로 (mm)
            <input
              aria-label="재구성 가로 (mm)"
              type="number"
              min="1"
              max="20000"
              value={width}
              onChange={(e) => setWidth(+e.target.value)}
            />
          </label>
          <label>
            높이 (mm)
            <input
              aria-label="재구성 높이 (mm)"
              type="number"
              min="1"
              max="6000"
              value={height}
              onChange={(e) => setHeight(+e.target.value)}
            />
          </label>
          {original ? (
            <label>
              깊이 (mm)
              <input
                aria-label="재구성 깊이 (mm)"
                type="number"
                min="0"
                max="20000"
                value={depth}
                onChange={(e) => setDepth(+e.target.value)}
              />
            </label>
          ) : (
            <label>
              줄눈 (mm)
              <input
                aria-label="재구성 줄눈 (mm)"
                type="number"
                min="0"
                max="15"
                step=".5"
                value={grout}
                onChange={(e) => setGrout(+e.target.value)}
              />
            </label>
          )}
        </div>
        <button
          className="btn small"
          style={{ marginTop: 10, width: '100%' }}
          disabled={busy}
          onClick={() => void apply()}
        >
          {busy ? '모형 준비 중…' : '재구성 설정 적용'}
        </button>
      </fieldset>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {original && (
        <p className="muted" style={{ fontSize: 11 }}>
          등록한 제품으로 바꾸려면 이 모형을 선택한 상태에서 왼쪽 자재 목록의 제품을 누르세요.
        </p>
      )}
    </section>
  );
}
