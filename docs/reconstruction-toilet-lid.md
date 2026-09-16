# 재구성 변기 뚜껑 상태

`Before → 설비 선택 → 재구성 모형 수정 → 변기 뚜껑 상태`에서 열림/닫힘을 고른 뒤 **재구성 설정 적용**을 누른다. 상태와 출처는 해당 설비에 저장되며, Before 실행 취소·다시 실행과 프로젝트 저장에 포함된다. 공간의 After·가격·제품 수량은 바꾸지 않는다.

## 호환과 출처

- `FixtureInstance.reconstruction.toiletLidState?: 'open' | 'closed'`를 사용한다. 이전 자료에서 값이 없으면 기존 좌석 테두리만 있는 형상을 그대로 유지한다. 다른 색·위치를 수정해도 열린/닫힌 뚜껑을 임의로 추가하지 않는다.
- 새 표준 변기는 `closed` 기본값을 사용한다. 이는 사진에서 닫힌 상태를 확인했다는 뜻이 아니다.
- `provenance.toiletLidState`는 `default`, `inferred`, `user`만 허용한다. 별도 모델의 직접 뚜껑 분류로 표시하지 않는다.
- 열린 상태의 자동 추정은 기록된 DeepLab `toilet-assembly`의 변기·볼 픽셀 수, 둘레 비율, 뚜껑/볼 범위와 상하·가로 지지 관계를 검증한다. 종류 이름이나 자유 설명 문장만으로 추정하지 않는다. 반사·확인 필요 후보는 자동 추정하지 않는다.
- 기존 개발 사진의 저장된 원관측 기준으로 `test 화장실3.jpg`에는 해당 조합 근거가 있으며, `TEST 화장실2.jpg`에는 없다. 두 번째 사진을 열림으로 보정하는 것은 사용자 선택이다. 이 확인은 저장된 분석 결과를 읽은 것이며 새 AI 검증으로 집계하지 않는다.

## 형상과 저장

열린 뚜껑은 기존 물탱크 높이 안에, 닫힌 뚜껑은 좌석 위에 추가한다. 기존 아홉 개 몸체 부품의 정규화된 좌표·물리 크기는 두 상태에서도 동일하다. 표준 모형 캐시 키에 상태를 포함하여 바꾼 결과가 바로 렌더링된다. PNG는 같은 모형을 사용하며 조작 UI를 포함하지 않는다.

상태를 바꾸면 새 불변 자재 버전/PNG를 만들고 해당 설비를 갱신한다. 이전 버전·다른 설비는 덮어쓰지 않는다. 서버 문서 검증에도 선택적 필드가 추가됐지만 실제 Supabase 연결 시험은 하지 않았다.

치수 출처는 선택적 `provenance.width/height/depth`를 우선하고, 없으면 이전 `dimensions` 집계 출처를 사용한다. 보정 패널에서 뚜껑만 바꿨다고 다른 치수까지 사용자 입력으로 표시하지 않는다.

## 2026-09-13 검증

- 관련 단위 6개 파일 64개 통과: 조합 근거/거짓·부족 근거 제외, 상태 없는 v1/v2 몸체 호환, 규격, PNG 캐시, 새 기본값, 불변 버전, fake-indexeddb 저장, Before undo/redo, 시안 복사 독립성.
- 실제 Chrome 152 / Windows / SwiftShader 브라우저: 세 상태의 투명 PNG, 공용 보정 선택, 실제 설정 적용, IndexedDB 저장/다시 읽기, Before undo/redo 통과. 별도 임시 localhost origin으로 실행했다.
- 900×600 비교에서 이전 모형→열림은 823개 픽셀이 변했고, 실행 취소에 해당하는 원상 복원은 최대 채널 차이가 0이었다. 기존 몸체 좌표가 동일하다는 별도 형상 검사도 통과했다. 이는 FPS나 AI 인식 품질 측정이 아니다.
- `tests/reconstruction-toilet-browser.ts`, `tests/reconstruction-toilet-properties-browser.ts`는 실제 렌더/브라우저 코드에 수동 지정한 검증 모형을 입력한다. 모델 호출·외부 요청은 없었다.
- 초기 검증의 테스트 기준(세면대용 1,000픽셀), 잘못 지정한 버튼 이름, 비동기 상태 대기 방식은 실패 기록을 확인한 뒤 테스트에서 수정했다. 실제 앱 코드가 테스트를 우회하도록 바꾸지는 않았다.
- 담당 파일 lint와 열린 변기 소스 완성 시점(18:52)의 전체 TypeScript 검사는 통과했다. 이후 병렬 작업 중인 실험실 UI의 타입 오류가 별도 검사에서 확인돼 해당 담당자에게 전달했다. 최종 전체 타입 검사·빌드 및 실사진 전체 파이프라인은 통합 결과 문서에서 별도로 기록한다.

실행:

```sh
npx vitest run tests/reconstruction-toilet-lid.test.ts tests/reconstruction-generation-v2.test.ts tests/reconstruction-candidates.test.ts tests/design-storage.test.ts tests/reconstruction-basin-shape.test.ts tests/reconstruction-standard-render.test.ts
node tests/run-browser-test.mjs tests/reconstruction-toilet-browser.ts
node tests/run-browser-test.mjs tests/reconstruction-toilet-properties-browser.ts
```

로컬 결과: `test-results/reconstruction-toilet-lid-20260913/gallery.png`, `result.json`, `properties-saved.png`, `properties-result.json`.

뚜껑 형태는 범용 표준 모형이다. 실제 제품의 좌석/뚜껑 분리 상태·힌지 각도·디자인까지 복원한 것이 아니며 사진 속 제품과 정확히 동일하다고 보장하지 않는다.
