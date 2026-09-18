'use client';
import Link from 'next/link';
import Image from 'next/image';
import { useEffect, useState } from 'react';
import { ArrowRight, FolderOpen, LockKeyhole, Plus } from 'lucide-react';
import { BASE_ROOM_IMAGE } from '@/lib/base-room';
import LoginPrompt from './login-prompt';
import WorkspaceNav from '@/components/workspace-nav';

export default function GuestHome({ onNewProject }: { onNewProject: () => void }) {
  const [feature, setFeature] = useState('');
  const [draftExists, setDraftExists] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let dead = false;
    void import('@/lib/guest/session').then(({ readGuestDraft }) => {
      try {
        const draft = readGuestDraft();
        if (!dead) setDraftExists(!!draft);
      } catch (reason) {
        if (!dead) setError(reason instanceof Error ? reason.message : '임시 작업을 확인하지 못했어요.');
      }
    });
    return () => {
      dead = true;
    };
  }, []);
  async function resetDraft() {
    if (!window.confirm('이 탭의 임시 체험 작업을 삭제할까요? 계정에 저장한 프로젝트는 바뀌지 않아요.'))
      return;
    try {
      const { clearGuestDraft } = await import('@/lib/guest/session');
      clearGuestDraft();
      setDraftExists(false);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '체험 초기화에 실패했어요.');
    }
  }
  return (
    <div
      className="home-shell guest-home"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files.length) setFeature('사진 업로드·공간 재구성');
      }}
      onPaste={(e) => {
        if (e.clipboardData.files.length) {
          e.preventDefault();
          setFeature('사진 업로드·공간 재구성');
        }
      }}
    >
      <WorkspaceNav active="home" onLogin={() => setFeature('프로젝트 저장')} />
      <main className="home-main">
        <div className="page-heading">
          <div>
            <div className="eyebrow">나의 리모델링 작업실</div>
            <h1>내 공간에서 시작하세요.</h1>
            <p>로그인 없이 빈 공간을 만들고, 마음에 드는 자재를 배치해 보세요.</p>
          </div>
          <div className="page-heading-actions">
            <button className="btn" onClick={() => setFeature('프로젝트 저장')}>
              로그인 / 회원가입
            </button>
            <button className="btn primary" onClick={onNewProject}>
              <Plus size={18} />새 프로젝트
            </button>
          </div>
        </div>
        {error && (
          <p role="alert" className="error notice">
            {error} <button onClick={() => void resetDraft()}>체험 초기화</button>
          </p>
        )}
        <section className="start-card">
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
            <span className="eyebrow">로그인 없이 시작</span>
            <h2>빈 공간부터 꾸며보세요</h2>
            <p>
              가로·깊이·높이를 입력하고 타일과 제품을 배치해요.
              <br />
              마음에 들면 로그인해서 내 프로젝트로 저장하세요.
            </p>
            <div className="start-actions">
              <button className="btn primary" onClick={onNewProject}>
                기본 공간으로 시작
                <ArrowRight size={17} />
              </button>
              <button className="btn" onClick={() => setFeature('사진으로 Before/After 만들기')}>
                <LockKeyhole size={17} />
                사진으로 시작
              </button>
              <Link className="btn" href="/materials">
                자재 둘러보기
              </Link>
            </div>
            <small className="start-hint">
              견적과 속성 조절·시안 비교는 체험할 수 있어요. 사진 분석·저장·다운로드는 로그인이 필요해요.
            </small>
          </div>
          <div className="start-steps">
            <span>
              <b>01</b>공간 크기 입력
            </span>
            <span>
              <b>02</b>자재 검색·배치
            </span>
            <span>
              <b>03</b>로그인하고 저장
            </span>
            <small>기본 크기는 2.4 × 2.4 × 2.4m예요.</small>
          </div>
        </section>
        {draftExists && (
          <section className="panel guest-resume">
            <div>
              <h2>체험하던 공간이 있어요</h2>
              <p>로그인 전 임시 작업이며 탭을 닫으면 사라질 수 있어요.</p>
            </div>
            <Link className="btn primary" href="/try">
              체험 이어가기
            </Link>
          </section>
        )}
        <section className="empty-projects">
          <FolderOpen size={29} />
          <h3>내 프로젝트로 보관하세요</h3>
          <p>로그인하면 작업을 저장하고 사진 비교와 내보내기도 이용할 수 있어요.</p>
          <button className="btn" onClick={() => setFeature('내 프로젝트')}>
            로그인 / 회원가입
          </button>
        </section>
      </main>
      {feature && <LoginPrompt feature={feature} resumeGuest={draftExists} onClose={() => setFeature('')} />}
    </div>
  );
}
