import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const REQUIRED_DOCUMENTS = Object.freeze([
  "CONTEXT.md",
  "docs/PRODUCT_SPEC.md",
  "docs/IMPLEMENTATION_PLAN.md",
  "docs/DECISIONS.md",
  "docs/research/platform-capabilities.md",
]);

const CURRENT_DOCUMENTS = Object.freeze(REQUIRED_DOCUMENTS.slice(0, 1));
const LEGACY_APPROVED_DOCUMENTS = Object.freeze(REQUIRED_DOCUMENTS.slice(1, 4));
const APPROVED_DOCUMENTS = Object.freeze([...CURRENT_DOCUMENTS, ...LEGACY_APPROVED_DOCUMENTS]);
const APPROVED_STATUS = /^Status: \*\*(?:Approved|Accepted)(?:(?:\s+—|;)[^*]+)?\*\*$/;

export async function checkCanonicalDocumentation(rootDirectory = process.cwd()) {
  const readDocument = async (document) => {
    try {
      return await readFile(resolve(rootDirectory, document), "utf8");
    } catch (error) {
      if (error !== null && typeof error === "object" && error.code === "ENOENT") {
        throw new Error(`Missing required planning document: ${document}`, {
          cause: error,
        });
      }

      throw error;
    }
  };

  const readme = await readDocument("README.md");
  let previousLinkIndex = -1;

  for (const document of REQUIRED_DOCUMENTS) {
    await readDocument(document);
    const linkIndex = readme.indexOf(`](${document})`);

    if (linkIndex === -1) {
      throw new Error(`README.md does not link to required planning document: ${document}`);
    }

    if (linkIndex <= previousLinkIndex) {
      throw new Error(
        `README.md must link required planning documents in this order: ${REQUIRED_DOCUMENTS.join(
          " → ",
        )}`,
      );
    }

    previousLinkIndex = linkIndex;
  }

  for (const document of APPROVED_DOCUMENTS) {
    const content = await readDocument(document);
    assertLeadingApprovedStatus(document, content);
  }

  return Object.freeze({
    currentDocumentCount: CURRENT_DOCUMENTS.length,
    legacyApprovedDocumentCount: LEGACY_APPROVED_DOCUMENTS.length,
    requiredDocumentCount: REQUIRED_DOCUMENTS.length,
  });
}

function assertLeadingApprovedStatus(document, content) {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const title = lines[0] ?? "";
  let statusIndex = 1;

  while (lines[statusIndex]?.trim() === "") {
    statusIndex += 1;
  }

  if (!title.startsWith("# ") || !APPROVED_STATUS.test(lines[statusIndex] ?? "")) {
    throw new Error(
      `${document} must declare an Approved or Accepted Status immediately after its title.`,
    );
  }
}

const entryPath = process.argv[1];

if (entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  const result = await checkCanonicalDocumentation();
  console.log(
    `Verified ${result.requiredDocumentCount} required planning documents: ${result.currentDocumentCount} current SSH-first contract and ${result.legacyApprovedDocumentCount} approved legacy prototype contracts.`,
  );
}
