'use client';
import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { FolderOpen, Grid2X2, Layers, FlaskConical, Menu, X, LogOut, Settings2 } from 'lucide-react';
import { StorageBadge, useAccess } from './app-provider';
import AdminLinks from './admin/admin-links';
import { useSharedCatalogAdmin } from './materials/shared-access';

export default function WorkspaceNav({
  active,
  onLogin,
}: {
  active: 'home' | 'materials';
  onLogin?: () => void;
}) {
  const access = useAccess();
  const isAdmin = useSharedCatalogAdmin();
  const signedIn = access.ready && !!access.userId && !access.expired;
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const toggle = useRef<HTMLButtonElement>(null);
  const contentId = useId();
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
      setOpen(false);
      toggle.current?.focus();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [open]);
  function beginLogin() {
    if (open) toggle.current?.focus();
    setOpen(false);
    onLogin?.();
  }
  return (
    <aside className="app-nav studio-nav" aria-label="작업 공간 탐색">
      <div className="studio-nav-heading">
        <Link href="/" className="brand" onClick={() => setOpen(false)}>
          <span className="brand-mark">
            <Layers size={21} />
          </span>
          공간미리<span className="beta">BETA</span>
        </Link>
        <button
          ref={toggle}
          className="icon-btn studio-menu-toggle"
          aria-label={open ? '메뉴 닫기' : '메뉴 열기'}
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => setOpen(!open)}
        >
          {open ? <X size={22} /> : <Menu size={22} />}
        </button>
      </div>
      <div id={contentId} className={'studio-nav-content' + (open ? ' is-open' : '')}>
        <div className="nav-section">{signedIn ? '나의 작업 공간' : '공간 체험'}</div>
        <nav
          aria-label="주 메뉴"
          onClick={(event) => {
            if ((event.target as Element).closest('a')) setOpen(false);
          }}
        >
          <Link
            href="/"
            className={'nav-item' + (active === 'home' ? ' active' : '')}
            aria-current={active === 'home' ? 'page' : undefined}
          >
            <FolderOpen size={18} />
            {signedIn ? '내 프로젝트' : '시작하기'}
          </Link>
          <Link
            href="/materials"
            className={'nav-item' + (active === 'materials' ? ' active' : '')}
            aria-current={active === 'materials' ? 'page' : undefined}
          >
            <Grid2X2 size={18} />
            자재 라이브러리
          </Link>
          {signedIn && (
            <Link href="/reconstruction-lab" className="nav-item">
              <FlaskConical size={18} />
              사진 재구성 테스트
            </Link>
          )}
        </nav>
        <div className="nav-bottom">
          {isAdmin && (
            <nav className="studio-admin-nav" aria-label="관리자 메뉴">
              <span className="nav-section">관리</span>
              <Link href="/admin/materials" className="nav-item">
                <Settings2 size={18} />
                관리자 자재 관리
              </Link>
              <Link href="/admin/catalog" className="nav-item">
                분류 관리
              </Link>
              <AdminLinks className="nav-item" />
            </nav>
          )}
          {signedIn ? (
            <>
              <StorageBadge />
              <p>로그인 계정에 작업을 저장해요.</p>
              <button
                className="btn studio-signout"
                onClick={async () => {
                  setError('');
                  try {
                    await access.signOut();
                  } catch {
                    setError('로그아웃하지 못했어요. 다시 시도해 주세요.');
                  }
                }}
              >
                <LogOut size={16} />
                로그아웃
              </button>
              {error && (
                <p role="alert" className="error">
                  {error}
                </p>
              )}
            </>
          ) : (
            <>
              <p>
                나만의 공간을 만들고
                <br />
                마음에 들면 저장하세요.
              </p>
              {onLogin ? (
                <button className="btn primary" onClick={beginLogin}>
                  로그인 / 회원가입
                </button>
              ) : (
                <Link className="btn primary" href="/login">
                  로그인 / 회원가입
                </Link>
              )}
            </>
          )}
          <span className="version">공간미리 · 나의 리모델링 작업실</span>
        </div>
      </div>
    </aside>
  );
}
