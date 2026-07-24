import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EXPECTED_WORKSPACE_DEPENDENCIES = Object.freeze({
  "@opendelegate/acceptance": Object.freeze([
    "@opendelegate/agent-adapter",
    "@opendelegate/computer-use",
    "@opendelegate/event-store",
    "@opendelegate/knowledge",
    "@opendelegate/orchestrator",
    "@opendelegate/policy",
    "@opendelegate/protocol",
    "@opendelegate/resource-locks",
    "@opendelegate/scheduler",
    "@opendelegate/secrets",
    "@opendelegate/storage-sql",
    "@opendelegate/transport",
  ]),
  "@opendelegate/admin-web": Object.freeze([]),
  "@opendelegate/agent-adapter": Object.freeze(["@opendelegate/domain"]),
  "@opendelegate/agent-adapters": Object.freeze([]),
  "@opendelegate/artifact-gateway": Object.freeze(["@opendelegate/artifact-store"]),
  "@opendelegate/artifact-store": Object.freeze(["@opendelegate/domain"]),
  "@opendelegate/computer-use": Object.freeze([
    "@opendelegate/domain",
    "@opendelegate/resource-locks",
  ]),
  "@opendelegate/computer-use-os": Object.freeze([]),
  "@opendelegate/configuration": Object.freeze([]),
  "@opendelegate/control-plane": Object.freeze([
    "@opendelegate/event-store",
    "@opendelegate/owner-auth",
    "@opendelegate/protocol",
    "@opendelegate/task-service",
  ]),
  "@opendelegate/device-discovery": Object.freeze(["@opendelegate/domain"]),
  "@opendelegate/device-identity": Object.freeze([]),
  "@opendelegate/discord-adapter": Object.freeze([]),
  "@opendelegate/domain": Object.freeze([]),
  "@opendelegate/event-store": Object.freeze([]),
  "@opendelegate/knowledge": Object.freeze([]),
  "@opendelegate/main": Object.freeze([
    "@opendelegate/control-plane",
    "@opendelegate/owner-auth",
    "@opendelegate/storage-sql",
    "@opendelegate/task-service",
  ]),
  "@opendelegate/orchestrator": Object.freeze([
    "@opendelegate/domain",
    "@opendelegate/event-store",
    "@opendelegate/protocol",
    "@opendelegate/scheduler",
  ]),
  "@opendelegate/owner-auth": Object.freeze([]),
  "@opendelegate/policy": Object.freeze([]),
  "@opendelegate/platform-services": Object.freeze([]),
  "@opendelegate/protocol": Object.freeze(["@opendelegate/domain"]),
  "@opendelegate/resource-locks": Object.freeze([]),
  "@opendelegate/scheduler": Object.freeze(["@opendelegate/domain"]),
  "@opendelegate/secrets": Object.freeze([]),
  "@opendelegate/simulator": Object.freeze(["@opendelegate/event-store"]),
  "@opendelegate/storage-sql": Object.freeze([
    "@opendelegate/event-store",
    "@opendelegate/owner-auth",
  ]),
  "@opendelegate/task-service": Object.freeze([
    "@opendelegate/domain",
    "@opendelegate/event-store",
    "@opendelegate/protocol",
  ]),
  "@opendelegate/transport": Object.freeze([]),
  "@opendelegate/worker-runtime": Object.freeze([
    "@opendelegate/protocol",
    "@opendelegate/transport",
  ]),
});

