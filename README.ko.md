님들의 Agent에게 그냥 이 Git 저장소 URL을 주고 환경설정을 시키세요.

# OpenDelegate

**OpenDelegate는 Hermes Device Agent Federation을 위한 가벼운 실전 Setup Kit입니다.**

Owner가 컴퓨터마다 설정 명령을 외우는 대신, Agent에게 이 저장소를 줘서 전체 환경을 발견·설치·연결·
검증하게 만드는 것이 목적입니다. 우리가 먼저 밟은 지뢰와 복구법을 정리해 다음 사람이 같은 문제를
반복하지 않게 합니다.

언어: [English](README.md) · **한국어**

## 목표 상태

설정이 끝나면 다음이 가능해야 합니다.

- 안정적인 컴퓨터 한 대가 상시 Coordinator와 Messaging 진입점 역할을 합니다.
- Mac Studio, Windows, Linux/NAS, MacBook 등은 각자의 로컬 Capability를 유지합니다.
- Device는 SSH, Hermes peer/API 또는 Owner가 승인한 다른 private route로 연결됩니다.
- Discord·휴대폰·연결된 컴퓨터 어디에서 명령해도 가장 적합한 Device에서 작업을 끝냅니다.
- 결과는 원래 대화로 돌아옵니다.
- Credential, Session, DB와 각 `HERMES_HOME`은 Device-local로 유지됩니다.

이 저장소는 Windows PATH, 잘못된 Service Lifecycle, Discord Intent와 mention policy, Peer quoting,
timeout 충돌, Gateway restart 중 완료 수집 유실, 잠드는 Portable Device, 단순 Reachability와 인증된
Authority의 차이처럼 우리가 먼저 겪은 문제를 정리합니다.

## 가장 짧은 시작 방법

1. 상시 Coordinator로 사용할 컴퓨터에서 Agent를 엽니다.
2. 이 저장소 URL을 줍니다.
3. 다음처럼 요청합니다.

> 이 저장소를 Hermes Federation Setup Kit로 읽어. 이 컴퓨터와 내가 승인한 다른 컴퓨터를 발견하고,
> 각 Device에 공식 Hermes Agent를 설치하거나 복구해. Credential과 `HERMES_HOME`은 각 Device에만
> 두고, SSH나 Hermes peer/API 등 적절한 private route를 선택해. Device 역할과 Gateway Service를
> 설정한 다음 실제 위임 요청이 적합한 컴퓨터에서 끝나고 원래 대화로 돌아오는지 검증해. 이 저장소의
> 보안·timeout·restart·recovery 지침을 따라. Push, 배포, 파괴적 삭제, 권한 확대, Secret 공개,
> Network·Firewall 변경은 먼저 확인해.

4. Coordinator가 요청하면 추가 컴퓨터에서도 같은 방식으로 로컬 Device Agent를 설치·등록합니다.
5. Health, Identity, 위임, 결과 회수, Service 재시작, Rollback까지 증명하기 전에는 완료라고 하지 않습니다.

상세 순서는 [Quick Start](docs/QUICKSTART.md)를 참고하세요.

## Setup Agent가 수행할 일

```text
발견 → 설치 → 연결 → 검증 → 운영
```

### 발견

- OS, 기존 Hermes 설치, Profile, Service, 안정적인 Route와 Device 역할을 확인합니다.
- OS 이름만 보고 Capability를 추정하지 않고 실제 Probe로 검증합니다.
- 안정적인 Coordinator를 선택하고 잠드는 MacBook은 best-effort Worker로 취급합니다.

### 설치

- 최신 공식 Hermes 문서를 기준으로 설치·복구합니다.
- `hermes doctor`를 통과합니다.
- Linux `systemd`, macOS `launchd`, Windows 공식 Gateway 시작 경로를 사용합니다.
- Profile과 Credential은 해당 Device에만 둡니다.

### 연결

- SSH, Hermes peer/API 또는 Owner가 승인한 다른 private route를 선택합니다.
- Reachability를 Identity나 Authority로 간주하지 않습니다.
- 실제 IP, Token, Peer Key, Private Path는 저장소에 기록하지 않습니다.

### 검증

- Agent turn 전에 deterministic health check를 수행합니다.
- 지정한 Device에 bounded request를 보내고 완전한 결과를 받습니다.
- 결과가 원래 대화로 돌아오는지 확인합니다.
- 진행 중 Peer 작업을 끊지 않고 Gateway restart를 검증합니다.
- Rollback 근거를 남깁니다.

### 운영

- 다른 Device가 실제로 유용할 때만 위임합니다.
- 요청을 받은 Origin Agent가 Owner에게 최종 결과를 책임집니다.
- Timeout을 Remote Worker 실패로 단정하지 않습니다.
- 미지의 장기 작업은 Durable Orchestration 경로로 처리합니다.

## 저장소 구성

```text
.agents/skills/opendelegate-setup/  Agent용 Setup Workflow
docs/QUICKSTART.md                 Owner·Agent 체크리스트
docs/HERMES_SETUP_AGENT.md        상세 Setup Agent 절차
docs/HERMES_FEDERATION_OPERATIONS.md
                                   Peer timeout·restart·recovery
docs/SECURITY_BOUNDARIES.md        Secret·Authority·State 경계
templates/                         Device·Agent·Peer·Fleet 템플릿
examples/four-device-fleet.md      일반화된 4-Device 예시
```

## 중요한 경계

현재 실전 경로는 **공식 Hermes Agent**를 사용합니다. 이 Kit는 raw `hermes peer dm`이 exactly-once
Dispatch, Durable Request Store, 무제한 장기 작업 자동 복구를 이미 제공한다고 주장하지 않습니다. 그런
보장이 필요하면 Durable Orchestration Service를 사용해야 합니다. 과거 OpenDelegate 앱 구현은 Git
History에 남아 있지만 현재 Setup Kit Tree에는 포함되지 않습니다.

## 보안

- Device 사이에 `HERMES_HOME` 전체를 동기화하지 않습니다.
- `.env`, Auth, Session, DB, Peer Key, Credential을 Git에 넣지 않습니다.
- Push, 배포, 외부 메시지, 결제, 파괴적 삭제, 권한 확대, Private Data 공개는 확인합니다.
- SSH Host Key 검증을 끄거나 예상하지 못한 Key 변경을 승인하지 않습니다.
- Unsandboxed Hermes API를 신뢰하지 않는 Network에 노출하지 않습니다.

연결 전 [보안 경계](docs/SECURITY_BOUNDARIES.md)를 읽으세요.

## 라이선스

Apache License 2.0. [LICENSE](LICENSE)를 참고하세요.
