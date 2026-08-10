import {
  DISCORD_COMPONENTS_V2_FLAG,
  type DiscordActionRow,
  type DiscordButton,
  type DiscordContainer,
  type DiscordMessagePayload,
  type DiscordPresentationLocale,
  type DiscordTaskState,
  type DiscordWorkflowStatus,
  type TaskChannelProjection,
} from "./contracts.ts";
import { DiscordAdapterError } from "./errors.ts";

const APPROVAL_ACTION_CATEGORIES = new Set([
  "read-only-observation",
  "opendelegate-process-retry",
  "opendelegate-process-restart",
  "project-dependency-install",
  "configured-official-package-install",
  "computer-use-input",
  "sandbox-boundary-escalation",
  "package-repository-addition",
  "remote-installer-script",
  "untrusted-installer",
  "driver-installation",
  "kernel-extension-installation",
  "os-network-change",
  "vpn-change",
  "firewall-change",
  "policy-relaxation",
  "secret-export",
  "cross-device-knowledge-transfer",
  "policy-bypass-attempt",
] as const);

const STATUS_LABELS: Readonly<
  Record<DiscordPresentationLocale, Readonly<Record<DiscordWorkflowStatus, string>>>
> = Object.freeze({
  en: Object.freeze({
    intake: "Intake",
    running: "Running",
    waiting: "Waiting",
    review: "Review",
    done: "Done",
    failed: "Failed",
  }),
  ko: Object.freeze({
    intake: "접수",
    running: "작업 중",
    waiting: "대기 중",
    review: "검토 중",
    done: "완료",
    failed: "문제 발생",
  }),
});

const STATUS_COLORS: Readonly<Record<DiscordWorkflowStatus, number>> = Object.freeze({
  intake: 0x64748b,
  running: 0x2563eb,
  waiting: 0xd97706,
  review: 0x7c3aed,
  done: 0x059669,
  failed: 0xdc2626,
});

export function workflowStatusForTaskState(state: DiscordTaskState): DiscordWorkflowStatus {
  switch (state) {
    case "intake":
      return "intake";
    case "queued":
    case "running":
      return "running";
    case "waiting_user":
    case "waiting_resource":
    case "paused":
      return "waiting";
    case "review":
      return "review";
    case "completed":
    case "cancelled":
      return "done";
    case "failed":
      return "failed";
  }
}

export function renderStatusPanel(
  projection: TaskChannelProjection,
  locale: DiscordPresentationLocale = "en",
): DiscordMessagePayload {
  validateProjection(projection);
  const status = workflowStatusForTaskState(projection.state);
  const detailLines = [
    locale === "ko" ? "## 작업 상태" : "## Task status",
    `**${STATUS_LABELS[locale][status]}**`,
    safeMarkdown(statusPanelSummary(projection, locale), 1_500),
  ];
  if (projection.progress !== undefined) {
    detailLines.push(
      `${locale === "ko" ? "진행" : "Progress"}: ${projection.progress.completed.toString()}/${projection.progress.total.toString()}`,
    );
  }
  if (projection.approval !== undefined) {
    detailLines.push(
      `${locale === "ko" ? "승인 필요" : "Approval needed"}: ${safeMarkdown(
        approvalDescription(projection.approval, locale),
        500,
      )}`,
    );
  }
  const controls =
    projection.significance === "status"
      ? controlButtons(projection, locale)
      : linkButtons(projection, locale);
  const containerComponents: DiscordContainer["components"] = Object.freeze([
    Object.freeze({ type: 10 as const, content: detailLines.join("\n\n") }),
    ...(controls.components.length === 0
      ? []
      : [Object.freeze({ type: 14 as const, divider: true, spacing: 1 as const }), controls]),
  ]);
  return Object.freeze({
    flags: DISCORD_COMPONENTS_V2_FLAG,
    components: Object.freeze([
      Object.freeze({
        type: 17 as const,
        accent_color: STATUS_COLORS[status],
        components: containerComponents,
      }),
    ]),
    allowed_mentions: Object.freeze({ parse: Object.freeze([]) }),
  });
}

