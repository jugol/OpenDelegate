# OpenDelegate

언어: [English](README.md) · **[한국어](README.ko.md)** · [日本語](README.ja.md) ·
[Français](README.fr.md) · [Español](README.es.md) · [简体中文](README.zh-CN.md) ·
[繁體中文](README.zh-TW.md)

OpenDelegate는 여러 컴퓨터의 Hermes Agent를 설치하고 운영하기 위한 저장소입니다. 별도의 웹 Control
Plane이 아닙니다. 한 대의 Origin 컴퓨터에서 저장소를 clone한 뒤 로컬 setup Agent에게 주면, 그
Agent가 SSH로 다른 Device에 연결해 설정을 진행합니다.

```text
Owner
  │
  ▼
Origin Hermes Agent
  ├── SSH ──> 각 Device의 Hermes 설치·업데이트·복구
  ├── peer dm ──> 설정 후 일반 Agent 작업 전달
  └── shared library ──> 필요한 문서와 Artifact 교환
```

현재 운영 방식은 단순합니다.

- SSH는 최초 설정과 복구 Channel입니다.
- 설정이 끝난 뒤 일반 Agent 작업은 Hermes Peer API로 전달합니다.
- Tailscale, LAN, 기존 VPN은 Device 간 Reachability를 제공합니다.
- Hermes State, Credential, Session, Memory는 각 Device에 따로 보관합니다.
- OpenDelegate Admin Web을 따로 설치하거나 관리하지 않습니다.
- Enrollment Grant 절차를 사용하지 않습니다.

## 빠른 시작

### 1. Origin 컴퓨터 선택

Origin은 Owner가 Hermes와 대화하고 작업을 요청하는 컴퓨터입니다. Peer 목록을 보관하고 어떤 Device
Agent에게 일을 보낼지 결정합니다. 다른 Device의 중앙 DB 역할을 하지는 않습니다.

### 2. Hermes 설치 및 OpenDelegate clone

