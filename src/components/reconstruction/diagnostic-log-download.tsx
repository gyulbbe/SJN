'use client';
import { useEffect, useRef, useState } from 'react';
import {
  readDiagnosticArchive,
  type DiagnosticArchiveEntry,
} from '@/lib/reconstruction/lab-diagnostic-storage';

export default function DiagnosticLogDownload({
  className,
  records,
}: {
  className?: string;
  records?: DiagnosticArchiveEntry[];
}) {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const urls = useRef(new Set<string>());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const activeUrls = urls.current,
      activeTimers = timers.current;
    return () => {
      activeTimers.forEach(clearTimeout);
      activeUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);
  async function download() {
    setBusy(true);
    setMessage('');
    try {
      const runs = records ?? (await readDiagnosticArchive());
      if (!runs.length) {
        setMessage(
          records
            ? '현재 관리자 편집에서 실행한 분석 기록이 없어요.'
            : '새로 실행한 분석부터 진단이 보관돼요. 아직 저장된 기록이 없어요.',
        );
        return;
      }
      const blob = new Blob(
        [
          JSON.stringify(
            {
              schemaVersion: 1,
              exportedAt: new Date().toISOString(),
              guide: {
                summary: 'runs[].report.diagnosticSummary',
                causes: 'runs[].report.diagnosticSummary.commonBlockers',
                candidateEvidence: 'runs[].report.candidateTraces',
                failedRun: 'runs[].failure.runLog',
                timing: 'runs[].report.runLog.events',
                note: '사진 본문은 포함하지 않아요. 원본 사진과 함께 전달하면 미검출도 대조할 수 있어요.',
              },
              runs,
            },
            null,
            2,
          ),
        ],
        { type: 'application/json' },
      );
      const url = URL.createObjectURL(blob);
      urls.current.add(url);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = '공간미리-재구성-진단로그.json';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      const timer = setTimeout(() => {
        URL.revokeObjectURL(url);
        urls.current.delete(url);
        timers.current.delete(timer);
      }, 15000);
      timers.current.add(timer);
      setMessage(
        records
          ? '현재 실행 기록을 내려받았어요. 관리자 편집 화면을 벗어나면 이 기록은 폐기돼요.'
          : runs.length + '회 실행 기록을 내려받았어요. 최근 20회·최대 25MB가 로그인 계정의 서버에 보관돼요.',
      );
    } catch (error) {
      setMessage(
        '진단 보관함을 읽지 못했어요. 현재 전체 보고서 JSON을 내려받아 주세요. ' +
          (error instanceof Error ? error.message : String(error)),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button type="button" className={className} disabled={busy} onClick={() => void download()}>
        {busy ? '진단 로그 준비 중' : '진단 로그 JSON'}
      </button>
      {message && <small role="status">{message}</small>}
    </>
  );
}
