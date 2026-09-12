> 이전 세 방향 기능의 역사 기록입니다. 해당 UI와 자동 정면 추정은 360° 편집기로 교체됐습니다. 현재 사용법은 [360° 제품 편집기](product3d-editor.md)를 참고하세요. 이전 소스·테스트는 `docs/archive/retired-three-view/`에 체크섬과 함께 보관했습니다.

# 자동 정면 정렬 검증

2026-09-12. 사용자 입력의 왼쪽·정면·오른쪽 분류에 고정 각도를 적용하던 경로 대신, 실제 TripoSR 복원 형상의 좌우 대칭과 입력 시점으로 정면을 추정하고, 그 정면을 먼저 렌더링한 뒤 동일한 기준의 좌우 이미지를 만드는 변경을 검증했다.

## 실추론과 재생의 구분

- **실추론**: 입력 PNG를 제품 등록 화면에 업로드하고 production `MultiViewClient`/Web Worker/ONNX 가중치로 새 형상을 복원했다. 모델 응답·형상·PNG 결과를 모의 처리하지 않았다. 생성된 세 장을 자재 등록 초안에 일괄 적용하는 것까지 확인했다. 이번 자동 정면 테스트는 자재 영구 저장·새로고침까지 다시 검사하는 테스트가 아니다.
- **재생**: 기존 실추론에서 보관한 의자·변기 형상을 알려진 각도로 회전시킨 뒤 production 정면 추정기와 PNG 렌더러로 처리했다. 사진으로부터 다시 추론한 것으로 세지 않는다.
- **합성 입력 후 실추론**: 이전 실제 의자 형상을 별도 카메라에서 렌더링한 PNG 세 장을 새 입력으로 사용했다. 이 PNG는 직접 촬영한 제품 사진이 아니다. 각각 실제 TripoSR 추론을 새로 수행했다.

가중치 전송만 검증 전용 localhost 스트리밍 서버로 바꿨다. `tmp/multiview-model`의 기존 고정 revision ONNX 파일을 브라우저에 전송하며, 모델·추론 실행은 production 경로 그대로다. 따라서 아래 다운로드 시간은 실제 인터넷 다운로드 속도가 아니다. 테스트 전송의 redirect 응답은 캐시에 보관되지 않아 재실행마다 로컬 파일을 다시 전송했다. 캐시 재사용 성공을 주장하지 않는다.

## 실제 결과

| 검사 | 결과 | 증거 (`test-results/` 아래) |
| --- | --- | --- |
| 실제 의자 형상 0/−12/+12/+40° 회전, 입력 시점 힌트는 모두 0° | 정면 추정 −12/−24/0/+28°. 알려진 회전과 정확히 같은 만큼 정면 기준이 이동했다. 네 PNG의 좌판·등받이 정렬이 동일함을 직접 확인 | `front-alignment/replay-measurements.json`, `chair-front-equivariance.png` |
| 실제 변기 형상 같은 네 회전 | 정면 −4.25/−16.25/+7.75/+35.75°. 회전 보정 일치, 볼·시트·뚜껑의 전면 축 유지 | 위 JSON, `toilet-front-equivariance.png` |
| 의자 미세 사선 합성 입력 −12°를 촬영 방향 **정면**으로 등록 후 실추론 | 자동 정면 1.5°. 출력에서 좌판·등받이의 중심이 정렬되고 양옆 방향 생성·일괄 적용 성공 | `front-alignment/chair--12/`, `real-measurements.json` |
| 의자 미세 사선 합성 입력 +12°를 **정면**으로 등록 후 실추론 | 자동 정면 −5.75°. 방향 선택값에 고정된 0°가 아니며 실제 형상에서 보정 | `front-alignment/chair-12/` |
| 의자 명확한 사선 합성 입력 −40°를 **오른쪽 측면**으로 등록 후 실추론 | 자동 정면 31.75°. 정면을 먼저 구성하고 그 기준의 좌우 이미지 생성·일괄 적용 | `front-alignment/chair--40/` |
| 실제 사선 의자 사진의 기존 BiRefNet 투명 결과를 **정면**으로 등록 후 실추론 | 자동 정면 −12.5°. 좌판·등받이의 중심 정렬을 확인. 입력의 촬영 방향 분류에 기대지 않음 | `front-alignment-photograph/real-measurements.json`, `contact.png`, `photograph/ui.png` |
| 실제 흰 변기 사진의 기존 BiRefNet 투명 결과를 **정면**으로 등록 후 실추론 | 자동 정면 −4.25°. 볼·뚜껑 중심축 유지, 좌우 방향 생성·일괄 적용 성공 | `front-alignment-toilet/real-measurements.json`, `contact.png`, `photograph/ui.png` |

합성 사진의 카메라 각도와 실추론 결과의 `yawDegrees`는 서로 다른 복원 좌표계에 속한다. 수치가 같다는 것을 정답 기준으로 삼지 않았다. 알려진 **형상 회전 재생**의 회전 일치와 실제 생성 PNG의 **정면 시각 확인**을 분리했다. 기준 yaw −14°(의자)/−7°(변기)는 별도 후보 렌더를 비교해 육안으로 선택한 근사 참조이며, 측정 장비에서 얻은 정확한 제품 자세는 아니다.

