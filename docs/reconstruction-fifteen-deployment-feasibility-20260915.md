# 일반 사용자 PC를 위한 재구성 실행 위치 검토

2026-09-15. 전체 15장 품질 목표는 **미달**이다. 이번 결과는 새 모델 채택이나 클라우드 배포 완료를 의미하지 않는다. 기존 운영 소스, 원본 사진, 채택된 019 결과는 유지했다.

## 추천과 무료 범위

사진 속 설비 종류·설치 관계를 읽는 첫 비교 후보는 Cloudflare Workers AI의 `@cf/google/gemma-4-26b-a4b-it`이다. 공식 문서에서 이미지 입력 지원과 입력/출력 요금 $0.10/$0.30 per million tokens를 확인했다. 사용자 PC에서 이 모델을 내려받을 필요 없이 서버에서 실행할 수 있다. 깊이 추정·설비 배치·표준 모형 렌더링을 모두 대신하는 모델은 아니다.

Workers Free의 무료 할당량은 계정 전체 하루 10,000 Neurons이며 초과 요청은 실패한다. Workers Paid에서는 무료 할당량 초과분이 과금된다. 사진 한 장당 호출 수와 실제 소비량을 측정하지 않았으므로 하루 처리 사진 수는 아직 제시하지 않는다. 사용자 사진의 외부 전송, 새 모델 도입, 실제 배포는 승인 전이다.

OCI Always Free 문서는 현재 A1 ARM 2 OCPU/12GB에 해당하는 월 1,500 OCPU-hours/9,000 GB-hours를 안내한다. 별도 공식 가격표는 유료 tenancy의 무료 사용량을 월 3,000 OCPU-hours/18,000 GB-hours(약 상시 4 OCPU/24GB)로 명시한다. 실제 계정 한도를 확인해야 하며 유료 계정의 초과 사용에는 과금 가능성이 있다. 무료 GPU는 이 구성에 포함되지 않는다.

OCI의 소형 시각언어 모델 비교 후보로 `qwen3-vl:2b-instruct-q4_K_M`(다운로드 패키지 1.9GB)이 있지만, 패키지 크기는 실행 RAM 요구량이 아니다. 기존 4B보다 인식 품질이 좋아진다는 근거는 없고 실제 OCI 속도·동시접속은 미검증이다.

## 기존 MoGe CPU 실제 확인

별도 실험 사본에서 기존 설치 Python/PyTorch와 `Ruicheng/moge-2-vits-normal` 가중치로 한 번의 CPU 추론에 성공했다. 모델·환경을 새로 설치하지 않았다.

- 입력: 기존 pc-01 관측과 SHA256이 동일한 399×501 이미지.
- 개발 PC: AMD64 물리 8/논리 16코어. PyTorch intraop 4스레드, interop 1, FP32. OCI 하드웨어 재현이 아니다.
- 모델 추론 7.588초, 모델 로딩 0.605초, 프로세스 시작부터 종료 17.652초.
- 해당 Python 프로세스 메모리 최고 2,364,370,944 bytes(약 2.20GiB). 전체 시스템·동시 사용자 메모리가 아니다.
- 기존 GPU 출력 대비 깊이 상대차 평균 0.0371%, 법선 각도차 평균 0.01948°. 모델 출력 간 비교이며 실측 공간 정확도가 아니다.
- CUDA 초기화 없음, 네트워크 시도 0, 보호한 입력·모델·운영 소스 변경 0.
- 미실행: semantic 평면 추출, 전체 앱 CPU 경로, 일반 사용자 PC, OCI ARM, 동시접속 부하.

상세 로그: `test-results/reconstruction-fifteen-rebuild/20260915-start/moge-cpu-one-actual-2026-09-15T11-48-38.918Z/report.md` 및 같은 폴더의 result.json/memory-samples.json/stdout.log/stderr.log.

## 15장 실제 렌더 비교와 채택 여부

기존 AI 관측을 재사용해 두 가지 대조 실험을 각각 15장 × 기존/후보로 렌더링했다. 새로운 15장 AI 추론이라고 보고하지 않는다.

1. 021: 사진 기준 정면 방향 해석 변경. 5장의 출력이 바뀌었고 10장은 동일했다. 일부 세면대 방향은 개선됐지만 유리 위치와 변기 잘림 등의 퇴행이 있어 미채택.
2. 022: MoGe 정보를 strict/estimated 배치 양쪽에서 완전히 제외. 5장의 출력이 바뀌었고 10장은 동일했다. 일부 사진에서 카메라·배치가 달라져 설비가 작고 멀어지는 문제가 생겨 미채택.

각 실험의 기존 조건 PNG 45장은 채택된 019와 바이트 단위로 같았다. 두 실험 모두 원본/기존/후보 이미지를 직접 확인했고 독립 검토를 남겼다. 각 30조건의 After는 빈 공간이었고 동일 조건의 Before/After 카메라는 같았다. 시간 81.169초/77.424초는 소프트웨어 WebGL 렌더·입출력을 포함한 실험 시간이며 AI 추론 시간이나 클라우드 성능이 아니다.

기둥 세면대가 떠 보이는 의심도 실제 메시 좌표로 점검했다. 6조건에서 기둥 최저점과 바닥 차이는 0mm였다. 이를 근거 없이 기둥 길이나 높이 보정으로 처리하지 않았다. 떠 보이는 시각적 원인은 별도로 남아 있다.

운영 코드 변경이 없는 이번 실험 때문에 전체 빌드를 반복하지 않았다. 마지막 운영 검증의 2,336 단위 테스트, lint, 타입 검사, Next.js/vinext 빌드 통과 기록은 유지되며 그 뒤 566개 소스 해시의 변경 없음도 확인했다. 이는 사진 재구성 품질 통과와 별개다.

## 다음 단계

Cloudflare 사진 전송과 새 모델 비교 승인이 오면 무료 계정·잔여 한도를 확인하고, 첫 파일럿을 포함한 총 15회 관측 비교부터 수행한다. 설치 종류·가림·설치 벽 오류가 줄었는지 확인한 뒤 전체 배치 결과까지 검증한다. OCI는 실제 A1에서 기존 MoGe와 필요한 분석 단계를 따로 측정해야 한다. 두 클라우드 방식 모두 아직 실제 구동 성공으로 보고할 수 없다.

## 공식 자료

- https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/
- https://developers.cloudflare.com/workers-ai/platform/pricing/
- https://ai.google.dev/gemma/apache_2
- https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
- https://www.oracle.com/cloud/price-list/
- https://ollama.com/library/qwen3-vl:2b-instruct-q4_K_M
- https://docs.ollama.com/linux
