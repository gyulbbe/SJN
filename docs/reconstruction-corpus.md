# 사진 재구성 독립 평가 자료 v1

2026-09-13에 **실제 사진 36장, 개발 24장 / 최종 평가 12장**을 고정했다. 사진은 Wikimedia Commons의 공식 파일 메타데이터에서 저자·출처·재사용 라이선스를 확인하고 원본 내용을 눈으로 검토해 선정했다. 원본 사진을 본 독립 Codex 평가자가 설비 114개의 종류·대략적인 사진 영역·설치 방식·형태와 반사/불확실 영역을 기록했다. 사람 여러 명의 합의나 현장 실측으로 확정한 정답은 아니다.

고정 파일은 `tests/fixtures/reconstruction-corpus-v1.json`이며 SHA256은 다음과 같다.

```text
2848369591ebd854929ff94ff0f79b8a47f913e5fd8ef689a81ffcc7f86da4f6
```

평가자는 새 후보의 이 36장 결과를 보지 않고 주석과 분할을 고정했다. 병렬 구현 작업 자체는 이미 진행 중이었으므로 모든 구현보다 먼저 만들어진 데이터라고 주장하지 않는다. 기존 사용자 사진에 관한 이전 분석 내용을 알고 있었으나, 이 사진들은 새로운 36장과 분리했다. 이후 정답 오류가 확인되면 원본 v1을 덮어쓰지 않고 정정 사유와 새 버전을 만들어야 한다. 포맷 변경도 바이트 체크섬을 바꾸므로 이 JSON을 일괄 prettier 대상으로 사용하지 않는다.

## 수집·입력·라이선스

Commons 검색의 174개 허용 형식/크기/라이선스 후보 중 72개 미리보기를 검토했다. 같은 사진과 같은 방의 여러 시점을 중복 수량으로 늘리지 않았고, 그림·CG·모형·외관·주요 설비가 없는 자료를 제외했다. 관련 가능성이 있는 Mid-City 사진 두 장은 같은 개발 그룹으로 묶었다. 기둥형·벽걸이·하부장·금속 다리형 세면대, 열린/닫힌 변기, 유리, 거울장, 선반, 반사, 가림, 작은 설비, 근접/상향/하향 시점, 다양한 빛을 포함한다. 금속 다리형 콘솔 세면대처럼 분류 체계에 정확한 항목이 없으면 억지로 기둥형으로 정하지 않았다.

개별 파일의 출처·저자·라이선스 URL·원본 SHA1·원본 크기·내려받은 미리보기 URL은 manifest의 `source`에 있다. 실제 평가 입력은 `test-results/reconstruction-corpus/inputs/bath-XX.jpg`에 있으며, 같은 JPEG 바이트를 두 엔진의 공통 입력으로 전달한다. 각 엔진 내부의 축소·재인코딩과 분석 해상도는 별도 실행 설정으로 기록한다. EXIF 방향을 정규화한 뒤 최대 1000×1000 안에 맞추고 확대 없이 JPEG 품질 88로 저장했다. 변환 런타임은 Sharp 0.35.4 / libvips 8.18.6 / mozjpeg 0826579이다. 최대 1000px 입력의 해시·치수·크기는 36개 모두 검증했다. 원본 해상도 분석 결과로 보고하지 않는다.

Commons 원본 파일을 별도로 받는 과정에서 HTTP 429와 `Retry-After: 600`이 발생했다. 이 제한을 우회하지 않았다. 평가에는 이미 확보한 미리보기의 고정 정규화본을 사용하며, 모든 원본 파일을 내려받았다고 보고하지 않는다. 원본 파일과 평가 JPEG를 혼동하지 않도록 각각 다른 해시를 기록한다.

라이선스는 CC BY, CC BY-SA, CC0 또는 원저자의 퍼블릭 도메인 선언이다. Commons에 올라왔다는 사실만으로 저작권이 보증되지는 않는다. 실제 원저자와 허용 조건은 각 파일의 출처 페이지를 확인해야 한다. BY-SA 원본의 배포용 파생 사진을 만들면 그 사진의 동일조건변경허락 의무도 따라야 한다. 현재 원본·정규화 사진·비교 결과는 Git에서 제외된 로컬 자료이며 커밋하지 않는다. 재배포가 필요하면 아래 크레딧과 변경 내역, 해당 라이선스를 함께 유지한다. [Commons 재사용 안내](https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia)