실제 PNG를 읽어 직접 비교한 합성 입력·결과 모음은 `front-alignment/real-three-inputs.png`, 직접 촬영된 원본 의자·변기의 전후 모음은 각각 `front-alignment-photograph/contact.png`, `front-alignment-toilet/contact.png`다. 해시가 다르거나 각도 숫자가 바뀌었다는 것만으로 품질 통과로 판정하지 않았다.

## 실행과 시간

- 저장 형상 replay 1개 테스트: **29.3초**, 2개 제품 × 4개 회전. 개별 정면 추정 약 0.83~1.00초.
- 합성 입력 세 장의 실추론 + UI: **46.0초**, 입력별 버튼 실행→세 결과 준비 약 **11.25초**. 실제 GPU 처리(정면 분석 포함) **4.72~5.09초**.
- 실제 의자 사진 실추론 + UI: **22.2초**, GPU 처리 **4.86초**.
- 실제 흰 변기 사진 실추론 + UI: **20.9초**, GPU 처리 **4.83초**.
- Windows, Chrome stable, RTX 4070 Ti 12GB. 다른 사용자 기기의 시간·메모리 보장값이 아니다. 이번 정면 변경으로 CPU 실추론을 재실행하지 않았다.
- 전체 단위 테스트 **466개 / 48개 파일 통과**, 전체 ESLint 및 타입 검사 통과.
- 기존 3방향 UI 회귀 **4개 통과(21.1초)**: 원본 보존, 늦은 응답, 취소, 추가 각도 보정과 동일 기준의 재렌더링.
- **Next.js production build와 vinext/Cloudflare production build 모두 통과**. 실제 서버 연결·배포는 하지 않았다. 두 빌드는 같은 `.next/types`를 사용하므로 순차 실행했다. vinext가 바꾼 생성 타입은 Next typegen으로 복구한 뒤 타입 검사 통과를 재확인했다.

초기 실추론 하네스는 666MB backbone을 Playwright `route.fulfill(path)`로 직접 전달하다 Chrome context가 종료되어 실패했다. 원인을 앱/모델 문제로 단정하지 않고 전송을 스트리밍 서버로 바꿨으며 이후 다섯 입력이 모두 성공했다. 또 다른 실행은 다른 테스트가 시작 중인 Next 개발 서버와 겹쳐 서버 시작 단계에서 실패했다. 해당 서버가 종료된 것을 확인한 뒤 흰 변기 시험을 다시 실행했다. 이 두 실행은 추론 성공으로 세지 않았다.

## 재현

```powershell
# AI 재추론 없이 기존 실추론 형상의 정면 탐색/렌더링/입력 PNG 생성
$env:SJN_FRONT_ALIGNMENT_REPLAY='1'
npx playwright test --config playwright.front-alignment.config.ts --grep '실제 메시'

# 위에서 만든 세 PNG를 실제 AI 모델로 재추론한다.
# tmp/multiview-model에 문서의 고정 revision 모델 세 파일이 있어야 한다.
$env:SJN_FRONT_ALIGNMENT_REAL='1'
npx playwright test --config playwright.front-alignment.config.ts --grep '실추론'

# 직접 촬영된 제품 사진(배경 제거한 PNG)을 별도로 실추론
$env:SJN_FRONT_ALIGNMENT_INPUT='C:\path\to\actual-product-transparent.png'
$env:SJN_FRONT_ALIGNMENT_LABEL='정면'
$env:SJN_FRONT_ALIGNMENT_OUTPUT='test-results/front-alignment-custom'
npx playwright test --config playwright.front-alignment.config.ts --grep '실추론'
```

기본 replay fixture는 `multiview-chair-left`와 `multiview-quality-toilet-after`의 `mesh-positions.bin`·`mesh-indices.bin`·`mesh-colors.bin`이다. 해당 fixture가 없는 체크아웃에서는 먼저 기존 [3방향 실추론 검증](multiview-validation.md)을 준비해야 한다. 사진 출처는 기존 [AI 배경 제거 문서](ai-background-removal.md)를 따른다. PNG·형상·모델 파일은 QA 전용이며 새 배포 샘플에 추가하지 않았다.

## 남아 있는 한계

정면 추정은 제품의 좌우 형태를 이용한 기하학적 추정이다. 대칭 원통, 좌우가 본래 다른 제품, 완전히 옆/뒤에서 찍은 사진은 정면과 뒷면을 구분할 근거가 부족할 수 있다. 불확실한 결과를 실제 정답으로 보장하지 않으며, UI가 자동 추정임을 표시하고 추가 각도 보정을 제공한다.

실제 의자에서는 촬영 사진의 등받이 구멍과 다리 형태가 덜 정확하게 복원됐다. 흰 변기는 배경 제거 결과에 남아 있던 휴지통·휴지걸이까지 함께 복원됐다. 자동 정면이 개선되어도 이 별도의 형상·배경 제거 품질 한계가 해결된 것은 아니다. 사용자가 제시했던 세면대의 원본 투명 PNG로는 이번 정면 변경을 직접 재검증하지 못했다.
