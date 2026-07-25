import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export async function withLinuxReleaseSmokeSecretFixture(staging, operation) {
  if (typeof operation !== "function") {
    throw new Error("The Linux release smoke operation must be callable.");
  }
  const canonicalStaging = await requireRegularDirectory(staging);
  const fixtureRoot = await mkdtemp(
    join(dirname(canonicalStaging), ".od-linux-release-smoke-secret-"),
  );
  assertOutside(canonicalStaging, fixtureRoot);
  const credentialDirectory = join(fixtureRoot, "credentials");
  const credentialName = "opendelegate-release-smoke-vault-key";
  const credentialPath = join(credentialDirectory, credentialName);
  const vaultRoot = join(fixtureRoot, "vault");
  const configPath = join(fixtureRoot, "secret-backend.json");
  const credential = randomBytes(32);
  try {
    await Promise.all([
      mkdir(credentialDirectory, { mode: 0o700 }),
      mkdir(vaultRoot, { mode: 0o700 }),
    ]);
    if (process.platform !== "win32") {
      await Promise.all([
        chmod(fixtureRoot, 0o700),
        chmod(credentialDirectory, 0o700),
        chmod(vaultRoot, 0o700),
      ]);
    }
    await writeFile(credentialPath, credential, {
      flag: "wx",
      mode: 0o400,
    });
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          backend: "linux-systemd-credential-vault",
          credentialName,
          vaultRoot,
        },
        null,
        2,
      )}\n`,
      {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      },
    );
    const outcome = await operation(
      Object.freeze({
        initArguments: Object.freeze(["--secret-backend-config", configPath]),
        environment: Object.freeze({
          CREDENTIALS_DIRECTORY: credentialDirectory,
        }),
      }),
    );
    if (
      outcome === null ||
      typeof outcome !== "object" ||
      !Array.isArray(outcome.observedOutput) ||
      outcome.observedOutput.some((value) => typeof value !== "string")
    ) {
      throw new Error("The Linux release smoke operation returned no bounded disclosure proof.");
    }
    assertSecretAbsentFromOutput(credential, outcome.observedOutput);
    await assertSecretAbsentFromTree(credential, canonicalStaging);
    return outcome.value;
  } finally {
    credential.fill(0);
    await rm(fixtureRoot, { force: true, recursive: true });
  }
}

function assertSecretAbsentFromOutput(credential, output) {
  const spellings = secretSpellings(credential);
  if (output.some((value) => spellings.some((spelling) => value.includes(spelling)))) {
    throw new Error("The Linux release smoke credential material entered captured output.");
  }
}

async function assertSecretAbsentFromTree(credential, root) {
  const encodedSpellings = secretSpellings(credential).map((value) => Buffer.from(value, "utf8"));
  for (const path of await listRegularFiles(root)) {
    const bytes = await readFile(path);
    if (
      bytes.indexOf(credential) !== -1 ||
      encodedSpellings.some((spelling) => bytes.indexOf(spelling) !== -1)
    ) {
      throw new Error("The Linux release smoke credential material entered the release payload.");
    }
  }
}

function secretSpellings(credential) {
  return [
    credential.toString("hex"),
    credential.toString("base64"),
    credential.toString("base64url"),
  ];
}

async function listRegularFiles(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await listRegularFiles(path)));
    } else if (entry.isFile()) {
      paths.push(path);
    } else {
      throw new Error("The release payload changed into a non-regular filesystem tree.");
    }
  }
  return paths;
}

async function requireRegularDirectory(path) {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) {
    throw new Error("The Linux release smoke payload must use an absolute directory.");
  }
  const lexicalPath = resolve(path);
  const [lexicalMetadata, canonicalPath] = await Promise.all([
    lstat(lexicalPath),
    realpath(lexicalPath),
  ]);
  const canonicalMetadata = await lstat(canonicalPath);
  if (
    !lexicalMetadata.isDirectory() ||
    lexicalMetadata.isSymbolicLink() ||
    !canonicalMetadata.isDirectory() ||
    canonicalMetadata.isSymbolicLink()
  ) {
    throw new Error("The Linux release smoke payload must be a regular directory.");
  }
  return canonicalPath;
}

function assertOutside(parent, candidate) {
  const relationship = relative(resolve(parent), resolve(candidate));
  if (
    relationship === "" ||
    (!isAbsolute(relationship) && relationship !== ".." && !relationship.startsWith(`..${sep}`))
  ) {
    throw new Error("Linux release smoke credentials must remain outside the release payload.");
  }
}
