import type { Metadata } from 'next';
import './globals.css';
import { AppProvider, BackendGuard } from '@/components/app-provider';
export const metadata: Metadata = {
  title: '공간미리 — 사진으로 미리 보는 우리 공간',
  description: '내 공간 사진과 직접 등록한 자재로 만드는 인테리어 시뮬레이터',
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <AppProvider>
          <BackendGuard>{children}</BackendGuard>
        </AppProvider>
      </body>
    </html>
  );
}
