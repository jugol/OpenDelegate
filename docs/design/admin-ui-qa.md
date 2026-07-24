# Admin Web visual QA

Status: **Admin surface baseline accepted**

Validated: **2026-07-24**

## Evidence

- [Desktop implementation at 1600 × 1000](admin-device-overview-baseline.png)
- [Mobile implementation at 390 × 844](admin-device-overview-mobile-baseline.png)
- [Minimum-width implementation at 320 × 720](admin-device-overview-minimum-width-baseline.png)

## Fidelity ledger

| Check | Approved requirement | Implementation result |
| --- | --- | --- |
| Primary frame | 264 px rail plus white canvas | Exact 264 px desktop rail and white content canvas |
| Device identity | Title, status line, one Configure action | Same hierarchy, copy, alignment, and cobalt action |
| Navigation | Five tabs with selected underline | Same order, visible copy, and selected treatment |
| Detail layout | Two open columns with shared dividers | Same open layout; no dashboard-card framing was added |
| Status language | Green health, blue detection, gray unavailable | AA-contrast semantic colors and one outline-icon family |
| Facts and runtime | Observations stay distinct from live state | Device facts contain OS and architecture; Worker service and user session have a separate Runtime status section |
| Configuration Chat | 394 px floating right drawer | 394 px desktop drawer with fixed header/composer and a central scroll region |
| Proposal | Soft-blue framed change plus separate actions | Same framing, content, and separated primary/secondary actions |
| Unfinished surfaces | No deceptive empty interactions | Future navigation, join, and Device tabs are visible but disabled |
| Responsive behavior | Top selector and modal bottom sheet below 820 px | Automated at 390 px and minimum 320 px with inert background, contained initial focus, no horizontal overflow, and no clipped controls |
| Device-specific setup truth | Configuration copy and proposals come from the selected Device | The Configuration Session view model supplies the assistant message and optional proposal; an offline signed-out Windows fixture renders a truthful no-proposal state |
| Knowledge privacy | Aggregate local health only | Only `Local Knowledge` and `Ready` are exposed |

## Visible-copy diff

The first-run desktop and mobile surfaces use the reviewed English copy in
[`admin-ui-spec.md`](admin-ui-spec.md#allowed-visible-copy). Configuration Chat now
states that Device setup stays separate from Task conversations, describes the
agent's intent as a proposal, labels the concrete diff operation `Add role`, and says
that the current proposal is review-only. Dynamic review and owner-message copy is
exercised only after an explicit interaction.

## Interaction evidence

Automated browser QA verifies:

- close, reopen, and Escape behavior while preserving the local draft and returning
  focus to the opener;
- expand and restore with background `inert`, modal focus containment, and preserved
  draft;
- initial 390 px and 320 px bottom-sheet focus, background isolation, full Tab-cycle
  containment, Escape closure, and focus restoration;
- compact-desktop-to-mobile media-query transitions that apply modal semantics and
  move outside focus into the open sheet;
- `Review change` reveals the exact `+Computer Use` and
  visual `Detected→Verified` Capability diff, while assistive technology receives
  the explicit phrase `Detected to Verified`, without applying it;
- the initial profile omits the proposed Computer Use role and keeps the capability
  in `Detected` state;
- an offline signed-out Windows Device does not claim Codex or desktop readiness and
  does not invent a Computer Use proposal;
- unfinished navigation and tabs cannot open empty placeholder surfaces;
- multiple chat turns keep the composer visible and scroll only the central region;
- the 390 px bottom sheet does not overlap its composer;
- the 320 px surface has no horizontal overflow or clipped primary controls; and
- an `@axe-core/playwright` 4.12.1 scan reports zero violations at every configured
  viewport.

The thirteen public component tests in `apps/admin-web/src/App.test.tsx` cover
cross-platform data injection, the offline no-proposal boundary, Facts/runtime
separation, canonical capability IDs, honest disabled surfaces, privacy, responsive
keyboard focus and modal transitions, proposal review, multi-message behavior, and
draft preservation. Eight Playwright tests exercise two journeys at 1600 × 1000,
1000 × 800, 390 × 844, and 320 × 720.
