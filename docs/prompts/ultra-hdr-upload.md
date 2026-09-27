# 요즘 휴대폰 사진(Ultra HDR·모션 포토) 업로드 거부 고치기

요즘 Android 카메라가 찍은 JPEG이 SJN 업로드에서 "손상된 이미지이거나 지원하지 않는 형식이에요"로 거부된다. 이 사진들도 정상적으로 올라가게 고쳐줘. 조사나 계획 설명에서 멈추지 말고 구현, 테스트, 문서, 보고까지 끝낸다. AI 호출과 비용은 없다.

## 0. 발견 경위와 원인 (2026-09-27)

- [사진 조명 맞춤 결과](../photo-lighting-match-results-20260927.md)에서 발견했다.
  - 저장소의 실제 욕실 사진 5장(`.codex-remote-attachments/01a071fe-92b3-77b3-a261-8698b3d3f8e9/04c0e236-9188-46ed-9a61-a8ff283287f8/1~5-Photo-*.jpg`, 세로 960×1280)은 모두 Android **Ultra HDR JPEG**이다.
  - 파일 구조: 기본 SDR JPEG + APP2 `MPF` 세그먼트 + 뒤에 붙은 두 번째 JPEG(ISO 21496-1 게인 맵). Display P3 ICC가 들어 있다.
- **원인**: 서버 업로드 검사 `validateD1Image`(`src/lib/d1/images.ts`)가 두 가지로 거부한다.
  - APP2 `MPF\0` 세그먼트를 만나면 바로 실패한다. "정지 JPG"만 받는 정책이다.
  - 파일 끝이 `FFD9`가 아니어도 실패한다. 모션 포토처럼 JPEG 뒤에 영상이 붙은 파일이 여기에 걸린다.
- **영향 범위**: `src/lib/d1/assets.ts`에서 이미지 자산은 전부 `validateD1Image`를 거친다. 그래서 한 기능이 아니라 **모든 이미지 업로드**가 영향을 받을 수 있다.
  - 사진으로 비교 공간 만들기
  - 자재 등록의 텍스처·제품 사진
  - 배경 제거·입체화의 원본
  - 편집기 사진
  - 로컬 저장(IndexedDB) 모드는 서버 검사를 거치지 않아 동작이 다를 수 있다. 확인한다.
- **클라이언트 가져오기**: `importImage`(`src/lib/images.ts`)는 원본 바이트를 그대로 `original` 자산으로 저장하고, 캔버스로 편집용 미리보기를 따로 만든다. 브라우저는 Ultra HDR의 기본 이미지를 정상으로 디코딩한다.

## 1. 먼저 읽는다

- `AGENTS.md`, `.agents/skills/sjn-workflow/SKILL.md`와 references(DB·권한, 개발/배포 환경·R2), `node_modules/next/dist/docs/`의 관련 문서
- `src/lib/d1/images.ts`, `src/lib/d1/assets.ts`, `src/lib/images.ts`(`importImage`, `readImageHeader`)
- `src/lib/file-drop.ts`와 이미지를 받는 모든 입력: 홈 시작 카드, 직접 편집, 비교 창 사진 상자, 자재 폼, 배경 제거·입체화
- 관련 테스트: `tests/*image*`, `tests/d1-storage.test.ts`, `tests/material-images.test.ts`, `e2e/file-drop.spec.ts`, `e2e/upload-read-error*.spec.ts`, `e2e/material-images.spec.ts`
- `docs/material-images.md`

## 2. 작업 환경

- `C:\app\SJN`의 main에서 새 브랜치 `claude/ultra-hdr-upload`를 만든다(워크트리 사용 가능).
- bare `git stash`는 쓰지 않는다. 커밋은 작업 단위로 한다. 푸시·main 병합은 사용자가 요청할 때만 한다.

## 3. 해결 방향: 가져올 때 "기본 이미지만" 남긴다

- **서버의 엄격한 검사는 유지한다**(여러 장·뒤에 붙은 데이터 거부). 대신 **브라우저에서 가져올 때 파일을 정리**해 기본 이미지 한 장만 저장·업로드한다.
- **JPEG 정리 규칙**
  1. 기본 JPEG을 끝까지 파싱해 첫 `EOI(FFD9)`의 위치를 찾는다. 엔트로피 데이터 안의 `FF00` 채움과 `RSTn`, progressive의 여러 `SOS`를 올바르게 넘는다.
  2. 그 뒤의 데이터(게인 맵 JPEG, 모션 포토 영상 등)는 버린다.
  3. APP2 `MPF` 세그먼트는 제거한다. 가리키는 대상이 없어지기 때문이다.
  4. **나머지 바이트는 그대로** 둔다. 다시 인코딩하지 않으므로 화질 손실이 없다.
     - EXIF 방향, ICC(Display P3 포함), 다른 APP 세그먼트는 유지한다.
     - 게인 맵을 가리키는 XMP(`hdrgm`, `MotionPhoto` 등)는 남아도 해가 없는지 확인하고 판단한다. 남기면 서버 검사와 충돌하지 않는지 본다.
  5. 정리한 결과가 올바른 단일 JPEG인지 `readImageHeader`와 서버 검사 함수로 다시 확인한다. 실패하면 지금처럼 명확한 오류를 보인다.
