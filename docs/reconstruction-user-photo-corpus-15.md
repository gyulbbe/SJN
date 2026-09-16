# 사용자 제공 재구성 테스트 사진 15장

2026-09-14 추가 6장을 기존 9장에 포함했다. 이 목록은 반복 검증용이며 원본 사진·정답·좌표를 앱에 포함하지 않는다. Commons 독립 평가 36장과 별개이고, 이미 본 개발 사례다. 원본·생성물은 로컬에 보관하며 외부 업로드·배포하지 않는다.

공통 비교 공간은 실측 없는 2400×2400×2400mm다. 기존 9장은 직전 after-01과 비교하고 새 6장은 기존 후보 결과가 없으므로 원본 대비 자동 결과만 평가했다.

| ID | 사진 | 원본 SHA-256 |
|---|---|---|
| pc-01 | TEST 화장실.jpg | `6e3c7ad75ac8e1c7ae8c6e2997da7f9ac0a1579f08482d2a57c74b7cd17bafbe` |
| pc-02 | TEST 화장실2.jpg | `8c3ff5c056b2d81e1a8a3ae2d1e587f974690523b9992270ca518e6e8666c4de` |
| pc-03 | test 화장실3.jpg | `0f2a7196a8e307926654990c9cbafa843b518e8043e99ce35ad441a960c6e77b` |
| pc-04 | images.jpg | `b7c46bd8117838723642da8f5e9cbf6ee2ea051a52cf14f88093a49a01d89bfb` |
| remote-01 | 1-Photo-1.jpg | `6093b1ad3781de0807e6f16300723278605698c84e122437117b646e2618f1db` |
| remote-02 | 2-Photo-2.jpg | `cc3dd243cc0a7cfe7f66d55fa26154688ca82225f047a1370e7777d55489cea2` |
| remote-03 | 3-Photo-3.jpg | `9350c5a8f45df044a9ba961b389417c523d6bdcb1408a1005a5bedfb08409636` |
| remote-04 | 4-Photo-4.jpg | `34abbe96f7be3ff8c843cf6a5d9e40e258ddba230ddfaeed265cf846666a504b` |
| remote-05 | 5-Photo-5.jpg | `99bb06d9fcbf5158910db5d0185e6c6c9dda50e86defa484b26b33ac4437b281` |
| additional-04 | TEST 화장실4.jpg | `70eedd90465b552523dbd0cd613742e26a353d51042d721517543121db019283` |
| additional-05 | TEST 화장실5.jpg | `d384a6f534a72c47031cc611555a26ac6cb86e4f7565d84abf7acd8324ec7cbc` |
| additional-06 | TEST 화장실6.jpg | `63cbb2023b55af2beeb9dac6601fa2c0b376628290a4ccbcbeddbcc8a2e6b40f` |
| additional-07 | TEST 화장실7.jpg | `340c498132f756fef0b337f558046d48c9b6d6a183109abb8455d5dfbaad05d0` |
| additional-08 | TEST 화장실8.jpg | `531a76121bd955a9ca05d8c0e6ad61daf3eca7e4816f3445d5803433a3751cc4` |
| additional-09 | TEST 화장실9.jpg | `b3354c190122cca3ed3822988bde451b159580842bc7360d4da0442c2fb44b58` |

전체 원본 경로는 `test-results/reconstruction-quality-next/fifteen-photo-manifest.json`에 있다. 추가 6장은 `C:/Users/H/Downloads/TEST 화장실4.jpg`부터 `TEST 화장실9.jpg`까지다. 전체 15장의 바이트 해시는 실행 후에도 일치했다.

- 결과와 원인: [15장 품질 보고서](reconstruction-nine-photo-quality-next-results-20260914.md)
- 실제 생성 결과: `test-results/reconstruction-quality-next/final-v3-comparison/`와 `final-v3-additional-comparison/`
- 전체 15장 재실행 도구: `test-results/reconstruction-quality-next/run-fifteen-actual.mjs` (기존 로컬 서버·모델 준비 필요, 새 출력 폴더 사용)
- 고정 평가 참고는 런타임 입력·사진별 분기·AI 프롬프트로 사용하지 않는다. 다음 개선의 회귀 검증에도 기존 9장과 새 6장을 모두 포함한다.
