import { RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AdminApiError, BrowserAdminApi, type AdminApi, type RuntimeFeatures } from "./admin-api";
import { parseAdminDeepLink } from "./admin-deep-link";
import { App } from "./App";
import { mapDeviceOverview } from "./device-overview";
import { useAdminI18n } from "./i18n";
import { LanguageSelector } from "./LanguageSelector";
import { LoginScreen } from "./LoginScreen";
import type { DeviceFleetViewModel } from "./view-model";

type AuthenticationState = "checking" | "authenticated" | "signed-out" | "unavailable";

export function AdminApplication({
  api: suppliedApi,
}: {
  readonly api?: AdminApi;
}): React.JSX.Element {
  const { messages } = useAdminI18n();
  const browserApi = useMemo(() => suppliedApi ?? new BrowserAdminApi(), [suppliedApi]);
  const deepLink = useMemo(() => parseAdminDeepLink(window.location.search), []);
  const [state, setState] = useState<AuthenticationState>("checking");
  const [failureCode, setFailureCode] = useState<string | null>(null);
  const [deviceFleet, setDeviceFleet] = useState<DeviceFleetViewModel | null>(null);
  const [features, setFeatures] = useState<RuntimeFeatures | null>(null);

  async function enterAdmin(checkSession: boolean): Promise<void> {
    setState("checking");
    setFailureCode(null);
    try {
      if (checkSession) {
        await browserApi.session();
      }
      const [devices, runtimeFeatures] = await Promise.all([
        browserApi.listDevices(),
        browserApi.runtimeFeatures(),
      ]);
      const mainDevices = devices.filter((candidate) => candidate.role === "main");
      const mainDevice = mainDevices[0];
      if (mainDevices.length !== 1 || mainDevice === undefined) {
        throw new AdminApiError(
          503,
          "MAIN_DEVICE_UNAVAILABLE",
          "OpenDelegate Main did not return exactly one fixed Main Device.",
        );
      }
      setDeviceFleet({
        devices: [
          mapDeviceOverview(mainDevice),
          ...devices
            .filter((candidate) => candidate.role === "worker")
            .map((candidate) => mapDeviceOverview(candidate)),
        ],
        mainDeviceId: mainDevice.deviceId,
      });
      setFeatures(runtimeFeatures);
      setState("authenticated");
    } catch (cause) {
      if (cause instanceof AdminApiError && cause.status === 401) {
        setState("signed-out");
        return;
      }
      setFailureCode(cause instanceof AdminApiError ? cause.code : "MAIN_UNAVAILABLE");
      setState("unavailable");
    }
  }

  useEffect(() => {
    void enterAdmin(true);
  }, [browserApi]);

  if (state === "checking") {
    return (
      <main aria-label={messages.startup.checkingSession} className="startup-state">
        <LanguageSelector placement="utility" />
        <span aria-hidden="true" className="startup-spinner" />
        <p>{messages.startup.connecting}</p>
      </main>
    );
  }

  if (state === "signed-out") {
    return (
      <LoginScreen
        api={browserApi}
        onAuthenticated={() => {
          void enterAdmin(false);
        }}
      />
    );
  }

  if (state === "unavailable") {
    return (
      <main className="startup-state startup-state--error">
        <LanguageSelector placement="utility" />
        <h1>{messages.startup.unavailableTitle}</h1>
        <p>
          {failureCode === "MAIN_DEVICE_UNAVAILABLE"
            ? messages.startup.invalidMainDevice
            : messages.startup.mainUnavailable}
        </p>
        <button className="secondary-button" onClick={() => void enterAdmin(true)} type="button">
          <RotateCcw aria-hidden="true" />
          {messages.common.tryAgain}
        </button>
      </main>
    );
  }

  if (deviceFleet === null || features === null) {
    return (
      <main className="startup-state startup-state--error">
        <LanguageSelector placement="utility" />
        <h1>{messages.startup.unavailableTitle}</h1>
        <p>{messages.startup.missingRuntimeState}</p>
      </main>
    );
  }

  return (
    <App
      api={browserApi}
      configurationAgentAvailable={features.configurationAgent.status === "ready"}
      deviceFleet={deviceFleet}
      discordConfigured={features.discord.status === "ready"}
      executionAvailable={features.taskExecution.status === "ready"}
      {...(deepLink.artifactId === undefined ? {} : { initialArtifactId: deepLink.artifactId })}
      initialSection={deepLink.section}
      onConfigurationMessage={(deviceId, message) =>
        browserApi.sendConfigurationMessage(deviceId, message)
      }
      onSecureSecretIngest={(purpose, secret) => browserApi.ingestSecret(purpose, secret)}
      releaseIdentity={features}
    />
  );
}
