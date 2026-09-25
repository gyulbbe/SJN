# 내보내기 경로 추적(path tracing) 보류 결정 · 2026-09-26

## 무엇을 왜 시험했나

- **목표:** 3D 방 프로젝트의 내보내기 이미지를 실제 사진에 가깝게 만든다.
- **기존 방식의 한계:** 래스터 렌더는 CG처럼 보인다. FLUX AI 변환은 사진 같지만 자재·구도를 바꿀 수 있다.
- **대안:** 내보내기 때만 사용자 브라우저에서 경로 추적 렌더를 돌린다. 편집 화면은 그대로 둔다.
- **시험 대상:** `three-gpu-pathtracer@0.0.24`(`three-mesh-bvh@0.9.15`)
- **시험 장면:** 빈 기본 방에 표준 양변기 1개

## 결론: 보류

| 항목                                 | 결과                                                                                                                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 설치·번들                            | 된다. 동적 import 청크(약 204KB, gzip 58KB)로만 불러오고 기존 번들은 그대로다                                                                                         |
| 구도                                 | 내보내기 카메라와 행렬 차이 0, 변기 실루엣 IoU 0.99                                                                                                                   |
| **Windows Chrome 기본(ANGLE D3D11)** | **물체가 모두 검게 나온다**(누적값 0). D3D11on12도 같다. 라이브러리 예제 수준의 최소 장면과 이전 버전 0.0.23에서도 같아, ANGLE D3D 경로의 셰이더 컴파일 문제로 좁혔다 |
| 같은 GPU(Iris Xe)의 ANGLE Vulkan     | 정상. 초당 약 10–15샘플이다. 조명 A는 30초 안에 수렴하고, 천장을 닫은 조명 B는 약 50초 걸린다                                                                         |
| 첫 셰이더 컴파일                     | D3D11 3–4분(같은 프로필 두 번째 실행 약 50초), Vulkan 7.5초                                                                                                           |
| 자원                                 | 라이브러리 `dispose()`만으로는 GPU 텍스처가 남는다. 추가 해제나 렌더러 폐기로 해결된다                                                                                |
| 자동 테스트(SwiftShader)             | 한 샘플 약 2.3초, 컴파일 약 3분이라 품질 측정용으로 쓸 수 없다                                                                                                        |

- **보류 이유:** 웹 페이지는 ANGLE 백엔드를 고를 수 없다. 대부분의 Windows 데스크톱 사용자는 D3D11이라, 도입해도 대체 경로(기존 래스터 내보내기)만 보게 된다.
- **대체 감지:** 작은 기준 장면을 2샘플 그리는 자가 검사로 D3D11 오동작을 감지할 수 있었다(Vulkan 통과, D3D11 실패).

## 다시 볼 조건

- **WebGPU 기반 경로 추적이 쓸 만해질 때.** Chrome Windows의 WebGPU는 D3D12를 직접 쓴다. 관련 논의는 [three-gpu-pathtracer #547](https://github.com/gkjohnson/three-gpu-pathtracer/issues/547)이다.
- 또는 이 라이브러리의 D3D11 출력 문제가 upstream이나 ANGLE에서 해결될 때.
- 다시 시작하면 2단계(타일 셰이더를 텍스처로 굽기)부터 한다. 이때의 위험: 라이브러리가 모든 재질 텍스처를 한 크기(기본 1024²)로 줄이므로 줄눈이 사라질 수 있다.

## 코드와 상세 결과 위치

- **main에 없다.** 원격 브랜치 `claude/pathtracer-spike`, 커밋 `8005b51`에 보존했다. 이 브랜치는 병합하지 않는다.
  - 결과 문서(그 브랜치 안)
    - `docs/pathtracer-spike-results-20260925.md`: 0–1단계, 라이브러리 조사표 포함
    - `docs/pathtracer-spike-results-20260925-d3d11.md`: 1b단계, 백엔드 비교·원인 좁히기
  - 시험 코드: `tests/pathtracer-spike-page.ts`, `tests/pathtracer-spike-browser.ts`, `tests/pathtracer-bundle-probe.mjs`
  - 렌더러의 시험용 `exportFrame`
- **작업 프롬프트**(main)
  - [0–1단계](prompts/pathtracer-stage-0-1-feasibility.md)
  - [1b단계](prompts/pathtracer-stage-1b-d3d11-investigation.md)
  - [정리](prompts/pathtracer-closeout.md)