function statusPanelSummary(
  projection: TaskChannelProjection,
  locale: DiscordPresentationLocale,
): string {
  switch (projection.significance) {
    case "question":
      return locale === "ko"
        ? "아래의 최신 질문에 답변해 주세요."
        : "Waiting for your reply to the latest message below.";
    case "failure":
      return locale === "ko"
        ? "확인이 필요합니다. 아래의 최신 오류 안내를 확인해 주세요."
        : "Action is needed. See the latest failure update below.";
    case "final":
      return locale === "ko"
        ? "처리가 끝났습니다. 아래의 최신 결과를 확인해 주세요."
        : "Completed. See the latest result below.";
    case "decision":
      return locale === "ko"
        ? "작업 상태가 변경됐습니다. 아래의 최신 결정을 확인해 주세요."
        : "The Task changed. See the latest decision below.";
    case "status":
      return localizeKnownText(projection.summary, locale);
  }
}

export function renderTaskUpdate(
  projection: TaskChannelProjection,
  locale: DiscordPresentationLocale = "en",
): DiscordMessagePayload {
  validateProjection(projection);
  const status = workflowStatusForTaskState(projection.state);
  const headline = taskUpdateHeadline(projection.significance, locale);
  const buttons = controlButtons(projection, locale);
  const content = [
    headline,
    safeMarkdown(
      localizeKnownText(projection.summary, locale),
      projection.approval === undefined ? 1_800 : 1_250,
    ),
    ...(projection.approval === undefined
      ? []
      : [
          `⚠️ **${locale === "ko" ? "승인 필요" : "Approval needed"}** — ${safeMarkdown(
            approvalDescription(projection.approval, locale),
            450,
          )}`,
        ]),
  ].join("\n\n");
  const components: DiscordMessagePayload["components"] = Object.freeze([
    Object.freeze({
      type: 17 as const,
      accent_color: STATUS_COLORS[status],
      components: Object.freeze([
        Object.freeze({
          type: 10 as const,
          content,
        }),
        ...(buttons.components.length === 0
          ? []
          : [Object.freeze({ type: 14 as const, divider: true, spacing: 1 as const }), buttons]),
      ]),
    }),
  ]);
  return Object.freeze({
    flags: DISCORD_COMPONENTS_V2_FLAG,
    components,
    allowed_mentions: Object.freeze({ parse: Object.freeze([]) }),
  });
}

export function renderTaskActivity(
  projection: TaskChannelProjection,
  locale: DiscordPresentationLocale = "en",
): DiscordMessagePayload {
  validateProjection(projection);
  const activity = projection.activity;
  if (activity === undefined) {
    throw invalidProjection();
  }
  const phaseLabel: Readonly<Record<typeof activity.phase, string>> =
    locale === "ko"
      ? {
          planning: "계획 중",
          dispatching: "작업 배정 중",
          working: "여러 기기에서 작업 중",
          verifying: "결과 확인 중",
        }
      : {
          planning: "Planning",
          dispatching: "Dispatching",
          working: "Working across Devices",
          verifying: "Verifying results",
        };
  const progress =
    activity.totalWorkOrders === 0
      ? phaseLabel[activity.phase]
      : `${phaseLabel[activity.phase]} · ${activity.completedWorkOrders.toString()}/${activity.totalWorkOrders.toString()} ${locale === "ko" ? "작업 단위 완료" : "Work Orders complete"}`;
  const milestoneLines = activity.milestones.map((milestone) => {
    const marker = milestone.status === "completed" ? "✅" : "↻";
    const deviceName = milestone.deviceLabel ?? (locale === "ko" ? "작업 기기" : "Worker Device");
    const device = deviceName === undefined ? "" : ` **${shortDeviceLabel(deviceName)}** —`;
    return `${marker}${device} ${safeMarkdown(localizeKnownText(milestone.summary, locale), 500)}`;
  });
  const content =
    projection.state === "paused"
      ? locale === "ko"
        ? [
            "## OpenDelegate가 일시정지됐어요",
            "**실행이 안전하게 멈춰 있습니다.**",
            "준비되면 같은 작업을 계속하거나 취소할 수 있어요.",
            "_일시정지 중에는 새로운 작업을 시작하지 않습니다._",
          ].join("\n\n")
        : [
            "## OpenDelegate is paused",
            "**Execution is safely paused.**",
            "Resume this same Task when you are ready, or cancel it.",
            "_No new work starts while this Task is paused._",
          ].join("\n\n")
      : [
          locale === "ko" ? "## OpenDelegate가 작업 중이에요" : "## OpenDelegate is working",
          `**${progress}**`,
          ...milestoneLines,
          ...(projection.approval === undefined
            ? []
            : [
                `⚠️ **${locale === "ko" ? "승인 필요" : "Approval needed"}** — ${safeMarkdown(
                  approvalDescription(projection.approval, locale),
                  500,
                )}`,
              ]),
          locale === "ko"
            ? "_의미 있는 진행 상황이 생길 때 이 메시지 하나만 갱신됩니다._"
            : "_This one message updates when meaningful progress changes._",
        ].join("\n\n");
  const buttons = controlButtons(projection, locale);
  return Object.freeze({
    flags: DISCORD_COMPONENTS_V2_FLAG,
    components: Object.freeze([
      Object.freeze({
        type: 17 as const,
        accent_color: STATUS_COLORS.running,
        components: Object.freeze([
          Object.freeze({ type: 10 as const, content }),
          ...(buttons.components.length === 0
            ? []
            : [Object.freeze({ type: 14 as const, divider: true, spacing: 1 as const }), buttons]),
        ]),
      }),
    ]),
    allowed_mentions: Object.freeze({ parse: Object.freeze([]) }),
  });
}