1930년대 사진첩에서 발견한 사진 한 장은 Flickr CC BY 표기가 있었지만 원저자가 불명확해서 동결 전에 제외했다. 대신 촬영자의 own-work CC BY-SA 사진을 사용했다. 사용자 개인 사진은 허가된 로컬 회귀에만 사용하며 이 공개 자료집에 넣지 않았다. 프로젝트가 만든 기본 예시 이미지는 렌더 회귀에는 사용할 수 있으나 실제 사진 36장에 포함하지 않았다.

36장 주석의 실제 설비 수는 세면대 25, 변기 16, 욕조 15, 거울 24, 거울장 2, 유리 파티션 6, 선반 6, 문 8, 창 12이며 명시적으로 구분한 반사 관측은 12개다. 특히 거울장은 2개뿐이므로 종류별 일반화나 안정적인 정확도 추정에는 부족하다. 입력 JPEG 전체는 5,248,591바이트다. 사진 수와 설비 수를 서로 다른 평가 단위로 다룬다.

## 실행

```powershell
# 이미 있는 입력 해시/실제 디코딩 치수와 고정 manifest 검사
node tests/reconstruction-corpus.mjs --verify

# 없는 공개 미리보기만 내려받아 동일하게 정규화, 해시 일치할 때만 저장
node tests/reconstruction-corpus.mjs --download

npx vitest run tests/reconstruction-corpus.test.ts tests/reconstruction-corpus-metrics.test.ts
```

다운로드 도구는 모델을 실행하거나 사용자 사진을 전송하지 않는다. 허용된 Wikimedia HTTPS URL만 요청하고, 429/503이면 다음 사진으로 우회하지 않고 중단해 재시도 조건을 표시한다. 서버 사진이나 변환 라이브러리가 바뀌어 정규화 바이트가 달라지면 새 결과를 기존 정답과 같은 입력이라고 취급하지 않고 실패한다. 고정 입력을 덮어쓰거나 해시를 자동 갱신하지 않는다. 2026-09-13에 36개 입력 검증, 데이터 무결성 5개와 평가 계산 9개 단위 테스트, 담당 파일 lint를 통과했다. 이 14개 테스트는 인식 정확도 시험 결과가 아니다.

실제 엔진 순차 실행 도구는 이 manifest의 `cases[].input.path`와 `roomMm`를 사용한다. 방 치수는 두 엔진에 동일하게 2400×2400×2400mm를 주는 통제 조건이며 사진의 실제 방 치수가 아니다. 개발 결과를 보고 수정할 수 있지만 최종 평가 12장의 결과를 본 뒤 같은 자료에 맞춰 조정한 결과는 새로운 독립 heldout 검증으로 간주하지 않는다.

## 정답과 집계 방식

`annotation.fixtures`는 사진에 직접 보이는 실제 설비 단위다. 한 개의 연속 하부장에 세면대가 두 개면 한 설비와 `basinCount: 2`, 독립 하부장이 둘이면 두 설비로 기록한다. `vanity`는 계산할 때 `basin + basinVariant: vanity`, 앱의 `wallShelf`는 정답의 `shelf`로 명시적으로 정규화한다. 사진에서 보이지 않는 수납장 내부, 문 뒤 제품, 정확한 mm 치수나 방 구조를 추측해 정답으로 만들지 않는다.

- `bounds`: 방향 정규화 사진 기준 `[left, top, right, bottom]`, 0~1의 대략적인 보이는 외곽 범위. 픽셀 마스크가 아니다.
- `mounting`, `installationWall`, `shape`, `basinVariant`, `toiletLid`: 보이는 근거가 부족하면 `unknown`. 설치 벽은 사진상 좌/뒤/우 벽을 가리키며 측량 좌표가 아니다.
- `partial`, `occluded`, `boundsUncertainty`, `notes`: 잘림, 가림, 유리 외곽처럼 애매한 범위를 보존한다.
- `reflections`: 거울/유리 속 관측을 실제 설비와 별도로 기록한다. 반사 풍경을 독립 제품 정답으로 넣지 않는다.
- `ignore`: 너무 작은 잘림이나 종류를 확인할 수 없는 부분. 실제 설비와 먼저 대응시킨 뒤 남은 예측에만 적용한다.
- `relations`: 명확한 앞뒤/반사 관계만 기록한다. 유리 뒤 설비는 존재를 유지한다.

