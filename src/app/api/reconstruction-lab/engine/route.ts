/** Retired local AI endpoint: never forwards a photo to a different provider. */
function retired() {
  return Response.json(
    {
      available: false,
      code: 'local_ai_retired',
      reason: '기존 로컬 AI 분석은 종료됐어요. AI 정밀 분석에서 Gemma와 브라우저 MoGe를 사용해 주세요.',
      error: '기존 로컬 AI 분석은 종료됐어요.',
    },
    { status: 410, headers: { 'Cache-Control': 'no-store' } },
  );
}
export { retired as GET, retired as POST };
