# Admin Web device overview design specification

Status: **Implementation reference**

Verified desktop baseline:
[`admin-device-overview-baseline.png`](admin-device-overview-baseline.png)

Reference viewport: **1600 × 1000**

Verified responsive baselines:
[`admin-device-overview-mobile-baseline.png`](admin-device-overview-mobile-baseline.png)
at **390 × 844** and
[`admin-device-overview-minimum-width-baseline.png`](admin-device-overview-minimum-width-baseline.png)
at **320 × 720**.

## Surface

This is the required first-run Admin Web surface, not a marketing page. It shows
exactly one current Device, its operational profile, and an open Configuration Chat
that uses a separate Agent Session.

The primary composition has four layers:

1. a 264 px cool-gray Device/navigation rail;
2. a quiet top area with Device identity and one primary action;
3. an open, two-column operational detail canvas built from lists and dividers;
4. a 394 px floating Configuration Chat surface anchored to the bottom-right.

The canvas remains true white. Only the selected Device, proposal, and chat drawer
receive visible framing. The overview must not become a grid of dashboard cards.
The compact chat keeps its header and composer fixed while only its central
conversation and proposal surface scrolls.

## Design tokens

| Token | Value | Use |
| --- | --- | --- |
| `color.canvas` | `#ffffff` | Main content and chat surfaces |
| `color.rail` | `#f7f9fc` | Left navigation |
| `color.ink` | `#111827` | Primary text and icons |
| `color.muted` | `#526071` | Secondary text with AA contrast |
| `color.border` | `#d7dde7` | Rules, fields, inactive framing |
| `color.controlBorder` | `#707c8c` | Resting control boundaries |
| `color.accent` | `#0f5fe7` | Primary action, selected state, focus |
| `color.accentSoft` | `#f2f6ff` | Selected Device and proposal background |
| `color.success` | `#08752a` | Healthy, ready, verified |
| `color.neutralStatus` | `#5f6b7a` | Not configured |
| `shadow.drawer` | `0 18px 48px rgb(17 24 39 / 18%)` | Chat only |
| `radius.control` | `8px` | Buttons and fields |
| `radius.panel` | `12px` | Chat and selected proposal |
| `stroke.icon` | `1.5px` | All outline icons |

Use Inter when bundled; otherwise use the platform UI sans-serif stack. Headings use
600 weight, body uses 400, and selected/control text uses 500. Intended desktop
sizes are 40/48 for the Device title, 22/28 for section headings, 16/24 for body,
14/20 for secondary content, and 13/18 for compact status text.

Spacing follows a 4 px base with primary steps of 8, 12, 16, 24, 32, and 48 px.
Content columns align to shared horizontal rules. Buttons and navigation rows are
44–48 px tall.

## Allowed visible copy

No additional above-the-fold headings, metrics, badges, or explanatory product copy
may be invented.

- `OpenDelegate`
- `Devices`
- `Mac Studio`
- `Main · Online`
- `Tasks`
- `Approvals`
- `Artifacts`
- `Audit`
- `Join a device`
- `Main computer · macOS · Online`
- `Configure`
- `Overview`
- `Capabilities`
- `Roles & Instructions`
- `Routes`
- `Runs`
- `Device facts`
- `Operating system`
- `macOS`
- `Architecture`
- `Apple silicon`
- `Runtime status`
- `Worker service`
- `Healthy`
- `User session`
- `Ready`
- `Roles`
- `Main Coordinator`
- `Development`
- `Capabilities`
- `Codex`
- `Verified`
- `Claude`
- `Detected`
- `Computer Use`
- `Detected`
- `Browser automation`
- `Transport routes`
- `Local network`
- `Healthy · Priority 1`
- `Tailscale`
- `Not configured · Priority 2`
- `Current work`
- `No active runs`
- `Knowledge health`
- `Local Knowledge`
- `Ready`
- `Configuration Chat`
- `Device setup stays separate from Task conversations.`
- `Codex and this desktop session are ready. I can verify Computer Use and propose
  it as a role for this Device.`
- `Proposed change`
- `Review only`
- `This preview does not apply settings.`
- `Add role`
- `Verify capability`
- `Computer Use`
- `computer-use`
- `Review change`
- `Change reviewed`
- `Not now`
- `Ask about this Device…`

