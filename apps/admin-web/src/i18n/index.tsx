import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";

import { englishMessages } from "./messages.en";
import { spanishMessages } from "./messages.es";
import { frenchMessages } from "./messages.fr";
import { japaneseMessages } from "./messages.ja";
import { koreanMessages } from "./messages.ko";
import { simplifiedChineseMessages } from "./messages.zh-CN";
import type { Messages, SupportedLocale } from "./types";
import type { ApprovalActionCategory, ArtifactDetail, ArtifactExposureMode } from "../admin-api";
import type {
  AgentAdapterView,
  CapabilityState,
  CurrentRunView,
  DevicePolicyView,
  PresentationText,
} from "../view-model";

export type { Messages, SupportedLocale } from "./types";

export const ADMIN_LOCALE_STORAGE_KEY = "opendelegate.admin.locale.v1";

export const supportedLocales = [
  { code: "en", name: "English" },
  { code: "ko", name: "한국어" },
  { code: "ja", name: "日本語" },
  { code: "fr", name: "Français" },
  { code: "es", name: "Español" },
  { code: "zh-CN", name: "简体中文" },
] as const satisfies ReadonlyArray<{
  readonly code: SupportedLocale;
  readonly name: string;
}>;

const messagesByLocale: Readonly<Record<SupportedLocale, Messages>> = {
  en: englishMessages,
  es: spanishMessages,
  fr: frenchMessages,
  ja: japaneseMessages,
  ko: koreanMessages,
  "zh-CN": simplifiedChineseMessages,
};

interface I18nContextValue {
  readonly locale: SupportedLocale;
  readonly messages: Messages;
  readonly setLocale: (locale: SupportedLocale) => void;
}

const defaultContext: I18nContextValue = {
  locale: "en",
  messages: englishMessages,
  setLocale: () => undefined,
};

const I18nContext = createContext<I18nContextValue>(defaultContext);

