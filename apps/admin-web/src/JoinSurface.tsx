import { Check, Clipboard, Download, KeyRound, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import type {
  AdminApi,
  DeviceEnrollmentOverview,
  EnrollmentGrantStatus,
  IssueEnrollmentGrantResult,
} from "./admin-api";
import { formatAdminDate, useAdminI18n } from "./i18n";

export type JoinSurfaceApi = Pick<AdminApi, "deviceEnrollment" | "issueEnrollmentGrant">;

export function JoinSurface({ api }: { readonly api: JoinSurfaceApi }): React.JSX.Element {
  const { locale, messages } = useAdminI18n();
  const [overview, setOverview] = useState<DeviceEnrollmentOverview | null>(null);
  const [issued, setIssued] = useState<IssueEnrollmentGrantResult | null>(null);
  const [deviceId, setDeviceId] = useState("");
  const [expiresInSeconds, setExpiresInSeconds] = useState(300);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [issuanceFailed, setIssuanceFailed] = useState(false);
  const [copied, setCopied] = useState(false);

  async function load(): Promise<void> {
    setLoading(true);
    setLoadFailed(false);
    try {
      setOverview(await api.deviceEnrollment());
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    void api
      .deviceEnrollment()
      .then((next) => {
        if (active) {
          setOverview(next);
        }
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
  }, [api]);

  async function issue(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const normalizedDeviceId = deviceId.trim();
    if (normalizedDeviceId === "") {
      return;
    }
    setIssuing(true);
    setIssuanceFailed(false);
    setCopied(false);
    try {
      const next = await api.issueEnrollmentGrant({
        deviceId: normalizedDeviceId,
        expiresInSeconds,
      });
      setIssued(next);
      setOverview((current) =>
        current === null
          ? current
          : {
              ...current,
              grants: [
                next.summary,
                ...current.grants.filter((grant) => grant.grantId !== next.summary.grantId),
              ],
            },
      );
    } catch {
      setIssuanceFailed(true);
    } finally {
      setIssuing(false);
    }
  }

  const joinCommand = useMemo(
    () =>
      issued === null
        ? ""
        : `opendelegate worker join --grant-file <absolute-path-to/${issued.suggestedFilename}>`,
    [issued],
  );

  async function copyCommand(): Promise<void> {
    if (joinCommand === "") {
      return;
    }
    try {
      await navigator.clipboard.writeText(joinCommand);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <main className="operations-main join-surface">
      <header className="operations-header">
        <div>
          <p className="surface-eyebrow">{messages.join.eyebrow}</p>
          <h1>{messages.join.title}</h1>
          <p>{messages.join.intro}</p>
        </div>
        <button
          aria-label={messages.common.tryAgain}
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
          <p>{messages.join.loadFailed}</p>
          <button className="secondary-button" onClick={() => void load()} type="button">
            {messages.common.tryAgain}
          </button>
        </div>
      ) : loading ? (
        <div aria-label={messages.startup.connecting} className="surface-loading" role="status">
          <span aria-hidden="true" className="startup-spinner" />
        </div>
      ) : overview?.available === false ? (
        <div className="surface-empty">
          <KeyRound aria-hidden="true" />
          <p>{messages.join.unavailable}</p>
        </div>
      ) : (
        <div className="join-layout">
          <section className="operations-card join-form-card">
            <div className="card-heading">
              <ShieldCheck aria-hidden="true" />
              <h2>{messages.join.stepsTitle}</h2>
            </div>
            <ol className="join-steps">
              <li>{messages.join.stepOne}</li>
              <li>{messages.join.stepTwo}</li>
              <li>{messages.join.stepThree}</li>
            </ol>
            <form className="join-form" onSubmit={(event) => void issue(event)}>
              <label htmlFor="join-device-id">{messages.join.deviceId}</label>
              <input
                aria-describedby="join-device-id-hint"
                autoComplete="off"
                id="join-device-id"
                maxLength={160}
                onChange={(event) => setDeviceId(event.target.value)}
                pattern="[A-Za-z0-9](?:[A-Za-z0-9._]|-)*"
                required
                spellCheck="false"
                value={deviceId}
              />
              <small id="join-device-id-hint">{messages.join.deviceIdHint}</small>
              <label htmlFor="join-expiry">{messages.join.expiry}</label>
              <select
                id="join-expiry"
                onChange={(event) => setExpiresInSeconds(Number(event.target.value))}
                value={expiresInSeconds}
              >
                <option value={300}>{messages.join.fiveMinutes}</option>
                <option value={900}>{messages.join.fifteenMinutes}</option>
                <option value={1800}>{messages.join.thirtyMinutes}</option>
              </select>
              {issuanceFailed ? (
                <p className="form-error" role="alert">
                  {messages.join.issuanceFailed}
                </p>
              ) : null}
              <button className="primary-button" disabled={issuing} type="submit">
                <KeyRound aria-hidden="true" />
                {issuing ? messages.join.generating : messages.join.generate}
              </button>
            </form>
          </section>

          {issued !== null ? (
            <section className="operations-card grant-ready" aria-live="polite">
              <div className="grant-ready-title">
                <span className="success-icon">
                  <Check aria-hidden="true" />
                </span>
                <div>
                  <h2>{messages.join.readyTitle}</h2>
                  <p>{messages.join.readyDetail}</p>
                </div>
              </div>
              <p className="credential-warning">
                <KeyRound aria-hidden="true" />
                <span>{messages.join.credentialWarning}</span>
              </p>
              <dl className="metadata-grid">
                <div>
                  <dt>{messages.join.expires}</dt>
                  <dd>{formatAdminDate(issued.summary.expiresAt, locale)}</dd>
                </div>
                <div>
                  <dt>{messages.join.fingerprint}</dt>
                  <dd className="code-value">{issued.document.expectedMainSpkiSha256}</dd>
                </div>
                <div className="metadata-grid--wide">
                  <dt>{messages.join.endpoints}</dt>
                  <dd>
                    {issued.document.channelEndpoints.map((endpoint) => (
                      <code key={endpoint.endpointId}>{endpoint.url}</code>
                    ))}
                  </dd>
                </div>
              </dl>
              <button
                className="primary-button"
                onClick={() => downloadEnrollmentGrant(issued)}
                type="button"
              >
                <Download aria-hidden="true" />
                {messages.join.download}
              </button>
              <div className="command-block">
                <span>{messages.join.joinCommand}</span>
                <code>{joinCommand}</code>
                <button
                  className="secondary-button"
                  onClick={() => void copyCommand()}
                  type="button"
                >
                  {copied ? <Check aria-hidden="true" /> : <Clipboard aria-hidden="true" />}
                  {copied ? messages.join.copyDone : messages.join.copyCommand}
                </button>
              </div>
            </section>
          ) : null}

          <section className="operations-card recent-grants">
            <h2>{messages.join.recent}</h2>
            {overview?.grants.length === 0 ? (
              <p className="muted-copy">{messages.join.none}</p>
            ) : (
              <ul className="grant-list">
                {overview?.grants.map((grant) => (
                  <li key={grant.grantId}>
                    <div>
                      <strong>{grant.deviceId}</strong>
                      <span>{formatAdminDate(grant.expiresAt, locale)}</span>
                    </div>
                    <span className={`state-pill state-pill--${grant.status}`}>
                      {grantStatusLabel(grant.status, messages.join)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </main>
  );
}

export function downloadEnrollmentGrant(result: IssueEnrollmentGrantResult): void {
  const bytes = `${JSON.stringify(result.document, undefined, 2)}\n`;
  const objectUrl = URL.createObjectURL(new Blob([bytes], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.download = result.suggestedFilename;
  anchor.href = objectUrl;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}

function grantStatusLabel(
  status: EnrollmentGrantStatus,
  messages: {
    readonly statusActive: string;
    readonly statusConsumed: string;
    readonly statusExpired: string;
    readonly statusRevoked: string;
  },
): string {
  return {
    active: messages.statusActive,
    consumed: messages.statusConsumed,
    expired: messages.statusExpired,
    revoked: messages.statusRevoked,
  }[status];
}