## Component inventory

- `AppShell`: rail, content, and overlay layer.
- `BrandMark`: three-node branching glyph plus wordmark.
- `DeviceRail`: section heading, selected Device row, global navigation, join action.
- `DeviceHeader`: identity, semantic online status, configure action.
- `DeviceTabs`: selected Overview underline with future tabs visible and disabled
  until their real surfaces exist.
- `DetailSection`: open layout with heading and rows; no enclosing card.
- `KeyValueRows`: observed Device Facts only.
- `RuntimeStatus`: service and user-session state, kept separate from observed
  Facts.
- `RoleList`: person-outline icon plus role.
- `CapabilityTable`: capability-specific icon, label, semantic state.
- `RouteList`: ordered circular number, endpoint label, state, priority.
- `EmptyWork`: subdued tray icon and honest empty state.
- `KnowledgeHealth`: aggregate health only; no local Knowledge metadata.
- `ConfigurationChat`: separate-session header, labelled conversation log,
  structured review-only proposal, central scroll region, and persistent composer.
- `ChatLauncher`: cobalt circular control that toggles the drawer.

Icons use one Lucide-compatible outline family: network/branch, checklist, shield,
folder, notebook, plus-circle, settings, user, code, message, monitor, globe, inbox,
book-open, expand, send, and message-circle. Optical size is 18–22 px in rows and
24–28 px for the wordmark/launcher.

## Interaction requirements

- The sole Device and Overview tab are programmatically selected. Unimplemented
  navigation, join, and Device tabs remain visibly disabled instead of opening empty
  surfaces.
- `Configure` and the launcher open the Configuration Chat and focus its composer.
- The close control and Escape close the drawer without losing its local draft and
  return focus to the control that opened it.
- The launcher is not rendered while the chat is open.
- Expanded chat and the ordinary bottom sheet below 820 px are true modal layouts:
  background content becomes inert and hidden from assistive technology, initial
  focus enters the composer, Tab focus is contained, Escape closes, and focus
  returns to the opener. The compact desktop drawer remains nonmodal.
- Resizing an open compact desktop drawer into the below-820-px layout immediately
  applies modal semantics and moves focus inside when focus was outside the drawer.
- `Review change` enters a review state showing the exact Role and Capability diff.
- Review is explicitly non-applying in this slice; the completed local review state
  exposes a disabled `Change reviewed` action.
- `Not now` dismisses the proposal but leaves the chat available.
- The composer remains visible while a labelled conversation log accepts multiple
  messages, appends owner bubbles, and returns deterministic local acknowledgements
  in this initial slice.
- All controls have visible focus treatment, semantic labels, and reduced-motion
  behavior.

## Responsive rules

- At 1200 px and above, preserve the verified desktop-baseline proportions.
- From 820–1199 px, reduce the rail to an icon rail, keep the Device title in the
  content header, and let the chat drawer cover the right content column.
- Below 820 px, use a top Device selector, one detail column, horizontally scrollable
  tabs, and a modal bottom-sheet Configuration Chat with a scrim, inert background,
  and contained focus. The sheet may occupy up to 94 dynamic viewport height at the
  320 px minimum so its controls are not clipped.
- No primary content may be clipped at 320 CSS px.

## Intentional implementation details

- All visible UI remains code-native. Baseline screenshots are documentation and QA
  evidence only.
- Sample operational data is isolated behind a complete cross-platform local
  view-model boundary. Device role, OS, connection, Facts, Runtime Status,
  Capabilities, routes, current work, Knowledge health, and the Device-specific
  Configuration Session are injected; the components contain no Mac, Main, Online,
  runtime-state, tool-readiness, or proposal fixture literals.
- Configuration Chat renders only the assistant message and optional proposal
  supplied by that Device's Configuration Session view model. An offline or
  otherwise unready Device can therefore show a truthful no-proposal state without
  the component inferring from OS, connection labels, or capability lists.
- The application shell, Device surface, and Configuration Chat are separate
  modules so their state and test seams remain local.
- Knowledge is represented only by aggregate local health, preserving the rule that
  titles, filenames, snippets, content, index, and graph never leave the Device.
