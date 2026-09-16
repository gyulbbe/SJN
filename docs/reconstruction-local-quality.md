> 과거 구현 기록: Qwen/Ollama 및 Python·CUDA 실행 경로는 종료되었습니다. 현재 실행 방법은 [Gemma·브라우저 MoGe 가이드](reconstruction-cloud-browser-setup.md)를 참고하세요.

# 사진 → Before 로컬 정밀 분석 실행 가이드

`local-quality-v1`은 욕실 사진의 설비 목록, 바닥 지지·벽 부착 근거, 표면 기하를 함께 분석해 공간미리의 표준 모형을 배치하는 개발용 분석 방식이다. 일반 사진 생성과 재분석에서 사용할 수 있으며, Lab에서만 작동하는 별도 모형은 아니다. 한 장의 사진으로 보이지 않는 공간이나 실제 제품 치수를 정확히 복원한다고 보장하지 않는다.

실제 9장 비교와 한계는 [9장 재구성 검증 결과](reconstruction-nine-photo-repair-results-20260914.md)에 별도로 기록한다. 이 문서는 실행 방법이며 과거 실험 수치를 이번 구현의 검증 결과로 사용하지 않는다. 기존 [MoGe 단독 실험 기록](reconstruction-moge2-probe.md)은 당시 독립 실험의 기록으로 유지한다.

## 무엇을 어디서 실행하는가

| 단계           | 실행 위치                             | 역할                                                                                                                                       |
| -------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| DeepLab ADE20K | 사용자 브라우저의 WASM 작업자         | 벽·바닥·설비 분할 등 기본 관측을 만든다. 브라우저 기본 분석에서도 사용한다.                                                                |
| Qwen3-VL 1단계 | Next 개발 서버와 같은 PC의 Ollama     | 사진에서 보이는 설비의 종류와 영역을 구조화된 후보 목록으로 만든다.                                                                        |
| Qwen3-VL 형태 단계 | 같은 로컬 Ollama | 원후보 ID·영역은 고정하고 세면대 지지 구조와 실제 거울 표면을 다시 관측한다. 설치 단계 전에 수행하며 알려진 값과 충돌하면 원값을 유지한다. |
| Qwen3-VL 설치 단계 | 같은 로컬 Ollama                      | 후보의 바닥 받침·전체 공중 간격·벽 연결·상판 지지를 확인하고 검증 규칙으로 설치 방식만 보완한다. 벽 방향·좌표·반사 관계는 추가하지 않는다. |
| MoGe-2         | 같은 PC에서 실행한 CUDA Python 작업자 | 깊이·점 좌표·법선·카메라 내부 파라미터를 추정하고, 분할 관측과 함께 설치를 뒷받침하는 평면을 찾는다.                                       |
| 배치·표준 모형 | 앱의 공통 재구성 코드                 | 관측을 검증해 표준 공간에 배치한다. 근거가 부족한 후보는 확인 대상으로 남긴다.                                                             |

여기서 **Qwen의 단계**는 `Qwen2`라는 다른 모델을 뜻하지 않는다. 제품 사진의 TripoSR 360° 입체화나 BiRefNet 배경 제거도 이번 공간 분석과 별개다. 각 모델의 출력은 검증한 데이터로 읽으며, 출력 텍스트를 코드나 명령으로 실행하지 않는다.

로컬 정밀 분석은 브라우저에 Qwen·MoGe 가중치를 추가 다운로드하지 않는다. 사진은 브라우저에서 같은 로컬 Next 서버로 전달되고, Qwen은 `127.0.0.1:11434`, MoGe는 로컬 Python에서 처리한다. 원격 Codex로 조작하더라도 이때의 실행 PC는 **Next 개발 서버가 켜져 있는 PC**다.

이 AI 경로는 외부 AI 서비스에 사진을 전송하지 않는다. 최초 공개 모델 다운로드에는 인터넷이 필요하지만 사진 분석과 분리되어 있다. 앱의 프로젝트 저장소 설정(D1/R2 등)에 따른 저장 동작은 AI 전송 경로와 별도이므로, 전체 앱의 모든 데이터가 항상 로컬에만 있다는 의미는 아니다.

