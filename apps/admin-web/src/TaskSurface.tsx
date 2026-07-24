import {
  CircleAlert,
  CirclePause,
  CirclePlay,
  Ellipsis,
  ListFilter,
  Plus,
  RotateCcw,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  AdminApiError,
  type AdminApi,
  type CreateTaskInput,
  type TaskDetail,
  type TaskState,
  type TaskSummary,
} from "./admin-api";
import { formatAdminDate, formatMessage, type Messages, useAdminI18n } from "./i18n";
import { useMediaQuery } from "./use-media-query";

interface TaskSurfaceProps {
  readonly api: AdminApi;
  readonly discordConfigured?: boolean;
  readonly executionAvailable?: boolean;
}

type TaskFilter = "all" | "active" | "waiting" | "completed";
type TaskMessageKey = keyof Messages["task"];

export function TaskSurface({
  api,
  discordConfigured = false,
  executionAvailable = false,
}: TaskSurfaceProps): React.JSX.Element {
  const { locale, messages } = useAdminI18n();
  const [tasks, setTasks] = useState<readonly TaskSummary[]>([]);
  const [selected, setSelected] = useState<TaskDetail | null>(null);
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [errorKey, setErrorKey] = useState<TaskMessageKey | null>(null);
  const [creating, setCreating] = useState(false);
  const compactInspector = useMediaQuery("(max-width: 819px)");

  async function refresh(preferredTaskId?: string): Promise<void> {
    setLoading(true);
    setErrorKey(null);
    try {
      const nextTasks = await api.listTasks();
      setTasks(nextTasks);
      const targetId = preferredTaskId ?? selected?.taskId ?? nextTasks[0]?.taskId;
      if (targetId === undefined) {
        setSelected(null);
      } else {
        await selectTask(targetId, false);
      }
    } catch (cause) {
      setErrorKey(errorKeyFor(cause, "loadFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function selectTask(taskId: string, showLoading = true): Promise<void> {
    if (showLoading) {
      setDetailLoading(true);
    }
    setErrorKey(null);
    try {
      setSelected(await api.getTask(taskId));
    } catch (cause) {
      setErrorKey(errorKeyFor(cause, "detailsLoadFailed"));
    } finally {
      setDetailLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    void api
      .listTasks()
      .then(async (nextTasks) => {
        if (!active) {
          return;
        }
        setTasks(nextTasks);
        const first = nextTasks[0];
        if (first !== undefined && !compactInspector) {
          const detail = await api.getTask(first.taskId);
          if (active) {
            setSelected(detail);
          }
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setErrorKey(errorKeyFor(cause, "loadFailed"));
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [api, compactInspector]);

  const visibleTasks = useMemo(
    () => tasks.filter((task) => matchesFilter(task, filter)),
    [filter, tasks],
  );

  async function createTask(input: CreateTaskInput): Promise<void> {
    const task = await api.createTask(input);
    setCreating(false);
    await refresh(task.taskId);
  }

  async function command(command: "pause" | "resume" | "cancel" | "retry"): Promise<void> {
    if (selected === null) {
      return;
    }
    setDetailLoading(true);
    setErrorKey(null);
    try {
      const detail = await api.commandTask(selected.taskId, command);
      setSelected(detail);
      setTasks((current) => current.map((task) => (task.taskId === detail.taskId ? detail : task)));
    } catch (cause) {
      setErrorKey(errorKeyFor(cause, "actionFailed"));
    } finally {
      setDetailLoading(false);
    }
  }

  return (
    <main className={`task-main ${selected === null ? "" : "task-main--inspector"}`}>
      <section className="task-workspace">
        <header className="task-header">
          <h1>{messages.task.title}</h1>
          <div className="task-toolbar">
            <button
              aria-description={executionAvailable ? undefined : messages.task.executionUnavailable}
              className="primary-button"
              disabled={!executionAvailable}
              onClick={() => setCreating(true)}
              title={executionAvailable ? undefined : messages.task.executionUnavailable}
              type="button"
            >
              <Plus aria-hidden="true" />
              {messages.task.newTask}
            </button>
            <label className="task-filter">
              <ListFilter aria-hidden="true" />
              <span className="sr-only">{messages.task.filter}</span>
              <select
                aria-label={messages.task.filter}
                onChange={(event) => setFilter(event.currentTarget.value as TaskFilter)}
                value={filter}
              >
                <option value="all">{messages.task.allTasks}</option>
                <option value="active">{messages.task.active}</option>
                <option value="waiting">{messages.task.waitingForYou}</option>
                <option value="completed">{messages.task.completed}</option>
              </select>
            </label>
          </div>
          {!discordConfigured ? (
            <p className="integration-notice">
              <CircleAlert aria-hidden="true" />
              {messages.task.discordNotice}
            </p>
          ) : null}
          {!executionAvailable ? (
            <p className="integration-notice integration-notice--blocked">
              <CircleAlert aria-hidden="true" />
              {messages.task.executionNotice}
            </p>
          ) : null}
        </header>

        <div aria-live="polite" className="task-error">
          {errorKey === null ? null : (
            <>
              <span>{messages.task[errorKey]}</span>
              <button className="text-button" onClick={() => void refresh()} type="button">
                {messages.common.tryAgain}
              </button>
            </>
          )}
        </div>

        {loading ? (
          <div aria-label={messages.task.loading} className="task-loading" role="status">
            {messages.task.loadingProgress}
          </div>
        ) : visibleTasks.length === 0 ? (
          <div className="task-empty">
            <h2>{tasks.length === 0 ? messages.task.noTasks : messages.task.noMatches}</h2>
            <p>
              {tasks.length === 0
                ? executionAvailable
                  ? discordConfigured
                    ? messages.task.emptyDiscord
                    : messages.task.emptyLocal
                  : messages.task.emptyExecution
                : messages.task.emptyFilter}
            </p>
            {tasks.length === 0 ? (
              <button
                aria-description={
                  executionAvailable ? undefined : messages.task.executionUnavailable
                }
                className="secondary-button"
                disabled={!executionAvailable}
                onClick={() => setCreating(true)}
                type="button"
              >
                <Plus aria-hidden="true" />
                {messages.task.createFirst}
              </button>
            ) : null}
          </div>
        ) : (
          <div className="task-table-wrap">
            <table className="task-table">
              <thead>
                <tr>
                  <th scope="col">{messages.task.columnTask}</th>
                  <th scope="col">{messages.task.columnStatus}</th>
                  <th scope="col">{messages.task.columnUpdated}</th>
                  <th className="task-action-column" scope="col">
                    {messages.task.columnActions}
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleTasks.map((task) => (
                  <tr
                    className={selected?.taskId === task.taskId ? "task-row--selected" : undefined}
                    key={task.taskId}
                  >
                    <td>
                      <button
                        className="task-title-button"
                        onClick={() => void selectTask(task.taskId)}
                        type="button"
                      >
                        {task.objective}
                      </button>
                    </td>
                    <td>
                      <TaskStateLabel state={task.state} />
                    </td>
                    <td>
                      <time dateTime={task.updatedAt}>
                        {formatAdminDate(task.updatedAt, locale)}
                      </time>
                    </td>
                    <td>
                      <button
                        aria-label={formatMessage(messages.task.inspect, {
                          objective: task.objective,
                        })}
                        className="icon-button"
                        onClick={() => void selectTask(task.taskId)}
                        type="button"
                      >
                        <Ellipsis aria-hidden="true" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selected !== null ? (
        <TaskInspector
          busy={detailLoading}
          executionAvailable={executionAvailable}
          onClose={() => setSelected(null)}
          onCommand={(taskCommand) => void command(taskCommand)}
          task={selected}
        />
      ) : null}

      {creating && executionAvailable ? (
        <NewTaskDialog
          onClose={() => setCreating(false)}
          onCreated={(input) => createTask(input)}
        />
      ) : null}
    </main>
  );
}

function TaskInspector({
  busy,
  executionAvailable,
  onClose,
  onCommand,
  task,
}: {
  readonly busy: boolean;
  readonly executionAvailable: boolean;
  readonly onClose: () => void;
  readonly onCommand: (command: "pause" | "resume" | "cancel" | "retry") => void;
  readonly task: TaskDetail;
}): React.JSX.Element {
  const { locale, messages } = useAdminI18n();

  return (
    <aside
      aria-label={formatMessage(messages.task.details, { objective: task.objective })}
      className="task-inspector"
    >
      <header>
        <div>
          <TaskStateLabel state={task.state} />
          <h2>{task.objective}</h2>
        </div>
        <button
          aria-label={messages.task.closeDetails}
          className="icon-button"
          onClick={onClose}
          type="button"
        >
          <X aria-hidden="true" />
        </button>
      </header>

      <div className="task-inspector-scroll">
        <DetailBlock title={messages.task.objective}>
          <p>{task.objective}</p>
        </DetailBlock>
        <DetailBlock title={messages.task.completionCriteria}>
          <ul>
            {task.completionCriteria.map((criterion) => (
              <li key={criterion}>{criterion}</li>
            ))}
          </ul>
        </DetailBlock>
        {task.constraints.length > 0 ? (
          <DetailBlock title={messages.task.constraints}>
            <ul>
              {task.constraints.map((constraint) => (
                <li key={constraint}>{constraint}</li>
              ))}
            </ul>
          </DetailBlock>
        ) : null}
        <DetailBlock title={messages.task.eventTimeline}>
          <ol className="event-timeline">
            {task.events.map((event) => (
              <li key={event.eventId}>
                <span aria-hidden="true" />
                <strong>{eventLabel(event.type, messages)}</strong>
                <time dateTime={event.occurredAt}>{formatAdminDate(event.occurredAt, locale)}</time>
              </li>
            ))}
          </ol>
        </DetailBlock>
      </div>

      <div className="task-inspector-actions">
        {task.state === "paused" ? (
          <button
            aria-description={executionAvailable ? undefined : messages.task.executionUnavailable}
            className="secondary-button"
            disabled={busy || !executionAvailable}
            onClick={() => onCommand("resume")}
            title={executionAvailable ? undefined : messages.task.executionUnavailable}
            type="button"
          >
            <CirclePlay aria-hidden="true" />
            {messages.task.resume}
          </button>
        ) : isTerminal(task.state) ? (
          <button
            aria-description={executionAvailable ? undefined : messages.task.executionUnavailable}
            className="secondary-button"
            disabled={busy || !executionAvailable}
            onClick={() => onCommand("retry")}
            title={executionAvailable ? undefined : messages.task.executionUnavailable}
            type="button"
          >
            <RotateCcw aria-hidden="true" />
            {messages.task.retry}
          </button>
        ) : (
          <button
            className="secondary-button"
            disabled={busy}
            onClick={() => onCommand("pause")}
            type="button"
          >
            <CirclePause aria-hidden="true" />
            {messages.task.pause}
          </button>
        )}
        {!isTerminal(task.state) ? (
          <button
            className="danger-button"
            disabled={busy}
            onClick={() => onCommand("cancel")}
            type="button"
          >
            <X aria-hidden="true" />
            {messages.task.cancel}
          </button>
        ) : null}
      </div>
    </aside>
  );
}

function DetailBlock({
  children,
  title,
}: {
  readonly children: React.ReactNode;
  readonly title: string;
}): React.JSX.Element {
  return (
    <section className="task-detail-block">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function NewTaskDialog({
  onClose,
  onCreated,
}: {
  readonly onClose: () => void;
  readonly onCreated: (input: CreateTaskInput) => Promise<void>;
}): React.JSX.Element {
  const { messages } = useAdminI18n();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const objectiveRef = useRef<HTMLTextAreaElement | null>(null);
  const [pending, setPending] = useState(false);
  const [errorKey, setErrorKey] = useState<TaskMessageKey | null>(null);

  useEffect(() => {
    dialogRef.current?.showModal();
    objectiveRef.current?.focus();
  }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const input: CreateTaskInput = {
      objective: String(data.get("objective") ?? "").trim(),
      completionCriteria: lines(String(data.get("completionCriteria") ?? "")),
      constraints: lines(String(data.get("constraints") ?? "")),
      mode: data.get("mode") === "manual" ? "manual" : "auto",
    };
    setPending(true);
    setErrorKey(null);
    try {
      await onCreated(input);
    } catch (cause) {
      setErrorKey(errorKeyFor(cause, "createFailed"));
      setPending(false);
    }
  }

  return (
    <dialog
      aria-labelledby="new-task-heading"
      className="task-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) {
          onClose();
        }
      }}
      ref={dialogRef}
    >
      <header>
        <div>
          <p>{messages.task.dialogEyebrow}</p>
          <h2 id="new-task-heading">{messages.task.dialogTitle}</h2>
        </div>
        <button
          aria-label={messages.task.closeNew}
          className="icon-button"
          disabled={pending}
          onClick={onClose}
          type="button"
        >
          <X aria-hidden="true" />
        </button>
      </header>
      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor="task-objective">{messages.task.objective}</label>
        <textarea
          autoFocus
          id="task-objective"
          maxLength={8192}
          name="objective"
          placeholder={messages.task.objectivePlaceholder}
          ref={objectiveRef}
          required
          rows={4}
        />
        <label htmlFor="task-criteria">{messages.task.completionCriteria}</label>
        <textarea
          id="task-criteria"
          name="completionCriteria"
          placeholder={messages.task.criteriaPlaceholder}
          required
          rows={4}
        />
        <label htmlFor="task-constraints">
          {messages.task.constraints} <span>{messages.task.optionalLines}</span>
        </label>
        <textarea id="task-constraints" name="constraints" rows={3} />
        <label htmlFor="task-mode">{messages.task.mode}</label>
        <select defaultValue="auto" id="task-mode" name="mode">
          <option value="auto">{messages.task.autoMode}</option>
          <option value="manual">{messages.task.manualMode}</option>
        </select>
        <p aria-live="polite" className="form-error" role={errorKey === null ? undefined : "alert"}>
          {errorKey === null ? "" : messages.task[errorKey]}
        </p>
        <div className="task-dialog-actions">
          <button className="secondary-button" disabled={pending} onClick={onClose} type="button">
            {messages.common.cancel}
          </button>
          <button className="primary-button" disabled={pending} type="submit">
            {pending ? messages.task.creating : messages.task.create}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function TaskStateLabel({ state }: { readonly state: TaskState }): React.JSX.Element {
  const { messages } = useAdminI18n();

  return (
    <span className={`task-state task-state--${state}`}>
      <span aria-hidden="true" />
      {stateLabel(state, messages)}
    </span>
  );
}

function stateLabel(state: TaskState, messages: Messages): string {
  const labels: Record<TaskState, keyof Messages["taskState"]> = {
    cancelled: "cancelled",
    completed: "completed",
    failed: "failed",
    intake: "intake",
    paused: "paused",
    queued: "queued",
    review: "review",
    running: "running",
    waiting_resource: "waitingResource",
    waiting_user: "waitingUser",
  };
  return messages.taskState[labels[state]];
}

function matchesFilter(task: TaskSummary, filter: TaskFilter): boolean {
  if (filter === "all") {
    return true;
  }
  if (filter === "waiting") {
    return task.state === "waiting_user";
  }
  if (filter === "completed") {
    return task.state === "completed";
  }
  return !isTerminal(task.state);
}

function isTerminal(state: TaskState): boolean {
  return state === "cancelled" || state === "completed" || state === "failed";
}

function lines(value: string): readonly string[] {
  return [
    ...new Set(
      value
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

function eventLabel(type: string, messages: Messages): string {
  const suffix = type.split(".").at(-1) ?? type;
  const labels: Readonly<Record<string, TaskMessageKey>> = {
    bound: "eventBound",
    cancelled: "eventCancelled",
    "clarification-requested": "eventClarificationRequested",
    "clarification-resolved": "eventClarificationResolved",
    commanded: "eventCommanded",
    completed: "eventCompleted",
    created: "eventCreated",
    failed: "eventFailed",
    "intake-recorded": "eventIntakeRecorded",
    paused: "eventPaused",
    published: "eventPublished",
    queued: "eventQueued",
    recorded: "eventRecorded",
    "review-approved": "eventReviewApproved",
    "review-requested": "eventReviewRequested",
    requested: "eventRequested",
    resumed: "eventResumed",
    review: "eventReview",
    running: "eventRunning",
    "state-changed": "eventStateChanged",
    "synthesis-recorded": "eventSynthesisRecorded",
  };
  const key = labels[suffix];
  return key === undefined
    ? suffix.replaceAll("-", " ").replace(/\b\w/gu, (character) => character.toUpperCase())
    : messages.task[key];
}

function errorKeyFor(cause: unknown, fallback: TaskMessageKey): TaskMessageKey {
  if (cause instanceof AdminApiError) {
    if (cause.status === 401) {
      return "sessionExpired";
    }
  }
  return fallback;
}
