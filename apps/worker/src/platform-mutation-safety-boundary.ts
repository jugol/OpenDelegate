import { createHash } from "node:crypto";
import { constants as fileConstants, type BigIntStats, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  PlatformMutationError,
  type PlatformMutationExecutableId,
  type PlatformMutationProcessPreflight,
  type PlatformMutationProcessRequest,
  type PlatformMutationProcessRunner,
} from "@opendelegate/platform-services";

const NPM_REGISTRY = "https://registry.npmjs.org/";
const MAXIMUM_PACKAGE_JSON_BYTES = 1_048_576;
const MAXIMUM_LOCKFILE_BYTES = 16 * 1_048_576;
const MAXIMUM_JSON_NODES = 200_000;
const SAFE_NPM_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]{0,63}\/)?[a-z0-9][a-z0-9._~-]{0,127}$/u;
const SAFE_REGISTRY_SELECTOR = /^[A-Za-z0-9*^~<>=|.+ -]{1,256}$/u;
const NPM_ARGUMENT_PREFIX = Object.freeze([
  "install",
  "--save-exact",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  `--registry=${NPM_REGISTRY}`,
]);

export interface WorkerSystemPackageSourceVerifier {
  verify(input: {
    readonly executable: string;
    readonly manager: PlatformMutationExecutableId;
  }): Promise<boolean>;
}

export interface CreateWorkerPlatformMutationSafetyBoundaryOptions {
  readonly stateDirectory: string;
  readonly sourceCheckoutRoot: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly executablePaths: readonly string[];
  readonly systemPackageSourceVerifier?: WorkerSystemPackageSourceVerifier;
}

export interface WorkerPlatformMutationSafetyBoundary {
  readonly environment: NodeJS.ProcessEnv;
  readonly processPreflight: PlatformMutationProcessPreflight;
  wrapProcessRunner(runner: PlatformMutationProcessRunner): PlatformMutationProcessRunner;
  close(): Promise<void>;
}

/**
 * Creates a fresh, process-lifetime package-manager home. No provider/global
 * package configuration, credential environment, proxy, or Device-local state
 * path is inherited. Project auto-install admits only npm's script-disabled
 * official-registry path. System installs admit only the platform manager's
 * typed install form after its exact configured executable is pinned by the
 * production composition; adding or changing a source remains a separate
 * protected action.
 */
