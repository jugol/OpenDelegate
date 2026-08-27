# OpenDelegate

언어: [English](README.md) · **[한국어](README.ko.md)** · [日本語](README.ja.md) ·
[Français](README.fr.md) · [Español](README.es.md) · [简体中文](README.zh-CN.md)

**내가 가진 여러 컴퓨터의 AI Agent를 하나의 개인 Control Plane으로 연결하고 관리합니다.** 이
저장소를 clone 또는 pull한 뒤 setup Agent에게 주면, 사용자가 직접 토폴로지를 설계하지 않아도 하나의
상시 가동 Main과 macOS·Windows·Linux/NAS Worker Device를 설정하도록 안내합니다.

![상시 가동 Main이 Windows·macOS·Linux Device의 Agent를 조율하는 OpenDelegate](docs/design/opendelegate-orchestration-hero.png)

> [!TIP]
> **여기서 시작하세요:** [무엇을 하는가](#opendelegate가-하는-일) ·
> [5분 설정](#5분-설정권장) · [Device 추가](#모든-device-추가) ·
> [사용 방법](#opendelegate-사용) · [전체 가이드(영문)](docs/GETTING_STARTED.md) ·
> [Hermes 가이드(영문)](docs/HERMES_SETUP_AGENT.md)

> [!WARNING]
> 이 저장소는 현재 **공개 소스 pre-alpha**이며 지원되지 않는 내부 프리뷰만 빌드할 수 있습니다.
> 지원되는 OpenDelegate 릴리스는 아직 없습니다. 검토와 통제된 검증에만 사용하고, 무인 프로덕션
> Control Plane으로 준비됐다고 표현하지 마십시오.

## OpenDelegate가 하는 일

OpenDelegate는 여러 Device에서 실행되는 Agent를 위한 개인용 self-hosted 조정 시스템입니다.

- 하나의 고정된 상시 가동 **Main**이 Task, 스케줄링, Policy, Approval, Audit, Admin Web을 소유합니다.
- Main을 포함한 각 컴퓨터는 **Worker Device**로 연결되어 검증된 Capability를 보고합니다.
- Worker는 Main으로만 outbound 연결하며, NxN SSH Mesh나 Worker용 DB 자격 증명이 필요 없습니다.
- 결정론적 코드가 정상 Device와 Route를 선택하고 Agent는 의미론적 계획과 실제 작업을 담당합니다.
- 각 Device의 Credential, Provider Session, Workspace, Markdown Knowledge는 해당 Device에만 남습니다.
- Admin Web은 설정·운영 화면입니다. Discord Forum은 나중에 주 대화형 Task Inbox로 연결할 수 있지만
  최초 설정에 필수는 아닙니다.

사용자는 원하는 결과만 말합니다. Main은 필요하면 Windows 개발, macOS 빌드·서명, Linux/NAS 작업으로
나누고 각 결과를 모으므로 사용자가 직접 Device 간 인계를 관리하지 않아도 됩니다.

## 5분 설정(권장)

OpenDelegate 명령부터 배울 필요는 없습니다. **Hermes, Codex, Claude** 같은 유능한 로컬 setup Agent를
사용하십시오.

### 1. Main 선택

계속 켜둘 수 있고 장애 시 직접 접근할 수 있는 컴퓨터 하나를 고릅니다. 첫 Milestone에서 Main은
고정입니다. NAS, Server, Desktop 또는 다른 안정적인 Device를 사용할 수 있습니다.

### 2. Main에서 setup Agent 준비

Main으로 사용할 컴퓨터에서 Hermes, Codex 또는 Claude를 엽니다. Hermes는
[공식 Hermes 설정 경로](docs/HERMES_SETUP_AGENT.md)로 설치한 뒤 `hermes doctor`로 확인합니다.
여기서 Hermes는 setup Agent이며 OpenDelegate의 runtime Agent Adapter가 되는 것은 아닙니다.

### 3. OpenDelegate clone 또는 업데이트

```sh
git clone https://github.com/jugol/OpenDelegate.git
cd OpenDelegate
```

이미 checkout이 있다면 다음을 실행합니다.

```sh
git pull --ff-only
```

Hermes로 source를 설정할 때는 저장소 Skill을 한 번 신뢰하고 새 세션을 시작합니다.

```sh
hermes skills trust
hermes
```

source Main 설정은 `.agents/skills/opendelegate-init/SKILL.md`, Worker 연결은
`.agents/skills/opendelegate-join/SKILL.md`를 사용합니다. 검증된 Release Bundle은 포함된 `AGENTS.md`를
통해 `skills/opendelegate-init/SKILL.md`와 `skills/opendelegate-join/SKILL.md`를 사용하며 project-skill
trust를 사용하지 않습니다. `HERMES_HOME`, OpenDelegate Runtime State, Credential, Provider Home,
Session, DB, Log, Private Key, Knowledge, Artifact, Device Grant는 checkout이나 bundle 밖에 보관합니다.

### 4. setup Agent에게 Main 설정 요청

다음 문장을 그대로 보냅니다.

> 이 컴퓨터를 고정된 상시 가동 OpenDelegate Main Device로 설정해 줘. source checkout인지 검증된
> release bundle인지 확인하고, AGENTS.md와 정식 제품 문서, Main 초기화 Skill을 따라 줘. 모든 Runtime
> State와 Credential은 프로젝트 밖에 보관해. Token, Credential, Private Key, Provider Home, Session,
> DB, Grant 내용을 채팅에 붙여 넣으라고 하지 마. 안전하고 되돌릴 수 있는 일은 직접 처리하고, 중요한
> Owner 결정이나 Owner 전용 보안 작업이 필요할 때만 질문해. 정확한 Support Status를 보고하고 Admin
> Web을 사용할 준비가 될 때까지 계속 진행해.

Agent는 Host를 검사하고, source와 bundle을 구분하고, `supportStatus`를 확인하고, 필요한 경우
Integrity가 확인된 Preview나 Launcher를 준비하고, Main을 초기화하고, Local Owner Claim을 열어 줍니다.
외부 전제조건이 없으면 정확한 복구 절차를 남깁니다.

### 5. Admin Web에서 Main 마무리

1. 로컬에서 Owner 계정을 Claim하고 일회용 복구 코드 10개를 모두 안전하게 보관합니다.
2. **장치 평가**를 실행해 Main의 제한된 비밀 제외 Capability Evidence를 저장합니다.
3. Main과 co-located Worker Profile, DB, Route, Artifact Policy, 시작 방식을 검토합니다.
4. Forum 게시글을 대화형 Task로 사용하고 싶을 때 Discord를 나중에 추가합니다.

SQLite는 별도 설정이 필요 없는 기본값입니다. Provider Credential과 Discord Token은 채팅에 넣지 말고
Provider의 기본 인증 또는 OpenDelegate의 보안 입력 Panel을 사용합니다.

## 모든 Device 추가

각 macOS, Windows, Linux, NAS 컴퓨터에서 다음 절차를 반복합니다.

1. Main Admin Web에서 **Device 추가**를 선택하고 용도를 정한 뒤 수명이 짧은 일회용 Enrollment Grant를
   만듭니다.
2. Grant File을 **열지 않은 채** Owner가 통제하는 안전한 방식으로 옮깁니다. 내용을 채팅에 붙이거나
   첨부하지 않습니다.
3. 새 Device에서 같은 저장소를 clone/pull하거나 해당 플랫폼용 검증된 bundle을 엽니다. Hermes로
   source를 사용한다면 `hermes skills trust`를 실행하고 새 세션을 시작합니다.
4. 로컬 Agent에게 다음 문장을 보냅니다.

   > 이 컴퓨터를 열어보지 않은 일회용 Grant File `<absolute-path-to-grant-file>`을 사용해 내 고정
   > OpenDelegate Main의 outbound-only Worker로 연결해 줘. AGENTS.md와 Worker Join Skill을 따라 줘.
   > OpenDelegate Tool에는 Grant 경로만 전달하고 내용을 출력·붙여넣기·Log·요약·복사하지 마. 이
   > Device의 Capability를 감지하고 Credential과 Knowledge는 로컬에 유지해. 보호된 Network 또는 권한
   > 변경 전에는 질문하고, Main에서 연결된 Device로 보이는지 확인해.

5. Admin Web에서 Device를 평가하고 Workspace를 등록한 뒤 Role, Instruction, Route, Agent Profile,
   Service 상태, Computer Use 준비 상태를 검토합니다.

Worker는 Main에만 연결됩니다. 일반 Task에서 실제 Device, Route, Agent Binding은 사용자가 아니라
OpenDelegate가 선택합니다.

## OpenDelegate 사용

- **Admin Web:** Instance 설정, Device·Task 검사, 보호 작업 승인, Audit·Artifact 확인, 장애 복구,
  Discord 비활성 상태에서 Task 생성.
- **Discord Forum(최초 설정 시 선택):** Bot과 Forum을 연결하면 게시글 하나가 지속성 있는 Task 하나가
  되고, 답글은 같은 Native Agent Session을 이어가며 새 게시글은 깨끗한 Context에서 시작합니다.
- **Configuration Chat:** OpenDelegate 설정과 Device Profile을 변경합니다. 프로젝트 작업에는 사용하지
  않습니다.
- **Artifact:** File, Report, Image, Patch, 격리된 Hosted Result를 Main을 통해 받습니다.
- **Owner Handoff:** Login, MFA, CAPTCHA, 법적 확인, OS Permission 작업을 Credential 노출 없이
  완료합니다.

## 역할 분담

- **Main 결정론적 Service:** Identity, Durable State, Eligibility, Route, Lease, Retry, Budget, Policy,
  Approval, Audit, Discord Projection, Artifact Delivery.
- **Main Agent:** Owner Intent 이해, Task 분해, Worker 결과 종합.
- **Worker Service:** Device Identity, Local Capability, Workspace, Resource Lock, Provider Session,
  Local Knowledge, 실행, 결과 Upload.
- **Worker Agent:** 해당 Device의 정확한 Policy와 Binding 안에서 할당된 Work Order만 수행.

Codex와 Claude가 현재 first-class runtime Agent Adapter입니다. Generic Runner는 확장 지점으로 남아
있습니다. Hermes는 현재 setup Agent로만 문서화되어 있으며 first-class runtime Adapter가 아닙니다.

## 아키텍처

```mermaid
flowchart LR
    owner["Owner<br/>휴대폰 또는 컴퓨터"] --> admin["Admin Web<br/>설정 및 운영"]
    owner --> discord["Discord Forum<br/>선택적 Task Inbox"]
    admin --> main["고정 상시 가동 Main<br/>Control Plane + Main Agent"]
    discord --> main
    main --> database[("Main 전용 SQLite 또는 PostgreSQL")]
    main --> artifacts["Artifact Gateway"]
    main <-->|"인증된 Outbound Device Channel"| mac["macOS Worker"]
    main <-->|"인증된 Outbound Device Channel"| windows["Windows Worker"]
    main <-->|"인증된 Outbound Device Channel"| linux["Linux / NAS Worker"]
    mac -. "Device 로컬" .-> macState["Credential, Session, Workspace, Knowledge"]
    windows -. "Device 로컬" .-> winState["Credential, Session, Workspace, Knowledge"]
    linux -. "Device 로컬" .-> linuxState["Credential, Session, Workspace, Knowledge"]
```

LAN, Omada, Tailscale, Tunnel, Custom Network는 각 Worker와 Main 사이의 Transport Profile
선택지입니다. Network Reachability는 Application Identity나 Permission을 대신하지 않습니다.

## 현재 소스 상태

다음 표는 프로덕션 형태로 구현된 소스 경로와 지원을 표방하기 전에 여전히 필요한 외부 증거를
구분합니다.

| 영역             | 소스에 구현되어 테스트할 수 있는 범위                                                                                                                                                                                                                                                      | 첫 Milestone에 여전히 필요한 범위                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Main 및 영속성   | 번들 `opendelegate` CLI, 구성된 Control Plane, SQLite/PostgreSQL Storage 계약(호스팅 PostgreSQL 증명은 현재 17로 고정), 지속성 있는 Task 실행·Approval·Audit·Artifact·Enrollment·Discord·Device Channel 서비스, 중단된 Action의 결과가 불명확하면 안전하게 실패하는 시작 시 Reconciliation | 지원을 선언할 각 Main 플랫폼에서의 깨끗한 Host 설치, Database Migration/Restore, Service Restart 및 완전한 Reconciliation 증거. 다른 PostgreSQL 메이저 버전은 아직 검증되지 않음 |
| Owner 접근       | Loopback 전용 최초 Claim, Passphrase 로그인, 복구 코드, 세션 폐기, CSRF 방어 및 SQL 영속성                                                                                                                                                                                                 | 릴리스에 유효한 Remote Route, 재시작, 탈취된 Browser Session 폐기 및 Discord와 독립적인 복구 증거                                                                                |
| Admin Web        | 인증된 Device·Task·Approval·Enrollment·Artifact·Audit·Emergency Control·Configuration Chat 화면, Capability-aware Control, 선택 상태가 유지되는 반응형 영어·한국어·일본어·프랑스어·스페인어·중국어(간체) UI                                                                                | 실제 Device Onboarding 및 장애 상황 Journey, Release Bundle의 Accessibility/Overflow 증거, 실제 운영자 인수 테스트                                                               |
| Device Runtime   | 일회용 Enrollment, Device-scoped Identity, 인증된 Outbound Main–Worker Channel, Lease 기반 Dispatch, 지속성 있는 Inbox/Outbox, Run Supervision, Workspace, 로컬 Agent 실행, 로컬 Knowledge MCP, Computer Use MCP 및 Artifact Upload                                                        | Enrollment가 완료된 실제 Device, Route Loss/Restart Recovery, Omada/Tailscale 형태의 혼합 Route 증거 및 세 OS 계열의 Persistent Service 증거                                     |
| Agent 및 Discord | Codex App Server와 Claude Agent SDK를 우선 사용하는 Adapter, 기능이 제한된 CLI Fallback, Generic Command, Native Session 연속성, Single-writer Enforcement 및 정확한 Action Authorization, Discord HTTP/Gateway·Forum Reconciliation·Control·Main 구성                                     | 고정된 버전의 인증된 실제 Codex/Claude 실행, 전용 Community Server·Forum·Bot·Token·Intent·Permission·Reconnect·Mobile·Outage 증거                                                |
| Knowledge        | Device-local Linked Markdown Discovery, 제한된 Retrieval, 결정론적 Indexing, Admission Check 및 내용을 Main 계약 밖에 유지하는 Agent용 MCP Tool                                                                                                                                            | 각 실제 Device 계열에서 Packet 수준 No-egress 증거와 Create/Update/Rebuild Journey                                                                                               |
| Artifact         | Main 소유 Local Store, 인증된 재개 가능 Worker Upload, 격리된 Static/Interactive Gateway 경로, Signed Access, Exposure Policy 계약 및 Admin 점검                                                                                                                                           | 실제 Discord 표시, Retention/Exposure Journey, 패키징된 Build의 Hostile-content 검증 및 Owner Device에서의 Cross-network 열기                                                    |
| 플랫폼 서비스    | Windows SCM, macOS launchd, Linux systemd/Foreground 소스 구현, 분리된 Core/Owner-session Helper Host, 인증된 Local IPC, Install/Start/Stop/Restart/Upgrade/Rollback/Diagnose/Uninstall 명령 경로                                                                                          | 권한이 필요한 깨끗한 Host 실행, Reboot/Login/Logout Persistence, 실패 Rollback, Permission Onboarding, 필요한 플랫폼의 Signing/Notarization 및 Lab 증거                          |
| Computer Use     | Device-wide Desktop Lock, 정확한 Action Authorization, 일회용 Local Capability Broker, Session-helper IPC, Native Windows/macOS/Linux Backend 소스, Readiness/Permission Probe, Capture/Input/Cancel/Emergency-stop 계약 및 결정론적·Native Fixture 테스트                                 | 실제 macOS·Windows·선언된 그래픽 Linux 환경의 Reference Interaction과 Screenshot·Exclusivity·Cancellation·Permission Failure·Locked-session·Headless Linux 증거                  |

필요한 Sandbox를 강제할 수 있을 때까지 Native Windows의 Claude SDK 실행은 의도적으로 지원 대상으로
표방하지 않습니다. Windows에서는 Codex, WSL2 또는 설정된 Container를 사용하십시오. WSL2나 Container
Worker는 Native Windows Service, Restart, Permission 또는 Computer Use 릴리스 기준을 대체하지
않습니다.

프로젝트 의존성 자동 설치는 현재 자격 증명이 없는 공식 Registry Staging 경계에서 Script를 끈 npm만
지원합니다. OpenDelegate는 명시적으로 설정된 System Package Manager의 설치 전용 요청도 수락하며,
해당 Manager 실행 파일을 고정한 뒤 실행 직전에 다시 검증합니다. 저장소 추가와 원격 설치 프로그램은
계속 승인 대상입니다. 이는 구현 증거일 뿐이며, 기존 Source와 권한 동작이 대상 Clean-host Lab을
통과하기 전에는 어떤 System Package Manager도 Release 지원 대상으로 표방하지 않습니다.

기계가 읽을 수 있는 Release Ledger는
[`docs/release/acceptance-evidence.json`](docs/release/acceptance-evidence.json)에 있습니다.
`pnpm release:status`로 현재 상태를 확인할 수 있습니다. 36개 인수 기준 모두 증거가 필요하며 플랫폼
또는 Computer Use Gate는 하나도 면제할 수 없습니다.

릴리스 관련 용어는 의도적으로 좁은 의미를 가집니다.

| Label                       | 의미                                                                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Public source pre-alpha     | 검토 가능한 소스. 지원되지 않으며 완성된 설치본이 아님                                                                                        |
| `internal-preview-*` bundle | 로컬 검증 Payload. 로컬 Smoke Test를 통과해도 항상 지원되지 않음                                                                              |
| `release-candidate` bundle  | 36개 Gate를 모두 통과했지만 아직 승격되거나 지원되지 않은 Artifact                                                                            |
| `released`                  | 유효한 불변 Candidate와 신뢰된 게시자, Platform Authenticity, Promotion, Supported Channel, Revocation Policy 전체 Chain으로 계산된 실효 상태 |

현재 `released` Artifact는 없습니다.

## 구현된 Admin Web

아래 스크린샷은 현재 구현된 Admin Web을 보여줍니다. 결정론적 API Fixture를 사용하는 Browser
Suite에서 캡처했습니다. UI는 인증된 Admin API 계약을 호출하지만, 이 이미지는 실제 Discord Binding,
실제 Worker Enrollment 또는 3개 OS 인수 테스트의 증거가 아닙니다. 기본값은 영어입니다. 언어 선택기를
사용하면 Owner 대상 UI 전체를 한국어, 일본어, 프랑스어, 스페인어 또는 중국어(간체)로 전환할 수
있습니다. Owner가 작성한 Task 내용이나 Agent 대화 기록은 번역하지 않습니다.

![구현된 OpenDelegate Task 작업 화면](docs/design/admin-tasks-implemented.png)

_Task 작업 Design Fixture: 인증된 목록/상세 데이터 및 제어 기능. 각 제어 기능은 Main이 보고한
Capability 상태를 따릅니다. 이 Fixture는 실제 외부 Runtime이 준비되었다는 증거가 아닙니다._

![구현된 OpenDelegate Owner 로그인](docs/design/admin-login-implemented.png)

_구현된 Owner 로그인 및 복구 진입 화면. 최초 Owner Claim은 별도의 Loopback 전용 Bootstrap Flow로
유지됩니다._

## 내부 프리뷰 빌드

Release Bundle에는 정확히 **Node.js 24.18.0**이 필요합니다. 저장소에는 pnpm 11.15.1이 고정되어
있습니다. Node.js 22.14 이상인 Node 22 계열은 Contributor 호환성 대상으로 유지되지만 Release
Bundle을 만들 수는 없습니다.

의존성을 설치한 깨끗하고 Commit된 Checkout에서 실행합니다.

```sh
node --version
git status --short
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test:browser
pnpm release:build --destination ABSOLUTE_PATH --internal-preview
```

`node --version`은 `v24.18.0`을 출력해야 하며 `git status --short`는 아무것도 출력하지 않아야
합니다. `ABSOLUTE_PATH`는 소스 Checkout 외부에 있는, 아직 존재하지 않는 경로여야 합니다. Builder는
기존 Destination을 덮어쓰지 않습니다. 최소 Launcher는 깨끗한 Commit을 내보낸 뒤 Assembly 전에 일회용
Snapshot에서 Release Logic을 다시 실행합니다. Builder는 고정된 공식 Node Archive를 내려받고 감사된
SHA-256을 검증하여 플랫폼별 Bundle을 생성합니다. 여기에는 Main/Worker Launcher, Admin Asset,
Init/Join Skill, Release Metadata, Dependency-instance Legal Inventory, Checksum과 더불어
CLI/Service/Worker Command, 깨끗한 Home Initialization, Main Health, Admin Serving, Owner
Claim/Login, Session-cookie Round-trip 및 정상 종료에 대한 제한된 Smoke Evidence가 포함됩니다.

Destination 이름에는 `internal-preview`가 포함되어야 합니다. 생성된 `INTERNAL_PREVIEW.md`와
`release-metadata.json`에는 Bundle이 지원되지 않는다는 사실과 정확한 Release Evidence 상태가
기록됩니다. Discord와 기타 Owner 선택이 지속성 있는 Main 설정 생성 전에 모두 확정되도록, 조립된
Bundle은 위의 Agent-first [권장 설치](#권장-설치-agent에게-맡기세요)를 통해서만 초기화하십시오. 내부 프리뷰는
Foreground에서 실행되고 지속성 있는 OS 서비스를 설치하지 않으며 Release Tag로 게시해서는 안 됩니다.

인수 기준이 하나라도 미완료이면 프로덕션 빌드는 의도적으로 실패합니다.

```sh
pnpm release:gate
pnpm release:build \
  --destination ABSOLUTE_PATH \
  --git-executable ABSOLUTE_UNLINKED_GIT \
  --git-executable-sha256 APPROVED_GIT_EXECUTABLE_SHA256 \
  --runner-executable-sha256 APPROVED_NODE_EXECUTABLE_SHA256
```

위 `release:build` 호출은 Linux x64 Candidate에서만 표시된 그대로 사용할 수 있습니다. macOS와
Windows에서는 대상 플랫폼별 필수 Credential Policy를 다음과 같이 추가해야 합니다.

```sh
  --platform-signing-policy ABSOLUTE_PLATFORM_SIGNING_POLICY \
  --platform-signing-policy-sha256 APPROVED_PLATFORM_SIGNING_POLICY_SHA256
```

`pnpm release:sign`은 명시적으로 확인된 지원되지 않는 Preview에만 의도적으로 제한되며 Release
Candidate를 거부합니다. 36개 Criterion Gate가 완료되면 깨끗하고 Hash가 고정된 대상 네이티브 Runner가
`pnpm release:finalize`를 사용해 각 Production Candidate를 Freeze하고 Candidate-v2 게시자
Attestation을 생성합니다. 구성된 외부 Promotion과 Supported Channel Receipt Chain을 검증해야만 이
불변 Candidate의 실효 상태가 `released`가 될 수 있습니다. 자세한 내용은
[Release Trust 절차](docs/release/README.md#supported-promotion-trust-path)를 참고하십시오.

Credential이 없는 운영자 입력 골격은 다음 명령으로 생성할 수 있습니다.

```sh
pnpm release:examples -- --destination ABSOLUTE_NEW_DIRECTORY
```

모든 생성물에는 `PLACEHOLDER`와 `NOT-A-RELEASE`가 표시되며 Credential, 서명, Artifact, Release
증거를 포함하지 않습니다. 자세한 내용은 [Release 입력 예시 가이드](docs/release/EXAMPLES.md)를
참고하십시오.

프로덕션 `release:gate`와 Candidate 모드 `release:build` 명령은 36개 구현 Gate와 실제 증거 Gate를
모두 통과한 뒤에만 성공할 수 있습니다. 지원되지 않는 Preview에 대한 서명은 이 프로덕션 Gate를
충족하지도 우회하지도 않습니다. [정확한 첫 Milestone 지원 Matrix](docs/release/SUPPORT_MATRIX.md),
[릴리스 증거 가이드](docs/release/README.md)와
[플랫폼 Lab 체크리스트](docs/release/PLATFORM_LAB.md)를 참고하십시오.

## 개발

```sh
pnpm install --frozen-lockfile
pnpm setup:browser
pnpm check
pnpm build
pnpm test:browser
```

`pnpm setup:browser`는 Admin Web Browser Suite용 Chromium을 설치합니다. Linux에서는 Playwright가 OS
의존성 설치도 요청할 수 있습니다.

Admin 개발 서버는 다음 명령으로 실행합니다.

```sh
pnpm dev:admin
```

이 개발 서버는 Owner 설치 경로가 아닙니다. 번들 Main을 검증할 때는 생성된 Internal-preview
Launcher를 사용하십시오.

Codex와 Claude 인증은 기본적으로 각 OpenDelegate Device의 `state/providers/codex` 및
`state/providers/claude`에 격리됩니다. Owner는 Main init에서
`--codex-home ABSOLUTE_PATH` 또는 `--claude-home ABSOLUTE_PATH`를 지정해 기존 로컬 Provider
디렉터리를 명시적인 공유 SSOT로 사용할 수 있습니다. OpenDelegate는 로그인 정보를 복사하지 않고
그 경로를 저장하며, 실행과 장치 평가에 같은 home을 사용합니다. Provider 설정, 플러그인, 캐시 및
native session 저장소는 공유되지만 각 Task는 계속 별도의 native session을 사용합니다. 전역 home을
암묵적으로 상속하지는 않습니다.

## 저장소 구성

- `apps/main` — Main 구성, 결정론적 CLI, Action Authorization, Device Channel, Discord, Artifact 및
  Agent Runtime 연결.
- `apps/worker`, `apps/service-host` — Enrollment된 Worker Runtime과 Platform Service 정의가
  사용하는 지속성 있는 Core/Session Process Host.
- `apps/control-plane` — 인증된 HTTP 및 Local-claim 경계.
- `apps/admin-web` — Owner 로그인, Device, Task, Approval, Enrollment, Artifact, Audit, 긴급 작업 및
  Configuration Chat.
- `apps/artifact-gateway` — 격리된 Artifact 전달 경계.
- `packages/domain`, `packages/policy`, `packages/scheduler` — 결정론적 Domain Mechanic 및 실행
  가능한 Policy.
- `packages/storage-sql`, `packages/owner-auth`, `packages/task-service`, `packages/configuration` —
  Main 영속성 및 Application Service.
- `packages/device-identity`, `packages/device-channel`, `packages/worker-runtime`,
  `packages/transport`, `packages/device-discovery` — Device Enrollment, 인증된 Main–Worker 통신 및
  Worker 실행.
- `packages/agent-adapters`, `packages/discord-adapter` — 여전히 자격 증명을 사용하는 실제 증거가
  필요한 프로그래밍 방식 Provider 및 Discord Forum 통합.
- `packages/artifact-store` — Main이 소유하는 Artifact Byte 및 Metadata 경계.
- `packages/platform-services`, `packages/computer-use-os` — OS Service 및 Graphical Runtime 구현.
  소스와 Fixture 결과는 지원되는 설치 서비스나 3개 OS Desktop Control의 증거가 아닙니다.
- `packages/session-helper-ipc`, `packages/session-helper-runtime`, `packages/computer-use-mcp`,
  `packages/run-capability-broker` — Run별로 제한되고 인증된 Owner-session Capability.
- `packages/knowledge`, `packages/knowledge-mcp` — Device-local Markdown Discovery, 연결형
  Retrieval, Indexing 및 Agent Tool.
- `packages/acceptance`, `packages/simulator` — 결정론적 Task Journey, Restart Case 및 Replay
  Fixture.
- `.agents/skills/opendelegate-init` — 명시적인 Internal-preview Gate를 갖춘 Agent 대상 초기화 Workflow.
- `.agents/skills/opendelegate-join` — 자격 증명을 노출하지 않는 Outbound-only Worker Enrollment 및 복구
  Workflow.
- `docs` — Product, Architecture, Security, Design, Research 및 Release Evidence.

## 정식 제품 문서

제품 동작을 계획하거나 변경하기 전에 다음 순서로 읽으십시오.

1. [`CONTEXT.md`](CONTEXT.md) — 간결한 Domain Model, Vocabulary 및 변경할 수 없는 Invariant.
2. [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md) — 전체 Product 및 Architecture 명세.
3. [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) — Delivery Phase, 공개 Test Seam 및
   Release Gate.
4. [`docs/DECISIONS.md`](docs/DECISIONS.md) — 승인된 Product Decision 및 근거.
5. [`docs/research/platform-capabilities.md`](docs/research/platform-capabilities.md) — 1차 출처
   기반 Platform Constraint.

Contributor Workflow는 [CONTRIBUTING.md](CONTRIBUTING.md)에 문서화되어 있습니다. Security Boundary와
검증된 비공개 취약점 신고 경로는 [SECURITY.md](SECURITY.md)에 있습니다. 안전한 Main Metadata
Snapshot과 새 Target 복원 절차는 [Backup 및 Restore 가이드](docs/BACKUP_AND_RESTORE.md)를
참고하십시오.

OpenDelegate는 [Apache License 2.0](LICENSE)으로 배포됩니다. 저장소 콘텐츠, Domain Term, API, Log 및
UI 기본값에는 영어를 사용합니다. 이 README와 Owner 대상 Admin UI는 위에 링크한 다섯 가지 번역으로도
제공됩니다.
