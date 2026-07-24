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
import { useMediaQuery } from "./use-media-query";

interface TaskSurfaceProps {
  readonly api: AdminApi;
  readonly discordConfigured?: boolean;
  readonly executionAvailable?: boolean;
}

type TaskFilter = "all" | "active" | "waiting" | "completed";

export function TaskSurface({
  api,
  discordConfigured = false,
  executionAvailable = false,
}: TaskSurfaceProps): React.JSX.Element {
  const [tasks, setTasks] = useState<readonly TaskSummary[]>([]);
  const [selected, setSelected] = useState<TaskDetail | null>(null);
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const compactInspector = useMediaQuery("(max-width: 819px)");

  async function refresh(preferredTaskId?: string): Promise<void> {
    setLoading(true);
    setError(null);
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
      setError(messageFor(cause, "Tasks could not be loaded."));
    } finally {
      setLoading(false);
    }
  }

  async function selectTask(taskId: string, showLoading = true): Promise<void> {
    if (showLoading) {
      setDetailLoading(true);
    }
    setError(null);
    try {
      setSelected(await api.getTask(taskId));
    } catch (cause) {
      setError(messageFor(cause, "The Task details could not be loaded."));
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
          setError(messageFor(cause, "Tasks could not be loaded."));
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
    setError(null);
    try {
      const detail = await api.commandTask(selected.taskId, command);
      setSelected(detail);
      setTasks((current) => current.map((task) => (task.taskId === detail.taskId ? detail : task)));
    } catch (cause) {
      setError(messageFor(cause, "The Task action could not be completed."));
    } finally {
      setDetailLoading(false);
    }
  }

  return (
    <main className={`task-main ${selected === null ? "" : "task-main--inspector"}`}>
      <section className="task-workspace">
        <header className="task-header">
          <h1>Tasks</h1>
          <div className="task-toolbar">
            <button
              className="primary-button"
              disabled={!executionAvailable}
              onClick={() => setCreating(true)}
              title={
                executionAvailable ? undefined : "Task execution is not connected in this build."
              }
              type="button"
            >
              <Plus aria-hidden="true" />
              New task
            </button>
            <label className="task-filter">
              <ListFilter aria-hidden="true" />
              <span className="sr-only">Filter Tasks</span>
              <select
                aria-label="Filter Tasks"
                onChange={(event) => setFilter(event.currentTarget.value as TaskFilter)}
                value={filter}
              >
                <option value="all">All tasks</option>
                <option value="active">Active</option>
                <option value="waiting">Waiting for you</option>
                <option value="completed">Completed</option>
              </select>
            </label>
          </div>
          {!discordConfigured ? (
            <p className="integration-notice">
              <CircleAlert aria-hidden="true" />
              Discord is not configured. Task control remains available here.
            </p>
          ) : null}
          {!executionAvailable ? (
            <p className="integration-notice integration-notice--blocked">
              <CircleAlert aria-hidden="true" />
              Agent execution is not connected. Existing Task records remain inspectable, but new
              work cannot start.
            </p>
          ) : null}
        </header>

        <div aria-live="polite" className="task-error">
          {error === null ? null : (
            <>
              <span>{error}</span>
              <button className="text-button" onClick={() => void refresh()} type="button">
                Try again
              </button>
            </>
          )}
        </div>

        {loading ? (
          <div aria-label="Loading Tasks" className="task-loading" role="status">
            Loading Tasks…
          </div>
        ) : visibleTasks.length === 0 ? (
          <div className="task-empty">
            <h2>{tasks.length === 0 ? "No Tasks yet" : "No Tasks match this filter"}</h2>
            <p>
              {tasks.length === 0
                ? executionAvailable
                  ? discordConfigured
                    ? "Create a Task here or from the configured Discord Forum."
                    : "Create a Task here. Discord intake is not configured."
                  : "Task execution must be connected before new work can start."
                : "Choose another filter to see the remaining Tasks."}
            </p>
            {tasks.length === 0 ? (
              <button
                className="secondary-button"
                disabled={!executionAvailable}
                onClick={() => setCreating(true)}
                type="button"
              >
                <Plus aria-hidden="true" />
                Create the first Task
              </button>
            ) : null}
          </div>
        ) : (
          <div className="task-table-wrap">
            <table className="task-table">
              <thead>
                <tr>
                  <th scope="col">Task</th>
                  <th scope="col">Status</th>
                  <th scope="col">Updated</th>
                  <th className="task-action-column" scope="col">
                    Actions
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
                      <time dateTime={task.updatedAt}>{formatDate(task.updatedAt)}</time>
                    </td>
                    <td>
                      <button
                        aria-label={`Inspect ${task.objective}`}
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
  return (
    <aside aria-label={`Task details: ${task.objective}`} className="task-inspector">
      <header>
        <div>
          <TaskStateLabel state={task.state} />
          <h2>{task.objective}</h2>
        </div>
        <button
          aria-label="Close Task details"
          className="icon-button"
          onClick={onClose}
          type="button"
        >
          <X aria-hidden="true" />
        </button>
      </header>

      <div className="task-inspector-scroll">
        <DetailBlock title="Objective">
          <p>{task.objective}</p>
        </DetailBlock>
        <DetailBlock title="Completion criteria">
          <ul>
            {task.completionCriteria.map((criterion) => (
              <li key={criterion}>{criterion}</li>
            ))}
          </ul>
        </DetailBlock>
        {task.constraints.length > 0 ? (
          <DetailBlock title="Constraints">
            <ul>
              {task.constraints.map((constraint) => (
                <li key={constraint}>{constraint}</li>
              ))}
            </ul>
          </DetailBlock>
        ) : null}
        <DetailBlock title="Event timeline">
          <ol className="event-timeline">
            {task.events.map((event) => (
              <li key={event.eventId}>
                <span aria-hidden="true" />
                <strong>{eventLabel(event.type)}</strong>
                <time dateTime={event.occurredAt}>{formatDate(event.occurredAt)}</time>
              </li>
            ))}
          </ol>
        </DetailBlock>
      </div>

      <div className="task-inspector-actions">
        {task.state === "paused" ? (
          <button
            className="secondary-button"
            disabled={busy || !executionAvailable}
            onClick={() => onCommand("resume")}
            title={
              executionAvailable ? undefined : "Task execution is not connected in this build."
            }
            type="button"
          >
            <CirclePlay aria-hidden="true" />
            Resume
          </button>
        ) : isTerminal(task.state) ? (
          <button
            className="secondary-button"
            disabled={busy || !executionAvailable}
            onClick={() => onCommand("retry")}
            title={
              executionAvailable ? undefined : "Task execution is not connected in this build."
            }
            type="button"
          >
            <RotateCcw aria-hidden="true" />
            Retry
          </button>
        ) : (
          <button
            className="secondary-button"
            disabled={busy}
            onClick={() => onCommand("pause")}
            type="button"
          >
            <CirclePause aria-hidden="true" />
            Pause
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
            Cancel
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
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const objectiveRef = useRef<HTMLTextAreaElement | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    setError(null);
    try {
      await onCreated(input);
    } catch (cause) {
      setError(messageFor(cause, "The Task could not be created."));
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
          <p>New Task</p>
          <h2 id="new-task-heading">What should OpenDelegate accomplish?</h2>
        </div>
        <button
          aria-label="Close new Task"
          className="icon-button"
          disabled={pending}
          onClick={onClose}
          type="button"
        >
          <X aria-hidden="true" />
        </button>
      </header>
      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor="task-objective">Objective</label>
        <textarea
          autoFocus
          id="task-objective"
          maxLength={8192}
          name="objective"
          placeholder="Describe the outcome, not just the first step."
          ref={objectiveRef}
          required
          rows={4}
        />
        <label htmlFor="task-criteria">Completion criteria</label>
        <textarea
          id="task-criteria"
          name="completionCriteria"
          placeholder={"One verifiable result per line\nFor example: All tests pass"}
          required
          rows={4}
        />
        <label htmlFor="task-constraints">
          Constraints <span>Optional, one per line</span>
        </label>
        <textarea id="task-constraints" name="constraints" rows={3} />
        <label htmlFor="task-mode">Mode</label>
        <select defaultValue="auto" id="task-mode" name="mode">
          <option value="auto">Auto — continue within policy</option>
          <option value="manual">Manual — wait between delegated steps</option>
        </select>
        <p aria-live="polite" className="form-error" role={error === null ? undefined : "alert"}>
          {error ?? ""}
        </p>
        <div className="task-dialog-actions">
          <button className="secondary-button" disabled={pending} onClick={onClose} type="button">
            Cancel
          </button>
          <button className="primary-button" disabled={pending} type="submit">
            {pending ? "Creating…" : "Create Task"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function TaskStateLabel({ state }: { readonly state: TaskState }): React.JSX.Element {
  return (
    <span className={`task-state task-state--${state}`}>
      <span aria-hidden="true" />
      {stateLabel(state)}
    </span>
  );
}

function stateLabel(state: TaskState): string {
  const labels: Record<TaskState, string> = {
    cancelled: "Cancelled",
    completed: "Completed",
    failed: "Failed",
    intake: "Intake",
    paused: "Paused",
    queued: "Queued",
    review: "In review",
    running: "Running",
    waiting_resource: "Waiting for resource",
    waiting_user: "Waiting for you",
  };
  return labels[state];
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

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return value;
  }
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function eventLabel(type: string): string {
  return type
    .split(".")
    .at(-1)!
    .replaceAll("-", " ")
    .replace(/\b\w/gu, (character) => character.toUpperCase());
}

function messageFor(cause: unknown, fallback: string): string {
  if (cause instanceof AdminApiError) {
    if (cause.status === 401) {
      return "Your owner session expired. Reload to sign in again.";
    }
    return cause.message;
  }
  return fallback;
}
