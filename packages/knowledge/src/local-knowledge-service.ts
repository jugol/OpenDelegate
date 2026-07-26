import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type {
  KnowledgeCandidate,
  KnowledgeHealth,
  KnowledgeRelationships,
  KnowledgeSearchOptions,
  LocalKnowledgeConfig,
  OpenedKnowledge,
  OpenKnowledgeOptions,
  UpsertKnowledgeNote,
  UpsertKnowledgeOptions,
  UpsertKnowledgeResult,
} from "./contracts.ts";
import { KnowledgeError } from "./knowledge-error.ts";

interface IndexedNote {
  readonly noteId: string;
  readonly title: string;
  readonly content: string;
  readonly outgoing: readonly string[];
}

interface ParsedNote {
  readonly noteId: string;
  readonly title: string;
  readonly content: string;
  readonly linkTargets: readonly string[];
}

let temporaryFileSequence = 0;

export class LocalKnowledgeService {
  readonly #configuredRoot: string;
  readonly #maxSearchCandidates: number;
  readonly #maxCandidatePreviewCharacters: number;
  readonly #maxOpenCharacters: number;
  readonly #maxNoteCharacters: number;
  readonly #knownSecretValues: readonly string[];
  #root: string;
  #status: KnowledgeHealth["status"] = "not-ready";
  #notes = new Map<string, IndexedNote>();
  #backlinks = new Map<string, readonly string[]>();