export function renderResolvedOwnerPrompt(
  projection: TaskChannelProjection,
  locale: DiscordPresentationLocale = "en",
): DiscordMessagePayload {
  validateProjection(projection);
  if (projection.significance !== "question") {
    throw new DiscordAdapterError(
      "PROJECTION_INVALID",
      "Only an owner-question projection can be resolved in place.",
    );
  }
  return Object.freeze({
    flags: DISCORD_COMPONENTS_V2_FLAG,
    components: Object.freeze([
      Object.freeze({
        type: 17 as const,
        accent_color: STATUS_COLORS.running,
        components: Object.freeze([
          Object.freeze({
            type: 10 as const,
            content:
              locale === "ko"
                ? `## 답변을 받았어요\n\n${safeMarkdown(
                    localizeKnownText(projection.summary, locale),
                    1_500,
                  )}\n\n✅ 답변을 반영해 OpenDelegate가 작업을 계속합니다.`
                : `## Input received\n\n${safeMarkdown(
                    projection.summary,
                    1_500,
                  )}\n\n✅ Your reply was received. OpenDelegate is continuing this Task.`,
          }),
        ]),
      }),
    ]),
    allowed_mentions: Object.freeze({ parse: Object.freeze([]) }),
  });
}

export function renderResolvedTaskFailure(
  projection: TaskChannelProjection,
  locale: DiscordPresentationLocale = "en",
): DiscordMessagePayload {
  validateProjection(projection);
  if (!isRetrySurfaceProjection(projection)) {
    throw new DiscordAdapterError(
      "PROJECTION_INVALID",
      "Only a chronological retry surface can be resolved in place.",
    );
  }
  return Object.freeze({
    flags: DISCORD_COMPONENTS_V2_FLAG,
    components: Object.freeze([
      Object.freeze({
        type: 17 as const,
        accent_color: STATUS_COLORS.running,
        components: Object.freeze([
          Object.freeze({
            type: 10 as const,
            content:
              locale === "ko"
                ? `## 다시 시작했어요\n\n${safeMarkdown(
                    localizeKnownText(projection.summary, locale),
                    1_400,
                  )}\n\n↻ 재시도를 시작했습니다. 아래의 최신 진행 상황이나 결과를 확인해 주세요.`
                : `## Retry started\n\n${safeMarkdown(
                    projection.summary,
                    1_400,
                  )}\n\n↻ OpenDelegate accepted a retry. Follow the latest status or result below.`,
          }),
        ]),
      }),
    ]),
    allowed_mentions: Object.freeze({ parse: Object.freeze([]) }),
  });
}

function taskUpdateHeadline(
  significance: TaskChannelProjection["significance"],
  locale: DiscordPresentationLocale,
): string {
  switch (significance) {
    case "final":
      return locale === "ko" ? "## 결과" : "## Result";
    case "failure":
      return locale === "ko" ? "## 확인이 필요해요" : "## Task needs attention";
    case "question":
      return locale === "ko" ? "## 답변이 필요해요" : "## Owner input needed";
    case "decision":
    case "status":
      return locale === "ko" ? "## 작업 업데이트" : "## Task update";
  }
}