export async function createWorkerPlatformMutationSafetyBoundary(
  options: CreateWorkerPlatformMutationSafetyBoundaryOptions,
): Promise<WorkerPlatformMutationSafetyBoundary> {
  validateOptions(options);
  const checkout = await realpath(options.sourceCheckoutRoot);
  const state = await realpath(options.stateDirectory);
  if (isWithin(checkout, state)) {
    throw unsafeMutation();
  }

  const processRoot = join(state, "platform-mutation-processes");
  await mkdir(processRoot, { recursive: true, mode: 0o700 });
  await requirePrivateDirectory(processRoot);
  const sessionRoot = await mkdtemp(join(processRoot, "session-"));
  await chmod(sessionRoot, 0o700);
  try {
    const home = join(sessionRoot, "home");
    const configuration = join(sessionRoot, "config");
    const cache = join(sessionRoot, "cache");
    const temporary = join(sessionRoot, "tmp");
    await Promise.all(
      [home, configuration, cache, temporary].map(async (path) => {
        await mkdir(path, { mode: 0o700 });
        await requirePrivateDirectory(path);
      }),
    );
    const npmUserConfig = join(configuration, "npm-user.ini");
    const npmGlobalConfig = join(configuration, "npm-global.ini");
    const recoveryRoot = join(processRoot, "recovery");
    await mkdir(recoveryRoot, { mode: 0o700 });
    await requirePrivateDirectory(recoveryRoot);
    await Promise.all([
      writeFile(npmUserConfig, "", { encoding: "utf8", flag: "wx", mode: 0o600 }),
      writeFile(npmGlobalConfig, "", { encoding: "utf8", flag: "wx", mode: 0o600 }),
    ]);

    const environment = isolatedEnvironment({
      source: options.environment,
      executablePaths: options.executablePaths,
      home,
      configuration,
      cache,
      temporary,
      npmUserConfig,
      npmGlobalConfig,
    });
    const staging = new NpmStagingBoundary({
      sessionRoot,
      recoveryRoot,
      ...(options.systemPackageSourceVerifier === undefined
        ? {}
        : { systemPackageSourceVerifier: options.systemPackageSourceVerifier }),
    });
    let closed = false;
    return Object.freeze({
      environment,
      processPreflight: staging.processPreflight,
      wrapProcessRunner: (runner: PlatformMutationProcessRunner) =>
        staging.wrapProcessRunner(runner),
      async close() {
        if (closed) {
          return;
        }
        closed = true;
        staging.close();
        await rm(sessionRoot, { recursive: true, force: true });
      },
    });
  } catch (error) {
    await rm(sessionRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

interface NpmWorkspaceSnapshot {
  readonly root: string;
  readonly device: number;
  readonly digest: string;
  readonly files: ReadonlyMap<string, Buffer>;
  readonly nodeModulesIdentity?: string;
}

interface PreparedNpmInstall {
  readonly requestDigest: string;
  readonly stagingDirectory: string;
  readonly snapshot: NpmWorkspaceSnapshot;
}

class NpmStagingBoundary {
  readonly processPreflight: PlatformMutationProcessPreflight;
  readonly #sessionRoot: string;
  readonly #recoveryRoot: string;
  readonly #systemVerifier: WorkerSystemPackageSourceVerifier | undefined;
  readonly #validated = new Map<
    string,
    { readonly digest: string; readonly timer: NodeJS.Timeout }
  >();
  readonly #prepared = new Map<string, PreparedNpmInstall>();
  #closed = false;

  public constructor(options: {
    readonly sessionRoot: string;
    readonly recoveryRoot: string;
    readonly systemPackageSourceVerifier?: WorkerSystemPackageSourceVerifier;
  }) {
    this.#sessionRoot = options.sessionRoot;
    this.#recoveryRoot = options.recoveryRoot;
    this.#systemVerifier = options.systemPackageSourceVerifier;
    this.processPreflight = Object.freeze({
      assertSafe: (request: PlatformMutationProcessRequest) => this.#assertSafe(request),
    });
  }

  public wrapProcessRunner(runner: PlatformMutationProcessRunner): PlatformMutationProcessRunner {
    if (runner === null || typeof runner !== "object" || typeof runner.run !== "function") {
      throw unsafeMutation();
    }
    return Object.freeze({
      run: async (request: PlatformMutationProcessRequest) => {
        if (request.actionCategory !== "project-dependency-install") {
          return runner.run(request);
        }
        const prepared = this.#prepared.get(request.commandId);
        if (prepared === undefined || prepared.requestDigest !== processRequestDigest(request)) {
          throw unsafeMutation();
        }
        this.#prepared.delete(request.commandId);
        try {
          const result = await runner.run({
            ...request,
            workingDirectory: prepared.stagingDirectory,
          });
          if (result.exitCode === 0) {
            await promotePreparedNpmInstall(prepared, this.#recoveryRoot);
          }
          return result;
        } finally {
          disposeSnapshot(prepared.snapshot);
          await rm(prepared.stagingDirectory, { recursive: true, force: true }).catch(
            () => undefined,
          );
        }
      },
    });
  }

  public close(): void {
    this.#closed = true;
    for (const entry of this.#validated.values()) {
      clearTimeout(entry.timer);
    }
    this.#validated.clear();
    for (const prepared of this.#prepared.values()) {
      disposeSnapshot(prepared.snapshot);
    }
    this.#prepared.clear();
  }

  async #assertSafe(request: PlatformMutationProcessRequest): Promise<void> {
    if (this.#closed) {
      throw unsafeMutation();
    }
    if (request.actionCategory === "configured-official-package-install") {
      if (
        this.#systemVerifier === undefined ||
        !(await this.#systemVerifier
          .verify({ executable: request.executable, manager: request.executableId })
          .catch(() => false))
      ) {
        throw unsafeMutation();
      }
      return;
    }
    if (request.actionCategory !== "project-dependency-install") {
      return;
    }
    assertSafeNpmRequest(request);
    const requestDigest = processRequestDigest(request);
    const snapshot = await readSafeNpmWorkspace(request.workingDirectory as string);
    const previous = this.#validated.get(request.commandId);
    if (previous === undefined) {
      if (this.#validated.size >= 1_024) {
        disposeSnapshot(snapshot);
        throw unsafeMutation();
      }
      const timer = setTimeout(() => {
        this.#validated.delete(request.commandId);
      }, 5 * 60_000);
      timer.unref();
      this.#validated.set(request.commandId, { digest: snapshot.digest, timer });
      disposeSnapshot(snapshot);
      return;
    }
    clearTimeout(previous.timer);
    this.#validated.delete(request.commandId);
    if (previous.digest !== snapshot.digest || this.#prepared.has(request.commandId)) {
      disposeSnapshot(snapshot);
      throw unsafeMutation();
    }
    const stagingDirectory = await mkdtemp(join(this.#sessionRoot, "npm-install-"));
    await chmod(stagingDirectory, 0o700);
    try {
      await writeSnapshot(stagingDirectory, snapshot);
      this.#prepared.set(request.commandId, {
        requestDigest,
        stagingDirectory,
        snapshot,
      });
    } catch (error) {
      disposeSnapshot(snapshot);
      await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }
}

function assertSafeNpmRequest(request: PlatformMutationProcessRequest): void {
  const packages = request.arguments.slice(NPM_ARGUMENT_PREFIX.length);
  if (
    request.executableId !== "npm" ||
    request.workingDirectory === undefined ||
    packages.length === 0 ||
    packages.length > 64 ||
    !NPM_ARGUMENT_PREFIX.every((value, index) => request.arguments[index] === value) ||
    packages.some(
      (value) =>
        value.startsWith("-") ||
        Buffer.byteLength(value, "utf8") > 256 ||
        !isSafeNpmPackageSpec(value),
    )
  ) {
    throw unsafeMutation();
  }
}

async function readSafeNpmWorkspace(workspace: string): Promise<NpmWorkspaceSnapshot> {
  const workspaceMetadata = await lstat(workspace).catch(() => undefined);
  if (
    workspaceMetadata === undefined ||
    !workspaceMetadata.isDirectory() ||
    workspaceMetadata.isSymbolicLink()
  ) {
    throw unsafeMutation();
  }
  const canonicalWorkspace = await realpath(workspace);
  if (canonicalWorkspace !== resolve(workspace)) {
    throw unsafeMutation();
  }
  if (await pathExists(join(canonicalWorkspace, ".npmrc"))) {
    throw unsafeMutation();
  }

  const manifest = await readBoundedJsonFile(
    join(canonicalWorkspace, "package.json"),
    canonicalWorkspace,
    MAXIMUM_PACKAGE_JSON_BYTES,
  );
  assertSafePackageManifest(manifest.value);
  const files = new Map<string, Buffer>([["package.json", manifest.bytes]]);
  const lockfiles: string[] = [];
  for (const relativePath of ["package-lock.json", "npm-shrinkwrap.json"]) {
    const filename = join(canonicalWorkspace, relativePath);
    if (!(await pathExists(filename))) {
      continue;
    }
    const lockfile = await readBoundedJsonFile(
      filename,
      canonicalWorkspace,
      MAXIMUM_LOCKFILE_BYTES,
    );
    assertSafeNpmLockfile(lockfile.value);
    files.set(relativePath, lockfile.bytes);
    lockfiles.push(relativePath);
  }
  if (lockfiles.length > 1) {
    disposeFiles(files);
    throw unsafeMutation();
  }
  const nodeModules = await lstat(join(canonicalWorkspace, "node_modules")).catch(() => undefined);
  if (nodeModules !== undefined && (!nodeModules.isDirectory() || nodeModules.isSymbolicLink())) {
    disposeFiles(files);
    throw unsafeMutation();
  }
  const digest = createHash("sha256");
  for (const [name, bytes] of [...files].sort(([left], [right]) =>
    left.localeCompare(right, "en"),
  )) {
    digest.update(name).update("\0").update(bytes).update("\0");
  }
  digest
    .update("node_modules\0")
    .update(nodeModules === undefined ? "absent" : fileIdentity(nodeModules));
  return Object.freeze({
    root: canonicalWorkspace,
    device: workspaceMetadata.dev,
    digest: `sha256:${digest.digest("hex")}`,
    files,
    ...(nodeModules === undefined ? {} : { nodeModulesIdentity: fileIdentity(nodeModules) }),
  });
}

async function readBoundedJsonFile(
  filename: string,
  expectedRoot: string,
  maximumBytes: number,
): Promise<{ readonly value: unknown; readonly bytes: Buffer }> {
  const before = await lstat(filename).catch(() => undefined);
  if (
    before === undefined ||
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size > maximumBytes
  ) {
    throw unsafeMutation();
  }
  const canonical = await realpath(filename);
  if (!isWithin(expectedRoot, canonical)) {
    throw unsafeMutation();
  }
  const bytes = await readFile(canonical);
  const after = await lstat(canonical).catch(() => undefined);
  if (
    bytes.byteLength > maximumBytes ||
    after === undefined ||
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.nlink !== 1 ||
    fileIdentity(before) !== fileIdentity(after) ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    bytes.fill(0);
    throw unsafeMutation();
  }
  try {
    return {
      value: JSON.parse(bytes.toString("utf8")) as unknown,
      bytes,
    };
  } catch {
    bytes.fill(0);
    throw unsafeMutation();
  }
}

function assertSafePackageManifest(input: unknown): void {
  if (!isRecord(input) || Object.hasOwn(input, "workspaces")) {
    throw unsafeMutation();
  }
  const packageManager = input["packageManager"];
  if (
    packageManager !== undefined &&
    (typeof packageManager !== "string" || !/^npm@[0-9][A-Za-z0-9.+-]{0,63}$/u.test(packageManager))
  ) {
    throw unsafeMutation();
  }
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const dependencies = input[field];
    if (dependencies === undefined) {
      continue;
    }
    if (
      !isRecord(dependencies) ||
      Object.values(dependencies).some(
        (value) => typeof value !== "string" || !isSafeRegistrySelector(value),
      )
    ) {
      throw unsafeMutation();
    }
  }
  if (input["overrides"] !== undefined) {
    assertSafeOverrideTree(input["overrides"], 0);
  }
}

function assertSafeOverrideTree(input: unknown, depth: number): void {
  if (depth > 32 || !isRecord(input)) {
    throw unsafeMutation();
  }
  for (const value of Object.values(input)) {
    if (typeof value === "string") {
      if (!isSafeRegistrySelector(value)) {
        throw unsafeMutation();
      }
    } else {
      assertSafeOverrideTree(value, depth + 1);
    }
  }
}

function assertSafeNpmLockfile(input: unknown): void {
  if (!isRecord(input)) {
    throw unsafeMutation();
  }
  const packages = input["packages"];
  if (packages !== undefined) {
    if (!isRecord(packages)) {
      throw unsafeMutation();
    }
    for (const path of Object.keys(packages)) {
      if (
        path !== "" &&
        (!path.startsWith("node_modules/") ||
          path.includes("..") ||
          path.includes("\\") ||
          isAbsolute(path))
      ) {
        throw unsafeMutation();
      }
    }
  }
  let visited = 0;
  const visit = (value: unknown, key: string | undefined, depth: number): void => {
    visited += 1;
    if (visited > MAXIMUM_JSON_NODES || depth > 64) {
      throw unsafeMutation();
    }
    if (key === "resolved") {
      if (typeof value !== "string" || !isOfficialNpmRegistryUrl(value)) {
        throw unsafeMutation();
      }
      return;
    }
    if (key === "version") {
      if (typeof value !== "string" || !isSafeRegistrySelector(value)) {
        throw unsafeMutation();
      }
      return;
    }
    if (key === "link" && value === true) {
      throw unsafeMutation();
    }
    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry, undefined, depth + 1));
      return;
    }
    if (isRecord(value)) {
      for (const [childKey, child] of Object.entries(value)) {
        visit(child, childKey, depth + 1);
      }
    }
  };
  visit(input, undefined, 0);
}

