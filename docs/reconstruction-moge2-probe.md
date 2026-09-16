# MoGe-2 로컬 기하 실험

이 도구는 사진 재구성 개선을 조사하기 위한 명시적 개발 실험이다. 앱 기본 분석기·의존성·API·배포·TripoSR에는 연결하지 않는다. 사진의 물리 바닥 범위가 확인되지 않은 문제를 자동으로 해결했다고 판단하지 않는다.

## 고정 소스와 라이선스

- [Microsoft MoGe 공식 소스](https://github.com/microsoft/MoGe/tree/925b8ed835a7a9cdb7578ba15c658a0afc969030): `925b8ed835a7a9cdb7578ba15c658a0afc969030`. MoGe-2 `moge/model/v2.py`의 `from_pretrained(local checkpoint)`와 `infer`를 사용한다. MoGe-3/Triton 경로를 사용하지 않는다.
- [공식 모델 페이지](https://huggingface.co/Ruicheng/moge-2-vits-normal): `Ruicheng/moge-2-vits-normal`, revision `26b477f41595707c5db6770294c0d1721e8ed4ed`. 고정 revision metadata의 `sha`와 `cardData.license=mit`를 확인했다.
- 모델 파일: `140,550,416 bytes`, SHA-256 `79a16621928c2bf0ed04659218c55c01075e950507f40bb3332fb4c873d3e1dc`, 실제 parameter count `35,103,656`.
- MoGe 본체 MIT, MoGe에 포함된 DINOv2 코드는 Apache-2.0 예외가 있다. 원본 소스의 라이선스·저작권 헤더를 그대로 보관한다. [고정 소스 README의 License](https://github.com/microsoft/MoGe/tree/925b8ed835a7a9cdb7578ba15c658a0afc969030#license).
- 공식 requirements에 지정된 [utils3d](https://github.com/EasternJournalist/utils3d/tree/3fab839f0be9931dac7c8488eb0e1600c236e183) revision `3fab839f0be9931dac7c8488eb0e1600c236e183`도 MIT이며 소스 경로로만 사용한다.
- ZIP·라이선스·모델·metadata·cache는 git에서 제외된 `tmp/moge2/`에 저장한다. Python 환경과 프로젝트 package.json을 변경하거나 pip를 실행하지 않았다.

## 재현 명령

`tests/reconstruction-moge2-probe.py`는 다운로드와 추론을 별도 명령으로 나눈다. Python 경로는 CUDA PyTorch 및 기존 호환 의존성이 설치된 환경으로 지정한다. 이번 실행에서는 기존 whisperx Python 3.10 환경을 사용했다.

```powershell
$probePython = 'C:\Users\H\miniconda3\envs\whisperx\python.exe'
& $probePython tests/reconstruction-moge2-probe.py download

# 다운로드가 끝난 다음 실행한다. 이 명령은 외부 접속을 허용하지 않는다.
& $probePython tests/reconstruction-moge2-probe.py run --extra-cv2-site 'C:\Users\H\AppData\Local\Programs\Python\Python310\Lib\site-packages'
```

`--extra-cv2-site`는 지정 환경에 cv2가 없을 때 **이미 설치된 호환 OpenCV**만 import하기 위한 선택 인수다. 외부 site 경로는 cv2 import 직후 제거하며 다른 패키지를 설치하지 않는다. 이번 실행은 기존 OpenCV 4.13.0을 사용했다. 호환 설치가 없으면 오류로 중단하며 자동 설치하지 않는다.

기본 manifest는 비공개 `test-results/reconstruction-moge2-20260913/manifest.json`이다. 각 case는 `id`, `split`, `input.path`, `input.sha256`, `input.width`, `input.height`를 가진다. 입력 파일은 로컬에 별도로 있어야 하며 해시와 디코딩 크기가 맞지 않으면 실행하지 않는다. 다운로드 단계는 manifest나 사진을 읽지 않는다.

반복 실행은 `--output test-results/reconstruction-moge2-repeat`처럼 별도 결과 폴더를 권장한다. 기존 결과가 있으면 기본적으로 중단한다. `--case user-01`로 범위를 제한할 수 있으나 부분 실행 결과로 전체 8장의 성공을 주장하지 않는다. 기존 결과를 바꾸려면 명시적 `--overwrite`가 필요하다.

추론 단계는 먼저 로컬 ZIP·가중치 SHA-256과 압축 해제된 소스 바이트를 검증한다. `HF_HOME`, `HF_HUB_CACHE`, `TORCH_HOME`, `XDG_CACHE_HOME`, `MPLCONFIGDIR`을 tmp 아래로 고정하고 `HF_HUB_OFFLINE`/`TRANSFORMERS_OFFLINE`을 활성화한다. 모델 import 전에 Python audit hook으로 DNS·socket connect/sendto·urllib 요청을 차단하고 자체 차단 검사를 수행한다. 이는 Python 수준 보호이며 OS 방화벽 격리라고 표현하지 않는다. 실제 모델 실행에서 추가 네트워크 시도는 0건이었다.

## 입력과 출력 계약

실행 조건은 전 사진 동일하다. 고정 JPEG의 EXIF 방향을 반영한 뒤 원본 해상도를 유지한다. `resolution_level=9`, `num_tokens_range=[1200,3600]`에서 3600 tokens, `use_fp16=True`, `force_projection=True`, `apply_mask=True`, `fov_x=None`이다. 방 치수·설비 주석·설치 벽·semantic mask를 모델에 제공하지 않는다.

결과 `{id}/geometry.npz`에는 원본 해상도와 같은 배열을 저장한다.

| 키 | 형태 | 의미 |
| --- | --- | --- |
| points | H×W×3 float32 | 모델이 추정한 카메라 좌표 pointmap |
| depth | H×W float32 | 카메라 z 방향 모델 추정 깊이 |
| normal | H×W×3 float32 | 표면 법선 추정 |
| mask | H×W bool | 모델 유효성 마스크. 바닥 분할이 아님 |
| intrinsics | 3×3 float32 | 사진 가로·세로로 정규화한 카메라 내부 파라미터 추정 |

좌표는 OpenCV의 오른쪽 +x, 아래 +y, 전방 +z이다. 모델이 예측한 metric scale은 실제 측정치가 아니다. 공통 표준 룸의 원점·방위·회전·카메라 위치로 변환한 값이 아니다.

각 case의 `report.json`에 입력 해시, 출력 해시, 배열 형태·유효 픽셀·깊이 범위·법선 길이·intrinsics·FOV, 시간과 메모리를 기록한다. `depth.png`는 사진별 깊이 p2–p98의 로그 색상화이고 `normal.png`는 xyz 법선을 RGB로 표시한다. `valid-mask.png`, 입력과 결과를 나란히 둔 `diagnostic.png`도 저장한다. 표시 범위가 사진마다 달라서 깊이 PNG의 같은 색이 같은 거리를 뜻하지 않는다.

원본 사진이 포함된 manifest, PNG 및 모델 결과는 `test-results/`에만 둔다. 결과·원문·사진을 공개 저장소에 추가하거나 외부 API로 전송하지 않는다.

## 2026-09-13 실제 실행 결과

`test-results/reconstruction-moge2-20260913/summary.json`의 8장 실행은 exit 0, status complete, errors=[], 추가 네트워크 시도 []였다. 이는 **추론 및 출력 계약 완료**다. 제품 위치 정확도나 전체 재구성 품질 합격을 의미하지 않는다.

| 입력 | 구분 | 동기화한 추론 시간 s | case 전체 s |
| --- | --- | ---: | ---: |
| user-01 | 기존 사용자 개발 사례 | 1.715 | 2.343 |
| user-02 | 기존 사용자 개발 사례 | 0.101 | 0.437 |
| user-03 | 기존 사용자 개발 사례 | 0.091 | 0.414 |
| user-04 | 기존 사용자 개발 사례 | 0.065 | 0.416 |
| bath-20 | 재사용 회귀 사진 | 0.089 | 0.990 |
| bath-22 | 재사용 회귀 사진 | 0.088 | 1.120 |
| bath-27 | 재사용 회귀 사진 | 0.082 | 0.697 |
| bath-31 | 재사용 회귀 사진 | 0.070 | 1.178 |

별도 4장은 이전 평가에서 사용한 사진으로 새 미공개 홀드아웃이 아니다. 위 수치에는 다운로드가 포함되지 않는다. 첫 user-01은 별도 warm-up 없는 첫 추론으로, 이후 사진과 동일한 준비 상태가 아니다. 추론 시간은 GPU 동기화로 측정한 `infer`만 포함하며 배열 CPU 복사·검증·NPZ/PNG 생성은 제외한다. case 전체에는 입력 로딩부터 산출물 생성까지 포함하되 마지막 해시·JSON 기록·GC 일부는 제외된다.

실행 환경: Windows, Python 3.10.20, torch 2.11.0+cu128, RTX 4070 Ti 12GB. 모델 로드 0.608s, offline guard 이후 import·모델 로드·8장 처리 등을 포함한 기록 범위 13.024s. Python 프로세스의 CUDA allocator 최대 allocated 1,210,328,576 bytes(약 1.13GiB), reserved 1,526,726,656 bytes(약 1.42GiB). 이는 GPU 전체 사용량이 아니다. 20ms 간격으로 관측한 프로세스 working-set RSS 최대 1,715,486,720 bytes(약 1.60GiB)이며 순간 최대치를 놓칠 수 있다. 브라우저 Chrome WASM DeepLab 및 개발 작업이 겹칠 수 있는 환경으로, 격리된 최고 성능 벤치마크가 아니다.

8장 모두 유효 마스크 내부 배열이 finite이고 z-depth가 일치하며 법선 길이는 약 1이었다. 재투영 오차 최대는 0.00026px 미만이었다. 그러나 `force_projection=True`가 깊이와 추정 intrinsics로 points를 다시 만들기 때문에 이 수치는 **내부 일관성**만 보여준다. 원본 카메라나 실제 거리의 정확도를 검증하는 독립 지표가 아니다.

## 육안 확인과 다음 검증 범위

8장 diagnostic PNG를 직접 확인했다. user-03의 기둥·샤워턱, user-04의 바닥·하부장·뒤벽에는 방향을 구분하는 법선 신호가 보인다. bath-20/22의 세면대 및 서로 다른 벽 방향, bath-27의 욕조 외곽, bath-31의 기둥·천장·벽도 표면 차이가 보인다. 이는 시각적 관찰이며 치수 정답 비교가 아니다.

특히 user-01/03/31의 투명 유리는 뒤쪽 면과 분리된 깊이를 얻었다고 판단하기 어렵다. 거울과 그 안의 반사도 실제 표면·반사상의 기하를 안정적으로 구분했다는 검증이 없다. **8장 모두 maskCoverage=1.0**으로, 유효성 마스크를 바닥·가림·확신도 필터로 사용하면 안 된다. 이 모델 결과만으로 안 보이는 물리 바닥 전체 모서리를 채울 수 없다.

후속 실험은 기존 semantic floor/wall mask와 pointmap 좌표계를 먼저 정렬하고, 다수 법선·독립 plane residual·가림/유리/거울 제외 및 split별 실패율을 함께 검증해야 한다. 보이는 바닥의 점 집합에서 얻은 plane은 바닥의 방향·카메라 상대 위치 추정이며 전체 방 범위를 뜻하지 않는다. 공통 룸으로 옮기는 기준점·회전·scale은 별도 근거 또는 사용자 확인이 필요하다. 제품 접점·지지면·높이의 오차를 검증하기 전에는 출력 좌표를 자동 배치에 사용하거나 앱 기본 모델로 채택하지 않는다.