export function renderInteractionResult(
  message: string,
  success = true,
  locale: DiscordPresentationLocale = "en",
): DiscordMessagePayload {
  return Object.freeze({
    flags: DISCORD_COMPONENTS_V2_FLAG,
    components: Object.freeze([
      Object.freeze({
        type: 17 as const,
        accent_color: success ? 0x059669 : 0xdc2626,
        components: Object.freeze([
          Object.freeze({
            type: 10 as const,
            content: safeMarkdown(localizeKnownText(message, locale), 1_000),
          }),
        ]),
      }),
    ]),
    allowed_mentions: Object.freeze({ parse: Object.freeze([]) }),
  });
}

function controlButtons(
  projection: TaskChannelProjection,
  locale: DiscordPresentationLocale,
): DiscordActionRow {
  const buttons: DiscordButton[] = [];
  if (projection.approval !== undefined) {
    buttons.push(
      actionButton(
        locale === "ko" ? "이 동작만 승인" : "Approve once",
        3,
        `od:v1:approve:${safeCustomIdSegment(projection.approval.approvalId)}`,
      ),
      actionButton(
        locale === "ko" ? "거부" : "Reject",
        4,
        `od:v1:reject:${safeCustomIdSegment(projection.approval.approvalId)}`,
      ),
    );
  } else {
    switch (projection.state) {
      case "intake":
      case "queued":
      case "running":
      case "waiting_resource":
      case "review":
        buttons.push(actionButton(locale === "ko" ? "일시정지" : "Pause", 2, "od:v1:pause"));
        break;
      case "paused":
        buttons.push(actionButton(locale === "ko" ? "계속" : "Resume", 1, "od:v1:resume"));
        break;
      case "failed":
      case "cancelled":
        buttons.push(actionButton(locale === "ko" ? "다시 시도" : "Retry", 1, "od:v1:retry"));
        break;
      case "waiting_user":
      case "completed":
        break;
    }
  }
  if (
    projection.state !== "completed" &&
    projection.state !== "failed" &&
    projection.state !== "cancelled"
  ) {
    buttons.push(actionButton(locale === "ko" ? "취소" : "Cancel", 4, "od:v1:cancel"));
  }
  buttons.push(...linkButtons(projection, locale).components);
  return Object.freeze({ type: 1 as const, components: Object.freeze(buttons.slice(0, 5)) });
}

function linkButtons(
  projection: TaskChannelProjection,
  locale: DiscordPresentationLocale,
): DiscordActionRow {
  const buttons: DiscordButton[] = [];
  if (projection.artifact !== undefined) {
    buttons.push(
      Object.freeze({
        type: 2 as const,
        style: 5 as const,
        label: projection.artifact.label.slice(0, 38),
        url: projection.artifact.url,
      }),
    );
  }
  if (projection.inspectUrl !== undefined) {
    buttons.push(
      Object.freeze({
        type: 2 as const,
        style: 5 as const,
        label: locale === "ko" ? "실행 내역" : "Inspect runs",
        url: projection.inspectUrl,
      }),
    );
  }
  return Object.freeze({ type: 1 as const, components: Object.freeze(buttons) });
}

function actionButton(label: string, style: 1 | 2 | 3 | 4, customId: string): DiscordButton {
  return Object.freeze({ type: 2 as const, style, label, custom_id: customId });
}

function isRetrySurfaceProjection(projection: TaskChannelProjection): boolean {
  return (
    projection.significance === "failure" ||
    (projection.significance === "final" && projection.state === "cancelled")
  );
}