## 현재 지원 환경

- 저장소에서 `npm run dev`로 실행한 Node 기반 Next 개발 서버.
- 주소는 `http://127.0.0.1:3000` 또는 `http://localhost:3000`처럼 loopback이어야 한다. 다른 사이트에서 보낸 요청은 받지 않는다.
- Ollama에 지정한 Qwen 모델이 이미 설치되어 있어야 한다. 실행 버튼은 모델을 자동 설치하지 않는다.
- MoGe용 Python에는 호환되는 CUDA PyTorch와 의존성이 있어야 한다. **현재 MoGe 실행기는 CUDA를 필수로 검사한다. CPU 대체 경로는 구현하지 않았다.** Qwen이 CPU에서 실행되더라도 전체 정밀 분석이 CPU를 지원하는 것은 아니다.
- 기존 실행 환경은 [MoGe 실험 기록](reconstruction-moge2-probe.md)에 있다. 깨끗한 PC의 신규 Python 환경 설치나 최소 RAM·VRAM 사양은 이번 가이드만으로 검증된 것이 아니다. `npm install`은 웹 의존성만 설치한다.

Cloudflare Workers의 vinext 빌드에서는 아래 로컬 AI 라우트를 명시적인 미지원 응답으로 바꾼다. GET은 `available: false`, POST는 503을 반환하며 Node 작업자나 Ollama를 호출하지 않는다. D1/R2를 연결한다고 CUDA나 AI 서버가 생기지 않는다. `npm run build` 이후 `npm start`도 production 모드이므로 localhost에서 열어도 이 개발 전용 분석을 사용할 수 없다.

- `/api/reconstruction-lab/engine`: Qwen 연결 확인·설비 목록 분석
- `/api/reconstruction/local`: Qwen 지지 근거 분석
- `/api/reconstruction/local/geometry`: MoGe 연결 확인·기하 분석

배포 환경에서는 브라우저 기본 분석을 선택할 수 있다. 로컬 정밀 분석이 실패했다고 서버나 모델을 조용히 바꾸는 동작은 없다.

## 1. Qwen 준비

Ollama를 설치하고 로컬 서비스를 실행한 다음, 필요한 모델을 명시적으로 준비한다.

```powershell
ollama pull qwen3-vl:4b-instruct-q4_K_M
ollama list
```

Ollama가 실행 중이지 않으면 별도 터미널에서 `ollama serve`를 실행한다. 이미 서비스가 떠 있다면 중복 실행하지 않는다. 현재 코드는 Ollama 주소를 `http://127.0.0.1:11434`로 고정하며 외부 서버 주소를 설정하는 옵션은 제공하지 않는다.