- **적용 위치**: 모든 이미지 가져오기 경로가 한 함수를 거치게 한다(`importImage` 또는 그 앞의 공용 단계). 로컬 저장 모드와 D1 모드가 같은 결과를 내야 한다.
- **사용자 안내**: 정리는 조용히 한다. 경고를 띄우지 않는다. 자산 메타데이터에 "HDR 게인 맵 제거" 같은 표시를 남길지는 판단해 적는다.
- **다른 휴대폰 형식도 같은 원리로 처리되는지 확인한다.**
  - iPhone HDR JPEG(Apple 게인 맵, MPF 사용)
  - Samsung·Google 모션 포토(JPEG 뒤 MP4)
  - HEIC/HEIF는 브라우저(Chrome)가 디코딩하지 못하면 지금처럼 거부하되, "JPG로 저장해 다시 올려 주세요" 같은 안내가 나오는지 확인한다. 변환 기능 추가는 이번 범위가 아니다. 필요하면 제안한다.
- **서버 검사 문구**: MPF나 뒤에 붙은 데이터로 거부할 때의 문구를 사람이 이해할 수 있게 바꿀지 판단한다. 예: "HDR·움직이는 사진 정보가 붙은 JPEG이에요." 정상 경로에서는 클라이언트가 정리하므로 이 문구는 예외 상황에서만 보인다.

## 4. 반드시 지킬 조건

- 서버가 받는 이미지 형식의 안전 조건은 약하게 하지 않는다. 여러 장 이미지와 뒤에 붙은 데이터를 저장하지 않는다.
- 기존에 저장된 자산과 문서는 그대로 읽는다.
- 다시 인코딩하지 않는다. 기본 이미지의 픽셀이 원본 디코딩과 같아야 한다.
- 사진 데이터를 로그·진단에 넣지 않는다.
- 줄바꿈은 작업 사본 CRLF, 저장소 LF다. Prettier는 쓰기에 `--end-of-line crlf --write`, 검사에 `--end-of-line auto`를 쓴다. typecheck 뒤 `next-env.d.ts`를 되돌린다.

## 5. 검증

- **단위**
  - 파서: baseline·progressive, `FF00`·`RSTn`, APP2 MPF 제거, 뒤 데이터 제거, EXIF 방향·ICC 유지, 손상 파일 거부
  - 저장소 사진 5장: 정리 후 `validateD1Image` 통과, 기본 이미지 디코딩 픽셀이 정리 전과 동일, 크기(960×1280)·방향 동일
  - 합성 시험 파일: 모션 포토(JPEG+MP4 꼬리), iPhone형 MPF. 실물이 없으면 규격대로 만든 작은 시험 파일로 대신하고 그렇게 적는다.
- **e2e**
  - 사진 5장 중 최소 2장으로 사진으로 비교 공간 만들기, 자재 폼 제품 사진 등록, 끌어 놓기 업로드가 성공한다.
  - D1 모드(격리 D1/R2)와 로컬 모드 모두 확인한다.
  - 새로고침 뒤에도 이미지가 그대로 보인다.
- 기존 `file-drop`, `material-images`, `upload-read-error`, `d1-storage`, 비교 공간 관련 spec이 통과해야 한다.
- `npm run typecheck`, `npm run lint`, 변경 파일 Prettier
- 전체 `npx vitest run`: 알려진 환경 실패(`reconstruction-corpus` 해시, `reconstruction-source-plane-mapping`, 로컬 D1/R2 첫 연결 초과) 외 실패 없음. CPU 부하 중 시간 초과는 환경 문제로 구분한다.

## 6. 문서와 보고

- `docs/material-images.md`의 업로드 규칙에 Ultra HDR·모션 포토 처리 방식을 적는다.
- `docs/verification.md` 맨 위에 항목을 추가한다.
- `docs/photo-lighting-match-results-20260927.md`의 "Ultra HDR JPEG 업로드 거부" 한계 항목에 해결 링크를 단다.
- **보고**
  - 원인
  - 처리 규칙과 영향받던 업로드 경로 목록
  - 파일별 변경과 이유, 테스트 결과
  - 남은 한계(HEIC 등)