const KOREAN_CLOSED_TEXT = Object.freeze({
  "OpenDelegate is reading this Task.": "OpenDelegate가 작업 내용을 확인하고 있어요.",
  "This Task is queued for its next eligible execution attempt.":
    "다음 실행이 가능한 순서를 기다리고 있어요.",
  "OpenDelegate is working on this Task.": "OpenDelegate가 이 작업을 진행하고 있어요.",
  "This Task is waiting for owner input.": "계속하려면 답변이 필요해요.",
  "This Task is waiting for an eligible resource.": "사용 가능한 기기나 리소스를 기다리고 있어요.",
  "No eligible Worker is online for this Work Order. OpenDelegate will continue automatically when relevant resource availability changes. Waiting does not consume the automatic retry Budget. Resource code: WORKER_OFFLINE.":
    "이 작업을 맡을 수 있는 Worker가 현재 오프라인입니다. 다시 온라인이 되면 OpenDelegate가 자동으로 계속합니다. 기다리는 동안 자동 재시도 횟수는 차감되지 않습니다. 진단 코드: WORKER_OFFLINE.",
  "The Worker could not resolve a registered Workspace for this Run. OpenDelegate will continue automatically when relevant resource availability changes. Waiting does not consume the automatic retry Budget.":
    "Worker가 이 실행에 사용할 등록된 Workspace를 준비하지 못했어요. Workspace 등록이나 경로 상태가 바뀌면 OpenDelegate가 자동으로 계속합니다. 기다리는 동안 자동 재시도 횟수는 차감되지 않습니다.",
  "This Task is ready for review.": "결과를 검토할 준비가 됐어요.",
  "This Task is complete.": "작업을 완료했어요.",
  "This Task needs attention before it can continue.": "계속하려면 확인이 필요해요.",
  "This Task is paused.": "작업이 일시정지됐어요.",
  "This Task was cancelled.": "작업을 취소했어요.",
  "Main is planning the work.": "Main이 작업을 계획하고 있어요.",
  "Main is verifying the combined results.": "Main이 취합한 결과를 확인하고 있어요.",
  "Worker Agent is consulting Device-local Knowledge.":
    "Worker가 이 기기의 Knowledge를 확인하고 있어요.",
  "Worker Agent is coordinating child Agents.": "Worker가 하위 Agent와 작업을 조율하고 있어요.",
  "Worker Agent is using Device-local tools.": "Worker가 이 기기의 도구를 사용하고 있어요.",
  "Worker Agent is verifying its work.": "Worker가 작업 결과를 확인하고 있어요.",
  "Worker Agent is waiting for owner approval.": "Worker가 소유자 승인을 기다리고 있어요.",
  "Worker Agent is making progress.": "Worker가 작업을 진행하고 있어요.",
  "The Worker is making progress.": "Worker가 작업을 진행하고 있어요.",
  "The Worker accepted its Work Order.": "Worker가 배정된 작업을 받았어요.",
  "The Worker reported completion; Main is checking its result.":
    "Worker가 완료를 보고해 Main이 결과를 확인하고 있어요.",
  "The Worker reported a problem; Main is deciding the next step.":
    "Worker가 문제를 보고해 Main이 다음 조치를 판단하고 있어요.",
  "Work Order completed.": "배정된 작업을 완료했어요.",
  "Main dispatched this Work Order.": "Main이 이 작업을 Worker에 배정했어요.",
  "A Worker is waiting for owner approval before it can continue.":
    "Worker가 계속하기 전에 승인을 기다리고 있어요.",
  "Main is preparing or coordinating the current work.":
    "Main이 현재 작업을 준비하고 조율하고 있어요.",
  "Execution is paused until the owner resumes this Task.":
    "사용자가 계속할 때까지 실행을 안전하게 멈췄어요.",
  "The approval was granted for its exact recorded scope.": "표시된 범위에 한해 승인했어요.",
  "The approval was rejected.": "승인을 거부했어요.",
  "This Task control is no longer available in the Task's current state. Use the latest Task update or send a new message.":
    "현재 작업 상태에서는 이 버튼을 사용할 수 없어요. 최신 작업 업데이트를 확인하거나 새 메시지를 보내 주세요.",
  "This approval is no longer available in the Task's current state. Use the latest Task update.":
    "현재 작업 상태에서는 이 승인을 처리할 수 없어요. 최신 작업 업데이트를 확인해 주세요.",
  "OpenDelegate could not safely record this control. Nothing was changed; use the current Task control again.":
    "이 요청을 안전하게 기록하지 못해 아무것도 변경하지 않았어요. 현재 작업 버튼을 다시 사용해 주세요.",
  "This Task control conflicts with an already processed request. Use the latest Task update.":
    "이미 처리된 요청과 충돌하는 버튼이에요. 최신 작업 업데이트를 확인해 주세요.",
  "This Task is no longer available.": "이 작업은 더 이상 사용할 수 없어요.",
} satisfies Readonly<Record<string, string>>);