모델 이름과 실제 digest는 진단에 남긴다. [Qwen3-VL 공식 모델](https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct)의 라이선스는 Apache-2.0이고, 실행용 태그는 [Ollama 모델 페이지](https://ollama.com/library/qwen3-vl:4b-instruct-q4_K_M)를 사용한다. Ollama 자체는 [MIT 라이선스](https://github.com/ollama/ollama/blob/main/LICENSE)다. 모델 태그의 크기를 전체 실행 메모리 요구량으로 해석하면 안 된다.

## 2. MoGe 준비와 환경 변수

설정은 저장소 루트의 `.env.local`에 넣는다. `.env.example`의 새 주석 블록을 참고하되 실제로 존재하는 Python 경로를 지정한다. 아래 경로의 사용자명과 환경 이름은 각 PC에 맞게 바꿔야 한다.

```dotenv
SJN_GEOMETRY_PYTHON=C:/Users/your-user/miniconda3/envs/your-cuda-env/python.exe
SJN_GEOMETRY_MODEL_DIR=C:/dev/SJN/tmp/moge2
# 선택한 Python에서 cv2를 가져올 수 없을 때만 기존 호환 OpenCV 경로를 지정한다.
# SJN_GEOMETRY_CV2_SITE=C:/Users/your-user/AppData/Local/Programs/Python/Python310/Lib/site-packages
```

| 설정                     | 미설정 시 현재 기본값                                                      | 용도                                                |
| ------------------------ | -------------------------------------------------------------------------- | --------------------------------------------------- |
| `SJN_GEOMETRY_PYTHON`    | 사용자 홈 아래 `miniconda3/envs/whisperx/python.exe`                       | CUDA Python 실행 파일                               |
| `SJN_GEOMETRY_MODEL_DIR` | 저장소 기준 `tmp/moge2`                                                    | 고정 모델·소스 파일 준비 폴더                       |
| `SJN_GEOMETRY_CV2_SITE`  | 사용자 홈 아래 `AppData/Local/Programs/Python/Python310/Lib/site-packages` | 선택 Python에 cv2가 없을 때만 쓰는 기존 OpenCV 경로 |

기본 경로는 기존 Windows 개발 환경을 위한 값으로 다른 PC에 자동으로 존재하지 않는다. 세 변수는 서버 전용이며 `NEXT_PUBLIC_`을 붙이지 않는다. 변경 후 Next 개발 서버를 재시작한다. MoGe 준비 스크립트는 다운로드 경로를 **저장소의 `tmp/` 아래**로 제한한다. 위 예시처럼 `C:/dev/SJN/tmp/moge2`를 사용한다.

선택한 Python에는 `torch`의 CUDA 지원, `numpy`, `scipy`, `psutil`, `Pillow`, `opencv-python`, `huggingface_hub` 등 해당 MoGe 소스의 호환 의존성이 필요하다. 전체 데모 환경을 자동 설치하지 않으며 설치된 패키지를 덮어쓰지도 않는다. 필요한 패키지가 없으면 해당 Python 환경을 준비한 뒤 아래 점검을 다시 한다. 현재 프로젝트에 새 Python 환경을 일괄 생성하는 고정 설치 스크립트는 없다.

```powershell
Set-Location C:\dev\SJN
$geometryPython = 'C:\Users\your-user\miniconda3\envs\your-cuda-env\python.exe'

# 공개 소스·라이선스·모델만 다운로드한다. 이 단계는 사진을 읽지 않는다.
& $geometryPython tests/reconstruction-moge2-probe.py download --work C:\dev\SJN\tmp\moge2

# 파일 무결성, Python 의존성과 CUDA를 점검한다. 사진 추론·모델 다운로드는 하지 않는다.
& $geometryPython scripts/reconstruction-geometry-worker.py --check --work C:\dev\SJN\tmp\moge2
```

별도 OpenCV 경로가 필요한 경우 마지막 명령에 `--extra-cv2-site '실제 호환 site-packages 경로'`를 추가한다. 앱에서는 같은 값을 `SJN_GEOMETRY_CV2_SITE`로 지정한다. 정상 점검 출력에는 `SJN_GEOMETRY_RESULT=` 뒤의 JSON에 `available: true`가 나타난다. `--check` 성공은 설치 점검이며 실제 사진 품질이나 모든 추론의 성공을 보장하지 않는다.

고정 입력은 다음과 같다. 다른 가중치로 파일명만 바꿔 넣으면 무결성 검증에서 중단한다.

| 항목               | 고정 값                                                            |
| ------------------ | ------------------------------------------------------------------ |
| 모델               | `Ruicheng/moge-2-vits-normal`                                      |
| 모델 revision      | `26b477f41595707c5db6770294c0d1721e8ed4ed`                         |
| MoGe 소스 revision | `925b8ed835a7a9cdb7578ba15c658a0afc969030`                         |
| utils3d revision   | `3fab839f0be9931dac7c8488eb0e1600c236e183`                         |
| `model.pt` SHA-256 | `79a16621928c2bf0ed04659218c55c01075e950507f40bb3332fb4c873d3e1dc` |

[MoGe 모델](https://huggingface.co/Ruicheng/moge-2-vits-normal)과 [MoGe 본체](https://github.com/microsoft/MoGe/tree/925b8ed835a7a9cdb7578ba15c658a0afc969030#license)는 MIT이며 포함된 DINOv2 코드에는 Apache-2.0 예외가 있다. [고정 utils3d 소스](https://github.com/EasternJournalist/utils3d/tree/3fab839f0be9931dac7c8488eb0e1600c236e183)는 MIT다. 준비된 원본 소스의 라이선스 파일과 저작권 헤더를 유지한다.

## 3. 앱에서 사용

1. `npm run dev`를 실행하고 `http://127.0.0.1:3000`을 연다.
2. **사진으로 비교 공간 만들기**에서 사진과 공간 크기를 입력한다.
3. **사진 분석 방식**의 연결 확인이 끝나면 방식을 선택한다. 새 프로젝트에서는 두 로컬 서비스가 모두 준비되었을 때 로컬 정밀 분석을 처음 선택한다. 미지원이면 이유를 표시하고 브라우저 기본 분석을 처음 선택한다. 사용자가 선택한 뒤에는 연결 재점검으로 선택을 덮어쓰지 않는다.
4. 분석을 실행한다. 연결 확인 중에는 자동 분석을 실행하지 않으며, 원하면 **분석 없이 직접 구성**을 사용할 수 있다.
5. 결과의 설비 목록과 확인 필요 항목을 검토한다. 종류·설치 방식·위치·크기는 추정 또는 기본값을 포함하므로 필요한 부분을 수정한다.

사진으로 시작하면 재구성 결과가 Before이고, After는 같은 크기·공통 카메라의 빈 공간이다. 사진 없이 시작하면 Before와 After 모두 빈 기본 공간이다.

기존 프로젝트는 **기존 공간 수정 → 사진 다시 분석**으로 들어간다. 저장된 분석 방식을 우선하며, 방식 정보가 없는 이전 프로젝트는 브라우저 기본 분석으로 시작한다. 이전 로컬 정밀 분석 프로젝트를 연결되지 않은 환경에서 열어도 선택을 자동 변경하지 않는다. 연결을 복구하거나 브라우저 기본 분석을 직접 선택해야 한다. 실행 중 실패도 자동 재시도나 다른 분석기로의 자동 전환 없이 이유와 진단을 남긴다.

Lab의 **기존 분석 전체 실행**은 브라우저 기본 분석이고, 새 **개선 후보 전체 실행**은 Qwen의 목록·형태·설치 관측과 MoGe를 함께 쓰는 정밀 분석이다. 새 후보 실행은 두 로컬 서비스가 모두 준비되어야 한다. 과거 Qwen 단독 결과에 사용자 확인 내용을 반영하는 재생은 당시 모드와 관측 근거를 유지한다. 과거 결과 재생을 이번 정밀 분석의 새 인식 성공으로 보지 않는다.

## 캐시, 취소와 처리 시간

- Ollama 가중치는 Ollama의 기존 디스크 캐시를 사용한다. Qwen 호출은 `keep_alive: 0`으로 종료 시 모델 해제를 요청한다.
- MoGe 공개 가중치·소스는 `tmp/moge2/`에 준비한다. 실제 분석 작업자는 오프라인 설정과 Python 네트워크 차단 검사를 사용한다. 이는 Python 수준 차단이며 OS 방화벽 격리라는 뜻은 아니다.
- 사진에서 추정한 점 좌표·법선 등은 `tmp/reconstruction-geometry/cache/`에 별도 보관한다. 사진 해시, 모델·작업자 revision, 분석 해상도와 관측 metadata를 캐시 키에 포함한다. 파일 해시와 입력 정체성을 검사한 결과만 재사용한다. 관측 마스크가 바뀌면 기하 자체를 재사용하면서 평면 추출을 다시 할 수 있다.
- 현재 기하 분석은 사진의 긴 변 최대 2048px에서 실행한다. 이 분석 해상도와 최종 Before 미리보기·내보내기 해상도는 다르다.
- 새 작업의 임시 사진·요청은 `tmp/reconstruction-geometry/jobs/<id>/`에 만든다. 작업자 종료가 확인되면 정리한다. 종료가 불확실하면 실행 중 파일을 무리하게 삭제하지 않는다.
- 기하 캐시가 이미 3GiB를 넘거나 남은 디스크 공간이 512MiB 미만이면 새 산출물 생성을 중단한다. 기존 기록을 자동 삭제하지 않는다. 필요하면 작업 종료 후 해당 캐시만 확인해 정리한다. 이 검사는 정확한 디스크 예약 한도를 보장하지 않는다.
- 저장된 정밀 분석 증거를 재사용할 때도 사진 해시·크기·분석 revision이 맞아야 한다. 새 추론 없이 재사용했는지는 진단에 표시한다.

Qwen과 MoGe는 공통 실행 대기열로 겹치지 않게 처리한다. 취소는 브라우저 요청과 로컬 추론에 전달된다. 종료를 확인할 수 없으면 다음 추론을 막아 겹친 GPU 작업이 계속 생기지 않게 한다. 이런 경우 작업자/Ollama 상태를 확인하고 남은 작업이 끝난 뒤 개발 서버를 재시작한다.

현재 MoGe 연결 점검은 서버에서 최대 45초, UI 요청은 최대 55초를 기다린다. MoGe 실제 Python 작업 한도는 대기열을 통과한 뒤 180초이며 클라이언트 요청은 대기를 포함해 최대 20분이다. 시간 초과는 성공 결과로 처리하지 않는다. 첫 실행의 준비 시간, 대기 시간, 추론 시간, 캐시 재사용 시간을 구분해 비교해야 한다.

`tmp/`와 `test-results/`는 git 제외 대상이다. 기하 캐시도 사진에서 파생한 비공개 자료이므로 공개 저장소나 외부 서비스에 올리지 않는다.

## 원인을 파악할 때 남길 자료

생성 창, 재분석 창 또는 Lab의 **진단 로그 JSON**으로 기록을 다운로드한다. 성공·실패·취소가 각각 저장되며 전용 IndexedDB(`sjn-reconstruction-diagnostics`)에 최근 20회, 합계 25MiB 범위로 보관한다. 저장 실패는 현재 편집 결과를 버리지 않고 알린다. 자세한 형식은 [진단 로그 가이드](reconstruction-diagnostic-logs.md)를 참고한다.

- 일반 생성·재분석 준비 기록: `runs[].projectAnalysis`. `scope`는 `project-prepared-save-transaction-is-separate`다. 이 성공은 프로젝트 준비 완료이며 이후 저장소 트랜잭션 성공을 뜻하지 않는다.
- Lab 성공 기록: `runs[].report`. 후보 추적, 단계별 결과와 실행 로그를 함께 읽는다.
- 실패·취소: `runs[].failure.runLog`. 마지막 완료 단계와 오류 근거를 확인한다.
- 입력 이름·크기·해시, 분석 방식, 실행 ID, 모델·prompt revision, 실제 Qwen digest, 관측과 적용값 및 출처, 보류·제외 이유, 기하 근거·캐시 여부, 단계별 시간을 대조한다. 후보가 처음부터 없었는지, 발견됐지만 배치가 보류됐는지 구분한다.

기록에서 사진 본문·binary와 인증 정보를 제외하고 긴 내용은 잘림을 표시한다. 이벤트 수에도 600개 한도가 있으므로 원시 모델 출력을 무제한 저장하는 덤프는 아니다. 사진 자체를 첨부해야 할 때는 별도로 공유 범위를 정한다.

MoGe 메모리는 해당 Python 프로세스의 RSS 표본과 CUDA allocator 최고치를 기록한다. 브라우저·Ollama·PC 전체 메모리를 합친 값이 아니다. 캐시 적중에는 새 추론 메모리 측정이 없으며 과거 값은 `cachedMeasurement`로 구분한다. 처리 완료, 낮은 재투영 오차 또는 빠른 실행만으로 실제 위치 정확도가 높다고 판단하지 않는다.

## 자주 막히는 경우

| 증상                                 | 확인할 항목                                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| 설비 분석 연결 실패                  | Ollama가 127.0.0.1:11434에서 실행 중인지, 지정 태그가 `ollama list`에 있는지 확인한다.                                               |
| Python 실행 파일 없음                | `.env.local`의 `SJN_GEOMETRY_PYTHON`을 실제 환경으로 바꾸고 Next를 재시작한다.                                                       |
| CUDA 또는 Python 모듈 오류           | 선택한 Python의 CUDA PyTorch·필요 의존성을 준비한다. 현재 CPU로 자동 전환하지 않는다.                                                |
| 모델·소스 파일 없음 또는 해시 불일치 | 올바른 저장소 `tmp/` 아래 `--work` 경로에 공개 파일 준비 명령을 실행하고 `--check`로 확인한다. 사진 실행으로 설치를 대신하지 않는다. |
| Workers/production에서 미지원        | 현재 의도된 제한이다. 로컬 Node 개발 환경에서 사용하거나 브라우저 기본 분석을 직접 선택한다.                                         |
| 취소 뒤 실행 차단                    | 종료가 확인되지 않은 작업의 진단을 읽고 프로세스 종료를 확인한다. 작업을 계속 겹쳐 실행하지 않는다.                                  |
| 같은 사진인데 결과가 다름            | 실제 모델 digest·prompt/작업자 revision·캐시·사용자 확인값·공간 치수를 함께 비교한다.                                                |
| 거울·유리·가려진 접점이 부정확함     | 모델 관측의 한계일 수 있다. 인식과 배치 진단을 나눠 보고 사용자가 확인한다. 추가 추론의 성공을 실제 기하 정답으로 간주하지 않는다.   |

## 구현 위치

- 공통 실행·계약: `src/lib/reconstruction/quality-core.ts`, `quality-contract.ts`, `index.ts`
- Qwen 관측·설치 판단: `local-engine-server.ts`, `inventory-observation.ts`, `installation-observation.ts`
- 기하 실행·검증: `geometry-local-client.ts`, `geometry-local-server.ts`, `geometry-contract.ts`, `scripts/reconstruction-geometry-worker.py`
- 환경별 라우트 처리: `src/app/api/reconstruction/local/`, `build/cloudflare-local.ts`
- 프로필 선택: `src/components/reconstruction/analysis-profile-picker.tsx`
- 일반 분석 진단: `src/lib/reconstruction/project-diagnostics.ts`, `lab-diagnostic-storage.ts`

## 형태·거울 역할 관측 갱신 (2026-09-14)

현재 분석 revision은 `local-quality-v1-identity-geometry-4`이다. `fixture-identity-v1` 계약과 `fixture-identity-rules-v2` 규칙으로 원목록 → 형태 재확인 → 설치 관측 → 기하 → 배치를 연결한다. 새 모델을 도입하지 않고 기존 4B 모델을 한 번 더 호출한다. 대상(세면대·하부장·거울·거울장)이 없는 사진은 이 추가 추론을 생략한다.

원목록은 `quality.inventory`, 형태 원응답과 제안은 `quality.identity`, 설치는 `quality.installation`, 최종 배치 입력은 `quality.effectiveUnderstanding`에 분리한다. 제안마다 original / proposed / final과 applied / confirmed / quarantined / unobserved를 기록한다. 출처는 규칙 추정(`rule-inferred`), 관측 근거는 모델(`model`)이다. 같은 모델의 재관측은 독립적인 정답 검증이 아니다. 후보별 진단에는 형태 단계가 추가되며, 보류한 제안을 모형 생성 성공으로 세지 않는다.

기존 관측은 읽을 수 있지만 새 계약과 다른 관측을 현재 분석의 재사용으로 처리하지 않는다. 현재 계약의 재사용도 원응답을 다시 파싱하고 모델 digest, 프롬프트·규칙 revision, 사진, 기하, 최종 병합 결과를 검사한다. 실패 시 이전 기록을 유지하며 자동으로 AI를 다시 실행하지 않는다. 오래된 결과를 새로 분석하는 동작과 저장된 결과의 단순 재생은 구분한다.

실제 9장 비교·채택하지 않은 기하 및 crop 실험·남은 한계는 [후속 품질 검증 보고서](reconstruction-nine-photo-quality-next-results-20260914.md)에 기록한다.
형태 보정 규칙 `fixture-identity-rules-v3`는 별도 받침대 후보가 세면볼 아래에서 겹치거나 접하는 경우 벽걸이 보정을 격리한다. 사진 영역의 겹침을 3D 지지 관계의 확정으로 쓰지는 않는다. `competingSupportCandidateIds`에 경쟁 후보를 남기며 원래 값과 명시된 partOf 관계를 보존한다. 상판형인지 확정하지 못한 상태를 벽걸이형으로 바꿔 숨기지 않는다.
