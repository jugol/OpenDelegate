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
    `## ${safeMarkdown(projection.objective, 180)}`,
    `**${STATUS_LABELS[status]}**`,
    safeMarkdown(projection.summary, 1_500),
  ];
  if (projection.progress !== undefined) {
    detailLines.push(
      `Progress: ${projection.progress.completed.toString()}/${projection.progress.total.toString()}`,
    );
  }
  if (projection.approval !== undefined) {
    detailLines.push(`Approval needed: ${safeMarkdown(projection.approval.description, 500)}`);
  }
  const actions = controlButtons(projection);
  const containerComponents: DiscordContainer["components"] = Object.freeze([
    Object.freeze({ type: 10 as const, content: detailLines.join("\n\n") }),
    ...(actions.components.length === 0
      ? []
      : [Object.freeze({ type: 14 as const, divider: true, spacing: 1 as const }), actions]),
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

export function renderTaskUpdate(projection: TaskChannelProjection): DiscordMessagePayload {
  validateProjection(projection);
  const status = workflowStatusForTaskState(projection.state);
  const headline =
    projection.significance === "final"
      ? "## Result"
      : projection.significance === "failure"
        ? "## Task needs attention"
        : projection.significance === "question"
          ? "## Owner input needed"
          : "## Task update";
  const buttons = linkButtons(projection);
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
  if (projection.state !== "completed" && projection.state !== "cancelled") {
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
