import { PlatformServiceError } from "./types.ts";

export interface ParsedWindowsTask {
  readonly trigger: "LogonTrigger";
  readonly userId: string;
  readonly logonType: "InteractiveToken";
  readonly runLevel: "LeastPrivilege";
  readonly command: string;
  readonly arguments: string;
}

const WINDOWS_TASK_PROLOGUE = '<?xml version="1.0" encoding="UTF-16"?>\n';
const WINDOWS_TASK_MAX_CODE_UNITS = 64 * 1024;

export function parseWindowsTaskXml(xml: string): ParsedWindowsTask {
  if (
    xml.length > WINDOWS_TASK_MAX_CODE_UNITS ||
    !xml.startsWith(WINDOWS_TASK_PROLOGUE) ||
    !xml.includes(
      '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    ) ||
    xml.includes("<!DOCTYPE") ||
    xml.includes("<Password>") ||
    xml.includes("<GroupId>")
  ) {
    throw new PlatformServiceError(
      "INVALID_CONFIGURATION",
      "Windows helper Task XML does not match the supported strict profile.",
    );
  }
  validateWindowsTaskElements(xml);
  assertSingleTag(xml, "LogonTrigger");
  const userId = readSingleTextTag(xml, "UserId");
  const logonType = readSingleTextTag(xml, "LogonType");
  const runLevel = readSingleTextTag(xml, "RunLevel");
  const command = readSingleTextTag(xml, "Command");
  const arguments_ = readSingleTextTag(xml, "Arguments");
  if (logonType !== "InteractiveToken" || runLevel !== "LeastPrivilege") {
    throw new PlatformServiceError(
      "INVALID_CONFIGURATION",
      "Windows helper must use a least-privilege interactive token.",
    );
  }
  return {
    trigger: "LogonTrigger",
    userId,
    logonType,
    runLevel,
    command,
    arguments: arguments_,
  };
}

const WINDOWS_TASK_ELEMENTS = new Set([
  "Actions",
  "AllowHardTerminate",
  "Arguments",
  "Author",
  "Command",
  "Count",
  "Description",
  "DisallowStartIfOnBatteries",
  "Enabled",
  "Exec",
  "ExecutionTimeLimit",
  "Interval",
  "LogonTrigger",
  "LogonType",
  "MultipleInstancesPolicy",
  "Principal",
  "Principals",
  "RegistrationInfo",
  "RestartOnFailure",
  "RunLevel",
  "Settings",
  "StartWhenAvailable",
  "StopIfGoingOnBatteries",
  "Task",
  "Triggers",
  "UserId",
]);

const WINDOWS_TASK_CHILDREN = new Map<string, readonly string[]>([
  ["Task", ["RegistrationInfo", "Triggers", "Principals", "Settings", "Actions"]],
  ["RegistrationInfo", ["Author", "Description"]],
  ["Author", []],
  ["Description", []],
  ["Triggers", ["LogonTrigger"]],
  ["LogonTrigger", ["Enabled"]],
  ["Enabled", []],
  ["Principals", ["Principal"]],
  ["Principal", ["UserId", "LogonType", "RunLevel"]],
  ["UserId", []],
  ["LogonType", []],
  ["RunLevel", []],
  [
    "Settings",
    [
      "MultipleInstancesPolicy",
      "DisallowStartIfOnBatteries",
      "StopIfGoingOnBatteries",
      "AllowHardTerminate",
      "StartWhenAvailable",
      "ExecutionTimeLimit",
      "RestartOnFailure",
    ],
  ],
  ["MultipleInstancesPolicy", []],
  ["DisallowStartIfOnBatteries", []],
  ["StopIfGoingOnBatteries", []],
  ["AllowHardTerminate", []],
  ["StartWhenAvailable", []],
  ["ExecutionTimeLimit", []],
  ["RestartOnFailure", ["Interval", "Count"]],
  ["Interval", []],
  ["Count", []],
  ["Actions", ["Exec"]],
  ["Exec", ["Command", "Arguments"]],
  ["Command", []],
  ["Arguments", []],
]);

const WINDOWS_TASK_FIXED_TEXT = new Map<string, string>([
  ["Author", "OpenDelegate"],
  ["Description", "OpenDelegate per-user graphical session helper"],
  ["Enabled", "true"],
  ["LogonType", "InteractiveToken"],
  ["RunLevel", "LeastPrivilege"],
  ["MultipleInstancesPolicy", "IgnoreNew"],
  ["DisallowStartIfOnBatteries", "false"],
  ["StopIfGoingOnBatteries", "false"],
  ["AllowHardTerminate", "true"],
  ["StartWhenAvailable", "true"],
  ["ExecutionTimeLimit", "PT0S"],
  ["Interval", "PT1M"],
  ["Count", "3"],
]);
const WINDOWS_TASK_DYNAMIC_TEXT = new Set(["Arguments", "Command", "UserId"]);

function validateWindowsTaskElements(xml: string): void {
  const openElements: Array<{ name: string; nextChildIndex: number }> = [];
  let cursor = WINDOWS_TASK_PROLOGUE.length;
  let elementCount = 0;
  let rootClosed = false;

  while (cursor < xml.length) {
    const elementStart = xml.indexOf("<", cursor);
    if (elementStart === -1) {
      validateWindowsTaskCharacterData(openElements.at(-1)?.name, xml.slice(cursor));
      break;
    }
    validateWindowsTaskCharacterData(openElements.at(-1)?.name, xml.slice(cursor, elementStart));
    const elementEnd = xml.indexOf(">", elementStart + 1);
    if (elementEnd === -1) {
      throw invalidWindowsTaskSyntax();
    }

    const raw = xml.slice(elementStart + 1, elementEnd);
    const closing = raw.startsWith("/");
    let nameEnd = closing ? 1 : 0;
    if (!isAsciiLetter(raw.charCodeAt(nameEnd))) {
      throw invalidWindowsTaskSyntax();
    }
    nameEnd += 1;
    while (isAsciiAlphaNumeric(raw.charCodeAt(nameEnd))) {
      nameEnd += 1;
    }
    const name = raw.slice(closing ? 1 : 0, nameEnd);
    const attributes = raw.slice(nameEnd).trim();
    if (!WINDOWS_TASK_ELEMENTS.has(name)) {
      throw new PlatformServiceError(
        "INVALID_CONFIGURATION",
        `Windows helper Task XML contains unsupported element ${name}.`,
      );
    }
    if (closing && attributes !== "") {
      throw new PlatformServiceError(
        "INVALID_CONFIGURATION",
        "Windows helper Task XML has attributes on a closing element.",
      );
    }

    if (closing) {
      const frame = openElements.pop();
      if (
        frame?.name !== name ||
        frame.nextChildIndex !== WINDOWS_TASK_CHILDREN.get(name)?.length
      ) {
        throw invalidWindowsTaskSyntax();
      }
      if (openElements.length === 0) {
        rootClosed = true;
      }
      elementCount += 1;
      cursor = elementEnd + 1;
      continue;
    }
    if (rootClosed || (openElements.length === 0 && name !== "Task")) {
      throw invalidWindowsTaskSyntax();
    }
    const parent = openElements.at(-1);
    if (parent !== undefined) {
      const expectedChild = WINDOWS_TASK_CHILDREN.get(parent.name)?.[parent.nextChildIndex];
      if (expectedChild !== name) {
        throw invalidWindowsTaskSyntax();
      }
      parent.nextChildIndex += 1;
    }

    const expectedAttributes =
      name === "Task"
        ? 'version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"'
        : name === "Principal"
          ? 'id="Owner"'
          : name === "Actions"
            ? 'Context="Owner"'
            : "";
    if (!closing && attributes !== expectedAttributes) {
      throw new PlatformServiceError(
        "INVALID_CONFIGURATION",
        `Windows helper Task XML has unsupported attributes on ${name}.`,
      );
    }
    openElements.push({ name, nextChildIndex: 0 });
    elementCount += 1;
    cursor = elementEnd + 1;
  }

  if (elementCount === 0 || openElements.length !== 0 || !rootClosed) {
    throw invalidWindowsTaskSyntax();
  }
}

function validateWindowsTaskCharacterData(element: string | undefined, text: string): void {
  if (element === undefined || (WINDOWS_TASK_CHILDREN.get(element)?.length ?? 0) > 0) {
    if (text.trim() !== "") {
      throw invalidWindowsTaskSyntax();
    }
    return;
  }
  const fixedText = WINDOWS_TASK_FIXED_TEXT.get(element);
  if (fixedText !== undefined) {
    if (text !== fixedText) {
      throw invalidWindowsTaskSyntax();
    }
    return;
  }
  if (WINDOWS_TASK_DYNAMIC_TEXT.has(element)) {
    const decoded = decodeXml(text);
    if (decoded === "" || /[\r\n]/u.test(decoded) || decoded.includes("\0")) {
      throw invalidWindowsTaskSyntax();
    }
    return;
  }
  throw invalidWindowsTaskSyntax();
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiAlphaNumeric(code: number): boolean {
  return isAsciiLetter(code) || (code >= 48 && code <= 57);
}

function invalidWindowsTaskSyntax(): PlatformServiceError {
  return new PlatformServiceError(
    "INVALID_CONFIGURATION",
    "Windows helper Task XML contains unsupported or unbalanced syntax.",
  );
}

export type PlistValue =
  boolean | number | string | readonly PlistValue[] | { readonly [key: string]: PlistValue };

interface XmlToken {
  readonly type: "close" | "open" | "text";
  readonly name?: string;
  readonly text?: string;
}

export function parseLaunchdPlist(xml: string): Record<string, PlistValue> {
  const tokens = tokenizePlist(xml);
  let index = 0;

  function take(): XmlToken {
    const token = tokens[index];
    if (token === undefined) {
      throw invalidPlist("Unexpected end of plist.");
    }
    index += 1;
    return token;
  }

  function expectOpen(name: string): void {
    const token = take();
    if (token.type !== "open" || token.name !== name) {
      throw invalidPlist(`Expected <${name}>.`);
    }
  }

  function expectClose(name: string): void {
    const token = take();
    if (token.type !== "close" || token.name !== name) {
      throw invalidPlist(`Expected </${name}>.`);
    }
  }

  function parseTextElement(name: "integer" | "key" | "string"): string {
    expectOpen(name);
    const token = take();
    const value = token.type === "text" ? (token.text ?? "") : "";
    if (token.type !== "text") {
      index -= 1;
    }
    expectClose(name);
    return value;
  }

  function parseValue(): PlistValue {
    const token = tokens[index];
    if (token?.type !== "open") {
      throw invalidPlist("Expected plist value.");
    }
    if (token.name === "string") {
      return parseTextElement("string");
    }
    if (token.name === "integer") {
      const value = parseTextElement("integer");
      if (!/^-?[0-9]+$/.test(value)) {
        throw invalidPlist("Invalid integer value.");
      }
      return Number(value);
    }
    if (token.name === "true" || token.name === "false") {
      const value = token.name === "true";
      expectOpen(token.name);
      expectClose(token.name);
      return value;
    }
    if (token.name === "array") {
      expectOpen("array");
      const values: PlistValue[] = [];
      while (tokens[index]?.type !== "close" || tokens[index]?.name !== "array") {
        values.push(parseValue());
      }
      expectClose("array");
      return values;
    }
    if (token.name === "dict") {
      return parseDictionary();
    }
    throw invalidPlist(`Unsupported plist element <${token.name ?? ""}>.`);
  }

  function parseDictionary(): Record<string, PlistValue> {
    expectOpen("dict");
    const output = Object.create(null) as Record<string, PlistValue>;
    while (tokens[index]?.type !== "close" || tokens[index]?.name !== "dict") {
      const key = parseTextElement("key");
      if (Object.hasOwn(output, key)) {
        throw invalidPlist(`Duplicate plist key: ${key}.`);
      }
      output[key] = parseValue();
    }
    expectClose("dict");
    return output;
  }

  expectOpen("plist");
  const result = parseDictionary();
  expectClose("plist");
  if (index !== tokens.length) {
    throw invalidPlist("Unexpected trailing plist content.");
  }
  return result;
}

export type ParsedSystemdUnit = Readonly<Record<string, Readonly<Record<string, string>>>>;

export function parseSystemdUnit(unit: string): ParsedSystemdUnit {
  if (unit.includes("\0") || unit.includes("\r")) {
    throw new PlatformServiceError(
      "INVALID_CONFIGURATION",
      "systemd unit contains prohibited bytes.",
    );
  }
  const output: Record<string, Record<string, string>> = {};
  let current: Record<string, string> | undefined;
  for (const [index, rawLine] of unit.split("\n").entries()) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const section = /^\[([A-Za-z][A-Za-z0-9]*)\]$/.exec(line);
    if (section !== null) {
      const name = section[1] ?? "";
      if (Object.hasOwn(output, name)) {
        throw invalidSystemd(index, `Duplicate section ${name}.`);
      }
      current = {};
      output[name] = current;
      continue;
    }
    if (current === undefined) {
      throw invalidSystemd(index, "Property appears before a section.");
    }
    const property = /^([A-Za-z][A-Za-z0-9]*)=(.*)$/.exec(line);
    if (property === null) {
      throw invalidSystemd(index, "Invalid property.");
    }
    const key = property[1] ?? "";
    if (Object.hasOwn(current, key)) {
      throw invalidSystemd(index, `Duplicate property ${key}.`);
    }
    current[key] = property[2] ?? "";
  }
  for (const section of ["Unit", "Service", "Install"]) {
    if (!Object.hasOwn(output, section)) {
      throw new PlatformServiceError(
        "INVALID_CONFIGURATION",
        `systemd unit is missing [${section}].`,
      );
    }
  }
  return output;
}

function tokenizePlist(xml: string): XmlToken[] {
  if (
    !xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n') ||
    !xml.includes('<plist version="1.0">') ||
    /<!ENTITY/i.test(xml)
  ) {
    throw invalidPlist("Unsupported plist prologue.");
  }
  const body = xml
    .replace(/^<\?xml[^?]*\?>\s*/, "")
    .replace(/^<!DOCTYPE plist PUBLIC "[^"]+" "[^"]+">\s*/, "");
  const tokenPattern =
    /<plist version="1\.0">|<\/?(?:array|dict|false|integer|key|plist|string|true)>|[^<]+/gy;
  const tokens: XmlToken[] = [];
  let offset = 0;
  while (offset < body.length) {
    tokenPattern.lastIndex = offset;
    const match = tokenPattern.exec(body);
    if (match === null || match.index !== offset) {
      throw invalidPlist("Unsupported XML syntax.");
    }
    offset = tokenPattern.lastIndex;
    const raw = match[0];
    if (!raw.startsWith("<")) {
      if (raw.trim() !== "") {
        tokens.push({ type: "text", text: decodeXml(raw) });
      }
      continue;
    }
    if (raw === '<plist version="1.0">') {
      tokens.push({ type: "open", name: "plist" });
      continue;
    }
    const close = raw.startsWith("</");
    const name = raw.slice(close ? 2 : 1, -1);
    tokens.push({ type: close ? "close" : "open", name });
  }
  return tokens;
}

function readSingleTextTag(xml: string, tag: string): string {
  const pattern = new RegExp(`<${tag}>([^<]*)</${tag}>`, "g");
  const matches = [...xml.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new PlatformServiceError(
      "INVALID_CONFIGURATION",
      `Windows helper Task XML requires exactly one ${tag}.`,
    );
  }
  return decodeXml(matches[0]?.[1] ?? "");
}

function assertSingleTag(xml: string, tag: string): void {
  const matches = xml.match(new RegExp(`<${tag}>`, "g")) ?? [];
  if (matches.length !== 1) {
    throw new PlatformServiceError(
      "INVALID_CONFIGURATION",
      `Windows helper Task XML requires exactly one ${tag}.`,
    );
  }
}

function decodeXml(value: string): string {
  if (/&(?!amp;|apos;|gt;|lt;|quot;)/.test(value)) {
    throw new PlatformServiceError(
      "INVALID_CONFIGURATION",
      "XML contains an unsupported entity reference.",
    );
  }
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function invalidPlist(message: string): PlatformServiceError {
  return new PlatformServiceError("INVALID_CONFIGURATION", `Invalid launchd plist: ${message}`);
}

function invalidSystemd(line: number, message: string): PlatformServiceError {
  return new PlatformServiceError(
    "INVALID_CONFIGURATION",
    `Invalid systemd unit at line ${String(line + 1)}: ${message}`,
  );
}