function localizeKnownText(value: string, locale: DiscordPresentationLocale): string {
  if (locale === "en") {
    return value;
  }
  const preparedWorkOrders = /^Main prepared ([1-9][0-9]*) Work Orders?\.$/u.exec(value);
  if (preparedWorkOrders !== null) {
    return `Main이 Worker에 배정할 작업 ${preparedWorkOrders[1]}개를 준비했어요.`;
  }
  const terminalWorkerFailure =
    /^Worker Run failed during ([^\n()]{1,80}) \(([A-Z0-9_]{1,80})\)\. OpenDelegate did not automatically replay this process because its external outcome may be uncertain\. Review Task Runs, then use Retry\.\n\nLast Worker report \(may be incomplete\):\n([\s\S]+)$/u.exec(
      value,
    );
  if (terminalWorkerFailure !== null) {
    const stage = terminalWorkerFailure[1] === "execution" ? "실행" : terminalWorkerFailure[1];
    return `Worker Run이 ${stage} 단계에서 실패했습니다 (${terminalWorkerFailure[2]}). 외부 작업이 실제로 어디까지 실행됐는지 확실하지 않아 OpenDelegate가 자동으로 다시 실행하지 않았습니다. 실행 내역을 확인한 뒤 다시 시도해 주세요.\n\n마지막 Worker 보고(불완전할 수 있음):\n${terminalWorkerFailure[3]}`;
  }
  const retryableWorkerFailure =
    /^Worker Run encountered a retryable failure during ([^\n()]{1,80}) \(([A-Z0-9_]{1,80})\)\.\n\nLast Worker report \(may be incomplete\):\n([\s\S]+)$/u.exec(
      value,
    );
  if (retryableWorkerFailure !== null) {
    const stage = retryableWorkerFailure[1] === "execution" ? "실행" : retryableWorkerFailure[1];
    return `Worker Run에서 다시 시도할 수 있는 오류가 발생했습니다. 단계: ${stage} · 코드: ${retryableWorkerFailure[2]}.\n\n마지막 Worker 보고(불완전할 수 있음):\n${retryableWorkerFailure[3]}`;
  }
  return KOREAN_CLOSED_TEXT[value as keyof typeof KOREAN_CLOSED_TEXT] ?? value;
}

function approvalDescription(
  approval: NonNullable<TaskChannelProjection["approval"]>,
  locale: DiscordPresentationLocale,
): string {
  if (!hasStructuredApprovalPresentation(approval)) {
    return localizeKnownText(approval.description, locale);
  }
  const action = approvalActionLabel(approval.actionCategory, locale);
  const risk = approvalRiskLabel(approval.risk, locale);
  if (locale === "ko") {
    const remaining =
      approval.remaining === 0
        ? ""
        : ` 현재 뒤에 추가 승인 요청 ${approval.remaining.toString()}개가 기다리고 있어요.`;
    return `이 작업의 ${approval.sequence.toString()}번째 보호 동작입니다. ${approval.deviceLabel}에서 ${action}. 위험도: ${risk}. 이 버튼은 표시된 동작 한 번만 승인하며, 이후의 다른 보호 동작은 별도 승인이 필요할 수 있어요.${remaining}`;
  }
  const remaining =
    approval.remaining === 0
      ? ""
      : ` ${approval.remaining.toString()} additional approval request(s) are already waiting.`;
  return `Protected action ${approval.sequence.toString()} for this Task. ${approval.deviceLabel} wants to ${action}. Risk: ${risk}. This approves only the exact action shown; a later protected action may require a separate decision.${remaining}`;
}

function hasStructuredApprovalPresentation(
  approval: NonNullable<TaskChannelProjection["approval"]>,
): approval is NonNullable<TaskChannelProjection["approval"]> & {
  readonly sequence: number;
  readonly remaining: number;
  readonly deviceLabel: string;
  readonly actionCategory: NonNullable<
    NonNullable<TaskChannelProjection["approval"]>["actionCategory"]
  >;
  readonly risk: NonNullable<NonNullable<TaskChannelProjection["approval"]>["risk"]>;
} {
  return (
    approval.sequence !== undefined &&
    approval.remaining !== undefined &&
    approval.deviceLabel !== undefined &&
    approval.actionCategory !== undefined &&
    approval.risk !== undefined
  );
}