공식 [Hermes 설치 안내](https://hermes-agent.nousresearch.com/docs/getting-started/installation)에
따라 Hermes를 설치한 뒤 실행합니다.

```sh
hermes doctor
git clone https://github.com/jugol/OpenDelegate.git
cd OpenDelegate
hermes skills trust
hermes
```

이미 저장소가 있다면 다음으로 갱신합니다.

```sh
git pull --ff-only
```

Project Skill은 `.agents/skills/`에 있으며, 저장소를 신뢰하고 새 Hermes 세션을 시작한 뒤 로드됩니다.

현재 SSH-first 절차에는 pnpm, Node.js, `apps/`, `packages/`가 필요하지 않습니다. 해당 디렉터리는
보존 중인 Legacy Prototype입니다.

### 3. SSH 연결 준비

각 Target Device는 Origin에서 SSH Host, IP 또는 `~/.ssh/config` Alias로 접근할 수 있어야 합니다.
같은 LAN이 아니라면 Tailscale 같은 Private Network를 사용합니다.

설정 전에 다음을 확인합니다.

- Target Device에서 SSH가 활성화돼 있습니다.
- Origin에 Owner가 승인한 SSH Key 또는 Login 방식이 있습니다.
- 최초 연결 시 예상 SSH Host Key를 확인합니다.
- Hermes가 없다면 Target Device가 공식 Installer에 접근할 수 있습니다.

OpenDelegate는 예상하지 못한 SSH Host Key 변경을 절대 허용하지 않습니다.

### 4. Hermes에게 설정 요청

예시:

> 이 OpenDelegate 저장소를 사용해 내 Hermes Device Agent들을 설정해 줘. 이 컴퓨터를 Origin으로
> 사용하고 기존 SSH 설정의 `nas`, `mac-studio`, `windows`에 연결해. 각 OS를 감지하고 Hermes를
> 설치하거나 업데이트한 뒤, Device 역할이 들어간 로컬 DEVICE.md를 만들고 Peer API와 Gateway
> Service를 설정해. Origin Peer 목록에 등록하고 실제 요청과 응답까지 검증해. Credential, Session,
> Memory, DB, Private Key, Hermes Home은 각 Device 로컬에 유지하고, 바뀐 SSH Host Key는 절대
> 허용하지 마. SSH 인증처럼 Owner만 할 수 있는 작업이 꼭 필요할 때만 질문해.

Setup Agent는 `.agents/skills/opendelegate-init/SKILL.md`를 따라 실제 Shell 작업을 수행합니다. Owner가
컴퓨터마다 명령을 복사해 붙일 필요는 없습니다.

## Setup Agent가 하는 일

각 Device마다 다음을 수행합니다.

1. 설정된 SSH Target을 읽기 전용으로 확인합니다.
2. OS, Architecture, Hermes 설치 상태, Service 상태를 감지합니다.
3. 공식 Platform Installer로 Hermes를 설치하거나 업데이트합니다.
4. Device-local Model/Provider 설정이 없다면 Owner가 제어하는 TTY에서 완료하고 Local Agent 응답을
   검증합니다.
5. `HERMES_HOME`과 Runtime Data를 OpenDelegate Checkout 밖에 보관합니다.
6. Device ID, 역할, Route, Local Boundary가 담긴 Device-local `DEVICE.md`를 만듭니다.
7. API Key를 Chat이나 Source File에 넣지 않고 Hermes API Server와 Gateway를 설정합니다.
8. 해당 OS의 Hermes Native Lifecycle로 Gateway를 시작합니다.
9. Origin에서 `hermes peer add`로 Secret이 아닌 Device Route를 등록한 뒤, Owner가 Masked Local
   Input으로 Peer Key를 입력하게 합니다. Literal Key를 Agent Chat이나 Tool Argument에 넣지 않습니다.
10. Tailscale/Network 접속 상태와 Hermes `/health` 준비 상태를 따로 확인합니다.
11. 실제 `hermes peer dm` 요청을 보내고 응답을 검증합니다.

`/health` 실패는 Origin에서 Hermes Peer API를 사용할 수 없다는 뜻일 뿐, 컴퓨터 전원이 꺼졌다는
증거가 아닙니다.

## 새 Device 추가

Origin Agent에게 SSH Target과 원하는 역할만 말합니다.

> `render-box`를 Windows GPU Device로 추가해 줘. 내 SSH Config에 있는 Alias를 사용하고 Hermes를
> 설치하거나 업데이트해. Device 역할과 Peer API를 설정하고 Origin에 등록한 뒤 요청과 응답을
> 검증해.

Agent는 `.agents/skills/opendelegate-join/SKILL.md`를 따릅니다. Admin Web이나 Enrollment Grant는
사용하지 않습니다.

## 평소 사용

접속 방법이 아니라 원하는 결과를 Origin Agent에게 말합니다.

- "Windows에서 이 이미지를 렌더링해 줘."
- "Mac Studio에서 macOS 앱을 빌드해 줘."
- "NAS에서 이 Dataset을 받고 백그라운드로 계속 처리해 줘."
- "모든 Device 상태를 모아 줘."

Origin은 Device 역할과 Peer API 준비 상태를 확인하고 제한된 Peer Request를 작성해 `hermes peer dm`으로
전달합니다. 공개된 명령은 동기 방식이며 현재 `--timeout` Option이 없습니다. 오래 걸리는 작업은 지원되는
경우 Hermes Bot Message를 사용하거나, Target이 Background 작업을 시작하고 Handle을 반환하게 한 뒤 다음
Peer Message에서 상태를 확인합니다. SSH는 설치, 업데이트, Service 복구, 운영자 진단에 계속 사용합니다.

## Device 역할

역할은 예시이며 제품에 하드코딩된 제한이 아닙니다.

| 역할 | 대표 작업 |
| --- | --- |
| Origin | Owner 대화, Routing, 결과 취합 |
| NAS | Storage, Download, Docker, 장시간 Service |
| macOS | Xcode, Apple Signing, Metal, macOS Application |
| Windows | CUDA/RTX, ComfyUI, Windows Application |
| Laptop | 이동 중 대화와 짧은 Local 작업 |

Owner는 Device 이름과 역할을 다르게 정할 수 있습니다. 명시적인 Device 이름은 Semantic Routing보다
항상 우선합니다.

## State 및 Security Boundary

- `HERMES_HOME`을 동기화하거나 Commit하지 않습니다.
- `config.yaml`, `.env`, Auth File, State DB, Session, Peer Key, Lock, Provider Home을 Device 간에
  복사하지 않습니다.
- API Key와 SSH Credential은 Device 로컬에 두고 Agent Prompt에 넣지 않습니다. 현재
  `hermes peer add`에는 Masked Key Prompt가 없으므로 Peer Key 입력은 Owner-only Local TTY에서만
  수행하고, Agent는 Target `.env`를 읽거나 Key를 SSH·Chat으로 운반하지 않습니다.
- 모든 Device 사이에 Pairwise Trust를 만들지 않습니다. 설정용 SSH는 Origin에서 Target으로만
  사용하고, 일반 Agent 작업은 등록된 Peer Route로 보냅니다.
- Shared Storage에는 사람이 읽을 수 있는 Knowledge, Project File, Artifact만 둡니다.
- Tailscale에서 Online인 Device도 Hermes Gateway가 중지됐을 수 있습니다. 두 상태를 구분해 보고합니다.

## 저장소 구조

- `.agents/skills/opendelegate-init/` — Origin 설정 및 SSH 기반 Multi-Device Bootstrap.
- `.agents/skills/opendelegate-join/` — SSH로 Device 하나를 추가하거나 복구.
- `docs/GETTING_STARTED.md` — 전체 SSH-first 절차.
- `docs/HERMES_SETUP_AGENT.md` — Hermes 전용 설정 참고.
- `templates/DEVICE.md` — 일반화된 Device Metadata Template.
- `apps/`, `packages/`, 기존 Control Plane 문서 — 현재 운영 방식이 아닌 Legacy Prototype Source.

## Legacy Prototype 안내

저장소에는 과거의 Main/Worker Control Plane Prototype이 남아 있습니다. Admin Web, Discord Forum
Orchestration, Enrollment Grant, Release Tooling 코드가 여기에 포함됩니다. 재사용 가능성을 위해 보존하지만
현재 OpenDelegate 설정·관리 방식은 아니며, Owner에게 별도 웹사이트를 운영하라고 안내하면 안 됩니다.

현재 OpenDelegate의 목적은 기존 로컬 Agent가 SSH와 Hermes Peer 연결을 사용해 실용적인 Multi-Device
Hermes Fleet를 설정하고 관리하도록 돕는 것입니다.
