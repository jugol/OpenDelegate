import { Network } from "lucide-react";
import { useState } from "react";

import { AdminApiError, type AdminApi, type RecoveryResult } from "./admin-api";
import { type Messages, useAdminI18n } from "./i18n";
import { LanguageSelector } from "./LanguageSelector";

type AuthMessageKey = keyof Messages["auth"];

interface LoginScreenProps {
  readonly api: AdminApi;
  readonly onAuthenticated: () => void;
}

export function LoginScreen({ api, onAuthenticated }: LoginScreenProps): React.JSX.Element {
  const { messages } = useAdminI18n();
  const [mode, setMode] = useState<"login" | "recovery">("login");
  const [pending, setPending] = useState(false);
  const [errorKey, setErrorKey] = useState<AuthMessageKey | null>(null);
  const [recoveryResult, setRecoveryResult] = useState<RecoveryResult | null>(null);

  async function submitLogin(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const passphrase = String(data.get("passphrase") ?? "");
    setPending(true);
    setErrorKey(null);
    try {
      await api.login(passphrase);
      onAuthenticated();
    } catch (cause) {
      setErrorKey(messageKeyFor(cause, "passphraseRejected"));
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
      setErrorKey("passphraseMismatch");
      return;
    }

    setPending(true);
    setErrorKey(null);
    try {
      const challenge = await api.beginRecovery(recoveryCode);
      setRecoveryResult(await api.completeRecovery(challenge.recoveryToken, newPassphrase));
    } catch (cause) {
      setErrorKey(messageKeyFor(cause, "recoveryFailed"));
    } finally {
      setPending(false);
    }
  }

  function returnToLogin(): void {
    setMode("login");
    setRecoveryResult(null);
    setErrorKey(null);
  }

  return (
    <div className="auth-layout">
      <aside className="auth-brand">
        <Network aria-hidden="true" />
        <span>OpenDelegate</span>
      </aside>
      <main className="auth-main">
        <LanguageSelector placement="utility" />
        <section aria-labelledby="auth-heading" className="auth-card">
          <p className="auth-release-note">{messages.auth.releaseNote}</p>
          {recoveryResult === null ? (
            mode === "login" ? (
              <>
                <h1 id="auth-heading">{messages.auth.signInTitle}</h1>
                <p className="auth-intro">{messages.auth.signInIntro}</p>
                <form className="auth-form" onSubmit={(event) => void submitLogin(event)}>
                  <label htmlFor="owner-passphrase">{messages.auth.ownerPassphrase}</label>
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
                  <FormError message={errorKey === null ? null : messages.auth[errorKey]} />
                  <button className="primary-button auth-submit" disabled={pending} type="submit">
                    {pending ? messages.auth.signingIn : messages.auth.signIn}
                  </button>
                </form>
                <div aria-hidden="true" className="auth-divider">
                  <span />
                  <span>{messages.auth.or}</span>
                  <span />
                </div>
                <button
                  className="auth-link"
                  disabled={pending}
                  onClick={() => {
                    setMode("recovery");
                    setErrorKey(null);
                  }}
                  type="button"
                >
                  {messages.auth.useRecoveryCode}
                </button>
                <p className="auth-footnote">{messages.auth.discordRecoveryNote}</p>
              </>
            ) : (
              <>
                <h1 id="auth-heading">{messages.auth.recoveryTitle}</h1>
                <p className="auth-intro">{messages.auth.recoveryIntro}</p>
                <form className="auth-form" onSubmit={(event) => void submitRecovery(event)}>
                  <label htmlFor="recovery-code">{messages.auth.recoveryCode}</label>
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
                  <label htmlFor="new-owner-passphrase">{messages.auth.newPassphrase}</label>
                  <input
                    autoComplete="new-password"
                    disabled={pending}
                    id="new-owner-passphrase"
                    minLength={12}
                    name="newPassphrase"
                    required
                    type="password"
                  />
                  <label htmlFor="confirm-owner-passphrase">
                    {messages.auth.confirmPassphrase}
                  </label>
                  <input
                    autoComplete="new-password"
                    disabled={pending}
                    id="confirm-owner-passphrase"
                    minLength={12}
                    name="passphraseConfirmation"
                    required
                    type="password"
                  />
                  <FormError message={errorKey === null ? null : messages.auth[errorKey]} />
                  <button className="primary-button auth-submit" disabled={pending} type="submit">
                    {pending ? messages.auth.recovering : messages.auth.recoverAccess}
                  </button>
                </form>
                <button
                  className="auth-link auth-link--back"
                  disabled={pending}
                  onClick={returnToLogin}
                  type="button"
                >
                  {messages.auth.backToSignIn}
                </button>
              </>
            )
          ) : (
            <>
              <h1 id="auth-heading">{messages.auth.saveCodesTitle}</h1>
              <p className="auth-intro">{messages.auth.saveCodesIntro}</p>
              <ol aria-label={messages.auth.newRecoveryCodes} className="recovery-codes">
                {recoveryResult.recoveryCodes.map((code) => (
                  <li key={code}>
                    <code>{code}</code>
                  </li>
                ))}
              </ol>
              <button className="primary-button auth-submit" onClick={returnToLogin} type="button">
                {messages.auth.savedCodes}
              </button>
            </>
          )}
        </section>
        <footer>{messages.auth.footer}</footer>
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

function messageKeyFor(cause: unknown, fallback: AuthMessageKey): AuthMessageKey {
  if (cause instanceof AdminApiError) {
    if (cause.code === "RATE_LIMITED") {
      return "rateLimited";
    }
    if (cause.status >= 500) {
      return "mainNotReady";
    }
  }
  return fallback;
}