평가 순수 함수는 `tests/reconstruction-corpus-metrics.mjs`에 있다. 종류를 먼저 맞춰서 틀린 분류를 숨기지 않고, IoU 0.25 이상의 사진 영역에 대해 **총 IoU를 최대화하는 일대일 Hungarian 대응**을 사용한다. 대략적인 주석이므로 이 대응만으로 물체 정체나 물리 배치의 정답을 확정하지 않는다.

다음 수치를 나눠 기록하며 임의의 종합 정확도를 만들지 않는다.

1. **인식 후보**: baseline의 원시 DeepLab 후보와 candidate의 자동 Qwen 구조화 출력을 비교한다. 사용자 확인값과 표준 모형의 기본값을 인식 성공으로 역산하지 않는다.
2. **실제 생성 모형**: `fixtures`를 `review.candidates[].fixtureId`로 연결한다. 인식만 했지만 보류한 물체는 실제 생성된 것으로 세지 않는다. 연결이 없는 모형도 숨기지 않는다.
3. **영역 대응/종류**: 대응 개수, 누락 영역, 잘못 추가, 종류가 틀린 대응, 종류가 맞은 recall을 분리한다. 거울/거울장 구분이 불확실한 정답과 높은 외곽 불확실성은 정확한 종류 recall의 분모에서 제외한다.
4. **속성**: 종류가 맞게 대응된 설비 중 정답 속성이 알려진 항목에 대해 정답/오답/모델 보류를 각각 기록한다. 누락된 설비를 속성 분모에서 뺀 사실을 명시하고 별도 누락 수를 함께 본다.
5. **반사·중복**: 실제 물체 대응 후 남은 예측 중 반사 영역 대응과 중복을 별도 센다. 모델이 `uncertain`으로 둔 반사는 보류 후보이며 확정된 실제 물체로 세지 않는다.
6. **위치**: 원본 후보 bbox 중심 오차와 실제 source-camera 모형 재투영 bbox 중심 오차를 구분한다. 후자는 사용할 수 있는 실제 재투영값이 있을 때만 기록한다. 입력 bbox를 재투영값으로 대신하지 않는다. 실측 mm 위치 오차나 올바른 방 치수 복원이라고 주장하지 않는다.
7. **실패·시간·메모리**: 잘못된 JSON, 실행 실패, 취소, 결과 없음은 실패 케이스로 남긴다. 성공한 자료에서만 산출되는 recall에는 그 범위를 표시한다. 실제 UI 조작으로 잰 사용자 수정량이 없으면 `null`이며 오류 필드 수를 클릭 횟수로 바꾸지 않는다. 메인 페이지 JS heap은 Worker/WASM/GPU/전체 프로세스 메모리가 아니다.

유리 외곽의 불확실성이 높은 한 영역은 일대일 대응을 시도하지만, 못 맞았다고 바로 설비가 없다고 판정하지 않고 수동 확인 대상으로 남긴다. 거울 안의 작은 제품, 연속 하부장, 반투명 유리는 bbox만으로 매칭이 모호할 수 있다. 모든 실패를 사람이 검토하지 않은 상태에서는 사진별 예시와 별도 수치를 보고할 수 있으나 확정된 제품 수준 인식 정확도라고 표현하지 않는다.

`evaluateCorpusCase(case, report, { error? })`로 사진별 결과를 만들고 `summarizeCorpusMetrics(evaluations)`에는 **동일 엔진**의 결과만 넘긴다. 개발/최종 평가 분할은 내부에서 따로 집계한다. 인식 개선과 모형 표현 개선, 자동 결과와 사용자 수정 결과는 분리한다. 채택 여부는 heldout의 누락·거짓 추가·반사·설치 오류와 실패를 함께 검토해 결정하며 함수가 자동 채택을 결정하지 않는다.

## 오프라인 비교 보고서

