'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { ReconstructionAnalysisProfile } from '@/lib/reconstruction/quality-contract';
import styles from './reconstruction.module.css';

export type AnalysisProfileSelection = { profile: ReconstructionAnalysisProfile; ready: boolean };
type Availability = { checking: boolean; available: boolean; reason: string };
const initial: Availability = { checking: true, available: false, reason: '' };
export default function AnalysisProfilePicker({
  initialProfile,
  disabled = false,
  onChange,
}: {
  initialProfile?: ReconstructionAnalysisProfile;
  disabled?: boolean;
  onChange: (selection: AnalysisProfileSelection) => void;
}) {
  const name = useId();
  const [profile, setProfile] = useState<ReconstructionAnalysisProfile>(
    initialProfile === 'local-quality-v1' ? 'cloud-browser-v1' : (initialProfile ?? 'browser-basic'),
  );
  const selected = useRef(profile),
    userSelected = useRef(false);
  const [refresh, setRefresh] = useState(0),
    [cloud, setCloud] = useState(initial);
  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(55000)]);
    setCloud(initial);
    onChange({ profile: selected.current, ready: selected.current === 'browser-basic' });
    async function status(url: string): Promise<Availability> {
      try {
        const response = await fetch(url, { signal, cache: 'no-store', credentials: 'same-origin' });
        const body = await response.json();
        return {
          checking: false,
          available: response.ok && body.available === true,
          reason:
            typeof body.reason === 'string'
              ? body.reason
              : typeof body.error === 'string'
                ? body.error
                : '분석 연결을 확인해 주세요.',
        };
      } catch (error) {
        return {
          checking: false,
          available: false,
          reason: error instanceof Error ? error.message : '연결을 확인하지 못했어요.',
        };
      }
    }
    async function check() {
      const cloudStatus = await status('/api/reconstruction/cloud').then((value) =>
        typeof Worker === 'undefined' || typeof WebAssembly === 'undefined'
          ? {
              checking: false,
              available: false,
              reason: '이 브라우저는 형상 분석 실행 환경을 지원하지 않아요.',
            }
          : value,
      );
      if (controller.signal.aborted) return;
      setCloud(cloudStatus);
      const next =
        !userSelected.current && initialProfile === undefined
          ? cloudStatus.available
            ? 'cloud-browser-v1'
            : 'browser-basic'
          : selected.current;
      selected.current = next;
      setProfile(next);
      onChange({
        profile: next,
        ready: next === 'browser-basic' || cloudStatus.available,
      });
    }
    void check();
    return () => controller.abort();
  }, [initialProfile, onChange, refresh]);
  function choose(next: ReconstructionAnalysisProfile) {
    userSelected.current = true;
    selected.current = next;
    setProfile(next);
    onChange({
      profile: next,
      ready: next === 'browser-basic' || cloud.available,
    });
  }
  const entries: {
    value: ReconstructionAnalysisProfile;
    title: string;
    description: string;
    unavailable: boolean;
  }[] = [
    {
      value: 'cloud-browser-v1',
      title: 'AI 정밀 분석',
      unavailable: cloud.checking || !cloud.available,
      description:
        '설비 분석용 사진은 Cloudflare로 전송해요. 깊이·벽·바닥 형상은 이 기기에서 MoGe로 계산해요. 처음 실행할 때 약 141MB 모델을 받아요.',
    },
    {
      value: 'browser-basic',
      title: '브라우저 기본 분석',
      unavailable: false,
      description: '사진을 외부 AI로 보내지 않아요. 유리·반사와 가려진 설치 위치는 직접 확인해 주세요.',
    },
  ];
  return (
    <fieldset
      disabled={disabled}
      className={styles.note}
      style={{ margin: '16px 0', border: '1px solid #dfe8e2' }}
    >
      <legend style={{ padding: '0 6px', fontWeight: 700 }}>사진 분석 방식</legend>
      {initialProfile === 'local-quality-v1' && (
        <p>
          기존 로컬 분석이 종료되어 AI 정밀 분석으로 바뀌었어요. 새로 분석하면 사진을 Cloudflare로 전송해요.
        </p>
      )}
      <div style={{ display: 'grid', gap: 12 }}>
        {entries.map((entry) => (
          <label key={entry.value} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <input
              type="radio"
              name={name}
              value={entry.value}
              checked={profile === entry.value}
              disabled={entry.unavailable}
              onChange={() => choose(entry.value)}
              onClick={() => {
                if (selected.current === entry.value) choose(entry.value);
              }}
            />
            <span>
              <strong>{entry.title}</strong>
              <br />
              {entry.description}
            </span>
          </label>
        ))}
      </div>
      <p role="status" aria-live="polite" style={{ margin: '10px 0' }}>
        {cloud.checking
          ? '서버 설비 분석 연결을 확인하고 있어요…'
          : cloud.available
            ? '서버 연결을 확인했어요. 형상 모델은 시작 버튼을 누를 때 준비하며, GPU 실행이 어려우면 CPU로 시도해요.'
            : 'AI 정밀 분석 연결: ' + cloud.reason}
      </p>
      {profile !== 'browser-basic' && !cloud.available && !cloud.checking && (
        <p>선택한 분석을 유지했어요. 연결을 복구하거나 브라우저 기본 분석을 직접 선택해 주세요.</p>
      )}
      <button
        type="button"
        className="btn small"
        disabled={disabled || cloud.checking}
        onClick={() => setRefresh((value) => value + 1)}
      >
        분석 연결 다시 확인
      </button>
    </fieldset>
  );
}
