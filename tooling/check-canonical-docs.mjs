import { access, readFile } from "node:fs/promises";

const canonicalDocuments = [
  "CONTEXT.md",
  "docs/PRODUCT_SPEC.md",
  "docs/IMPLEMENTATION_PLAN.md",
  "docs/DECISIONS.md",
  "docs/research/platform-capabilities.md",
];
const approvedDocuments = [
  "CONTEXT.md",
  "docs/PRODUCT_SPEC.md",
  "docs/IMPLEMENTATION_PLAN.md",
  "docs/DECISIONS.md",
];
const readme = await readFile("README.md", "utf8");

for (const document of canonicalDocuments) {
  await access(document);

  if (!readme.includes(`(${document})`)) {
    throw new Error(`README.md does not link to canonical document: ${document}`);
  }
}

for (const document of approvedDocuments) {
  const content = await readFile(document, "utf8");

  if (!content.includes("Approved") && !content.includes("Accepted")) {
    throw new Error(`Canonical document is not approved: ${document}`);
  }
}

console.log(`Verified ${canonicalDocuments.length} canonical planning documents.`);