const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const workspaceParents = ["apps", "packages", "tooling"];
const sourceExtensions = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const ignoredDirectoryNames = new Set([
  ".git",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);

export function validateWorkspaceGraph(workspaces, expectedDependencies) {
  const errors = [];
  const actualByName = new Map();

  for (const workspace of workspaces) {
    if (actualByName.has(workspace.name)) {
      errors.push(`Workspace name ${workspace.name} is declared more than once.`);
      continue;
    }
    actualByName.set(workspace.name, {
      ...workspace,
      internalDependencies: [...new Set(workspace.internalDependencies)].sort(),
    });
  }

  const expectedNames = Object.keys(expectedDependencies).sort();
  const actualNames = [...actualByName.keys()].sort();
  const expectedNameSet = new Set(expectedNames);
  const actualNameSet = new Set(actualNames);

  for (const name of expectedNames) {
    if (!actualNameSet.has(name)) {
      errors.push(`Expected workspace ${name} is missing.`);
    }
  }

  for (const name of actualNames) {
    if (!expectedNameSet.has(name)) {
      errors.push(`Workspace ${name} has no boundary-map entry.`);
    }
  }

  for (const name of actualNames) {
    const workspace = actualByName.get(name);
    if (workspace === undefined) {
      continue;
    }

    for (const dependency of workspace.internalDependencies) {
      if (!actualNameSet.has(dependency)) {
        errors.push(`${name} depends on unknown workspace ${dependency}.`);
      }
    }

    const allowed = new Set(expectedDependencies[name] ?? []);
    for (const dependency of workspace.internalDependencies) {
      if (!allowed.has(dependency)) {
        errors.push(`${name} has unexpected workspace dependency ${dependency}.`);
      }
    }

    if (expectedNameSet.has(name)) {
      for (const dependency of [...allowed].sort()) {
        if (!workspace.internalDependencies.includes(dependency)) {
          errors.push(`${name} is missing mapped workspace dependency ${dependency}.`);
        }
      }
    }
  }

  errors.push(...findDependencyCycles(actualByName, actualNameSet));
  return errors;
}

export function validateWorkspaceTooling(workspaces) {
  const errors = [];

  for (const workspace of [...workspaces].sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (workspace.hasLocalTsconfig !== true) {
      errors.push(`${workspace.name} must have a package-local tsconfig.json.`);
    }
    if (workspace.hasTypecheckScript !== true) {
      errors.push(`${workspace.name} must expose an isolated typecheck script.`);
    }
    if (typeof workspace.testScript !== "string" || workspace.testScript.trim() === "") {
      errors.push(`${workspace.name} must expose a test script.`);
    } else if (/(?:^|\s)--test(?:=|\s+(?!-))/.test(workspace.testScript)) {
      errors.push(
        `${workspace.name} must use suite-wide Node test discovery instead of positional test paths.`,
      );
    }
  }

  return errors;
}

export async function auditWorkspaceBoundaries(repositoryRoot) {
  const workspaces = await discoverWorkspaces(repositoryRoot);
  const errors = [
    ...validateWorkspaceGraph(workspaces, EXPECTED_WORKSPACE_DEPENDENCIES),
    ...validateWorkspaceTooling(workspaces),
  ];
  const workspaceNames = new Set(workspaces.map((workspace) => workspace.name));

  for (const workspace of workspaces) {
    const declared = new Set(workspace.internalDependencies);
    const importedPackages = await readInternalImports(workspace.directory);
    for (const importedPackage of importedPackages) {
      if (
        importedPackage !== workspace.name &&
        workspaceNames.has(importedPackage) &&
        !declared.has(importedPackage)
      ) {
        errors.push(
          `${workspace.name} imports ${importedPackage} without declaring a workspace dependency.`,
        );
      }
    }
  }

  return [...new Set(errors)].sort((left, right) => left.localeCompare(right));
}

async function discoverWorkspaces(repositoryRoot) {
  const workspaces = [];

  for (const parentName of workspaceParents) {
    const parentPath = join(repositoryRoot, parentName);
    let entries;
    try {
      entries = await readdir(parentPath, { withFileTypes: true });
    } catch (error) {
      if (error !== null && typeof error === "object" && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const directory = join(parentPath, entry.name);
      const manifestPath = join(directory, "package.json");
      let manifestText;
      try {
        manifestText = await readFile(manifestPath, "utf8");
      } catch (error) {
        if (error !== null && typeof error === "object" && error.code === "ENOENT") {
          continue;
        }
        throw error;
      }

      const manifest = JSON.parse(manifestText);
      if (typeof manifest.name !== "string" || manifest.name.trim() === "") {
        throw new Error(
          `Workspace manifest ${relative(repositoryRoot, manifestPath)} has no valid name.`,
        );
      }

      const internalDependencies = new Set();
      for (const field of dependencyFields) {
        const dependencies = manifest[field];
        if (dependencies === null || typeof dependencies !== "object") {
          continue;
        }
        for (const dependency of Object.keys(dependencies)) {
          if (dependency.startsWith("@opendelegate/")) {
            internalDependencies.add(dependency);
          }
        }
      }

      workspaces.push({
        name: manifest.name,
        directory,
        hasLocalTsconfig: await fileExists(join(directory, "tsconfig.json")),
        hasTypecheckScript:
          manifest.scripts !== null &&
          typeof manifest.scripts === "object" &&
          typeof manifest.scripts.typecheck === "string" &&
          manifest.scripts.typecheck.trim() !== "",
        testScript:
          manifest.scripts !== null &&
          typeof manifest.scripts === "object" &&
          typeof manifest.scripts.test === "string"
            ? manifest.scripts.test
            : undefined,
        internalDependencies: [...internalDependencies].sort(),
      });
    }
  }

  return workspaces.sort((left, right) => left.name.localeCompare(right.name));
}

async function fileExists(path) {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function findDependencyCycles(actualByName, actualNameSet) {
  const state = new Map();
  const stack = [];
  const reported = new Set();
  const errors = [];

  const visit = (name) => {
    state.set(name, "visiting");
    stack.push(name);
    const workspace = actualByName.get(name);
    const dependencies =
      workspace?.internalDependencies.filter((dependency) => actualNameSet.has(dependency)) ?? [];

    for (const dependency of dependencies) {
      const dependencyState = state.get(dependency);
      if (dependencyState === "visiting") {
        const cycleStart = stack.indexOf(dependency);
        const cycle = [...stack.slice(cycleStart), dependency];
        const signature = canonicalCycleSignature(cycle);
        if (!reported.has(signature)) {
          reported.add(signature);
          errors.push(`Workspace dependency cycle detected: ${cycle.join(" -> ")}.`);
        }
        continue;
      }
      if (dependencyState !== "visited") {
        visit(dependency);
      }
    }

    stack.pop();
    state.set(name, "visited");
  };

  for (const name of [...actualNameSet].sort()) {
    if (state.get(name) === undefined) {
      visit(name);
    }
  }

  return errors;
}

function canonicalCycleSignature(cycle) {
  const nodes = cycle.slice(0, -1);
  const rotations = nodes.map((_, index) => [...nodes.slice(index), ...nodes.slice(0, index)]);
  rotations.sort((left, right) => left.join("\0").localeCompare(right.join("\0")));
  return rotations[0]?.join("\0") ?? "";
}

async function readInternalImports(workspaceDirectory) {
  const imports = new Set();
  const files = await listSourceFiles(workspaceDirectory);
  const importPattern =
    /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'](@opendelegate\/[a-z0-9-]+)(?:\/[^"']*)?["']/g;

  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const importedPackage = match[1];
      if (importedPackage !== undefined) {
        imports.add(importedPackage);
      }
    }
  }

  return [...imports].sort();
}

async function listSourceFiles(directory) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (ignoredDirectoryNames.has(entry.name)) {
      continue;
    }
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(entryPath)));
      continue;
    }
    if (entry.isFile() && sourceExtensions.has(extensionOf(entry.name))) {
      files.push(entryPath);
    }
  }

  return files;
}

function extensionOf(fileName) {
  const dot = fileName.lastIndexOf(".");
  return dot === -1 ? "" : fileName.slice(dot);
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);

if (invokedFile === resolve(currentFile)) {
  const repositoryRoot = resolve(dirname(currentFile), "..");
  const errors = await auditWorkspaceBoundaries(repositoryRoot);
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exitCode = 1;
  } else {
    console.log("Workspace boundaries match ADR-0003.");
  }
}
