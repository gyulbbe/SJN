# 025: 기존4B 모델의 접점 발견 단계 분리 검증

**일부 접점은 찾았지만 자동 재구성에는 채택하지 않았다. 15장 품질 목표는 여전히 미달이다.**

처음부터 홈/낮은벽의 종류와 깊이 증거를 모두 요구하던 질문을, 눈에 보이는 면의 꺾임·끝·가림 후보만 찾는 단계로 줄였다. 이전 dense fixed-region 확인과는 다른 미실행 가설임을 확인했다. 기존 승인 Qwen3-VL4B와 동일한 사진입력·설정으로4장에 한 번씩 실제 추론했고 평가기준은 응답 열람 전에 고정했다.

| 사진 | 실제 판정 |
|---|---|
| remote-04 | 낮은 벽/바닥의 접점 하나는 유효한 단서. 상단은 누락되고 물체 전체 박스가 섞임 |
| remote-05 | 왼쪽 홈 경계 근처를 잡았으나 천장이라고 설명. 오른쪽은 실제 돌아들어간 경계를 벗어남 |
| pc-02 | 빈 응답. 계약상 허용되지만 문틀/제품 경계가 없다는 뜻은 아님 |
| additional-06 | 가구 전체 영역·잘못된 면 접촉·거울 가림 설명·중복 문제 |

24개 영역/4개 유효JSON은 정확한 구조24개를 뜻하지 않는다. 사진별정답을 입력하지 않았고 잘못된 박스를 사람이 고쳐 자동결과로 넣지 않았다. 이 단계의 제한된 관측 이득을 새3D 품질 개선으로 보고하지 않았다. 새3D 렌더/운영적용0.

전체30.784초, 모델 API합30.295초, 출력1758토큰. 요청마다 keep_alive0이어서 로드 시간이 포함된다. 원본/정규화입력/계약/직접 의존소스 불변, 마지막 모델resident=[]/lease idle. peak RAM/VRAM과 이 실행의 GPU/CPU백엔드는 미측정이다. 새모델·외부전송0. 최종운영소스는024의2528검사 이후584파일SHA 동일하다.

[실행 영수증](C:/dev/SJN/test-results/reconstruction-fifteen-rebuild/20260915-start/surface-junction-actual-2026-09-15T14-18-03.256Z/execution-audit.md) · [root 검토](C:/dev/SJN/test-results/reconstruction-fifteen-rebuild/20260915-start/surface-junction-actual-2026-09-15T14-18-03.256Z/root-review.md) · [4장 위치 표시](C:/dev/SJN/test-results/reconstruction-fifteen-rebuild/20260915-start/surface-junction-actual-2026-09-15T14-18-03.256Z/root-box-review-four.jpg)

다음 우선 검증은 기존에 준비한 Cloudflare Gemma4 무료15장 비교다. 현재4B로는 절대 불가능하다는 결론은 내리지 않는다. 다만 같은 조건을 또 돌리는 대신 다른 모델이 실제 누락·오분류를 줄이는지 대조할 근거가 충분하다. 새모델/외부 사진 전송은 사용자의 명시적 승인 후에만 진행하며, 현재는 미승인이다.

[독립 검토](C:/dev/SJN/test-results/reconstruction-fifteen-rebuild/20260915-start/surface-junction-actual-2026-09-15T14-18-03.256Z/independent-review.md)도 두 핵심 사진 기준 미달로 판정했다. 실제 요청본문4개 해시와 보존 참조51개를 대조했다. 별도 검토는 source/raw 수정이나 추가 모델 실행 없이 완료했다.
