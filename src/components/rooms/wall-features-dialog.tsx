'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ROOM_FACE_NAMES } from '@/lib/room-geometry';
import type { RoomDefinition } from '@/lib/room-types';
import { WALL_FEATURE_KIND_NAMES as kindNames, withKind } from '@/lib/wall-feature-editing';
import {
  validateWallFeatures,
  WALL_FEATURE_MAX_COUNT,
  WALL_FEATURE_MAX_DEPTH_MM,
  type WallFeatureV1,
} from '@/lib/wall-features';
import { WallFeatureFieldInputs } from './wall-feature-tool';
import styles from './wall-features-dialog.module.css';

// The same names as the canvas card: the back wall is the 정면 벽 everywhere else in the app.
const faceNames = { back: ROOM_FACE_NAMES.back, left: ROOM_FACE_NAMES.left, right: ROOM_FACE_NAMES.right };
type Props = {
  room: RoomDefinition;
  initial: readonly WallFeatureV1[];
  targetName: string;
  onApply: (features: WallFeatureV1[]) => void;
  onClose: () => void;
};

export default function WallFeaturesDialog({ room, initial, targetName, onApply, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [features, setFeatures] = useState<WallFeatureV1[]>(() => structuredClone([...initial]));
  const [selectedId, setSelectedId] = useState(initial[0]?.id ?? '');
  const [failure, setFailure] = useState('');
  const selected = features.find((feature) => feature.id === selectedId);
  const issues = validateWallFeatures(room, features);
  useEffect(() => {
    const element = dialog.current;
    const focus = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    element?.showModal();
    return () => {
      element?.close();
      document.body.style.overflow = overflow;
      focus?.focus();
    };
  }, []);
  function replace(next: WallFeatureV1) {
    setFeatures((previous) => previous.map((feature) => (feature.id === next.id ? next : feature)));
    setFailure('');
  }
  function add(kind: WallFeatureV1['kind']) {
    if (features.length >= WALL_FEATURE_MAX_COUNT) return;
    const widthMm = Math.min(600, room.widthMm / 3);
    const base = {
      version: 1 as const,
      id: crypto.randomUUID(),
      source: 'user' as const,
      face: 'back' as const,
      leftMm: (room.widthMm - widthMm) / 2,
      topMm: room.heightMm / 3,
      widthMm,
      depthMm: 200,
    };
    const next: WallFeatureV1 =
      kind === 'closed-niche'
        ? { ...base, kind, heightMm: Math.min(500, room.heightMm / 3) }
        : { ...base, kind };
    setFeatures((previous) => [...previous, next]);
    setSelectedId(next.id);
    setFailure('');
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (issues.length) return;
    try {
      onApply(structuredClone(features));
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    }
  }
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="wall-feature-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <form onSubmit={submit} noValidate>
        <header className={styles.header}>
          <div>
            <small>{targetName}</small>
            <h2 id="wall-feature-title">벽 구조 편집</h2>
          </div>
          <button type="button" className="btn" onClick={onClose}>
            닫기
          </button>
        </header>
        <div className={styles.body}>
          <p>
            벽 안쪽으로 들어간 홈과 후퇴 공간을 설정해요. 입력한 값은 사용자 설정이며 실측값이나 AI 인식
            결과로 표시하지 않아요.
          </p>
          <div className={styles.actions}>
            <button
              type="button"
              className="btn"
              disabled={features.length >= WALL_FEATURE_MAX_COUNT}
              onClick={() => add('closed-niche')}
            >
              벽 홈 추가
            </button>
            <button
              type="button"
              className="btn"
              disabled={features.length >= WALL_FEATURE_MAX_COUNT}
              onClick={() => add('floor-alcove')}
            >
              후퇴 공간 추가
            </button>
            <span>
              {features.length}/{WALL_FEATURE_MAX_COUNT}
            </span>
          </div>
          {!features.length ? (
            <p className={styles.hint}>설정한 벽 구조가 없어요. 기본 벽과 바닥은 유지돼요.</p>
          ) : (
            <>
              <label className="field">
                편집할 구조
                <select
                  className="input"
                  value={selectedId}
                  onChange={(event) => setSelectedId(event.target.value)}
                >
                  {features.map((feature, index) => (
                    <option key={feature.id} value={feature.id}>
                      {index + 1}. {faceNames[feature.face]} · {kindNames[feature.kind]}
                    </option>
                  ))}
                </select>
              </label>
              {selected && (
                <>
                  <div className={styles.fields}>
                    <label className="field">
                      설치 벽
                      <select
                        className="input"
                        value={selected.face}
                        onChange={(event) =>
                          replace({ ...selected, face: event.target.value as WallFeatureV1['face'] })
                        }
                      >
                        {Object.entries(faceNames).map(([face, name]) => (
                          <option key={face} value={face}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      형태
                      <select
                        className="input"
                        value={selected.kind}
                        onChange={(event) =>
                          replace(withKind(selected, event.target.value as WallFeatureV1['kind'], room))
                        }
                      >
                        {Object.entries(kindNames).map(([kind, name]) => (
                          <option key={kind} value={kind}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <WallFeatureFieldInputs
                      key={selected.id + selected.kind}
                      feature={selected}
                      room={room}
                      onChange={replace}
                    />
                  </div>
                  <p className={styles.hint}>
                    왼쪽은 방 안에서 이 벽을 마주 봤을 때의 왼쪽이에요(정면 벽은 왼쪽 모서리, 왼쪽 벽은 입구
                    쪽 모서리, 오른쪽 벽은 정면 벽 쪽 모서리부터). 단위는 mm이며 깊이는 최대{' '}
                    {WALL_FEATURE_MAX_DEPTH_MM}mm까지 지원해요.{' '}
                    {selected.kind === 'floor-alcove' && '윗면에서 바닥까지 열려요.'}
                  </p>
                  <button
                    type="button"
                    className="btn danger"
                    onClick={() => {
                      const next = features.filter((feature) => feature.id !== selected.id);
                      setFeatures(next);
                      setSelectedId(next[0]?.id ?? '');
                      setFailure('');
                    }}
                  >
                    선택한 구조 삭제
                  </button>
                </>
              )}
            </>
          )}
          {!!issues.length && (
            <div role="alert" className={styles.error}>
              {[...new Set(issues.map((issue) => issue.message))].join(' ')}
            </div>
          )}
          {failure && (
            <p role="alert" className={styles.error}>
              {failure}
            </p>
          )}
        </div>
        <footer className={styles.footer}>
          <button className="btn" type="button" onClick={onClose}>
            취소
          </button>
          <button className="btn primary" type="submit" disabled={!!issues.length}>
            적용하고 공간 보기
          </button>
        </footer>
      </form>
    </dialog>
  );
}
