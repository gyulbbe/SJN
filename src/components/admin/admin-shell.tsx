'use client';
import Link from 'next/link';
import styles from './admin.module.css';
export default function AdminShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className={styles.shell}>
      <nav className={styles.nav} aria-label="관리자 메뉴">
        <Link href="/">내 프로젝트</Link>
        <Link href="/materials">자재 둘러보기</Link>
        <Link href="/admin/materials">자재 관리</Link>
        <Link href="/admin/catalog">분류 관리</Link>
        <Link href="/admin/users">회원 관리</Link>
        <Link href="/admin/projects">전체 프로젝트</Link>
        <Link href="/admin/ai-usage">AI 사용량</Link>
      </nav>
      <h1>{title}</h1>
      {children}
    </main>
  );
}
