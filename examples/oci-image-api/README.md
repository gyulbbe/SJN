# OCI Compose 배포 연습용 API

이 예제는 `/health`에 응답하는 Python 서버다. 배경 제거, 좌우 이미지 생성, R2 저장 기능은 포함하지 않는다.

Ubuntu 서버에서 Docker 설치 후 이 폴더로 이동해 실행한다.

```bash
sudo docker compose up -d --build --wait
curl -fsS http://127.0.0.1:8000/health
```

응답 예시: `{"status":"ok","mode":"deployment-demo"}`.

설치, Windows에서 파일 전송, SSH 터널, 업데이트 방법은 [전체 배포 안내](../../docs/oci-docker-compose.md)를 참고한다.

- `Dockerfile`: Python 실행 환경과 실행 명령.
- `requirements.txt`: 설치할 Python 라이브러리. 최상위 두 패키지 버전을 고정했으며 전체 전이 의존성 잠금 파일은 아니다.
- `compose.yaml`: 실행할 서비스, 포트, 재시작, 상태 검사 설정.
- `app.py`: 상태 확인 API.

호스트의 `127.0.0.1:8000`으로만 연결된다. SSH 터널로 시험할 수 있다. 실제 AI 서비스 연결은 인증 및 별도 작업 처리 프로그램을 구현한 뒤 진행한다.
