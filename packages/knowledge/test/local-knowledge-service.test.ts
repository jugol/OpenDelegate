import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  KnowledgeError,
  LocalKnowledgeService,
  type KnowledgeErrorCode,
  type UpsertKnowledgeNote,
} from "../src/index.ts";

async function createKnowledgeRoot(context: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-knowledge-"));
  context.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test("rebuilds outgoing links and backlinks from ordinary Obsidian-style Markdown", async (context) => {
  const root = await createKnowledgeRoot(context);
  await writeFile(
    join(root, "network.md"),
    "# Main networking\n\nUse [[VPN Setup|the private VPN]].",
    "utf8",
  );
  await writeFile(join(root, "vpn.md"), "# VPN Setup\n\nSee [[network#Troubleshooting]].", "utf8");
  await writeFile(join(root, "ignored.txt"), "[[network]] is not Markdown Knowledge.", "utf8");
  const service = new LocalKnowledgeService({ root });

  const rebuilt = await service.rebuild();

  assert.deepEqual(rebuilt, {
    status: "ready",
  });
  assert.deepEqual(service.relationships("network.md"), {
    outgoing: ["vpn.md"],
    backlinks: ["vpn.md"],
  });
  assert.deepEqual(service.relationships("vpn.md"), {
    outgoing: ["network.md"],
    backlinks: ["network.md"],
  });
});

test("returns bounded candidates and opens content only through an explicit total character budget", async (context) => {
  const root = await createKnowledgeRoot(context);
  const alphaContent =
    "# Docker Alpha\n\nDocker socket recovery for this Device requires restarting the local helper.";
  await writeFile(join(root, "alpha.md"), alphaContent, "utf8");
  await writeFile(
    join(root, "beta.md"),
    "# Docker Beta\n\nDocker storage uses the Device-local mounted volume.",
    "utf8",
  );
  await writeFile(
    join(root, "gamma.md"),
    "# Docker Gamma\n\nDocker diagnostics use the local service log.",
    "utf8",
  );
  const service = new LocalKnowledgeService({
    root,
    maxSearchCandidates: 2,
    maxCandidatePreviewCharacters: 24,
    maxOpenCharacters: 40,
  });
  await service.rebuild();

  const candidates = service.search("docker", { limit: 10 });

  assert.deepEqual(
    candidates.map((candidate) => candidate.noteId),
    ["alpha.md", "beta.md"],
  );
  for (const candidate of candidates) {
    assert.ok(candidate.preview.length <= 24);
    assert.equal("content" in candidate, false);
  }

  const opened = service.openNotes(["alpha.md", "beta.md"], {
    totalCharacterBudget: 100,
  });

  assert.deepEqual(opened, {
    characterBudget: 40,
    usedCharacters: 40,
    notes: [
      {
        noteId: "alpha.md",
        title: "Docker Alpha",
        content: alphaContent.slice(0, 40),
        truncated: true,
      },
    ],
    omittedNoteIds: ["beta.md"],
  });
});

test("rebuild replaces stale derived state and ignores symlinked Markdown", async (context) => {
  const root = await createKnowledgeRoot(context);
  const externalRoot = await createKnowledgeRoot(context);
  await writeFile(join(root, "stale.md"), "# Stale procedure\n\nobsolete-marker", "utf8");
  await writeFile(
    join(externalRoot, "hidden.md"),
    "# Hidden external note\n\nexternal-marker",
    "utf8",
  );
  await symlink(
    externalRoot,
    join(root, "linked-external"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const service = new LocalKnowledgeService({ root });
  await service.rebuild();

  await unlink(join(root, "stale.md"));
  await writeFile(join(root, "fresh.md"), "# Fresh procedure\n\nfresh-marker", "utf8");
  const rebuilt = await service.rebuild();

  assert.deepEqual(rebuilt, {
    status: "ready",
  });
  assert.deepEqual(service.search("obsolete-marker"), []);
  assert.deepEqual(service.search("external-marker"), []);
  assert.deepEqual(
    service.search("fresh-marker").map((candidate) => candidate.noteId),
    ["fresh.md"],
  );
});

test("atomically creates and updates a qualifying durable Device-specific note", async (context) => {
  const root = await createKnowledgeRoot(context);
  const service = new LocalKnowledgeService({
    root,
    maxNoteCharacters: 500,
  });
  await service.rebuild();
  const qualification = {
    deviceSpecific: true,
    repeatedlyUseful: true,
    expensiveToRediscover: true,
    actionable: true,
  } as const;

  const created = await service.upsertNote({
    noteId: "procedures/gpu-reset.md",
    contentKind: "durable-device-knowledge",
    content: "# GPU reset\n\nOn this Device, restart the local GPU helper before retrying.",
    qualification,
  });

  assert.deepEqual(created, {
    noteId: "procedures/gpu-reset.md",
    operation: "created",
  });
  assert.deepEqual(
    service.search("GPU helper").map((candidate) => candidate.noteId),
    ["procedures/gpu-reset.md"],
  );

  const updated = await service.upsertNote({
    noteId: "procedures/gpu-reset.md",
    contentKind: "durable-device-knowledge",
    content:
      "# GPU reset\n\nOn this Device, stop the render queue before restarting the GPU helper.",
    qualification,
  });

  assert.deepEqual(updated, {
    noteId: "procedures/gpu-reset.md",
    operation: "updated",
  });
  assert.deepEqual(service.search("retrying"), []);
  assert.deepEqual(
    service.search("render queue").map((candidate) => candidate.noteId),
    ["procedures/gpu-reset.md"],
  );
  assert.deepEqual(await readdir(join(root, "procedures")), ["gpu-reset.md"]);
});

test("rejects inadmissible Knowledge with stable admission codes", async (context) => {
  const root = await createKnowledgeRoot(context);
  const service = new LocalKnowledgeService({
    root,
    maxNoteCharacters: 80,
  });
  await service.rebuild();
  const qualifying = {
    deviceSpecific: true,
    repeatedlyUseful: true,
    expensiveToRediscover: true,
    actionable: true,
  } as const;
  const cases: readonly {
    readonly input: UpsertKnowledgeNote;
    readonly code: KnowledgeErrorCode;
  }[] = [
    {
      input: {
        noteId: "rejected-credential.md",
        contentKind: "credential",
        content: "api_key = secret-value",
        qualification: qualifying,
      },
      code: "KNOWLEDGE_CREDENTIAL_REJECTED",
    },
    {
      input: {
        noteId: "rejected-transcript.md",
        contentKind: "raw-transcript",
        content: "User: run it\nAssistant: done",
        qualification: qualifying,
      },
      code: "KNOWLEDGE_RAW_TRANSCRIPT_REJECTED",
    },
    {
      input: {
        noteId: "rejected-log.md",
        contentKind: "raw-log",
        content: "[INFO] helper started",
        qualification: qualifying,
      },
      code: "KNOWLEDGE_RAW_LOG_REJECTED",
    },
    {
      input: {
        noteId: "rejected-task-state.md",
        contentKind: "temporary-task-state",
        content: "Current Task attempt is waiting.",
        qualification: qualifying,
      },
      code: "KNOWLEDGE_TEMPORARY_TASK_STATE_REJECTED",
    },
    {
      input: {
        noteId: "rejected-common-fact.md",
        contentKind: "common-fact",
        content: "Git is a version control system.",
        qualification: qualifying,
      },
      code: "KNOWLEDGE_COMMON_FACT_REJECTED",
    },
    {
      input: {
        noteId: "rejected-not-device-specific.md",
        contentKind: "durable-device-knowledge",
        content: "This is not specific to the Device.",
        qualification: {
          ...qualifying,
          deviceSpecific: false,
        },
      },
      code: "KNOWLEDGE_COMMON_FACT_REJECTED",
    },
    {
      input: {
        noteId: "rejected-disguised-secret.md",
        contentKind: "durable-device-knowledge",
        content: "api_key = super-secret-value",
        qualification: qualifying,
      },
      code: "KNOWLEDGE_CREDENTIAL_REJECTED",
    },
    {
      input: {
        noteId: "rejected-overlarge.md",
        contentKind: "durable-device-knowledge",
        content: "x".repeat(81),
        qualification: qualifying,
      },
      code: "KNOWLEDGE_CONTENT_TOO_LARGE",
    },
    {
      input: {
        noteId: "rejected-not-durable.md",
        contentKind: "durable-device-knowledge",
        content: "A one-time local observation.",
        qualification: {
          ...qualifying,
          repeatedlyUseful: false,
        },
      },
      code: "KNOWLEDGE_NOT_DURABLE",
    },
  ];

  for (const item of cases) {
    await assert.rejects(service.upsertNote(item.input), (error: unknown) => {
      assert.ok(error instanceof KnowledgeError);
      assert.equal(error.code, item.code);
      return true;
    });
  }
});

test("rejects common credential forms while allowing prose that merely names them", async (context) => {
  const root = await createKnowledgeRoot(context);
  const service = new LocalKnowledgeService({ root });
  await service.rebuild();
  const qualification = {
    deviceSpecific: true,
    repeatedlyUseful: true,
    expensiveToRediscover: true,
    actionable: true,
  } as const;
  const credentialSamples = [
    `AWS access key: ${["AKIA", "IOSFODNN7EXAMPLE"].join("")}`,
    `aws_secret_access_key = ${["wJalrXUtnFEMI/K7M", "DENG/bPxRfiCYEXAMPLEKEY"].join("")}`,
    `Authorization: Bearer ${["mF_9.B5f-4.1JqM", "abcdefghijklmnopqrstuvwxyz"].join("")}`,
    [
      "eyJhbGciOiJIUzI1NiJ9",
      "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
      "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    ].join("."),
    `slack = ${["xoxb-", "123456789012-123456789012-abcdefghijklmnopqrstuvwx"].join("")}`,
    `google = ${["AIza", "SyA12345678901234567890123456789012"].join("")}`,
    `npm = ${["npm_", "abcdefghijklmnopqrstuvwxyz123456"].join("")}`,
    `database = ${["postgres://owner:", "super-secret-password@localhost/opendelegate"].join("")}`,
  ] as const;

  for (const [index, content] of credentialSamples.entries()) {
    await assert.rejects(
      service.upsertNote({
        noteId: `credential-${index}.md`,
        contentKind: "durable-device-knowledge",
        content,
        qualification,
      }),
      (error: unknown) => {
        assert.ok(error instanceof KnowledgeError);
        assert.equal(error.code, "KNOWLEDGE_CREDENTIAL_REJECTED");
        return true;
      },
    );
  }

  const safeProse = [
    "Use AWS access keys only through the Device-local Secret Store.",
    "Send Bearer tokens through the credential helper, never through Knowledge.",
    "JWT parsing belongs in the authentication adapter.",
  ] as const;

  for (const [index, content] of safeProse.entries()) {
    await service.upsertNote({
      noteId: `safe-security-guidance-${index}.md`,
      contentKind: "durable-device-knowledge",
      content,
      qualification,
    });
  }

  assert.equal(service.health().status, "ready");
});

test("rejects contextual credential assignments without blocking security guidance", async (context) => {
  const root = await createKnowledgeRoot(context);
  const service = new LocalKnowledgeService({ root });
  await service.rebuild();
  const qualification = {
    deviceSpecific: true,
    repeatedlyUseful: true,
    expensiveToRediscover: true,
    actionable: true,
  } as const;

  for (const [index, content] of [
    "Password is correct-horse-battery-staple",
    "The access token is device-local-token-2026",
    'Passphrase was "winter-device-access-phrase"',
  ].entries()) {
    await assert.rejects(
      service.upsertNote({
        noteId: `contextual-credential-${index}.md`,
        contentKind: "durable-device-knowledge",
        content,
        qualification,
      }),
      (error: unknown) => {
        assert.ok(error instanceof KnowledgeError);
        assert.equal(error.code, "KNOWLEDGE_CREDENTIAL_REJECTED");
        return true;
      },
    );
  }

  for (const [index, content] of [
    "The password is stored only in the Device-local Secret Store.",
    "A secret is never copied into Knowledge.",
    "The access token is resolved at execution time by the credential helper.",
  ].entries()) {
    await service.upsertNote({
      noteId: `contextual-security-guidance-${index}.md`,
      contentKind: "durable-device-knowledge",
      content,
      qualification,
    });
  }
});

test("rejects a Discord bot token disguised as durable Device Knowledge", async (context) => {
  const root = await createKnowledgeRoot(context);
  const service = new LocalKnowledgeService({ root });
  await service.rebuild();
  const discordToken = ["mfa.", "A".repeat(64)].join("");

  await assert.rejects(
    service.upsertNote({
      noteId: "discord-operations.md",
      contentKind: "durable-device-knowledge",
      content: `Discord bot token is ${discordToken}`,
      qualification: {
        deviceSpecific: true,
        repeatedlyUseful: true,
        expensiveToRediscover: true,
        actionable: true,
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof KnowledgeError);
      assert.equal(error.code, "KNOWLEDGE_CREDENTIAL_REJECTED");
      return true;
    },
  );
  assert.deepEqual(await readdir(root), []);
});

test("rejects configured Device-local Secret values by exact substring", async (context) => {
  const root = await createKnowledgeRoot(context);
  const service = new LocalKnowledgeService({
    root,
    knownSecretValues: ["", "local-secret-value-2026"],
  });
  await service.rebuild();
  const qualification = {
    deviceSpecific: true,
    repeatedlyUseful: true,
    expensiveToRediscover: true,
    actionable: true,
  } as const;

  await assert.rejects(
    service.upsertNote({
      noteId: "known-secret.md",
      contentKind: "durable-device-knowledge",
      content: "The credential helper injects local-secret-value-2026 when required.",
      qualification,
    }),
    (error: unknown) => {
      assert.ok(error instanceof KnowledgeError);
      assert.equal(error.code, "KNOWLEDGE_CREDENTIAL_REJECTED");
      return true;
    },
  );

  await service.upsertNote({
    noteId: "safe-helper-guidance.md",
    contentKind: "durable-device-knowledge",
    content: "The credential helper injects the configured value only at execution time.",
    qualification,
  });
});

test("contains every note path under the configured root and rejects symlink traversal", async (context) => {
  const root = await createKnowledgeRoot(context);
  const externalRoot = await createKnowledgeRoot(context);
  await symlink(
    externalRoot,
    join(root, "linked-external"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const service = new LocalKnowledgeService({ root });
  await service.rebuild();
  const qualification = {
    deviceSpecific: true,
    repeatedlyUseful: true,
    expensiveToRediscover: true,
    actionable: true,
  } as const;
  const rejectedInputs: readonly UpsertKnowledgeNote[] = [
    {
      noteId: "../escaped.md",
      contentKind: "durable-device-knowledge",
      content: "# Escaped",
      qualification,
    },
    {
      noteId: "..\\escaped-windows.md",
      contentKind: "durable-device-knowledge",
      content: "# Escaped",
      qualification,
    },
    {
      noteId: join(externalRoot, "absolute.md"),
      contentKind: "durable-device-knowledge",
      content: "# Absolute",
      qualification,
    },
    {
      noteId: "not-markdown.txt",
      contentKind: "durable-device-knowledge",
      content: "# Not Markdown",
      qualification,
    },
    {
      noteId: "linked-external/escaped.md",
      contentKind: "durable-device-knowledge",
      content: "# Symlink escape",
      qualification,
    },
  ];

  for (const input of rejectedInputs) {
    await assert.rejects(service.upsertNote(input), (error: unknown) => {
      assert.ok(error instanceof KnowledgeError);
      assert.equal(error.code, "KNOWLEDGE_PATH_INVALID");
      return true;
    });
  }

  assert.throws(
    () =>
      service.openNotes(["../outside.md"], {
        totalCharacterBudget: 100,
      }),
    (error: unknown) => {
      assert.ok(error instanceof KnowledgeError);
      assert.equal(error.code, "KNOWLEDGE_PATH_INVALID");
      return true;
    },
  );
  assert.throws(
    () => service.relationships("../outside.md"),
    (error: unknown) => {
      assert.ok(error instanceof KnowledgeError);
      assert.equal(error.code, "KNOWLEDGE_PATH_INVALID");
      return true;
    },
  );
  assert.throws(
    () => service.relationships("missing.md"),
    (error: unknown) => {
      assert.ok(error instanceof KnowledgeError);
      assert.equal(error.code, "KNOWLEDGE_NOTE_NOT_FOUND");
      return true;
    },
  );
  assert.deepEqual(await readdir(externalRoot), []);
});

test("reports only local health status without Knowledge cardinality metadata", async (context) => {
  const root = await createKnowledgeRoot(context);
  await writeFile(
    join(root, "private-name.md"),
    "# Sensitive local title\n\nprivate-snippet [[linked-note]]",
    "utf8",
  );
  await writeFile(
    join(root, "linked-note.md"),
    "# Linked secret procedure\n\nDevice-local content.",
    "utf8",
  );
  const service = new LocalKnowledgeService({ root });
  await service.rebuild();

  const health = service.health();

  assert.deepEqual(health, {
    status: "ready",
  });
  assert.equal(Object.isFrozen(health), true);
  const serialized = JSON.stringify(health);
  for (const forbidden of [
    "private-name",
    "Sensitive local title",
    "private-snippet",
    "linked-note",
    "Linked secret procedure",
    "[[",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});