  public constructor(config: LocalKnowledgeConfig) {
    this.#configuredRoot = resolve(config.root);
    this.#root = this.#configuredRoot;
    this.#maxSearchCandidates = positiveInteger(config.maxSearchCandidates, 5);
    this.#maxCandidatePreviewCharacters = positiveInteger(
      config.maxCandidatePreviewCharacters,
      160,
    );
    this.#maxOpenCharacters = positiveInteger(config.maxOpenCharacters, 12_000);
    this.#maxNoteCharacters = positiveInteger(config.maxNoteCharacters, 20_000);
    this.#knownSecretValues = Object.freeze([
      ...new Set(
        (config.knownSecretValues ?? []).filter(
          (value) => typeof value === "string" && value.trim().length > 0,
        ),
      ),
    ]);
  }

  public async rebuild(): Promise<KnowledgeHealth> {
    await mkdir(this.#configuredRoot, { recursive: true });
    this.#root = await realpath(this.#configuredRoot);

    const filePaths = await findMarkdownFiles(this.#root);
    const parsedNotes = await Promise.all(
      filePaths.map(async (filePath): Promise<ParsedNote> => {
        const content = await readFile(filePath, "utf8");
        const noteId = toNoteId(this.#root, filePath);

        return {
          noteId,
          title: extractTitle(noteId, content),
          content,
          linkTargets: extractWikiLinkTargets(content),
        };
      }),
    );
    parsedNotes.sort((left, right) => compareStableString(left.noteId, right.noteId));

    const aliases = buildAliasIndex(parsedNotes);
    const notes = new Map<string, IndexedNote>();

    for (const note of parsedNotes) {
      const outgoing = [
        ...new Set(
          note.linkTargets
            .map((target) => aliases.get(target))
            .filter((target): target is string => target !== undefined),
        ),
      ].sort(compareStableString);

      notes.set(note.noteId, {
        noteId: note.noteId,
        title: note.title,
        content: note.content,
        outgoing,
      });
    }

    this.#notes = notes;
    this.#backlinks = buildBacklinks(notes);
    this.#status = "ready";

    return createHealth(this.#status);
  }

  public relationships(noteId: string): KnowledgeRelationships {
    const normalizedNoteId = normalizeNoteId(noteId);
    const note = this.#notes.get(normalizedNoteId);

    if (note === undefined) {
      throw new KnowledgeError(
        "KNOWLEDGE_NOTE_NOT_FOUND",
        `Knowledge note ${normalizedNoteId} was not found.`,
      );
    }

    return Object.freeze({
      outgoing: Object.freeze([...note.outgoing]),
      backlinks: Object.freeze([...(this.#backlinks.get(normalizedNoteId) ?? [])]),
    });
  }

  public health(): KnowledgeHealth {
    return createHealth(this.#status);
  }

  public search(
    query: string,
    options: KnowledgeSearchOptions = {},
  ): readonly KnowledgeCandidate[] {
    const tokens = tokenize(query);

    if (tokens.length === 0) {
      return Object.freeze([]);
    }

    const requestedLimit = positiveInteger(options.limit, this.#maxSearchCandidates);
    const limit = Math.min(requestedLimit, this.#maxSearchCandidates);
    const candidates = [...this.#notes.values()]
      .map((note) => ({
        note,
        score: scoreSearchResult(note, tokens),
      }))
      .filter((result) => result.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score || compareStableString(left.note.noteId, right.note.noteId),
      )
      .slice(0, limit)
      .map(({ note }) =>
        Object.freeze({
          noteId: note.noteId,
          title: note.title,
          preview: createPreview(note.content, tokens, this.#maxCandidatePreviewCharacters),
        }),
      );

    return Object.freeze(candidates);
  }

  public openNotes(noteIds: readonly string[], options: OpenKnowledgeOptions): OpenedKnowledge {
    const requestedBudget = Number.isFinite(options.totalCharacterBudget)
      ? Math.max(0, Math.floor(options.totalCharacterBudget))
      : options.totalCharacterBudget === Number.POSITIVE_INFINITY
        ? this.#maxOpenCharacters
        : 0;
    const characterBudget = Math.min(requestedBudget, this.#maxOpenCharacters);
    const notes = [];
    const omittedNoteIds: string[] = [];
    let remainingCharacters = characterBudget;

    for (const noteId of noteIds) {
      const normalizedNoteId = normalizeNoteId(noteId);
      const note = this.#notes.get(normalizedNoteId);

      if (note === undefined) {
        throw new KnowledgeError(
          "KNOWLEDGE_NOTE_NOT_FOUND",
          `Knowledge note ${normalizedNoteId} was not found.`,
        );
      }

      if (remainingCharacters === 0) {
        omittedNoteIds.push(normalizedNoteId);
        continue;
      }

      const content = note.content.slice(0, remainingCharacters);
      notes.push(
        Object.freeze({
          noteId: note.noteId,
          title: note.title,
          content,
          truncated: content.length < note.content.length,
        }),
      );
      remainingCharacters -= content.length;
    }

    return Object.freeze({
      characterBudget,
      usedCharacters: characterBudget - remainingCharacters,
      notes: Object.freeze(notes),
      omittedNoteIds: Object.freeze(omittedNoteIds),
    });
  }

  public async upsertNote(
    input: UpsertKnowledgeNote,
    options?: UpsertKnowledgeOptions,
  ): Promise<UpsertKnowledgeResult> {
    validateDurableNote(input, this.#maxNoteCharacters, this.#knownSecretValues);
    if (
      options !== undefined &&
      (options === null ||
        typeof options !== "object" ||
        typeof options.beforeCommit !== "function")
    ) {
      throw new TypeError("Knowledge upsert options are invalid.");
    }
    await this.#ensureRoot();

    const noteId = normalizeNoteId(input.noteId);
    const target = resolve(this.#root, ...noteId.split("/"));
    const parent = dirname(target);
    await ensureSafeDirectory(this.#root, parent);

    const existing = await lstatIfExists(target);

    if (existing !== undefined && (!existing.isFile() || existing.isSymbolicLink())) {
      throw new KnowledgeError(
        "KNOWLEDGE_PATH_INVALID",
        `Knowledge note ${noteId} is not an ordinary file.`,
      );
    }

    const operation = existing === undefined ? "created" : "updated";
    temporaryFileSequence += 1;
    const temporaryPath = join(
      parent,
      `.${basename(target)}.${process.pid}.${temporaryFileSequence}.tmp`,
    );

    try {
      await writeFile(temporaryPath, input.content, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await options?.beforeCommit();
      await rename(temporaryPath, target);
    } finally {
      await unlink(temporaryPath).catch((error: unknown) => {
        if (!hasErrorCode(error, "ENOENT")) {
          throw error;
        }
      });
    }

    await this.rebuild();

    return Object.freeze({
      noteId,
      operation,
    });
  }

  async #ensureRoot(): Promise<void> {
    await mkdir(this.#configuredRoot, { recursive: true });
    this.#root = await realpath(this.#configuredRoot);
  }
}

async function findMarkdownFiles(root: string): Promise<readonly string[]> {
  const found: string[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareStableString(left.name, right.name));

    for (const entry of entries) {
      const path = join(directory, entry.name);
      const stats = await lstat(path);

      if (stats.isSymbolicLink()) {
        continue;
      }

      if (stats.isDirectory()) {
        await visit(path);
        continue;
      }

      if (stats.isFile() && extname(entry.name).toLowerCase() === ".md") {
        found.push(path);
      }
    }
  }

  await visit(root);
  return found;
}

function toNoteId(root: string, filePath: string): string {
  return relative(root, filePath).split(sep).join("/");
}

function extractTitle(noteId: string, content: string): string {
  const heading = /^#\s+(.+?)\s*$/m.exec(content)?.[1];

  return heading ?? basename(noteId, extname(noteId));
}

function extractWikiLinkTargets(content: string): readonly string[] {
  const targets: string[] = [];
  const pattern = /\[\[([^\]]+)\]\]/g;

  for (const match of content.matchAll(pattern)) {
    const rawTarget = match[1];

    if (rawTarget === undefined) {
      continue;
    }

    const target = normalizeWikiTarget(rawTarget);

    if (target.length > 0) {
      targets.push(target);
    }
  }

  return targets;
}

function normalizeWikiTarget(rawTarget: string): string {
  const withoutAlias = rawTarget.split("|", 1)[0] ?? "";
  const withoutHeading = withoutAlias.split("#", 1)[0] ?? "";

  return withoutHeading
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\.md$/i, "")
    .toLocaleLowerCase("en-US");
}

function buildAliasIndex(notes: readonly ParsedNote[]): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>();

  for (const note of notes) {
    const noteIdWithoutExtension = note.noteId.replace(/\.md$/i, "");
    const values = [
      note.noteId,
      noteIdWithoutExtension,
      basename(noteIdWithoutExtension),
      note.title,
    ];

    for (const value of values) {
      const normalized = normalizeWikiTarget(value);

      if (!aliases.has(normalized)) {
        aliases.set(normalized, note.noteId);
      }
    }
  }

  return aliases;
}

function buildBacklinks(notes: ReadonlyMap<string, IndexedNote>): Map<string, readonly string[]> {
  const backlinks = new Map<string, string[]>();

  for (const noteId of notes.keys()) {
    backlinks.set(noteId, []);
  }

  for (const note of notes.values()) {
    for (const target of note.outgoing) {
      backlinks.get(target)?.push(note.noteId);
    }
  }

  return new Map(
    [...backlinks.entries()].map(([noteId, sources]) => [
      noteId,
      Object.freeze(sources.sort(compareStableString)),
    ]),
  );
}

function createHealth(status: KnowledgeHealth["status"]): KnowledgeHealth {
  return Object.freeze({ status });
}

function validateDurableNote(
  input: UpsertKnowledgeNote,
  maximumCharacters: number,
  knownSecretValues: readonly string[],
): void {
  switch (input.contentKind) {
    case "credential":
      throw new KnowledgeError(
        "KNOWLEDGE_CREDENTIAL_REJECTED",
        "Credentials cannot be stored in Knowledge.",
      );
    case "raw-transcript":
      throw new KnowledgeError(
        "KNOWLEDGE_RAW_TRANSCRIPT_REJECTED",
        "Raw transcripts cannot be stored in Knowledge.",
      );
    case "raw-log":
      throw new KnowledgeError(
        "KNOWLEDGE_RAW_LOG_REJECTED",
        "Raw logs cannot be stored in Knowledge.",
      );
    case "temporary-task-state":
      throw new KnowledgeError(
        "KNOWLEDGE_TEMPORARY_TASK_STATE_REJECTED",
        "Temporary Task state cannot be stored in Knowledge.",
      );
    case "common-fact":
      throw new KnowledgeError(
        "KNOWLEDGE_COMMON_FACT_REJECTED",
        "Common facts do not qualify as Device-local Knowledge.",
      );
    case "durable-device-knowledge":
      break;
  }

  if (knownSecretValues.some((secretValue) => input.content.includes(secretValue))) {
    throw new KnowledgeError(
      "KNOWLEDGE_CREDENTIAL_REJECTED",
      "Content containing a configured Secret value cannot be stored in Knowledge.",
    );
  }

  if (containsCommonCredentialPattern(input.content)) {
    throw new KnowledgeError(
      "KNOWLEDGE_CREDENTIAL_REJECTED",
      "Content matching a common credential pattern cannot be stored in Knowledge.",
    );
  }

  if (!input.qualification.deviceSpecific) {
    throw new KnowledgeError(
      "KNOWLEDGE_COMMON_FACT_REJECTED",
      "Knowledge must be specific to this Device.",
    );
  }

  if (
    !input.qualification.repeatedlyUseful ||
    !input.qualification.expensiveToRediscover ||
    !input.qualification.actionable
  ) {
    throw new KnowledgeError(
      "KNOWLEDGE_NOT_DURABLE",
      "Knowledge must be durable, Device-specific, repeatedly useful, expensive to rediscover, and actionable.",
    );
  }

  if (input.content.length > maximumCharacters) {
    throw new KnowledgeError(
      "KNOWLEDGE_CONTENT_TOO_LARGE",
      `Knowledge content exceeds the ${maximumCharacters} character limit.`,
    );
  }
}

function containsCommonCredentialPattern(content: string): boolean {
  return (
    /-----BEGIN [^-]*(?:PRIVATE KEY|OPENSSH PRIVATE KEY)-----/i.test(content) ||
    /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret|account[_-]?key|aws[_-]?secret[_-]?access[_-]?key|aws[_-]?session[_-]?token)\s*[:=]\s*["']?[^\s"']{4,}/i.test(
      content,
    ) ||
    /\b(?:(?:[a-z][a-z0-9_-]{0,31}[ _-]+){0,3}(?:token|password|passphrase|secret|credential)|api[ _-]?key|private[ _-]?key)\s+(?:is|was)\s+(?:"[^"\r\n]{12,256}"|'[^'\r\n]{12,256}'|[A-Za-z0-9][A-Za-z0-9._~+/-]{11,255})(?=$|[\s,.;!?])/i.test(
      content,
    ) ||
    /\bmfa\.[A-Za-z0-9_-]{20,}\b/i.test(content) ||
    /\b(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}\b/.test(content) ||
    /\b(?:Authorization\s*:\s*)?Bearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}\b/i.test(content) ||
    /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\b/.test(content) ||
    /\b(?:sk[-_]|ghp_|github_pat_|glpat-|npm_|xox[baprs]-)[A-Za-z0-9_-]{8,}\b/.test(content) ||
    /\bAIza[0-9A-Za-z_-]{35}\b/.test(content) ||
    /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^/\s:@]+:[^@\s/]+@/i.test(content)
  );
}

function normalizeNoteId(noteId: string): string {
  if (
    noteId.length === 0 ||
    noteId.includes("\0") ||
    isAbsolute(noteId) ||
    /^[a-zA-Z]:/.test(noteId)
  ) {
    throw new KnowledgeError("KNOWLEDGE_PATH_INVALID", "Knowledge note path is invalid.");
  }

  const segments = noteId.replaceAll("\\", "/").split("/");

  if (
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
    extname(segments.at(-1) ?? "").toLowerCase() !== ".md"
  ) {
    throw new KnowledgeError("KNOWLEDGE_PATH_INVALID", "Knowledge note path is invalid.");
  }

  return segments.join("/");
}

async function ensureSafeDirectory(root: string, targetDirectory: string): Promise<void> {
  const relativeDirectory = relative(root, targetDirectory);

  if (
    relativeDirectory === ".." ||
    relativeDirectory.startsWith(`..${sep}`) ||
    isAbsolute(relativeDirectory)
  ) {
    throw new KnowledgeError(
      "KNOWLEDGE_PATH_INVALID",
      "Knowledge note path leaves its configured root.",
    );
  }

  let current = root;

  for (const segment of relativeDirectory.split(sep).filter((value) => value.length > 0)) {
    current = join(current, segment);
    await mkdir(current).catch((error: unknown) => {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }
    });
    const stats = await lstat(current);

    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new KnowledgeError(
        "KNOWLEDGE_PATH_INVALID",
        "Knowledge note path contains a non-directory or symbolic link.",
      );
    }

    const resolvedDirectory = await realpath(current);
    const resolvedRelative = relative(root, resolvedDirectory);

    if (
      resolvedRelative === ".." ||
      resolvedRelative.startsWith(`..${sep}`) ||
      isAbsolute(resolvedRelative)
    ) {
      throw new KnowledgeError(
        "KNOWLEDGE_PATH_INVALID",
        "Knowledge note path leaves its configured root.",
      );
    }
  }
}

async function lstatIfExists(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error: unknown) {
    if (hasErrorCode(error, "ENOENT")) {
      return undefined;
    }

    throw error;
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function tokenize(value: string): readonly string[] {
  return [
    ...new Set(
      (value.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}_-]+/gu) ?? []).filter(
        (token) => token.length > 0,
      ),
    ),
  ].sort(compareStableString);
}

function scoreSearchResult(note: IndexedNote, tokens: readonly string[]): number {
  const title = note.title.toLocaleLowerCase("en-US");
  const content = note.content.toLocaleLowerCase("en-US");

  return tokens.reduce(
    (score, token) =>
      score + countOccurrences(title, token) * 10 + countOccurrences(content, token),
    0,
  );
}

function countOccurrences(value: string, token: string): number {
  let count = 0;
  let offset = 0;

  while (offset < value.length) {
    const index = value.indexOf(token, offset);

    if (index === -1) {
      break;
    }

    count += 1;
    offset = index + token.length;
  }

  return count;
}

function createPreview(
  content: string,
  tokens: readonly string[],
  maximumCharacters: number,
): string {
  const normalizedContent = content.toLocaleLowerCase("en-US");
  const firstMatch = tokens.reduce<number | undefined>((earliest, token) => {
    const index = normalizedContent.indexOf(token);

    if (index === -1) {
      return earliest;
    }

    return earliest === undefined ? index : Math.min(earliest, index);
  }, undefined);
  const start =
    firstMatch === undefined ? 0 : Math.max(0, firstMatch - Math.floor(maximumCharacters / 4));

  return content.slice(start, start + maximumCharacters);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value <= 0
    ? fallback
    : Math.floor(value);
}

function compareStableString(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}