function approvalActionLabel(
  action: NonNullable<NonNullable<TaskChannelProjection["approval"]>["actionCategory"]>,
  locale: DiscordPresentationLocale,
): string {
  const labels: Record<typeof action, readonly [english: string, korean: string]> = {
    "read-only-observation": [
      "perform a protected observation",
      "보호된 상태 확인을 수행하려고 해요",
    ],
    "opendelegate-process-retry": [
      "retry an OpenDelegate process",
      "OpenDelegate 프로세스를 다시 시도하려고 해요",
    ],
    "opendelegate-process-restart": [
      "restart an OpenDelegate process",
      "OpenDelegate 프로세스를 다시 시작하려고 해요",
    ],
    "project-dependency-install": [
      "install a Task dependency",
      "작업에 필요한 패키지를 설치하려고 해요",
    ],
    "configured-official-package-install": [
      "install an official package",
      "공식 패키지를 설치하려고 해요",
    ],
    "computer-use-input": [
      "control the desktop for this Task",
      "이 작업을 위해 데스크톱을 조작하려고 해요",
    ],
    "sandbox-boundary-escalation": [
      "temporarily expand its sandbox for this Task",
      "Task 전용 샌드박스 범위를 일시적으로 넓히려고 해요",
    ],
    "package-repository-addition": ["add a package repository", "패키지 저장소를 추가하려고 해요"],
    "remote-installer-script": ["run a remote installer", "원격 설치 스크립트를 실행하려고 해요"],
    "untrusted-installer": [
      "run an untrusted installer",
      "검증되지 않은 설치 프로그램을 실행하려고 해요",
    ],
    "driver-installation": ["install a driver", "드라이버를 설치하려고 해요"],
    "kernel-extension-installation": ["install a kernel extension", "커널 확장을 설치하려고 해요"],
    "os-network-change": ["change OS networking", "운영 체제 네트워크 설정을 바꾸려고 해요"],
    "vpn-change": ["change VPN configuration", "VPN 설정을 바꾸려고 해요"],
    "firewall-change": ["change firewall configuration", "방화벽 설정을 바꾸려고 해요"],
    "policy-relaxation": ["relax an execution policy", "실행 정책을 완화하려고 해요"],
    "secret-export": ["export protected Secret material", "보호된 Secret을 내보내려고 해요"],
    "cross-device-knowledge-transfer": [
      "transfer Device-local Knowledge",
      "Device-local Knowledge를 전송하려고 해요",
    ],
    "policy-bypass-attempt": [
      "perform an action blocked by policy",
      "정책에서 차단된 동작을 수행하려고 해요",
    ],
  };
  return labels[action][locale === "ko" ? 1 : 0];
}

function approvalRiskLabel(
  risk: NonNullable<NonNullable<TaskChannelProjection["approval"]>["risk"]>,
  locale: DiscordPresentationLocale,
): string {
  if (locale === "en") {
    return risk;
  }
  return { low: "낮음", medium: "보통", high: "높음", critical: "매우 높음" }[risk];
}

