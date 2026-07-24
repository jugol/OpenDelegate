import { RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AdminApiError, BrowserAdminApi, type AdminApi, type RuntimeFeatures } from "./admin-api";
import { App } from "./App";
import { mapMainDeviceOverview } from "./device-overview";
import { LoginScreen } from "./LoginScreen";
import type { DeviceOverviewViewModel } from "./view-model";

type AuthenticationState = "checking" | "authenticated" | "signed-out" | "unavailable";

export function AdminApplication({
  api: suppliedApi,
}: {
  readonly api?: AdminApi;
}): React.JSX.Element {
  const browserApi = useMemo(() => suppliedApi ?? new BrowserAdminApi(), [suppliedApi]);
  const [state, setState] = useState<AuthenticationState>("checking");
  const [failure, setFailure] = useState<string | null>(null);
  const [device, setDevice] = useState<DeviceOverviewViewModel | null>(null);
  const [features, setFeatures] = useState<RuntimeFeatures | null>(null);

  async function enterAdmin(checkSession: boolean): Promise<void> {
    setState("checking");
    setFailure(null);
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
      setDevice(mapMainDeviceOverview(mainDevice));
      setFeatures(runtimeFeatures);
      setState("authenticated");
    } catch (cause) {
      if (cause instanceof AdminApiError && cause.status === 401) {
        setState("signed-out");
        return;
      }
      setFailure(
        cause instanceof AdminApiError ? cause.message : "OpenDelegate Main could not be reached.",
      );
      setState("unavailable");
    }
  }

  useEffect(() => {
    void enterAdmin(true);
  }, [browserApi]);

  if (state === "checking") {
    return (
      <main aria-label="Checking owner session" className="startup-state">
        <span aria-hidden="true" className="startup-spinner" />
        <p>Connecting to OpenDelegate Main…</p>
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
        <h1>Admin is temporarily unavailable</h1>
        <p>{failure}</p>
        <button className="secondary-button" onClick={() => void enterAdmin(true)} type="button">
          <RotateCcw aria-hidden="true" />
          Try again
        </button>
      </main>
    );
  }

  if (device === null || features === null) {
    return (
      <main className="startup-state startup-state--error">
        <h1>Admin is temporarily unavailable</h1>
        <p>OpenDelegate Main did not return its fixed Device and runtime feature state.</p>
      </main>
    );
  }

  return (
    <App
      api={browserApi}
      configurationAgentAvailable={features.configurationAgent.status === "ready"}
      device={device}
      discordConfigured={features.discord.status === "ready"}
      executionAvailable={features.taskExecution.status === "ready"}
      initialSection="devices"
      releaseChannel={features.releaseChannel}
    />
  );
}
