/** Older clients cannot select a retired storage backend or bypass Google/D1 access. */
export function retiredStorageRoute() {
  return Response.json(
    { error: '이전 저장 API는 종료됐어요. 새로고침한 뒤 Google 계정으로 로그인해 주세요.' },
    { status: 410, headers: { 'Cache-Control': 'private, no-store' } },
  );
}