function validateProjection(projection: TaskChannelProjection): void {
  if (
    projection.taskId.length === 0 ||
    projection.taskId.length > 160 ||
    projection.objective.trim().length === 0 ||
    projection.summary.trim().length === 0
  ) {
    throw invalidProjection();
  }
  if (
    projection.sourceEventId !== undefined &&
    (projection.sourceEventId.length === 0 ||
      projection.sourceEventId.length > 160 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(projection.sourceEventId))
  ) {
    throw invalidProjection();
  }
  if (projection.significance !== "status" && projection.sourceEventId === undefined) {
    throw invalidProjection();
  }
  if (
    projection.artifact !== undefined &&
    (projection.artifact.label.trim().length === 0 ||
      projection.artifact.label.length > 38 ||
      projection.artifact.label.includes("\u0000"))
  ) {
    throw invalidProjection();
  }
  if (
    projection.progress !== undefined &&
    (!Number.isSafeInteger(projection.progress.completed) ||
      !Number.isSafeInteger(projection.progress.total) ||
      projection.progress.completed < 0 ||
      projection.progress.total < 1 ||
      projection.progress.completed > projection.progress.total)
  ) {
    throw invalidProjection();
  }
  if (projection.activity !== undefined) {
    const activity = projection.activity;
    if (
      activity.cycleId.length === 0 ||
      activity.cycleId.length > 160 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(activity.cycleId) ||
      !Number.isSafeInteger(activity.revision) ||
      activity.revision < 1 ||
      !Number.isSafeInteger(activity.updatedAtMs) ||
      activity.updatedAtMs < 0 ||
      !["planning", "dispatching", "working", "verifying"].includes(activity.phase) ||
      !Number.isSafeInteger(activity.completedWorkOrders) ||
      !Number.isSafeInteger(activity.totalWorkOrders) ||
      activity.completedWorkOrders < 0 ||
      activity.totalWorkOrders < 0 ||
      activity.completedWorkOrders > activity.totalWorkOrders ||
      activity.milestones.length < 1 ||
      activity.milestones.length > 4
    ) {
      throw invalidProjection();
    }
    for (const milestone of activity.milestones) {
      if (
        milestone.key.length === 0 ||
        milestone.key.length > 160 ||
        milestone.summary.trim().length === 0 ||
        milestone.summary.length > 1_024 ||
        milestone.summary.includes("\0") ||
        (milestone.status !== "active" && milestone.status !== "completed") ||
        (milestone.deviceId !== undefined &&
          (milestone.deviceId.length === 0 || milestone.deviceId.length > 160)) ||
        (milestone.deviceLabel !== undefined &&
          (milestone.deviceLabel.trim().length === 0 ||
            milestone.deviceLabel.length > 253 ||
            milestone.deviceLabel.includes("\0")))
      ) {
        throw invalidProjection();
      }
    }
  }
  for (const url of [projection.artifact?.url, projection.inspectUrl]) {
    if (url !== undefined && !isSafeWebUrl(url)) {
      throw invalidProjection();
    }
  }
  if (
    projection.approval !== undefined &&
    (projection.approval.approvalId.length === 0 ||
      projection.approval.approvalId.length > 70 ||
      !/^[A-Za-z0-9._-]+$/.test(projection.approval.approvalId) ||
      !validStructuredApprovalPresentation(projection.approval))
  ) {
    throw invalidProjection();
  }
}

function validStructuredApprovalPresentation(
  approval: NonNullable<TaskChannelProjection["approval"]>,
): boolean {
  const values = [
    approval.sequence,
    approval.remaining,
    approval.deviceLabel,
    approval.actionCategory,
    approval.risk,
  ];
  if (values.every((value) => value === undefined)) {
    return true;
  }
  return (
    Number.isSafeInteger(approval.sequence) &&
    approval.sequence! >= 1 &&
    Number.isSafeInteger(approval.remaining) &&
    approval.remaining! >= 0 &&
    typeof approval.deviceLabel === "string" &&
    approval.deviceLabel.trim().length > 0 &&
    approval.deviceLabel.length <= 253 &&
    !approval.deviceLabel.includes("\0") &&
    approval.actionCategory !== undefined &&
    APPROVAL_ACTION_CATEGORIES.has(approval.actionCategory) &&
    approval.risk !== undefined &&
    ["low", "medium", "high", "critical"].includes(approval.risk)
  );
}

function safeCustomIdSegment(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw invalidProjection();
  }
  return value;
}

function shortDeviceLabel(value: string): string {
  const safe = safeMarkdown(value, 160).replaceAll("`", "");
  return safe.length <= 28 ? safe : `${safe.slice(0, 27)}…`;
}

function safeMarkdown(value: string, maximum: number): string {
  return value
    .replaceAll("\u0000", "")
    .replace(/@(everyone|here)/giu, "@\u200b$1")
    .slice(0, maximum);
}

function isSafeWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  } catch {
    return false;
  }
}

function invalidProjection(): DiscordAdapterError {
  return new DiscordAdapterError("PROJECTION_INVALID", "The Discord projection is invalid.");
}