최종 엔진 실행이 끝난 뒤 아래 명령을 실행한다. 모델이나 브라우저 AI를 재실행하지 않고 저장된 결과만 읽는다.

```powershell
node tests/reconstruction-corpus-report.mjs test-results/reconstruction-corpus-final
```

출력은 지정 결과 폴더의 `report/index.html`, `report/summary.json`이며, 원본·기존 분석·개선 후보 이미지와 상세 JSON을 `report/assets`에 복사한다. 보고서 폴더 전체를 함께 보관하면 네트워크 없이 비교할 수 있다. HTML은 36장 모두를 나열하고 개발/최종 평가, 실패, 사진 이름으로 필터링한다. 이미지 클릭은 저장된 큰 이미지를 연다. 개별 출처·저자·라이선스 링크와 원본 변환 내역을 함께 보존한다.

완료 기록이 없는 사진은 미실행/진행 중, 모델 오류는 실패, 보류는 미배치 후보로 표시한다. 실패한 재시도 뒤에 예전 PNG/JSON이 폴더에 남아 있어도 완료 기록이 허용하지 않으면 사용하지 않는다. 구현 해시·입력·모델 설정이 섞인 기록은 자동 합계를 만들지 않고 불일치를 표시한다. 전체가 끝나지 않은 보고서는 큰 미완료 표시를 붙이며 최종 결과로 취급하지 않는다. 재실행할 때 원시 결과나 고정 주석은 수정하지 않는다.

보고서 검증 5개를 포함해 corpus 관련 19개 단위와 lint, 타입 검사를 통과했다. 별도 로컬 정적 서버의 실제 Chrome에서 1440px/390px 레이아웃, 36개 사진 유지, 개발/heldout·실패 필터, 검색, 가로 넘침 없음, 브라우저 오류·외부 요청 없음도 확인했다. 이 UI 검사는 중간 결과의 배치만 확인했으며 그 수치를 최종 성능으로 사용하지 않았다.

정답 동결 뒤 독립 코드 검토에서 다른 물체의 접점이 anchor로 연결될 수 있는 검사 누락과 근거 없는 모서리 관측 허용을 발견했다. 담당 구현은 bbox 밖 anchor·비어 있는 anchor/모서리 근거를 보류하도록 수정했다. 이는 새 평가 사진의 출력에 맞춘 보정이 아니라 관측 계약 검사 수정이며, 정답 v1은 변경하지 않았다. 실제 대량 평가의 구현 해시는 해당 실행 환경 기록으로 구분한다.

## 출처별 크레딧

각 행의 링크는 해당 사진의 공식 출처이며, 저장된 이미지 변환은 방향 정규화·최대 1000px 축소·JPEG 재인코딩이다. Public domain 행은 manifest의 공식 파일 페이지에 기록된 선언을 근거로 하며 별도 CC 라이선스 URL을 만들지 않았다.

