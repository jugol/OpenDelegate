import { Network } from "lucide-react";
import { useState } from "react";

import { AdminApiError, type AdminApi, type RecoveryResult } from "./admin-api";

interface LoginScreenProps {
  readonly api: AdminApi;
  readonly onAuthenticated: () => void;
}

export function LoginScreen({ api, onAuthenticated }: LoginScreenProps): React.JSX.Element {
  const [mode, setMode] = useState<"login" | "recovery">("login");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveryResult, setRecoveryResult] = useState<RecoveryResult | null>(null);

  async function submitLogin(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const passphrase = String(data.get("passphrase") ?? "");
    setPending(true);
    setError(null);
    try {
      await api.login(passphrase);
      onAuthenticated();
    } catch (cause) {
      setError(messageFor(cause, "The owner passphrase was not accepted."));
    } finally {
      setPending(false);
    }
  }

  async function submitRecovery(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const recoveryCode = String(data.get("recoveryCode") ?? "");
    const newPassphrase = String(data.get("newPassphrase") ?? "");
    const confirmation = String(data.get("passphraseConfirmation") ?? "");
    if (newPassphrase !== confirmation) {
      setError("The new passphrases do not match.");
      return;
    }

    setPending(true);
    setError(null);
    try {
      const challenge = await api.beginRecovery(recoveryCode);
      setRecoveryResult(await api.completeRecovery(challenge.recoveryToken, newPassphrase));
    } catch (cause) {
      setError(messageFor(cause, "Recovery could not be completed with that code."));
    } finally {
      setPending(false);
    }
  }

  function returnToLogin(): void {
    setMode("login");
    setRecoveryResult(null);
    setError(null);
  }

  return (
    <div className="auth-layout">
      <aside className="auth-brand">
        <Network aria-hidden="true" />
        <span>OpenDelegate</span>
      </aside>
      <main className="auth-main">
        <section aria-labelledby="auth-heading" className="auth-card">
          <p className="auth-release-note">
            Pre-release software · No supported release is published.
          </p>
          {recoveryResult === null ? (
            mode === "login" ? (
              <>
                <h1 id="auth-heading">Sign in to OpenDelegate</h1>
                <p className="auth-intro">Use the owner passphrase created on this Main.</p>
                <form className="auth-form" onSubmit={(event) => void submitLogin(event)}>
                  <label htmlFor="owner-passphrase">Owner passphrase</label>
                  <input
                    autoComplete="current-password"
                    autoFocus
                    disabled={pending}
                    id="owner-passphrase"
                    minLength={12}
                    name="passphrase"
                    required
                    type="password"
                  />
                  <FormError message={error} />
                  <button className="primary-button auth-submit" disabled={pending} type="submit">
                    {pending ? "Signing in…" : "Sign in"}
                  </button>
                </form>
                <div aria-hidden="true" className="auth-divider">
                  <span />
                  <span>or</span>
                  <span />
                </div>
                <button
                  className="auth-link"
                  disabled={pending}
                  onClick={() => {
                    setMode("recovery");
                    setError(null);
                  }}
                  type="button"
                >
                  Use a recovery code
                </button>
                <p className="auth-footnote">Discord is not required for Admin recovery.</p>
              </>
            ) : (
              <>
                <h1 id="auth-heading">Recover owner access</h1>
                <p className="auth-intro">
                  A recovery code is single-use. Completing recovery signs out every browser.
                </p>
                <form className="auth-form" onSubmit={(event) => void submitRecovery(event)}>
                  <label htmlFor="recovery-code">Recovery code</label>
                  <input
                    autoComplete="off"
                    autoFocus
                    disabled={pending}
                    id="recovery-code"
                    name="recoveryCode"
                    pattern="odr_[A-Za-z0-9_-]{22}"
                    placeholder="odr_…"
                    required
                    spellCheck={false}
                    type="text"
                  />
                  <label htmlFor="new-owner-passphrase">New owner passphrase</label>
                  <input
                    autoComplete="new-password"
                    disabled={pending}
                    id="new-owner-passphrase"
                    minLength={12}
                    name="newPassphrase"
                    required
                    type="password"
                  />
                  <label htmlFor="confirm-owner-passphrase">Confirm new passphrase</label>
                  <input
                    autoComplete="new-password"
                    disabled={pending}
                    id="confirm-owner-passphrase"
                    minLength={12}
                    name="passphraseConfirmation"
                    required
                    type="password"
                  />
                  <FormError message={error} />
                  <button className="primary-button auth-submit" disabled={pending} type="submit">
                    {pending ? "Recovering…" : "Recover access"}
                  </button>
                </form>
                <button
                  className="auth-link auth-link--back"
                  disabled={pending}
                  onClick={returnToLogin}
                  type="button"
                >
                  Back to sign in
                </button>
              </>
            )
          ) : (
            <>
              <h1 id="auth-heading">Save your new recovery codes</h1>
              <p className="auth-intro">
                These codes are shown once. Store them outside this Main before continuing.
              </p>
              <ol aria-label="New recovery codes" className="recovery-codes">
                {recoveryResult.recoveryCodes.map((code) => (
                  <li key={code}>
                    <code>{code}</code>
                  </li>
                ))}
              </ol>
              <button className="primary-button auth-submit" onClick={returnToLogin} type="button">
                I saved the codes
              </button>
            </>
          )}
        </section>
        <footer>Personal, self-hosted control plane</footer>
      </main>
    </div>
  );
}

function FormError({ message }: { readonly message: string | null }): React.JSX.Element {
  return (
    <p aria-live="polite" className="form-error" role={message === null ? undefined : "alert"}>
      {message ?? ""}
    </p>
  );
}

function messageFor(cause: unknown, fallback: string): string {
  if (cause instanceof AdminApiError) {
    if (cause.status >= 500) {
      return "OpenDelegate Main is not ready. Try again after checking its service status.";
    }
    return cause.message;
  }
  return fallback;
}
