import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { REQUIRED_DOCUMENTS, checkCanonicalDocumentation } from "../check-canonical-docs.mjs";

const approvedDocuments = new Map([
  ["CONTEXT.md", "Approved — 2026-07-24"],
  ["docs/PRODUCT_SPEC.md", "Approved — 2026-07-24"],
  ["docs/IMPLEMENTATION_PLAN.md", "Approved — implementation authorized 2026-07-24"],
  ["docs/DECISIONS.md", "Accepted; specification approved 2026-07-24"],
]);

async function createFixture(t) {
  const rootDirectory = await mkdtemp(join(tmpdir(), "opendelegate-docs-check-"));
  t.after(async () => {
    await rm(rootDirectory, { force: true, recursive: true });
  });

  for (const document of REQUIRED_DOCUMENTS) {
    const filePath = join(rootDirectory, document);
    await mkdir(dirname(filePath), { recursive: true });
    const status = approvedDocuments.get(document);
    const content =
      status === undefined
        ? "# Platform research\n\nResearch snapshot: 2026-07-24\n"
        : `# ${document}\n\nStatus: **${status}**\n`;
    await writeFile(filePath, content, "utf8");
  }

  await writeReadme(rootDirectory, REQUIRED_DOCUMENTS);
  return rootDirectory;
}

async function writeReadme(rootDirectory, documents) {
  const links = documents.map((document) => `- [${document}](${document})`).join("\n");
  await writeFile(join(rootDirectory, "README.md"), `# Fixture\n\n${links}\n`, "utf8");
}

test("accepts the current contract, retained legacy approvals, and required README order", async (t) => {
  const rootDirectory = await createFixture(t);

  const result = await checkCanonicalDocumentation(rootDirectory);

  assert.deepEqual(result, {
    currentDocumentCount: 1,
    legacyApprovedDocumentCount: 3,
    requiredDocumentCount: 5,
  });
});

test("rejects a Draft leading Status even when Approved appears later", async (t) => {
  const rootDirectory = await createFixture(t);
  await writeFile(
    join(rootDirectory, "CONTEXT.md"),
    "# Context\n\nStatus: **Draft**\n\nThis was Approved in an unrelated example.\n",
    "utf8",
  );

  await assert.rejects(
    checkCanonicalDocumentation(rootDirectory),
    /CONTEXT\.md must declare an Approved or Accepted Status immediately after its title/,
  );
});

test("rejects an approved Status that is not the first field after the title", async (t) => {
  const rootDirectory = await createFixture(t);
  await writeFile(
    join(rootDirectory, "docs/PRODUCT_SPEC.md"),
    "# Product specification\n\nLast updated: 2026-07-24\n\nStatus: **Approved**\n",
    "utf8",
  );

  await assert.rejects(
    checkCanonicalDocumentation(rootDirectory),
    /docs\/PRODUCT_SPEC\.md must declare an Approved or Accepted Status immediately after its title/,
  );
});

test("rejects required README links in the wrong order", async (t) => {
  const rootDirectory = await createFixture(t);
  const reordered = [REQUIRED_DOCUMENTS[1], REQUIRED_DOCUMENTS[0], ...REQUIRED_DOCUMENTS.slice(2)];
  await writeReadme(rootDirectory, reordered);

  await assert.rejects(
    checkCanonicalDocumentation(rootDirectory),
    /README\.md must link required planning documents in this order/,
  );
});