| ID / split | Photograph | Author | License |
|---|---|---|---|
| bath-01 / development | [Tallink-Interior-Bathroom.JPG](https://commons.wikimedia.org/wiki/File:Tallink-Interior-Bathroom.JPG) | Dmitry G | Public domain |
| bath-02 / development | [Mary Plantation House Upstairs Interior Bathroom Bathtub.JPG](https://commons.wikimedia.org/wiki/File:Mary_Plantation_House_Upstairs_Interior_Bathroom_Bathtub.JPG) | Infrogmation of New Orleans | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0) |
| bath-03 / development | [Marston House - interior bathroom..JPG](https://commons.wikimedia.org/wiki/File:Marston_House_-_interior_bathroom..JPG) | Photojack53 | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0) |
| bath-04 / heldout | [Bathroom at Norbulingka.jpg](https://commons.wikimedia.org/wiki/File:Bathroom_at_Norbulingka.jpg) | Maris Burbergs | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0) |
| bath-05 / development | [Toilet and Bathroom.jpg](https://commons.wikimedia.org/wiki/File:Toilet_and_Bathroom.jpg) | Gaurav Dhwaj Khadka | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) |
| bath-06 / development | [Bathroom, Westin Canal Place - New Orleans.jpg](https://commons.wikimedia.org/wiki/File:Bathroom,_Westin_Canal_Place_-_New_Orleans.jpg) | TravelingOtter | [CC BY-SA 2.0](https://creativecommons.org/licenses/by-sa/2.0) |
| bath-07 / development | [University Medical Center New Orleans bathroom 02.jpg](https://commons.wikimedia.org/wiki/File:University_Medical_Center_New_Orleans_bathroom_02.jpg) | Infrogmation of New Orleans | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) |
| bath-08 / heldout | [Dirty residential bathroom in America.jpg](https://commons.wikimedia.org/wiki/File:Dirty_residential_bathroom_in_America.jpg) | Yitzilitt | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) |
| bath-09 / development | [Bathroom Mid-City New Orleans - Time to reglaze the Tub?.jpg](https://commons.wikimedia.org/wiki/File:Bathroom_Mid-City_New_Orleans_-_Time_to_reglaze_the_Tub%253F.jpg) | Bart Everson | [CC BY 2.0](https://creativecommons.org/licenses/by/2.0) |
| bath-10 / development | [Bathroom 2 - Olivier House, New Orleans.jpg](https://commons.wikimedia.org/wiki/File:Bathroom_2_-_Olivier_House,_New_Orleans.jpg) | Paul Schultz | [CC BY 2.0](https://creativecommons.org/licenses/by/2.0) |
| bath-11 / development | [Painted Bathroom - Mid-City New Orleans.jpg](https://commons.wikimedia.org/wiki/File:Painted_Bathroom_-_Mid-City_New_Orleans.jpg) | Bart Everson | [CC BY 2.0](https://creativecommons.org/licenses/by/2.0) |
| bath-12 / heldout | [Coaster Bathroom Interior.jpg](https://commons.wikimedia.org/wiki/File:Coaster_Bathroom_Interior.jpg) | Mds08011 | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0) |
| bath-13 / development | [Red modern bathroom interior. (51528276166).jpg](https://commons.wikimedia.org/wiki/File:Red_modern_bathroom_interior._%2851528276166%29.jpg) | Nenad Stojkovic | [CC BY 2.0](https://creativecommons.org/licenses/by/2.0) |
| bath-14 / development | [Hamilton Hume Motor Inn bathroom interior 2009-09-08.jpg](https://commons.wikimedia.org/wiki/File:Hamilton_Hume_Motor_Inn_bathroom_interior_2009-09-08.jpg) | Tangerineduel | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) |
| bath-15 / development | [The 1950s bathroom, Lotherton Hall.jpg](https://commons.wikimedia.org/wiki/File:The_1950s_bathroom,_Lotherton_Hall.jpg) | Richard Avery | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) |
| bath-16 / heldout | [Bathroom of Khan Pool Suite in Amantaka luxury Resort & Hotel in Luang Prabang Laos.jpg](https://commons.wikimedia.org/wiki/File:Bathroom_of_Khan_Pool_Suite_in_Amantaka_luxury_Resort_%2526_Hotel_in_Luang_Prabang_Laos.jpg) | Basile Morin | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) |
| bath-17 / development | [Bathroom in Tallinn 2.jpg](https://commons.wikimedia.org/wiki/File:Bathroom_in_Tallinn_2.jpg) | Dmitry G | Public domain |
| bath-18 / development | [Bathroom, Interior of apartment in Brisbane, 2025, 08.jpg](https://commons.wikimedia.org/wiki/File:Bathroom,_Interior_of_apartment_in_Brisbane,_2025,_08.jpg) | Chris Olszewski | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) |
| bath-19 / development | [2025.01.02 Bialystok Hotel Branicki Interior of Bathroom 01.jpg](https://commons.wikimedia.org/wiki/File:2025.01.02_Bialystok_Hotel_Branicki_Interior_of_Bathroom_01.jpg) | Tess Mattew | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) |
| bath-20 / heldout | [Seattle - Hofius House interior 44 - a bathroom sink.jpg](https://commons.wikimedia.org/wiki/File:Seattle_-_Hofius_House_interior_44_-_a_bathroom_sink.jpg) | Photo by Joe Mabel | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) |
| bath-21 / development | [Bathroom interior at Dead Lakes Park.jpg](https://commons.wikimedia.org/wiki/File:Bathroom_interior_at_Dead_Lakes_Park.jpg) | The Bushranger | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) |
| bath-22 / heldout | [Hotel Barcelona Catedral Bathroom 2010.JPG](https://commons.wikimedia.org/wiki/File:Hotel_Barcelona_Catedral_Bathroom_2010.JPG) | Patrick Pelletier | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0) |
| bath-23 / development | [Phoenix bathroom Residence Inn Marriott hotel with towels and shower.JPG](https://commons.wikimedia.org/wiki/File:Phoenix_bathroom_Residence_Inn_Marriott_hotel_with_towels_and_shower.JPG) | Tomwsulcer | [CC0](http://creativecommons.org/publicdomain/zero/1.0/deed.en) |
| bath-24 / development | [Cedar Point's Express Hotel bathroom (34173339541).jpg](https://commons.wikimedia.org/wiki/File:Cedar_Point%2527s_Express_Hotel_bathroom_%2834173339541%29.jpg) | Ken Srail from North Olmsted, OH | [CC BY 2.0](https://creativecommons.org/licenses/by/2.0) |
| bath-25 / development | [Hotel bathroom at Quality Hotel Grand, Borås.jpg](https://commons.wikimedia.org/wiki/File:Hotel_bathroom_at_Quality_Hotel_Grand,_Bor%25C3%25A5s.jpg) | JIP | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) |
| bath-26 / development | [Bathroom at La Fonda Hotel (14909619835).jpg](https://commons.wikimedia.org/wiki/File:Bathroom_at_La_Fonda_Hotel_%2814909619835%29.jpg) | McLevn | [CC BY-SA 2.0](https://creativecommons.org/licenses/by-sa/2.0) |
| bath-27 / heldout | [Bathtub in bathroom of premier room in Buddha bar hotel Prague - image 2.jpg](https://commons.wikimedia.org/wiki/File:Bathtub_in_bathroom_of_premier_room_in_Buddha_bar_hotel_Prague_-_image_2.jpg) | Pittigrilli | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) |
| bath-28 / development | [Bathroom @ Shangri-La Hotel, Taipei 2017.jpg](https://commons.wikimedia.org/wiki/File:Bathroom_@_Shangri-La_Hotel,_Taipei_2017.jpg) | Kanesue | [CC BY 2.0](https://creativecommons.org/licenses/by/2.0) |
| bath-29 / development | [Hotel Pohjanhovi Standard Twin bathroom a.jpg](https://commons.wikimedia.org/wiki/File:Hotel_Pohjanhovi_Standard_Twin_bathroom_a.jpg) | Htm | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) |
| bath-30 / development | [Modern Ofuro.jpg](https://commons.wikimedia.org/wiki/File:Modern_Ofuro.jpg) | MC MasterChef | [CC BY-SA 2.5](https://creativecommons.org/licenses/by-sa/2.5) |
| bath-31 / heldout | [A modern styled hotel bathroom.jpg](https://commons.wikimedia.org/wiki/File:A_modern_styled_hotel_bathroom.jpg) | Tim36272 | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0) |
| bath-32 / heldout | [Small Bathroom Renovation in Wellington.jpg](https://commons.wikimedia.org/wiki/File:Small_Bathroom_Renovation_in_Wellington.jpg) | Smtzzz | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) |
| bath-33 / development | [Contemporary bathroom.jpg](https://commons.wikimedia.org/wiki/File:Contemporary_bathroom.jpg) | OKJaguar | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0) |
| bath-34 / heldout | [Bathroomcabinet2.jpg](https://commons.wikimedia.org/wiki/File:Bathroomcabinet2.jpg) | Yvwv | Public domain |
| bath-35 / heldout | [Bathroom in hotel in Bergen, Norway. 2016-03-16. hand wash basin sink, mirror, toilet, shower cabinet, etc (low view). Also wall and floor tiles.jpg](https://commons.wikimedia.org/wiki/File:Bathroom_in_hotel_in_Bergen,_Norway._2016-03-16._hand_wash_basin_sink,_mirror,_toilet,_shower_cabinet,_etc_%28low_view%29._Also_wall_and_floor_tiles.jpg) | Wolfmann | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) |
| bath-36 / heldout | [Pink and black bathroom.jpg](https://commons.wikimedia.org/wiki/File:Pink_and_black_bathroom.jpg) | Downtowngal | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0) |