function isSafeNpmPackageSpec(value: string): boolean {
  let packageName = value;
  let selector: string | undefined;
  if (value.startsWith("@")) {
    const scopeSeparator = value.indexOf("/");
    if (scopeSeparator < 2) {
      return false;
    }
    const selectorSeparator = value.indexOf("@", scopeSeparator + 1);
    if (selectorSeparator >= 0) {
      packageName = value.slice(0, selectorSeparator);
      selector = value.slice(selectorSeparator + 1);
    }
  } else {
    const selectorSeparator = value.lastIndexOf("@");
    if (selectorSeparator > 0) {
      packageName = value.slice(0, selectorSeparator);
      selector = value.slice(selectorSeparator + 1);
    }
  }
  return (
    packageName.length <= 214 &&
    SAFE_NPM_PACKAGE_NAME.test(packageName) &&
    !packageName.endsWith(".tgz") &&
    !packageName.endsWith(".tar.gz") &&
    (selector === undefined || isSafeRegistrySelector(selector))
  );
}

function isSafeRegistrySelector(value: string): boolean {
  return (
    SAFE_REGISTRY_SELECTOR.test(value) &&
    value.trim() === value &&
    value !== "." &&
    value !== ".." &&
    !value.endsWith(".tgz") &&
    !value.endsWith(".tar.gz")
  );
}

function isOfficialNpmRegistryUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "registry.npmjs.org" &&
      url.port === "" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

async function writeSnapshot(
  stagingDirectory: string,
  snapshot: NpmWorkspaceSnapshot,
): Promise<void> {
  const stagingMetadata = await lstat(stagingDirectory);
  if (
    !stagingMetadata.isDirectory() ||
    stagingMetadata.isSymbolicLink() ||
    stagingMetadata.dev !== snapshot.device
  ) {
    throw unsafeMutation();
  }
  for (const [name, bytes] of snapshot.files) {
    if (name !== "package.json" && name !== "package-lock.json" && name !== "npm-shrinkwrap.json") {
      throw unsafeMutation();
    }
    await writeFile(join(stagingDirectory, name), bytes, {
      flag: "wx",
      mode: 0o600,
    });
  }
}

async function promotePreparedNpmInstall(
  prepared: PreparedNpmInstall,
  recoveryRoot: string,
): Promise<void> {
  const staged = await readSafeNpmWorkspace(prepared.stagingDirectory);
  const current = await readSafeNpmWorkspace(prepared.snapshot.root);
  try {
    if (
      staged.device !== prepared.snapshot.device ||
      current.digest !== prepared.snapshot.digest ||
      staged.nodeModulesIdentity === undefined
    ) {
      throw unsafeMutation();
    }
    const initialLocks = [...prepared.snapshot.files.keys()].filter(
      (name) => name !== "package.json",
    );
    const stagedLocks = [...staged.files.keys()].filter((name) => name !== "package.json");
    if (
      stagedLocks.length > 1 ||
      (initialLocks.length === 1 && initialLocks[0] !== stagedLocks[0])
    ) {
      throw unsafeMutation();
    }
    await assertSafeInstalledTree(join(prepared.stagingDirectory, "node_modules"));
    await promoteEntries({
      commandId: processRequestCommandSuffix(prepared.requestDigest),
      expectedSnapshot: prepared.snapshot,
      recoveryRoot,
      stagedSnapshot: staged,
      workspace: prepared.snapshot.root,
      entries: [
        {
          source: join(prepared.stagingDirectory, "node_modules"),
          targetName: "node_modules",
        },
        {
          source: join(prepared.stagingDirectory, "package.json"),
          targetName: "package.json",
        },
        ...stagedLocks.map((name) => ({
          source: join(prepared.stagingDirectory, name),
          targetName: name,
        })),
      ],
    });
  } finally {
    disposeSnapshot(staged);
    disposeSnapshot(current);
  }
}

