# 15장 품질 개선 기록 — 023 온도 대조와 남은 원인

2026-09-15. **전체 재구성 품질은 아직 미달이며, 이번에는 운영 코드를 변경하지 않았다.** 채택된 019와 모든 원본·기존 결과를 보존했다.

## 이번 실제 결과

승인된 기존 Qwen3-VL 4B Q4 모델로 15장을 두 조건(temperature 0.7 / 0)에서 각각 새로 분석했다. 사진·프롬프트·스키마·seed 등 나머지 요청은 정확히 같다. 30회 모두 응답·파싱에 성공했고 총 242.207초가 걸렸다. 매회 모델 로딩을 포함한 개발 PC 기록이며 일반 사용자 PC, OCI, Cloudflare 성능이 아니다. 종료 시 모델 residency가 비어 있고 추론 lease도 해제됐다. RAM/VRAM 최고치는 이번에 측정하지 않았다.

원본 15장과 양쪽 관측, 원응답 30개를 직접 확인했다. pc-02와 additional-08의 거짓 벽장 후보 감소는 인정한다. 그러나 remote-01의 door 영역이 사진 전체로 커지고, 벽걸이 세면대의 cabinet 지지 오류, 반사·불투명 벽의 오분류, 실제 구획 누락은 계속된다. 추가07의 작은 타원형 대상은 원본 확대 후에도 실재·반사·장식 여부를 확정하지 못했으므로 확정 오검출로 세지 않았다.

**온도 0은 미채택이다.** 이번은 설비 관측 단계의 비교이며 새로운 15장 3D 출력이 아니다. 잘 나온 사진만 골라 결합하지 않았고, 관측 수나 JSON 성공률을 품질 점수로 쓰지 않았다.

- [원본/양쪽 관측 확대 비교](../test-results/reconstruction-fifteen-rebuild/20260915-start/sampling-temperature-actual-2026-09-15T12-19-31.304Z/visual-review/comparison.html)
- [사진별 직접 검토](../test-results/reconstruction-fifteen-rebuild/20260915-start/sampling-temperature-actual-2026-09-15T12-19-31.304Z/root-review.md)
- [실제 실행 횟수·시간·보존 감사](../test-results/reconstruction-fifteen-rebuild/20260915-start/sampling-temperature-actual-2026-09-15T12-19-31.304Z/execution-audit.md)
- [독립 품질 검토](../test-results/reconstruction-fifteen-rebuild/20260915-start/sampling-temperature-actual-2026-09-15T12-19-31.304Z/independent-review.md)

## 원인 조사에서 확인한 것

remote-04 세면대는 계획→장면 저장 과정에서 위치가 바뀐 것이 아니었다. 배치 점수가 사진상의 맞춤보다 유리의 앞뒤 관계를 우선한다. 다만 현재 관계 계약은 physical room depth만 말하고 카메라 광학축/중심점을 명시하지 않아, 계산축을 임의로 바꾸는 것을 확정 버그 수정으로 채택하지 않았다.

remote-04의 낮은 벽은 실제 관측 목록에 없다. remote-05의 벽 후퇴 공간은 실제 구조 관측도 비어 있고 Scene의 형상 표현도 없다. 두 문제를 분리해 닫힌 홈·바닥까지 열린 후퇴 공간의 저장/렌더/복사/undo/출력 설계를 남겼다. 구현하거나 수동 구조를 넣어 자동 인식 성공으로 제시한 것은 아니다.

## 일반 사용자 PC와 다음 비교

추천 후보는 Cloudflare Workers AI의 Gemma 4 26B-A4B 이미지 분석이다. 사용자 PC에 이 모델을 내려받지 않고 서버에서 실행할 수 있지만, 깊이 추정·배치·모형 렌더를 전부 대신하지는 않는다. 실제 15장 품질과 처리량은 아직 검증하지 않았다. 외부 사진 전송과 새 모델에 대한 기존 승인 질문은 답변 대기 중이며, 이번에 사진을 외부로 보내지 않았다.

Workers Free는 계정 전체 하루 10,000 Neurons까지이며 초과 요청은 실패한다. Paid는 초과 과금이 가능하다. OCI는 현재 Always Free 안내상 A1 2 OCPU/12GB, 유료 tenancy 가격표의 무료 할당은 월 3,000 OCPU시간/18,000 GB시간이다. 실제 계정 조건을 확인해야 한다. OCI의 Qwen3-VL 2B Q4는 더 작은 실행 후보일 뿐 기존4B보다 품질이 좋거나 충분히 빠르다는 검증 결과가 아니다.

[Cloudflare 모델](https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/), [무료/과금 조건](https://developers.cloudflare.com/workers-ai/platform/pricing/), [OCI Always Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm), [OCI 가격표](https://www.oracle.com/cloud/price-list/).

## 검사 범위

실험 실행기의 모의 경계 검사 13개와 실제 30응답/15쌍 입력·요청 SHA 감사를 통과했다. 원본과 보호한 소스·입력·응답 파일은 보존됐다. 운영 소스 변경이 없어 이전 2,336 테스트·lint·타입·Next/vinext 빌드를 반복하지 않았다. 기존 통과 기록은 사진 품질 통과를 대신하지 않는다. 이번에 새 브라우저 3D 렌더·저장·다운로드 회귀나 서버 배포 검증을 했다고 보고하지 않는다.
