'use client';
import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { DEFAULT_ROOM } from '@/lib/room-geometry';
import {
  runBrowserAnalysisTest,
  type BrowserAnalysisTestKind,
  type BrowserAnalysisTestResult,
} from '@/lib/reconstruction/browser-analysis-test';
import type { MogeBrowserResult, MogeExecutionMode } from '@/lib/reconstruction/moge-browser/client';

function useBlobUrl(blob?: Blob) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!blob) {
      setUrl('');
      return;
    }
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
}
function DensePreview({ result, kind }: { result: MogeBrowserResult; kind: 'depth' | 'normal' | 'planes' }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const { dense } = result,
      labels = result.planes?.labels;
    const width = kind === 'planes' && labels ? labels.width : dense.width,
      height = kind === 'planes' && labels ? labels.height : dense.height;
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return;
    const pixels = context.createImageData(width, height);
    const valid = Array.from(dense.depth)
      .filter((value, i) => dense.mask[i] && Number.isFinite(value))
      .sort((a, b) => a - b);
    const near = valid[Math.floor(valid.length * 0.02)] ?? 0,
      far = valid[Math.floor(valid.length * 0.98)] ?? 1;
    for (let i = 0; i < width * height; i++) {
      const at = i * 4;
      pixels.data[at + 3] = 255;
      if (kind === 'planes' && labels) {
        if (labels.floor[i] > 0) {
          pixels.data[at] = 54;
          pixels.data[at + 1] = 187;
          pixels.data[at + 2] = 116;
        } else if (labels.wall[i] > 0) {
          pixels.data[at] = 80 + (labels.wall[i] - 11) * 25;
          pixels.data[at + 1] = 108;
          pixels.data[at + 2] = 210 - (labels.wall[i] - 11) * 20;
        }
        continue;
      }
      if (!dense.mask[i]) continue;
      if (kind === 'normal')
        for (let channel = 0; channel < 3; channel++)
          pixels.data[at + channel] = Math.round((dense.normal[i * 3 + channel] + 1) * 127.5);
      else {
        const value = Math.max(0, Math.min(1, (dense.depth[i] - near) / Math.max(1e-6, far - near)));
        pixels.data[at] = 255 * value;
        pixels.data[at + 1] = 190 * (1 - value);
        pixels.data[at + 2] = 255 * (1 - value);
      }
    }
    context.putImageData(pixels, 0, 0);
  }, [result, kind]);
  return (
    <figure style={{ margin: 0 }}>
      <figcaption>
        {kind === 'depth'
          ? '추정 깊이 · 상대 색상'
          : kind === 'normal'
            ? '표면 법선'
            : '바닥·벽 관측 지지 영역'}
      </figcaption>
      <canvas
        ref={ref}
        aria-label={kind + ' preview'}
        style={{ width: '100%', height: 'auto', background: '#17212b' }}
      />
    </figure>
  );
}
export default function BrowserAnalysisLab() {
  const [file, setFile] = useState<File>(),
    [mode, setMode] = useState<MogeExecutionMode>('auto');
  const [kind, setKind] = useState<BrowserAnalysisTestKind>('geometry');
  const [result, setResult] = useState<BrowserAnalysisTestResult>(),
    [stage, setStage] = useState(''),
    [error, setError] = useState('');
  const [size, setSize] = useState({ widthMm: 2400, depthMm: 2400, heightMm: 2400 });
  const request = useRef<AbortController | null>(null),
    alive = useRef(true),
    selection = useRef(0);
  const [reading, setReading] = useState(false),
    [idleMessage, setIdleMessage] = useState('');
  const validSize =
    Number.isFinite(size.widthMm) &&
    size.widthMm >= 500 &&
    size.widthMm <= 20000 &&
    Number.isFinite(size.depthMm) &&
    size.depthMm >= 500 &&
    size.depthMm <= 20000 &&
    Number.isFinite(size.heightMm) &&
    size.heightMm >= 1000 &&
    size.heightMm <= 6000;
  const originalUrl = useBlobUrl(result?.original ?? file),
    beforeUrl = useBlobUrl(result?.before);
  useEffect(() => {
    alive.current = true;
    const pagehide = () => request.current?.abort();
    window.addEventListener('pagehide', pagehide);
    return () => {
      alive.current = false;
      pagehide();
      window.removeEventListener('pagehide', pagehide);
    };
  }, []);
  async function execute() {
    if (!file || reading || request.current || !validSize) return;
    const controller = new AbortController();
    request.current = controller;
    setError('');
    setIdleMessage('');
    setStage('사진 준비 중');
    const active = () => alive.current && request.current === controller && !controller.signal.aborted;
    try {
      const next = await runBrowserAnalysisTest(
        file,
        kind,
        { ...DEFAULT_ROOM, ...size },
        {
          mode,
          signal: controller.signal,
          onStage: (message) => {
            if (active()) setStage(message);
          },
        },
      );
      if (active()) setResult(next);
    } catch (failure) {
      if (active()) setError(failure instanceof Error ? failure.message : '분석에 실패했어요.');
      else if (alive.current && controller.signal.aborted) setIdleMessage('분석을 취소했어요.');
    } finally {
      if (request.current === controller) request.current = null;
      if (alive.current) setStage('');
    }
  }
  function download() {
    if (!result) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(result.report, null, 2)], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'sjn-browser-analysis.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <main className="container" style={{ maxWidth: 1250, margin: '0 auto', padding: 24 }}>
      <a href="/reconstruction-lab">← 사진 재구성 Lab</a>
      <h1>정밀 분석 성능 테스트</h1>
      <p>
        Gemma는 설비 분석용 사진을 Cloudflare로 전송해요. MoGe의 깊이·법선·벽·바닥 계산과 DeepLab 분할은 이
        기기에서 실행해요.
      </p>
      <p>
        테스트 결과는 프로젝트나 자재에 저장하지 않아요. 완료 단계와 모델은 이 브라우저의 캐시를 재사용할 수
        있어요.
      </p>
      <fieldset
        disabled={!!stage}
        style={{ display: 'flex', flexWrap: 'wrap', gap: 16, padding: 16, margin: '20px 0' }}
      >
        <legend>실제 모델 테스트</legend>
        <label>
          사진{' '}
          <input
            aria-label="테스트할 사진"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={async (event) => {
              const selected = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (!selected) return;
              const ticket = ++selection.current;
              setIdleMessage('');
              if (selected.size > 25 * 1024 * 1024) {
                setError('사진은 25MB 이하로 선택해 주세요.');
                setReading(false);
                return;
              }
              setReading(true);
              try {
                const bytes = await selected.arrayBuffer();
                if (alive.current && ticket === selection.current) {
                  setFile(new File([bytes], selected.name, { type: selected.type }));
                  setResult(undefined);
                  setError('');
                }
              } catch {
                if (alive.current && ticket === selection.current)
                  setError('파일을 읽지 못했어요. 사진을 다시 선택해 주세요.');
              } finally {
                if (alive.current && ticket === selection.current) setReading(false);
              }
            }}
          />
        </label>
        <label>
          분석{' '}
          <select
            aria-label="테스트 종류"
            value={kind}
            onChange={(event) => setKind(event.target.value as BrowserAnalysisTestKind)}
          >
            <option value="gemma">Gemma 설비 분석</option>
            <option value="geometry">MoGe 형상 + DeepLab</option>
            <option value="full">전체 분석 → Before 생성</option>
          </select>
        </label>
        <label>
          형상 실행{' '}
          <select
            aria-label="MoGe 실행 방식"
            disabled={kind === 'gemma'}
            value={mode}
            onChange={(event) => setMode(event.target.value as MogeExecutionMode)}
          >
            <option value="auto">자동 · GPU 우선</option>
            <option value="webgpu">WebGPU</option>
            <option value="wasm">WASM CPU</option>
          </select>
        </label>
        {(['widthMm', 'depthMm', 'heightMm'] as const).map((key, i) => (
          <label key={key}>
            {['가로', '깊이', '높이'][i]} (mm){' '}
            <input
              type="number"
              min={i === 2 ? 1000 : 500}
              max={i === 2 ? 6000 : 20000}
              step="100"
              value={size[key]}
              style={{ width: 90 }}
              onChange={(event) => setSize((value) => ({ ...value, [key]: Number(event.target.value) }))}
            />
          </label>
        ))}
      </fieldset>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <button
          className="btn primary"
          disabled={!file || reading || !!stage || !validSize}
          onClick={() => void execute()}
        >
          {error ? '실패한 단계부터 재시도' : '테스트 실행'}
        </button>
        {!!stage && (
          <button className="btn" onClick={() => request.current?.abort()}>
            취소
          </button>
        )}
        {result && (
          <button className="btn" onClick={download}>
            결과 JSON 다운로드
          </button>
        )}
      </div>
      <p role="status" aria-live="polite">
        {stage ||
          (reading
            ? '사진을 읽고 있어요.'
            : error
              ? '분석을 완료하지 못했어요.'
              : idleMessage || (result ? '분석 완료' : '실행 버튼을 눌렀을 때만 모델을 준비해요.'))}
      </p>
      {!validSize && <p role="alert">가로·깊이는 500~20,000mm, 높이는 1,000~6,000mm로 입력해 주세요.</p>}
      {error && (
        <p role="alert" className="error">
          {error} 기본 분석은 홈의 사진 생성 창에서 선택할 수 있어요.
        </p>
      )}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 250px), 1fr))',
          gap: 18,
        }}
      >
        {originalUrl && (
          <figure style={{ margin: 0 }}>
            <figcaption>원본</figcaption>
            <Image
              unoptimized
              src={originalUrl}
              width={700}
              height={700}
              alt="테스트 원본"
              style={{ width: '100%', height: 'auto' }}
            />
          </figure>
        )}
        {beforeUrl && (
          <figure style={{ margin: 0 }}>
            <figcaption>일반 생성 경로의 Before</figcaption>
            <Image
              unoptimized
              src={beforeUrl}
              width={1024}
              height={1024}
              alt="재구성 Before"
              style={{ width: '100%', height: 'auto' }}
            />
          </figure>
        )}
        {result?.geometry && (
          <>
            <DensePreview result={result.geometry} kind="depth" />
            <DensePreview result={result.geometry} kind="normal" />
            <DensePreview result={result.geometry} kind="planes" />
          </>
        )}
      </div>
      {result?.geometry && (
        <p>
          실행: {result.geometry.backend} · 모델:{' '}
          {result.geometry.cacheSource === 'network' ? '최초 다운로드' : '캐시 재사용'} · 추론{' '}
          {(result.geometry.timings.inferenceMs / 1000).toFixed(2)}초 · 전체{' '}
          {(result.geometry.timings.totalMs / 1000).toFixed(2)}초 · 실행 메모리: 측정 불가
        </p>
      )}
      {result && (
        <details open style={{ marginTop: 20 }}>
          <summary>모델·시간·사용량·관측 JSON</summary>
          <pre
            style={{
              maxHeight: 600,
              overflow: 'auto',
              padding: 16,
              background: '#eef3ef',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
            }}
          >
            {JSON.stringify(result.report, null, 2)}
          </pre>
        </details>
      )}
    </main>
  );
}