async function assertSafeInstalledTree(root: string): Promise<void> {
  const rootMetadata = await lstat(root).catch(() => undefined);
  if (rootMetadata === undefined || !rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw unsafeMutation();
  }
  let entries = 0;
  let bytes = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      entries += 1;
      if (entries > 200_000) {
        throw unsafeMutation();
      }
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        const target = await readlink(path);
        const lexicalTarget = resolve(dirname(path), target);
        const canonicalTarget = await realpath(path).catch(() => undefined);
        if (
          isAbsolute(target) ||
          !isWithin(root, lexicalTarget) ||
          canonicalTarget === undefined ||
          !isWithin(root, canonicalTarget)
        ) {
          throw unsafeMutation();
        }
        continue;
      }
      if (metadata.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!metadata.isFile() || metadata.nlink !== 1) {
        throw unsafeMutation();
      }
      bytes += metadata.size;
      if (bytes > 4 * 1024 * 1024 * 1024) {
        throw unsafeMutation();
      }
    }
  };
  await visit(root);
}

async function promoteEntries(input: {
  readonly commandId: string;
  readonly expectedSnapshot: NpmWorkspaceSnapshot;
  readonly recoveryRoot: string;
  readonly stagedSnapshot: NpmWorkspaceSnapshot;
  readonly workspace: string;
  readonly entries: readonly { readonly source: string; readonly targetName: string }[];
}): Promise<void> {
  const completed: Array<{
    readonly source: string;
    readonly target: string;
    readonly targetName: string;
    readonly backup?: string;
    recovery?: string;
  }> = [];
  try {
    for (const entry of input.entries) {
      assertPromotableTargetName(entry.targetName);
      if (resolve(entry.source) !== resolve(input.stagedSnapshot.root, entry.targetName)) {
        throw unsafeMutation();
      }
      await assertSnapshotEntry(entry.source, entry.targetName, input.stagedSnapshot);
      if (
        entry.targetName !== "node_modules" &&
        input.expectedSnapshot.files.has(entry.targetName)
      ) {
        const recoveryPath = recoveryPathFor(input.recoveryRoot, input.commandId, entry.targetName);
        if (await pathExists(recoveryPath)) {
          throw unsafeMutation();
        }
      }
    }
    for (const entry of input.entries) {
      const target = join(input.workspace, entry.targetName);
      const backup = join(
        input.workspace,
        `.opendelegate-backup-${input.commandId}-${basename(entry.targetName)}`,
      );
      if (await pathExists(backup)) {
        throw unsafeMutation();
      }
      const targetExists = await pathExists(target);
      const expectedBytes = input.expectedSnapshot.files.get(entry.targetName);
      const expectedNodeModulesIdentity =
        entry.targetName === "node_modules"
          ? input.expectedSnapshot.nodeModulesIdentity
          : undefined;
      if (
        targetExists !==
        (entry.targetName === "node_modules"
          ? expectedNodeModulesIdentity !== undefined
          : expectedBytes !== undefined)
      ) {
        throw unsafeMutation();
      }
      if (targetExists) {
        const targetMetadata = await lstat(target);
        if (
          targetMetadata.isSymbolicLink() ||
          (entry.targetName === "node_modules"
            ? !targetMetadata.isDirectory()
            : !targetMetadata.isFile() || targetMetadata.nlink !== 1)
        ) {
          throw unsafeMutation();
        }
        if (
          entry.targetName === "node_modules"
            ? fileIdentity(targetMetadata) !== expectedNodeModulesIdentity
            : !(await fileBytesEqual(target, expectedBytes as Buffer))
        ) {
          throw unsafeMutation();
        }
        await rename(target, backup);
        const backupMetadata = await lstat(backup);
        if (
          entry.targetName === "node_modules"
            ? fileIdentity(backupMetadata) !== expectedNodeModulesIdentity
            : !(await fileBytesEqual(backup, expectedBytes as Buffer))
        ) {
          await rename(backup, target).catch(() => undefined);
          throw unsafeMutation();
        }
      }
      await assertSnapshotEntry(entry.source, entry.targetName, input.stagedSnapshot);
      let promoted = false;
      try {
        await rename(entry.source, target);
        promoted = true;
        await assertSnapshotEntry(target, entry.targetName, input.stagedSnapshot);
      } catch (error) {
        if (promoted) {
          await rename(target, entry.source).catch(() => undefined);
        }
        if (targetExists) {
          await rename(backup, target).catch(() => undefined);
        }
        throw error;
      }
      completed.push({
        source: entry.source,
        target,
        targetName: entry.targetName,
        ...(targetExists ? { backup } : {}),
      });
    }
    for (const entry of completed) {
      if (entry.backup === undefined || entry.targetName === "node_modules") {
        continue;
      }
      const recoveryPath = recoveryPathFor(input.recoveryRoot, input.commandId, entry.targetName);
      if (await pathExists(recoveryPath)) {
        throw unsafeMutation();
      }
      await rename(entry.backup, recoveryPath);
      entry.recovery = recoveryPath;
    }
  } catch {
    for (const entry of completed.reverse()) {
      await rename(entry.target, entry.source).catch(() => undefined);
      const previous = entry.recovery ?? entry.backup;
      if (previous !== undefined) {
        await rename(previous, entry.target).catch(() => undefined);
      }
    }
    throw unsafeMutation();
  }
  for (const entry of completed) {
    if (entry.backup !== undefined && entry.targetName === "node_modules") {
      await rm(entry.backup, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function assertSnapshotEntry(
  path: string,
  targetName: string,
  snapshot: NpmWorkspaceSnapshot,
): Promise<void> {
  if (targetName === "node_modules") {
    const expectedIdentity = snapshot.nodeModulesIdentity;
    const before = await lstat(path).catch(() => undefined);
    if (
      expectedIdentity === undefined ||
      before === undefined ||
      !before.isDirectory() ||
      before.isSymbolicLink() ||
      fileIdentity(before) !== expectedIdentity
    ) {
      throw unsafeMutation();
    }
    await assertSafeInstalledTree(path);
    const after = await lstat(path).catch(() => undefined);
    if (
      after === undefined ||
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      fileIdentity(after) !== expectedIdentity
    ) {
      throw unsafeMutation();
    }
    return;
  }
  const expected = snapshot.files.get(targetName);
  if (expected === undefined || !(await fileBytesEqual(path, expected))) {
    throw unsafeMutation();
  }
}

function assertPromotableTargetName(targetName: string): void {
  if (
    targetName !== "node_modules" &&
    targetName !== "package.json" &&
    targetName !== "package-lock.json" &&
    targetName !== "npm-shrinkwrap.json"
  ) {
    throw unsafeMutation();
  }
}

function recoveryPathFor(recoveryRoot: string, commandId: string, targetName: string): string {
  return join(recoveryRoot, `${commandId}-${basename(targetName)}.before`);
}

async function fileBytesEqual(path: string, expected: Buffer): Promise<boolean> {
  const noFollow = fileConstants.O_NOFOLLOW ?? 0;
  const nonBlocking = fileConstants.O_NONBLOCK ?? 0;
  const handle = await open(path, fileConstants.O_RDONLY | noFollow | nonBlocking).catch(
    () => undefined,
  );
  if (handle === undefined) {
    return false;
  }
  let bytes: Buffer | undefined;
  try {
    const opened = await handle.stat({ bigint: true });
    const named = await lstat(path, { bigint: true }).catch(() => undefined);
    if (
      named === undefined ||
      !opened.isFile() ||
      opened.nlink !== 1n ||
      opened.size !== BigInt(expected.byteLength) ||
      named.isSymbolicLink() ||
      !named.isFile() ||
      named.nlink !== 1n ||
      !sameStableFileSnapshot(opened, named)
    ) {
      return false;
    }
    bytes = Buffer.allocUnsafe(expected.byteLength);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0) {
        return false;
      }
      offset += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const afterNamed = await lstat(path, { bigint: true }).catch(() => undefined);
    return (
      afterNamed !== undefined &&
      !afterNamed.isSymbolicLink() &&
      afterNamed.isFile() &&
      afterNamed.nlink === 1n &&
      sameStableFileSnapshot(opened, after) &&
      sameStableFileSnapshot(after, afterNamed) &&
      bytes.equals(expected)
    );
  } finally {
    bytes?.fill(0);
    await handle.close();
  }
}

function sameStableFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameStableFile(left, right) &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameStableFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.ino === right.ino &&
    (left.dev === right.dev ||
      (process.platform === "win32" &&
        (left.dev === 0n || right.dev === 0n) &&
        left.birthtimeNs === right.birthtimeNs))
  );
}

function processRequestDigest(request: PlatformMutationProcessRequest): string {
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        commandId: request.commandId,
        actionCategory: request.actionCategory,
        executableId: request.executableId,
        executable: request.executable,
        arguments: request.arguments,
        workingDirectory: request.workingDirectory,
      }),
    )
    .digest("hex")}`;
}

function processRequestCommandSuffix(requestDigest: string): string {
  return requestDigest.slice("sha256:".length, "sha256:".length + 24);
}

function disposeSnapshot(snapshot: NpmWorkspaceSnapshot): void {
  disposeFiles(snapshot.files);
}

function disposeFiles(files: ReadonlyMap<string, Buffer>): void {
  for (const bytes of files.values()) {
    bytes.fill(0);
  }
}

function fileIdentity(metadata: Stats): string {
  return `${metadata.dev}:${metadata.ino}:${metadata.mode}:${metadata.size}:${metadata.mtimeMs}`;
}

function isolatedEnvironment(input: {
  readonly source: Readonly<Record<string, string | undefined>>;
  readonly executablePaths: readonly string[];
  readonly home: string;
  readonly configuration: string;
  readonly cache: string;
  readonly temporary: string;
  readonly npmUserConfig: string;
  readonly npmGlobalConfig: string;
}): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  const copiedNames =
    process.platform === "win32"
      ? ["ProgramData", "ProgramFiles", "ProgramFiles(x86)", "SystemDrive", "SystemRoot", "WINDIR"]
      : ["LANG", "LC_ALL", "SSL_CERT_DIR", "SSL_CERT_FILE"];
  for (const name of copiedNames) {
    const value = input.source[name];
    if (value !== undefined && value.length > 0 && !value.includes("\0")) {
      result[name] = value;
    }
  }
  const systemDirectories =
    process.platform === "win32"
      ? [
          input.source["SystemRoot"] === undefined
            ? undefined
            : join(input.source["SystemRoot"], "System32"),
        ]
      : ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"];
  result["PATH"] = [
    ...new Set([
      ...input.executablePaths.map(dirname),
      ...systemDirectories.filter((value): value is string => value !== undefined),
    ]),
  ].join(process.platform === "win32" ? ";" : ":");
  result["HOME"] = input.home;
  result["USERPROFILE"] = input.home;
  result["APPDATA"] = input.configuration;
  result["LOCALAPPDATA"] = input.cache;
  result["XDG_CONFIG_HOME"] = input.configuration;
  result["XDG_DATA_HOME"] = join(input.home, "data");
  result["XDG_CACHE_HOME"] = input.cache;
  result["TEMP"] = input.temporary;
  result["TMP"] = input.temporary;
  result["TMPDIR"] = input.temporary;
  result["NPM_CONFIG_USERCONFIG"] = input.npmUserConfig;
  result["NPM_CONFIG_GLOBALCONFIG"] = input.npmGlobalConfig;
  result["NPM_CONFIG_CACHE"] = join(input.cache, "npm");
  result["NPM_CONFIG_REGISTRY"] = NPM_REGISTRY;
  result["NPM_CONFIG_IGNORE_SCRIPTS"] = "true";
  result["NPM_CONFIG_AUDIT"] = "false";
  result["NPM_CONFIG_FUND"] = "false";
  result["NO_UPDATE_NOTIFIER"] = "1";
  return Object.freeze(result);
}

async function requirePrivateDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw unsafeMutation();
  }
  if (process.platform !== "win32") {
    await chmod(path, 0o700);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw unsafeMutation();
  }
}

function validateOptions(options: CreateWorkerPlatformMutationSafetyBoundaryOptions): void {
  if (
    !isAbsolute(options.stateDirectory) ||
    !isAbsolute(options.sourceCheckoutRoot) ||
    options.executablePaths.length === 0 ||
    options.executablePaths.some((path) => !isAbsolute(path) || path.includes("\0"))
  ) {
    throw unsafeMutation();
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unsafeMutation(): PlatformMutationError {
  return new PlatformMutationError(
    "MUTATION_REQUEST_INVALID",
    "The platform mutation did not satisfy the local automatic-install safety boundary.",
  );
}
