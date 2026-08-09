import {
  DISCORD_COMPONENTS_V2_FLAG,
  type DiscordActionRow,
  type DiscordButton,
  type DiscordContainer,
  type DiscordMessagePayload,
  type DiscordTaskState,
  type DiscordWorkflowStatus,
  type TaskChannelProjection,
} from "./contracts.ts";
import { DiscordAdapterError } from "./errors.ts";

const STATUS_LABELS: Readonly<Record<DiscordWorkflowStatus, string>> = Object.freeze({
  intake: "Intake",
  running: "Running",
  waiting: "Waiting",
  review: "Review",
  done: "Done",
  failed: "Failed",
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

export function renderStatusPanel(projection: TaskChannelProjection): DiscordMessagePayload {
  validateProjection(projection);
  const status = workflowStatusForTaskState(projection.state);
  const detailLines = [
    "## Task status",
    `**${STATUS_LABELS[status]}**`,
    safeMarkdown(statusPanelSummary(projection), 1_500),
  ];
  if (projection.progress !== undefined) {
    detailLines.push(
      `Progress: ${projection.progress.completed.toString()}/${projection.progress.total.toString()}`,
    );
  }
  if (projection.approval !== undefined) {
    detailLines.push(`Approval needed: ${safeMarkdown(projection.approval.description, 500)}`);
  }
  const references = linkButtons(projection);
  const containerComponents: DiscordContainer["components"] = Object.freeze([
    Object.freeze({ type: 10 as const, content: detailLines.join("\n\n") }),
    ...(references.components.length === 0
      ? []
      : [Object.freeze({ type: 14 as const, divider: true, spacing: 1 as const }), references]),
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

function statusPanelSummary(projection: TaskChannelProjection): string {
  switch (projection.significance) {
    case "question":
      return "Waiting for your reply to the latest message below.";
    case "failure":
      return "Action is needed. See the latest failure update below.";
    case "final":
      return "Completed. See the latest result below.";
    case "decision":
      return "The Task changed. See the latest decision below.";
    case "status":
      return projection.summary;
  }
}

export function renderTaskUpdate(projection: TaskChannelProjection): DiscordMessagePayload {
  validateProjection(projection);
  const status = workflowStatusForTaskState(projection.state);
  const headline = taskUpdateHeadline(projection.significance);
  const buttons = controlButtons(projection);
  const components: DiscordMessagePayload["components"] = Object.freeze([
    Object.freeze({
      type: 17 as const,
      accent_color: STATUS_COLORS[status],
      components: Object.freeze([
        Object.freeze({
          type: 10 as const,
          content: `${headline}\n\n${safeMarkdown(projection.summary, 1_800)}`,
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

export function renderTaskActivity(projection: TaskChannelProjection): DiscordMessagePayload {
  validateProjection(projection);
  const activity = projection.activity;
  if (activity === undefined) {
    throw invalidProjection();
  }
  const phaseLabel: Readonly<Record<typeof activity.phase, string>> = {
    planning: "Planning",
    dispatching: "Dispatching",
    working: "Working across Devices",
    verifying: "Verifying results",
  };
  const progress =
    activity.totalWorkOrders === 0
      ? phaseLabel[activity.phase]
      : `${phaseLabel[activity.phase]} · ${activity.completedWorkOrders.toString()}/${activity.totalWorkOrders.toString()} Work Orders complete`;
  const milestoneLines = activity.milestones.map((milestone) => {
    const marker = milestone.status === "completed" ? "✅" : "↻";
    const deviceName = milestone.deviceLabel ?? "Worker Device";
    const device = deviceName === undefined ? "" : ` **${shortDeviceLabel(deviceName)}** —`;
    return `${marker}${device} ${safeMarkdown(milestone.summary, 500)}`;
  });
  const content = [
    "## OpenDelegate is working",
    `**${progress}**`,
    ...milestoneLines,
    "_This one message updates when meaningful progress changes._",
  ].join("\n\n");
  const buttons = controlButtons(projection);
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
            content: `## Input received\n\n${safeMarkdown(
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

function taskUpdateHeadline(significance: TaskChannelProjection["significance"]): string {
  switch (significance) {
    case "final":
      return "## Result";
    case "failure":
      return "## Task needs attention";
    case "question":
      return "## Owner input needed";
    case "decision":
    case "status":
      return "## Task update";
  }
}

export function renderInteractionResult(message: string, success = true): DiscordMessagePayload {
  return Object.freeze({
    flags: DISCORD_COMPONENTS_V2_FLAG,
    components: Object.freeze([
      Object.freeze({
        type: 17 as const,
        accent_color: success ? 0x059669 : 0xdc2626,
        components: Object.freeze([
          Object.freeze({ type: 10 as const, content: safeMarkdown(message, 1_000) }),
        ]),
      }),
    ]),
    allowed_mentions: Object.freeze({ parse: Object.freeze([]) }),
  });
}

function controlButtons(projection: TaskChannelProjection): DiscordActionRow {
  const buttons: DiscordButton[] = [];
  if (projection.approval !== undefined) {
    buttons.push(
      actionButton(
        "Approve",
        3,
        `od:v1:approve:${safeCustomIdSegment(projection.approval.approvalId)}`,
      ),
      actionButton(
        "Reject",
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
        buttons.push(actionButton("Pause", 2, "od:v1:pause"));
        break;
      case "paused":
        buttons.push(actionButton("Resume", 1, "od:v1:resume"));
        break;
      case "failed":
      case "cancelled":
        buttons.push(actionButton("Retry", 1, "od:v1:retry"));
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
    buttons.push(actionButton("Cancel", 4, "od:v1:cancel"));
  }
  buttons.push(...linkButtons(projection).components);
  return Object.freeze({ type: 1 as const, components: Object.freeze(buttons.slice(0, 5)) });
}

function linkButtons(projection: TaskChannelProjection): DiscordActionRow {
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
        label: "Inspect runs",
        url: projection.inspectUrl,
      }),
    );
  }
  return Object.freeze({ type: 1 as const, components: Object.freeze(buttons) });
}

function actionButton(label: string, style: 1 | 2 | 3 | 4, customId: string): DiscordButton {
  return Object.freeze({ type: 2 as const, style, label, custom_id: customId });
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
      !/^[A-Za-z0-9._-]+$/.test(projection.approval.approvalId))
  ) {
    throw invalidProjection();
  }
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
