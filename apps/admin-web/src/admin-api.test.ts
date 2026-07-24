import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminApiError, BrowserAdminApi, type OwnerSession, type TaskDetail } from "./admin-api";

const ownerSession: OwnerSession = {
  sessionId: "session_owner_browser",
  ownerId: "owner_primary",
  createdAt: "2026-07-24T01:00:00.000Z",
  authenticatedAt: "2026-07-24T01:00:00.000Z",
  lastUsedAt: "2026-07-24T01:00:00.000Z",
  idleExpiresAt: "2026-07-24T02:00:00.000Z",
  absoluteExpiresAt: "2026-07-25T01:00:00.000Z",
};

const task: TaskDetail = {
  taskId: "task_shutdown_review",
  state: "paused",
  mode: "auto",
  objective: "Review shutdown behavior.",
  createdAt: "2026-07-24T01:00:00.000Z",
  updatedAt: "2026-07-24T01:01:00.000Z",
  version: 2,
  completionCriteria: ["Shutdown failures are observable."],
  constraints: [],
  selectedInputRefs: [],
  events: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BrowserAdminApi JSON responses", () => {
  it("preserves Problem Details and refreshes CSRF state after a 401", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-old", session: ownerSession }))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            code: "AUTHENTICATION_FAILED",
            detail: "The owner credential is no longer valid.",
            title: "Owner authentication failed.",
          },
          {
            status: 401,
            contentType: "application/problem+json; charset=utf-8",
          },
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-new", session: ownerSession }))
      .mockResolvedValueOnce(jsonResponse(task));
    vi.stubGlobal("fetch", fetchMock);
    const api = new BrowserAdminApi();

    await api.login("correct horse battery staple");
    await expect(api.commandTask(task.taskId, "pause")).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
      message: "The owner credential is no longer valid.",
      status: 401,
    });

    await expect(api.commandTask(task.taskId, "pause")).resolves.toEqual(task);
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/v1/auth/session");
    const refreshedCommandHeaders = fetchMock.mock.calls[3]?.[1]?.headers;
    expect(refreshedCommandHeaders).toBeInstanceOf(Headers);
    expect((refreshedCommandHeaders as Headers).get("x-opendelegate-csrf")).toBe("csrf-new");
  });

  it("uses a valid Problem Details title when the server omits detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            type: "https://opendelegate.dev/problems/authentication-required",
            title: "Owner authentication is required.",
            status: 401,
            code: "AUTHENTICATION_REQUIRED",
            correlationId: "correlation_title_only",
          },
          {
            status: 401,
            contentType: "application/problem+json",
          },
        ),
      ),
    );

    await expect(new BrowserAdminApi().session()).rejects.toMatchObject({
      code: "AUTHENTICATION_REQUIRED",
      message: "Owner authentication is required.",
      status: 401,
    });
  });

  it("refreshes CSRF state when a 401 contains a non-JSON body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-old", session: ownerSession }))
      .mockResolvedValueOnce(
        new Response("<h1>Unauthorized</h1>", {
          status: 401,
          headers: { "content-type": "text/html" },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-new", session: ownerSession }))
      .mockResolvedValueOnce(jsonResponse(task));
    vi.stubGlobal("fetch", fetchMock);
    const api = new BrowserAdminApi();

    await api.login("correct horse battery staple");
    await expect(api.commandTask(task.taskId, "pause")).rejects.toBeDefined();
    await expect(api.commandTask(task.taskId, "pause")).resolves.toEqual(task);

    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/v1/auth/session");
    const refreshedCommandHeaders = fetchMock.mock.calls[3]?.[1]?.headers;
    expect(refreshedCommandHeaders).toBeInstanceOf(Headers);
    expect((refreshedCommandHeaders as Headers).get("x-opendelegate-csrf")).toBe("csrf-new");
  });

  it("redacts malformed JSON while preserving status and refreshing CSRF state", async () => {
    const privateSentinel = "PRIVATE_RESPONSE_SENTINEL";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-old", session: ownerSession }))
      .mockResolvedValueOnce(
        new Response(`{"private":"${privateSentinel}"`, {
          status: 401,
          headers: { "content-type": "application/problem+json" },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-new", session: ownerSession }))
      .mockResolvedValueOnce(jsonResponse(task));
    vi.stubGlobal("fetch", fetchMock);
    const api = new BrowserAdminApi();

    await api.login("correct horse battery staple");
    let failure: unknown;
    try {
      await api.commandTask(task.taskId, "pause");
    } catch (cause) {
      failure = cause;
    }
    expect(failure?.constructor).toBe(AdminApiError);
    expect(failure).toMatchObject({
      code: "UNEXPECTED_RESPONSE",
      message: "OpenDelegate returned an unexpected response.",
      status: 401,
    });
    expect(String(failure)).not.toContain(privateSentinel);
    expect(String(failure)).not.toContain("SyntaxError");

    await expect(api.commandTask(task.taskId, "pause")).resolves.toEqual(task);
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/v1/auth/session");
    const refreshedCommandHeaders = fetchMock.mock.calls[3]?.[1]?.headers;
    expect(refreshedCommandHeaders).toBeInstanceOf(Headers);
    expect((refreshedCommandHeaders as Headers).get("x-opendelegate-csrf")).toBe("csrf-new");
  });

  it.each([
    "application/json",
    "Application/JSON; Charset=UTF-8",
    "application/problem+json",
    "application/vnd.opendelegate.owner+json; version=1",
  ])("accepts the JSON media type %s", async (contentType) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          { csrfToken: "csrf-token", session: ownerSession },
          {
            contentType,
          },
        ),
      ),
    );

    await expect(new BrowserAdminApi().login("owner passphrase")).resolves.toEqual(ownerSession);
  });

  it.each([
    "text/json",
    "text/application/json",
    "application/jsonp",
    "application/problem+jsonx",
    "application/json, text/plain",
  ])("rejects the non-JSON media type %s", async (contentType) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          { csrfToken: "csrf-token", session: ownerSession },
          {
            contentType,
          },
        ),
      ),
    );

    await expect(new BrowserAdminApi().login("owner passphrase")).rejects.toMatchObject({
      code: "UNEXPECTED_RESPONSE",
    });
  });
});

function jsonResponse(
  body: unknown,
  options: {
    readonly contentType?: string;
    readonly status?: number;
  } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    headers: {
      "content-type": options.contentType ?? "application/json",
    },
  });
}
