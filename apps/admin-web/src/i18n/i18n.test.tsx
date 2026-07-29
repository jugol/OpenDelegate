import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { DeviceSurface } from "../DeviceSurface";
import { App } from "../App";
import { LanguageSelector } from "../LanguageSelector";
import { firstRunDevice, type DeviceOverviewViewModel } from "../view-model";
import {
  ADMIN_LOCALE_STORAGE_KEY,
  AdminI18nProvider,
  formatAdminDate,
  formatMessage,
  localizeApprovalActionCategory,
  normalizeLocale,
  readStoredLocale,
  supportedLocales,
} from "./index";
import { englishMessages } from "./messages.en";
import { spanishMessages } from "./messages.es";
import { frenchMessages } from "./messages.fr";
import { japaneseMessages } from "./messages.ja";
import { koreanMessages } from "./messages.ko";
import { simplifiedChineseMessages } from "./messages.zh-CN";
import type { Messages, SupportedLocale } from "./types";

const catalogs: Readonly<Record<SupportedLocale, Messages>> = {
  en: englishMessages,
  es: spanishMessages,
  fr: frenchMessages,
  ja: japaneseMessages,
  ko: koreanMessages,
  "zh-CN": simplifiedChineseMessages,
};

const intentionalCanonicalEnglishKeys: Readonly<
  Record<Exclude<SupportedLocale, "en">, readonly string[]>
> = {
  es: [
    "artifact.checksum",
    "budget.metricTokens",
    "device.roles",
    "device.runIdentity",
    "device.wakeOnLan",
    "known.computerUse",
  ],
  fr: [
    "artifact.checksum",
    "artifact.source",
    "audit.routeIncidentId",
    "audit.source",
    "device.instructions",
    "device.routes",
    "device.runIdentity",
    "device.wakeOnLan",
    "join.fifteenMinutes",
    "join.fiveMinutes",
    "join.thirtyMinutes",
    "known.architecture",
    "known.computerUse",
    "navigation.audit",
    "task.columnActions",
    "task.conversation",
    "task.mode",
  ],
  ja: [
    "artifact.checksum",
    "budget.workOrderReference",
    "device.runIdentity",
    "device.wakeOnLan",
    "known.computerUse",
  ],
  ko: ["approval.fingerprint", "artifact.checksum", "device.wakeOnLan", "known.computerUse"],
  "zh-CN": ["artifact.checksum", "device.runIdentity", "device.wakeOnLan", "known.computerUse"],
};

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.lang = "en";
  document.querySelector('meta[name="description"]')?.remove();
});

describe("Admin localization catalogs", () => {
  it("ships six complete, non-empty catalogs with English as the first default option", () => {
    expect(supportedLocales.map(({ code }) => code)).toEqual([
      "en",
      "ko",
      "ja",
      "fr",
      "es",
      "zh-CN",
    ]);

    const englishKeys = leafEntries(englishMessages).map(([key]) => key);
    const englishValues = new Map(leafEntries(englishMessages));
    for (const [locale, catalog] of Object.entries(catalogs)) {
      const entries = leafEntries(catalog);
      expect(
        entries.map(([key]) => key),
        `${locale} must have exactly the English keys`,
      ).toEqual(englishKeys);
      expect(entries.every(([, value]) => value.trim() !== "")).toBe(true);
      for (const [key, value] of entries) {
        const englishValue = englishValues.get(key);
        expect(englishValue).toBeDefined();
        expect(placeholders(value), `${locale}.${key} placeholders`).toEqual(
          placeholders(englishValue ?? ""),
        );
        expect(value.split("\n").length, `${locale}.${key} line structure`).toBe(
          (englishValue ?? "").split("\n").length,
        );
      }
      if (locale !== "en") {
        expect(
          entries
            .filter(([key, value]) => value === englishValues.get(key))
            .map(([key]) => key)
            .sort(),
          `${locale} must not silently fall back to English`,
        ).toEqual(intentionalCanonicalEnglishKeys[locale as Exclude<SupportedLocale, "en">]);
      }
    }
  });

  it("normalizes supported regional tags but never replaces the default implicitly", () => {
    expect(readStoredLocale(undefined)).toBe("en");
    expect(readStoredLocale({ getItem: () => "unsupported" })).toBe("en");
    expect(normalizeLocale("ko-KR")).toBe("ko");
    expect(normalizeLocale("fr-CA")).toBe("fr");
    expect(normalizeLocale("zh-Hans-SG")).toBe("zh-CN");
    expect(normalizeLocale("zh-Hant")).toBeNull();
  });

  it("formats locale-sensitive dates and safely interpolates owner content", () => {
    const value = "2026-07-24T01:32:00.000Z";
    expect(formatAdminDate(value, "fr")).toBe(
      new Intl.DateTimeFormat("fr", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value)),
    );
    expect(formatMessage("Inspect {objective}", { objective: "<owner text>" })).toBe(
      "Inspect <owner text>",
    );
  });
});

