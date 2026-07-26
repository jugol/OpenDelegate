import { ExternalLink, FileArchive, RefreshCw, ShieldCheck, X } from "lucide-react";
import { useEffect, useState } from "react";

import type { AdminApi, ArtifactDetail, ArtifactOpenInstruction } from "./admin-api";
import {
  formatAdminDate,
  formatMessage,
  localizeArtifactExposure,
  localizeArtifactPresentation,
  useAdminI18n,
} from "./i18n";

export type ArtifactSurfaceApi = Pick<AdminApi, "listArtifacts" | "getArtifact" | "openArtifact">;

export function ArtifactSurface({
  api,
  initialArtifactId,
}: {
  readonly api: ArtifactSurfaceApi;
  readonly initialArtifactId?: string;
}): React.JSX.Element {
  const { locale, messages } = useAdminI18n();
  const [artifacts, setArtifacts] = useState<readonly ArtifactDetail[]>([]);
  const [selected, setSelected] = useState<ArtifactDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [opening, setOpening] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);

  async function load(): Promise<void> {
    setLoading(true);
    setLoadFailed(false);
    try {
      const next = sortArtifacts(await api.listArtifacts());
      setArtifacts(next);
      setSelected((current) => {
        if (current === null) {
          return next[0] ?? null;
        }
        return (
          next.find((artifact) => artifact.artifactId === current.artifactId) ?? next[0] ?? null
        );
      });
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    void api
      .listArtifacts()
      .then((nextArtifacts) => {
        if (!active) {
          return;
        }
        const next = sortArtifacts(nextArtifacts);
        setArtifacts(next);
        setSelected(
          next.find((artifact) => artifact.artifactId === initialArtifactId) ?? next[0] ?? null,
        );
      })
      .catch(() => {
        if (active) {
          setLoadFailed(true);
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
  }, [api, initialArtifactId]);

  async function selectArtifact(artifactId: string): Promise<void> {
    setLoadFailed(false);
    try {
      setSelected(await api.getArtifact(artifactId));
    } catch {
      setLoadFailed(true);
    }
  }

  async function openSelected(): Promise<void> {
    if (selected === null || selected.state !== "available") {
      return;
    }
    setOpening(true);
    setOpenFailed(false);
    try {
      openArtifactInstruction(await api.openArtifact(selected.artifactId));
    } catch {
      setOpenFailed(true);
    } finally {
      setOpening(false);
    }
  }

  return (
    <main className="operations-main artifact-surface">
      <header className="operations-header">
        <div>
          <p className="surface-eyebrow">{messages.artifact.eyebrow}</p>
          <h1>{messages.artifact.title}</h1>
          <p>{messages.artifact.intro}</p>
        </div>
        <button
          aria-label={messages.artifact.refresh}
          className="icon-button"
          disabled={loading}
          onClick={() => void load()}
          type="button"
        >
          <RefreshCw aria-hidden="true" />
        </button>
      </header>

      {loadFailed ? (
        <div className="surface-alert surface-alert--error" role="alert">
          <p>{messages.artifact.loadFailed}</p>
          <button className="secondary-button" onClick={() => void load()} type="button">
            {messages.common.tryAgain}
          </button>
        </div>
      ) : null}

      {loading ? (
        <div className="surface-loading" role="status">
          <span aria-hidden="true" className="startup-spinner" />
          <span>{messages.artifact.loading}</span>
        </div>
      ) : artifacts.length === 0 ? (
        <section className="surface-empty">
          <FileArchive aria-hidden="true" />
          <h2>{messages.artifact.noArtifacts}</h2>
          <p>{messages.artifact.noArtifactsDetail}</p>
        </section>
      ) : (
        <div className="artifact-layout">
          <section aria-label={messages.artifact.title} className="artifact-list">
            {artifacts.map((artifact) => (
              <button
                aria-current={selected?.artifactId === artifact.artifactId ? "true" : undefined}
                className={`artifact-card ${
                  selected?.artifactId === artifact.artifactId ? "artifact-card--selected" : ""
                }`}
                key={artifact.artifactId}
                onClick={() => void selectArtifact(artifact.artifactId)}
                type="button"
              >
                <FileArchive aria-hidden="true" />
                <span>
                  <strong>{artifact.originalFilename}</strong>
                  <small>{artifact.mediaType}</small>
                </span>
                <span className={`state-pill state-pill--${artifact.state}`}>
                  {artifactStateLabel(artifact.state, messages.artifact)}
                </span>
              </button>
            ))}
          </section>

          {selected !== null ? (
            <aside
              aria-label={formatMessage(messages.artifact.details, {
                filename: selected.originalFilename,
              })}
              className="artifact-inspector"
            >
              <header className="inspector-header">
                <div>
                  <p className="surface-eyebrow">{selected.mediaType}</p>
                  <h2>{selected.originalFilename}</h2>
                </div>
                <button
                  aria-label={messages.artifact.closeDetails}
                  className="icon-button artifact-inspector-close"
                  onClick={() => setSelected(null)}
                  type="button"
                >
                  <X aria-hidden="true" />
                </button>
              </header>
              <p className="isolated-origin-notice">
                <ShieldCheck aria-hidden="true" />
                <span>{messages.artifact.isolatedNotice}</span>
              </p>
              <dl className="metadata-grid artifact-metadata">
                <Metadata label={messages.artifact.state}>
                  {artifactStateLabel(selected.state, messages.artifact)}
                </Metadata>
                <Metadata label={messages.artifact.size}>
                  {formatBytes(selected.sizeBytes, locale)}
                </Metadata>
                <Metadata label={messages.artifact.mediaType}>{selected.mediaType}</Metadata>
                <Metadata label={messages.artifact.created}>
                  {formatAdminDate(selected.createdAt, locale)}
                </Metadata>
                <Metadata label={messages.artifact.task}>{selected.taskId}</Metadata>
                <Metadata label={messages.artifact.run}>{selected.producingRunId}</Metadata>
                <Metadata label={messages.artifact.device}>{selected.provenance.deviceId}</Metadata>
                <Metadata label={messages.artifact.source}>{selected.provenance.source}</Metadata>
                {selected.provenance.workspaceId === undefined ? null : (
                  <Metadata label={messages.artifact.workspace}>
                    {selected.provenance.workspaceId}
                  </Metadata>
                )}
                <Metadata label={messages.artifact.retention}>
                  {retentionLabel(selected, locale, messages.artifact)}
                </Metadata>
                <Metadata label={messages.artifact.exposure}>
                  {localizeArtifactExposure(selected.exposurePolicy.mode, messages)}
                </Metadata>
                <Metadata label={messages.artifact.presentation}>
                  {localizeArtifactPresentation(selected.presentation, messages)}
                </Metadata>
                <div className="metadata-grid--wide">
                  <dt>{messages.artifact.checksum}</dt>
                  <dd className="code-value">{selected.checksum.value}</dd>
                </div>
              </dl>
              {openFailed ? (
                <p className="form-error" role="alert">
                  {messages.artifact.openFailed}
                </p>
              ) : null}
              <button
                className="primary-button"
                disabled={opening || selected.state !== "available"}
                onClick={() => void openSelected()}
                type="button"
              >
                <ExternalLink aria-hidden="true" />
                {selected.state !== "available"
                  ? messages.artifact.unavailable
                  : opening
                    ? messages.artifact.opening
                    : messages.artifact.open}
              </button>
            </aside>
          ) : null}
        </div>
      )}
    </main>
  );
}

function Metadata({
  children,
  label,
}: {
  readonly children: React.ReactNode;
  readonly label: string;
}): React.JSX.Element {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function openArtifactInstruction(instruction: ArtifactOpenInstruction): void {
  if (instruction.method === "GET") {
    const anchor = document.createElement("a");
    anchor.href = instruction.href;
    anchor.rel = "noopener noreferrer";
    anchor.target = "_blank";
    anchor.click();
    return;
  }

  const form = document.createElement("form");
  form.action = instruction.actionUrl;
  form.method = "post";
  form.target = "_blank";
  form.rel = "noopener noreferrer";
  const grant = document.createElement("input");
  grant.name = instruction.fieldName;
  grant.type = "hidden";
  grant.value = instruction.fieldValue;
  form.append(grant);
  document.body.append(form);
  form.submit();
  form.remove();
  grant.value = "";
}

function sortArtifacts(artifacts: readonly ArtifactDetail[]): readonly ArtifactDetail[] {
  return [...artifacts].sort(
    (left, right) =>
      Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
      left.artifactId.localeCompare(right.artifactId),
  );
}

function formatBytes(sizeBytes: number, locale: string): string {
  if (sizeBytes < 1_024) {
    return `${new Intl.NumberFormat(locale).format(sizeBytes)} B`;
  }
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = sizeBytes / 1_024;
  let unit = units[0]!;
  for (let index = 1; value >= 1_024 && index < units.length; index += 1) {
    value /= 1_024;
    unit = units[index]!;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)} ${unit}`;
}

function artifactStateLabel(
  state: ArtifactDetail["state"],
  messages: {
    readonly stateAvailable: string;
    readonly stateExpired: string;
    readonly stateRevoked: string;
  },
): string {
  return {
    available: messages.stateAvailable,
    expired: messages.stateExpired,
    revoked: messages.stateRevoked,
  }[state];
}

function retentionLabel(
  artifact: ArtifactDetail,
  locale: Parameters<typeof formatAdminDate>[1],
  messages: {
    readonly retentionTemporary: string;
    readonly retentionTask: string;
    readonly retentionPinned: string;
  },
): string {
  switch (artifact.retentionPolicy.kind) {
    case "temporary":
      return formatMessage(messages.retentionTemporary, {
        date: formatAdminDate(artifact.retentionPolicy.expiresAt, locale),
      });
    case "task":
      return messages.retentionTask;
    case "pinned":
      return messages.retentionPinned;
  }
}
