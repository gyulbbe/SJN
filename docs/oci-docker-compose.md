# OCI에 Docker Compose로 Python 서버 배포하기

SJN 웹사이트는 Cloudflare에 두고, Python 프로그램을 기존 OCI 서버에서 실행하는 안내다. Windows PowerShell은 파일 전송과 SSH 접속에 사용한다. Docker 명령은 SSH로 접속한 OCI 터미널에서 실행한다.

현재 `examples/oci-image-api`는 **배포 연습용 API**다. `/health`로 서버 실행만 확인하며, 배경 제거·좌우 생성·R2 저장은 구현되어 있지 않다. 이 안내를 마치면 Python 서버 배포 기반을 갖추게 된다.

## 1. OCI 서버에 접속하고 운영체제 확인

OCI 인스턴스 상세 화면에서 운영체제, 공인 IP, Shape/OCPU/메모리를 확인한다. 아래 `서버IP`와 SSH 개인 키 경로를 실제 값으로 바꾼다. 개인 키는 자기 PC에 둔다.

**Windows PowerShell — Ubuntu 서버 접속:**

```powershell
ssh -i "C:\Users\H\Downloads\ssh-key.key" ubuntu@서버IP
```

Oracle Linux 기본 계정은 `opc`다. 처음 접속할 때 표시되는 호스트 키 지문은 OCI 콘솔에서 확인한 값과 대조한다. [OCI Linux 접속 문서](https://docs.oracle.com/en-us/iaas/Content/Compute/Tasks/connect-to-linux-instance.htm)

**접속한 OCI 터미널:**

```bash
cat /etc/os-release
uname -m
nproc
free -h
```

다음 설치 단계는 **Ubuntu 22.04/24.04** 기준이다. `aarch64`는 ARM64, `x86_64`는 AMD64이며 Docker는 두 아키텍처를 지원한다. Oracle Linux라면 아래 Ubuntu용 `apt-get` 설치 명령을 실행하지 않는다. 이미 Docker와 Compose가 동작하면 2단계를 건너뛴다. [Docker 지원 환경](https://docs.docker.com/engine/install/ubuntu/#os-requirements)

## 2. Docker Engine과 Compose 설치

**Ubuntu OCI 터미널에서 실행:**

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

sudo tee /etc/apt/sources.list.d/docker.sources > /dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker version
sudo docker compose version
```

Docker의 공식 저장소 설치 절차를 따른다. 기존 Docker/Podman/containerd와 충돌한다는 오류가 나오면, 기존 서비스 사용 여부와 설치 상태부터 확인한다. [공식 설치 절차](https://docs.docker.com/engine/install/ubuntu/#install-using-the-apt-repository)

서버에는 Docker Engine을 설치한다. 이 배포를 위해 사용자 Windows PC에 Docker Desktop을 실행할 필요는 없다. Python도 컨테이너 안에 설치되므로 OCI 호스트에 별도로 설치하지 않아도 된다.

## 3. 준비된 예제를 OCI로 전송

**새 Windows PowerShell 창에서 실행:**

```powershell
scp -i "C:\Users\H\Downloads\ssh-key.key" -r "C:\dev\SJN\examples\oci-image-api" ubuntu@서버IP:~/
```

원격 홈 폴더에 `oci-image-api`가 생긴다. Oracle Linux에 이미 Docker가 설치되어 있어 이후 과정을 따르는 경우에는 접속 계정을 `opc`로 바꾼다.

파일 역할은 다음과 같다.

| 파일 | 역할 |
| --- | --- |
| `app.py` | `/health`에 응답하는 Python 프로그램 |
| `requirements.txt` | FastAPI와 Uvicorn 설치 버전 |
| `Dockerfile` | Python 실행 환경을 만들고 프로그램을 실행하는 방법 |
| `compose.yaml` | 서비스 실행, 포트, 재시작, 상태 검사 설정 |
| `.dockerignore` | 이미지 빌드에 필요한 파일만 포함 |

이 예제의 Compose 설정에는 `api` 서비스 하나가 있다. AI 기능을 구현할 때 무거운 작업을 담당하는 별도 처리 서비스를 추가할 수 있다. [FastAPI Docker 배포](https://fastapi.tiangolo.com/deployment/docker/)

## 4. 빌드하고 실행

**OCI 터미널에서 실행:**

```bash
cd ~/oci-image-api
sudo docker compose config --quiet
sudo docker compose up -d --build --wait
sudo docker compose ps
curl -fsS http://127.0.0.1:8000/health
```

정상 응답은 다음과 같다.

```json
{"status":"ok","mode":"deployment-demo"}
```

`--build`는 실행 환경을 만들고, `-d`는 터미널을 닫아도 실행하게 하며, `--wait`는 상태 검사를 통과할 때까지 기다린다. 처음에는 Python 이미지와 패키지를 내려받는다. [Compose 실행 명령](https://docs.docker.com/reference/cli/docker/compose/up/)

`restart: unless-stopped`는 프로세스 종료나 서버 재부팅 후 다시 실행하도록 설정한다. 직접 중지한 컨테이너는 자동으로 시작하지 않는다. 상태 검사가 실패해 `unhealthy`가 되는 것만으로 자동 재시작되지는 않는다. [재시작 정책](https://docs.docker.com/engine/containers/start-containers-automatically/)

## 5. 내 PC 브라우저에서 확인

예제는 OCI의 `127.0.0.1:8000`에 연결된다. OCI 공인 IP의 8000번 포트로 직접 접속하는 구성은 아니다. 기존 SSH 연결을 활용해 확인한다. [Docker 포트 바인딩](https://docs.docker.com/engine/network/port-publishing/)

**Windows PowerShell의 새 창:**

```powershell
ssh -i "C:\Users\H\Downloads\ssh-key.key" -N -L 127.0.0.1:18000:127.0.0.1:8000 ubuntu@서버IP
```

이 창을 켜 둔 상태에서 PC 브라우저로 다음 주소를 연다.

- 상태 확인: `http://127.0.0.1:18000/health`
- API 문서: `http://127.0.0.1:18000/docs`

명령 실행 후 아무 메시지가 없어도 오류가 아니라 연결 대기 상태일 수 있다. `Ctrl+C`로 SSH 터널만 종료할 수 있으며 OCI 컨테이너는 계속 실행된다. 18000번 포트를 이미 사용 중이면 명령과 브라우저 주소의 18000을 함께 바꾼다. [SSH 포트 전달](https://man.openbsd.org/ssh#L)

이 단계가 성공하면 OCI에 Python API를 배포하고 접속하는 과정이 확인된 것이다. AI 모델이 실행된 것은 아니다.

## 6. 업데이트 및 상태 확인

PC에서 예제를 수정한 뒤 3단계의 `scp`로 다시 전송하고, **OCI에서** 실행한다.

```bash
cd ~/oci-image-api
sudo docker compose up -d --build --wait
```

자주 쓰는 명령은 다음과 같다.

```bash
# 서비스 상태
sudo docker compose ps

# 최근 로그
sudo docker compose logs --tail=100 api

# 실시간 로그: Ctrl+C는 로그 보기만 종료
sudo docker compose logs -f api

# 잠시 중지 / 다시 시작
sudo docker compose stop
sudo docker compose start
```

현재 Cloudflare의 `main` 자동 배포는 Cloudflare 쪽에만 적용된다. OCI는 이 예제에서 수동 업데이트하며, `main` 푸시 후 OCI까지 자동으로 갱신하려면 별도의 배포 작업을 구성해야 한다.

## 7. 실제 이미지 기능을 연결할 때

다음 구현은 아직 이 예제에 포함되어 있지 않다.

1. FastAPI에서 인증된 이미지 처리 요청을 접수하고 작업 번호를 반환한다.
2. 별도 Python 처리 프로그램에서 배경 제거와 좌우 이미지 생성을 수행한다. 작업 상태와 임시 파일은 컨테이너를 다시 만들 때 유지되는 저장소에 둔다.
3. SJN이 작업 번호로 상태를 확인하고 결과를 미리 보여 준다.
4. 사용자가 확인하면 세 이미지를 압축해 R2에 저장한다.

무거운 AI 작업은 처음에는 한 번에 하나씩 실행한다. 모델의 OCI ARM 호환성과 처리 시간은 실제 인스턴스에서 검증해야 한다. [FastAPI의 무거운 백그라운드 작업 안내](https://fastapi.tiangolo.com/tutorial/background-tasks/#caveat)

웹사이트에서 OCI API를 호출할 주소는, Cloudflare에서 관리하는 도메인이 있다면 Cloudflare Tunnel의 HTTPS 주소로 연결할 수 있다. API 요청 인증과 사용자별 제한은 별도로 구현한다. 서버용 API 키나 터널 토큰을 브라우저 코드에 넣지 않는다. [Cloudflare Tunnel 설정](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/)

터널 프로그램 `cloudflared`의 실행 위치에 따라 대상 주소가 달라진다.

- OCI 호스트에 직접 설치: `http://127.0.0.1:8000`
- 이 Compose 안의 별도 서비스로 실행: `http://api:8000`

같은 Compose의 서비스끼리는 서비스 이름으로 연결한다. 별도 컨테이너의 `localhost`는 API 컨테이너를 가리키지 않는다. [Compose 네트워크](https://docs.docker.com/compose/how-tos/networking/)