export function AdminI18nProvider({
  children,
  initialLocale,
}: {
  readonly children: ReactNode;
  readonly initialLocale?: SupportedLocale;
}): React.JSX.Element {
  const [locale, updateLocale] = useState<SupportedLocale>(
    () => initialLocale ?? readStoredLocale(),
  );

  const setLocale = useCallback((nextLocale: SupportedLocale) => {
    updateLocale(nextLocale);
    try {
      window.localStorage.setItem(ADMIN_LOCALE_STORAGE_KEY, nextLocale);
    } catch {
      // Admin localization must remain usable when browser storage is unavailable.
    }
  }, []);

  useLayoutEffect(() => {
    applyDocumentLocale(locale, messagesByLocale[locale]);
  }, [locale]);

  useEffect(() => {
    function synchronizeLocale(event: StorageEvent): void {
      if (event.key !== ADMIN_LOCALE_STORAGE_KEY) {
        return;
      }
      const nextLocale = event.newValue === null ? "en" : normalizeLocale(event.newValue);
      if (nextLocale !== null) {
        updateLocale(nextLocale);
      }
    }

    window.addEventListener("storage", synchronizeLocale);
    return () => window.removeEventListener("storage", synchronizeLocale);
  }, []);

  const value = useMemo<I18nContextValue>(
    () => ({ locale, messages: messagesByLocale[locale], setLocale }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useAdminI18n(): I18nContextValue {
  return use(I18nContext);
}

export function initializeDocumentLocale(): SupportedLocale {
  const locale = readStoredLocale();
  applyDocumentLocale(locale, messagesByLocale[locale]);
  return locale;
}

export function readStoredLocale(
  storage: Pick<Storage, "getItem"> | undefined = browserStorage(),
): SupportedLocale {
  if (storage === undefined) {
    return "en";
  }
  try {
    return normalizeLocale(storage.getItem(ADMIN_LOCALE_STORAGE_KEY)) ?? "en";
  } catch {
    return "en";
  }
}

export function normalizeLocale(value: string | null | undefined): SupportedLocale | null {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = value.trim().replaceAll("_", "-").toLowerCase();
  if (normalized === "zh-cn" || normalized === "zh-hans" || normalized === "zh-sg") {
    return "zh-CN";
  }
  if (normalized === "zh" || normalized.startsWith("zh-cn-") || normalized.startsWith("zh-hans-")) {
    return "zh-CN";
  }
  if (
    normalized === "zh-tw" ||
    normalized === "zh-hk" ||
    normalized === "zh-mo" ||
    normalized === "zh-hant" ||
    normalized.startsWith("zh-hant-")
  ) {
    return null;
  }
  const language = normalized.split("-")[0];
  if (
    language === "en" ||
    language === "es" ||
    language === "fr" ||
    language === "ja" ||
    language === "ko"
  ) {
    return language;
  }
  return null;
}

export function formatMessage(
  template: string,
  values: Readonly<Record<string, string | number>>,
): string {
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (match, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : match,
  );
}

export function formatAdminDate(value: string, locale: SupportedLocale): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return value;
  }
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function localizeCapabilityState(state: CapabilityState, messages: Messages): string {
  const keys: Readonly<Record<CapabilityState, keyof Messages["known"]>> = {
    degraded: "degraded",
    detected: "detected",
    disabled: "disabled",
    not_assessed: "notAssessed",
    ready: "ready",
    unavailable: "unavailable",
    verified: "verified",
  };
  return messages.known[keys[state]];
}

export function localizeCurrentRunState(
  state: CurrentRunView["state"],
  messages: Messages,
): string {
  return {
    cancelling: messages.device.runStateCancelling,
    running: messages.device.runStateRunning,
    starting: messages.device.runStateStarting,
  }[state];
}

export function localizePolicyScope(
  scope: DevicePolicyView["effectiveScope"],
  messages: Messages,
): string {
  return {
    device: messages.device.policyScopeDevice,
    instance: messages.device.policyScopeInstance,
    main: messages.device.policyScopeMain,
  }[scope];
}

export function localizeAdapterReadiness(
  readiness: AgentAdapterView["readiness"],
  messages: Messages,
): string {
  return {
    degraded: messages.device.adapterReadinessDegraded,
    ready: messages.device.adapterReadinessReady,
    unavailable: messages.device.adapterReadinessUnavailable,
  }[readiness];
}

export function localizeAdapterCompatibility(
  compatibility: AgentAdapterView["compatibility"],
  messages: Messages,
): string {
  return {
    compatible: messages.device.adapterCompatibilityCompatible,
    incompatible: messages.device.adapterCompatibilityIncompatible,
    tested: messages.device.adapterCompatibilityTested,
    untested: messages.device.adapterCompatibilityUntested,
  }[compatibility];
}

export function localizeAgentAdapterBlocker(
  blocker: NonNullable<AgentAdapterView["blockedBy"]>,
  messages: Messages,
): string {
  return {
    "provider-home-unavailable": messages.device.adapterBlockedProviderHome,
    "executable-unavailable": messages.device.adapterBlockedExecutable,
    "authentication-required": messages.device.adapterBlockedAuthentication,
    "version-unsupported": messages.device.adapterBlockedVersion,
    "platform-incompatible": messages.device.adapterBlockedPlatform,
    "probe-failed": messages.device.adapterBlockedProbe,
  }[blocker];
}

export function localizeArtifactExposure(
  exposure: ArtifactExposureMode,
  messages: Messages,
): string {
  return {
    authenticated: messages.artifact.exposureAuthenticated,
    custom: messages.artifact.exposureCustom,
    "private-network": messages.artifact.exposurePrivateNetwork,
    public: messages.artifact.exposurePublic,
    "signed-link": messages.artifact.exposureSignedLink,
  }[exposure];
}

export function localizeArtifactPresentation(
  presentation: ArtifactDetail["presentation"],
  messages: Messages,
): string {
  return {
    download: messages.artifact.presentationDownload,
    inline: messages.artifact.presentationInline,
    "interactive-html": messages.artifact.presentationInteractiveHtml,
    "static-html": messages.artifact.presentationStaticHtml,
  }[presentation];
}

const approvalCategoryMessageKeys = {
  "computer-use-input": "computerUseInput",
  "configured-official-package-install": "configuredOfficialPackageInstall",
  "cross-device-knowledge-transfer": "crossDeviceKnowledgeTransfer",
  "driver-installation": "driverInstallation",
  "firewall-change": "firewallChange",
  "kernel-extension-installation": "kernelExtensionInstallation",
  "opendelegate-process-restart": "opendelegateProcessRestart",
  "opendelegate-process-retry": "opendelegateProcessRetry",
  "os-network-change": "osNetworkChange",
  "package-repository-addition": "packageRepositoryAddition",
  "policy-bypass-attempt": "policyBypassAttempt",
  "policy-relaxation": "policyRelaxation",
  "project-dependency-install": "projectDependencyInstall",
  "read-only-observation": "readOnlyObservation",
  "remote-installer-script": "remoteInstallerScript",
  "secret-export": "secretExport",
  "untrusted-installer": "untrustedInstaller",
  "vpn-change": "vpnChange",
} as const satisfies Readonly<Record<ApprovalActionCategory, keyof Messages["approvalCategory"]>>;

export function localizeApprovalActionCategory(category: string, messages: Messages): string {
  if (!Object.hasOwn(approvalCategoryMessageKeys, category)) {
    return category;
  }
  const messageKey = approvalCategoryMessageKeys[category as ApprovalActionCategory];
  return messages.approvalCategory[messageKey];
}

export function localizePresentationText(value: PresentationText, messages: Messages): string {
  if (typeof value === "string") {
    return value;
  }
  const message = messages.known[value.messageKey];
  return value.values === undefined ? message : formatMessage(message, value.values);
}

function browserStorage(): Pick<Storage, "getItem"> | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function applyDocumentLocale(locale: SupportedLocale, messages: Messages): void {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.lang = locale;
  document.documentElement.dir = "ltr";
  document
    .querySelector('meta[name="description"]')
    ?.setAttribute("content", messages.common.metaDescription);
}