describe("Admin language selection", () => {
  it("switches an already-loaded Device surface, metadata, and accessibility names", async () => {
    const meta = document.createElement("meta");
    meta.name = "description";
    document.head.append(meta);
    const user = userEvent.setup();
    const deviceWithOperationalStates = {
      ...firstRunDevice,
      policies: [
        {
          policyId: "policy-network",
          actionCategory: "os-network-change",
          decision: "require-approval",
          source: "configuration",
          effectiveScope: "device",
        },
      ],
      agentAdapters: [
        {
          provider: "codex",
          adapterId: "codex-app-server",
          readiness: "ready",
          compatibility: "tested",
          observedAtMs: Date.parse("2026-07-25T00:00:00.000Z"),
          models: [],
        },
      ],
      currentRuns: [
        {
          taskId: "task-1",
          workOrderId: "work-order-1",
          runId: "run-1",
          state: "running",
          acceptedAtMs: Date.parse("2026-07-25T00:00:00.000Z"),
          leaseExpiresAtMs: Date.parse("2026-07-25T00:05:00.000Z"),
        },
      ],
    } satisfies DeviceOverviewViewModel;

    render(
      <AdminI18nProvider initialLocale="en">
        <LanguageSelector placement="utility" />
        <DeviceSurface
          chatOpen={false}
          device={deviceWithOperationalStates}
          onConfigure={() => undefined}
          onConfigureAgentProfile={() => undefined}
        />
      </AdminI18nProvider>,
    );

    expect(screen.getByRole("heading", { name: englishMessages.device.facts })).toBeTruthy();
    expect(screen.getByText(firstRunDevice.name)).toBeTruthy();
    expect(screen.getByText("EN")).toBeTruthy();

    await user.selectOptions(screen.getByLabelText(englishMessages.common.language), "ko");

    expect(screen.getByRole("heading", { name: koreanMessages.device.facts })).toBeTruthy();
    expect(screen.getByText(koreanMessages.known.mainCoordinator)).toBeTruthy();
    expect(screen.getByText(firstRunDevice.name)).toBeTruthy();
    expect(screen.getByText("한국")).toBeTruthy();
    expect(document.documentElement.lang).toBe("ko");
    expect(meta.content).toBe(koreanMessages.common.metaDescription);
    expect(window.localStorage.getItem(ADMIN_LOCALE_STORAGE_KEY)).toBe("ko");

    await user.click(screen.getByRole("tab", { name: koreanMessages.device.authority }));
    expect(screen.getByText(koreanMessages.approvalCategory.osNetworkChange)).toBeTruthy();
    expect(
      screen.getByText(
        `${koreanMessages.device.configuredPolicy} · ${koreanMessages.device.policyScopeDevice}`,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        `${koreanMessages.device.adapterReadinessReady} · ${koreanMessages.device.adapterCompatibilityTested}`,
      ),
    ).toBeTruthy();

    await user.click(screen.getByRole("tab", { name: koreanMessages.device.runs }));
    expect(
      screen.getByText(new RegExp(`^${koreanMessages.device.runStateRunning} ·`, "u")),
    ).toBeTruthy();
  });

  it("never translates owner-authored text even when it matches a built-in English label", () => {
    const ownerDevice = {
      ...firstRunDevice,
      name: "Development",
      roles: ["Development"],
    } satisfies DeviceOverviewViewModel;

    render(
      <AdminI18nProvider initialLocale="ko">
        <DeviceSurface
          chatOpen={false}
          device={ownerDevice}
          onConfigure={() => undefined}
          onConfigureAgentProfile={() => undefined}
        />
      </AdminI18nProvider>,
    );

    expect(screen.getByRole("heading", { name: "Development" })).toBeTruthy();
    expect(screen.getByText("Development", { selector: ".role-list li" })).toBeTruthy();
    expect(localizeApprovalActionCategory("owner-custom-action", koreanMessages)).toBe(
      "owner-custom-action",
    );
  });

  it("re-renders deterministic chat failures while preserving Agent and owner history", async () => {
    const user = userEvent.setup();
    render(
      <AdminI18nProvider initialLocale="en">
        <App
          configurationAgentAvailable
          deviceFleet={{ devices: [firstRunDevice], mainDeviceId: firstRunDevice.deviceId }}
          initialChatOpen
          onConfigurationMessage={async () => {
            throw new Error("fixture failure");
          }}
        />
      </AdminI18nProvider>,
    );

    await user.type(
      screen.getByLabelText(englishMessages.chat.messageLabel),
      "Keep this owner text",
    );
    await user.click(screen.getByRole("button", { name: englishMessages.chat.send }));
    expect(await screen.findByText(englishMessages.chat.failedMessage)).toBeTruthy();

    await user.selectOptions(screen.getByLabelText(englishMessages.common.language), "ko");
    expect(await screen.findByText(koreanMessages.chat.failedMessage)).toBeTruthy();
    expect(screen.getByText("Keep this owner text")).toBeTruthy();
    expect(screen.getByText(firstRunDevice.configurationSession.assistantMessage)).toBeTruthy();
  });

  it("restores an explicit choice and synchronizes a change from another tab", async () => {
    window.localStorage.setItem(ADMIN_LOCALE_STORAGE_KEY, "fr");

    render(
      <AdminI18nProvider>
        <LanguageSelector placement="utility" />
      </AdminI18nProvider>,
    );

    expect((screen.getByLabelText(frenchMessages.common.language) as HTMLSelectElement).value).toBe(
      "fr",
    );
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: ADMIN_LOCALE_STORAGE_KEY,
        newValue: "ja",
      }),
    );

    await waitFor(() => {
      expect(
        (screen.getByLabelText(japaneseMessages.common.language) as HTMLSelectElement).value,
      ).toBe("ja");
    });
    expect(document.documentElement.lang).toBe("ja");

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: ADMIN_LOCALE_STORAGE_KEY,
        newValue: null,
      }),
    );
    await waitFor(() => {
      expect(
        (screen.getByLabelText(englishMessages.common.language) as HTMLSelectElement).value,
      ).toBe("en");
    });
  });
});

function leafEntries(messages: Messages): ReadonlyArray<readonly [key: string, value: string]> {
  return Object.entries(messages).flatMap(([section, values]) =>
    Object.entries(values).map(([key, value]) => [`${section}.${key}`, value] as const),
  );
}

function placeholders(value: string): readonly string[] {
  return [...value.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/gu)].map((match) => match[1] ?? "").sort();
}
