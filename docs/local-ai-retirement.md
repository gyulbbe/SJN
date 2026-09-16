# 기존 개발 PC AI 경로 제거

2026-09-16 사용자 요청으로 Qwen/Ollama 및 Python·CUDA MoGe를 실행하던 앱 경로를 제거했다.

## 현재 실행

- 설비 분석: Cloudflare Workers AI Gemma. 서버 AI 바인딩과 sjn-gateway 사용.
- 공간 형상: 사용자 브라우저 MoGe-2 ONNX. WebGPU 우선, WASM CPU 대체 실행.
- 영역 분류: 기존 브라우저 DeepLab 유지.
- 정밀 분석 진입점: cloud-quality.ts. 공통 분석 코어에 실제 공급자들을 명시적으로 전달한다.
- `/reconstruction-lab`은 `/reconstruction-performance`로 이동한다.

## 제거 범위

기존 모델 실행 서버, 로컬 geometry HTTP 클라이언트, CUDA Python 실행기, GPU 점유 관리 코드, 로컬 전용 실험 화면 및 해당 서버 전용 테스트와 npm 실행 명령을 제거했다. 환경 예시의 SJN_GEOMETRY 설정도 제거했다.

오래된 `/api/reconstruction/local`, `/api/reconstruction/local/geometry`, `/api/reconstruction-lab/engine`은 410과 local_ai_retired를 반환한다. 사진을 새 공급자로 전달하지 않는다. 기존 로컬 프로필로 직접 요청해도 재선택 오류를 반환한다. 선택 UI에서는 현재 AI 정밀 분석과 사진 전송 안내를 보여주며, 사용자 실행 전 추론하지 않는다.

## 저장 결과와 비교 자료

저장된 프로젝트, 사진, 분석 결과는 삭제하지 않았다. 과거 결과의 모델 식별자·데이터 계약과 오프라인 재계산 코드는 읽기 호환성을 위해 남긴다. 공통 코어의 기본 의존성은 새 AI 실행을 거부하며, 새 분석은 Cloudflare 진입점으로만 실행한다. 과거 실험 보고서는 당시 기록이다.

브라우저 구현과 비교하는 Python 수치 대조 도구는 개발 검증용이며 서비스 실행 경로가 아니다. 순수 평면 추출 참조는 tests/helpers/moge-plane-reference.py에 있다. 사용자의 PC에 설치된 Ollama/Python 환경이나 다운로드된 모델 파일은 시스템 공유 자산일 수 있으므로 이번 소스 정리에서 삭제하지 않았다.

## 검증

검증 결과:

- 타입 검사와 lint 통과.
- 전체 단위 테스트: 196파일, 2,977개 통과.
- 실제 Chrome + 격리된 로컬 Worker의 프로필·이전 프로젝트 전환·리다이렉트 E2E: 7개 통과. AI 상태 응답만 모의 처리했으며 추론 요청은 하지 않았다.
- Cloudflare용 vinext 빌드 통과. 기존 개발 서버가 루트 dist를 점유하여 tmp/local-ai-retirement-build의 소스 사본에서 검증했다. 루트 dist는 이전 빌드일 수 있으므로 배포 전에 개발 서버를 종료하고 다시 빌드해야 한다.

실제 Cloudflare AI 호출, 커밋·푸시 및 배포는 수행하지 않았다. 이 검증은 모델 인식 품질이나 새 배포 완료를 의미하지 않는다.

수정 전 소스·테스트·문서는 tmp/local-ai-retirement-backup-20260916-211124.zip에 보관했다.
