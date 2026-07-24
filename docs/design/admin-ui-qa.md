# Admin Web visual QA

Status: **Admin surface baseline accepted**

Validated: **2026-07-24**

## Evidence

- [Desktop implementation at 1600 × 1000](admin-device-overview-baseline.png)
- [Mobile implementation at 390 × 844](admin-device-overview-mobile-baseline.png)

## Fidelity ledger

| Check | Approved requirement | Implementation result |
| --- | --- | --- |
| Primary frame | 264 px rail plus white canvas | Exact 264 px desktop rail and white content canvas |
| Device identity | Title, status line, one Configure action | Same hierarchy, copy, alignment, and cobalt action |
| Navigation | Five tabs with selected underline | Same order, visible copy, and selected treatment |
| Detail layout | Two open columns with shared dividers | Same open layout; no dashboard-card framing was added |
| Status language | Green health, blue detection, gray unavailable | Same semantic colors and outline-icon family |
| Configuration Chat | 394 px floating right drawer | 394 × 630 px desktop drawer, bottom-right anchored |
| Proposal | Soft-blue framed change plus separate actions | Same framing, content, and separated primary/secondary actions |
| Responsive behavior | Top selector and bottom sheet below 820 px | Verified at 390 px and minimum 320 px without horizontal overflow |
| Knowledge privacy | Aggregate local health only | Only `Local Knowledge` and `Ready` are exposed |

## Visible-copy diff

The first-run desktop and mobile surfaces have **zero missing, substituted, or
additional visible strings** relative to
[`admin-ui-spec.md`](admin-ui-spec.md#allowed-visible-copy). Dynamic review and
owner-message copy is exercised only after an explicit interaction.

## Interaction evidence

Browser QA verified:

- collapse and reopen Configuration Chat while preserving its local draft;
- expand and restore Configuration Chat while preserving its local draft;
- `Review change` reveals the exact `+Computer Use` and
  `computer-useDetected→Verified` diff;
- the initial profile omits the proposed Computer Use role and keeps the capability
  in `Detected` state;
- Arrow Right moves selection and focus from Overview to Capabilities;
- the 390 px bottom sheet does not overlap its composer;
- the 320 px surface has no horizontal overflow.

The eight public component tests in `apps/admin-web/src/App.test.tsx` cover state,
copy, privacy, keyboard, proposal, and chat-draft behavior. Playwright separately
verifies the rendered 1600 px, 1000 px, and 390 px browser layouts; the recorded
manual browser pass covers the 320 px overflow boundary.
