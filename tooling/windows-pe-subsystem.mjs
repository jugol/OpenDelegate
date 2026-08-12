import { open, readFile } from "node:fs/promises";

export const WINDOWS_GUI_SUBSYSTEM = 2;
export const WINDOWS_CUI_SUBSYSTEM = 3;

const MAXIMUM_PE_BYTES = 512 * 1024 * 1024;
const OPTIONAL_HEADER_SUBSYSTEM_OFFSET = 68;

export async function readWindowsPeSubsystem(path) {
  const { bytes, subsystemOffset } = await readPortableExecutable(path);
  try {
    return bytes.readUInt16LE(subsystemOffset);
  } finally {
    bytes.fill(0);
  }
}

export async function setWindowsPeSubsystem(path, options) {
  if (
    !Number.isSafeInteger(options?.expected) ||
    !Number.isSafeInteger(options?.subsystem) ||
    options.expected < 0 ||
    options.expected > 0xffff ||
    options.subsystem < 0 ||
    options.subsystem > 0xffff
  ) {
    throw new TypeError("The guarded Windows PE subsystem mutation is invalid.");
  }
  const { bytes, subsystemOffset } = await readPortableExecutable(path);
  try {
    if (bytes.readUInt16LE(subsystemOffset) !== options.expected) {
      throw new Error("The Windows PE subsystem does not match the guarded predecessor.");
    }
  } finally {
    bytes.fill(0);
  }

  const handle = await open(path, "r+");
  try {
    const replacement = Buffer.allocUnsafe(2);
    replacement.writeUInt16LE(options.subsystem, 0);
    try {
      const result = await handle.write(replacement, 0, replacement.byteLength, subsystemOffset);
      if (result.bytesWritten !== replacement.byteLength) {
        throw new Error("The Windows PE subsystem update was incomplete.");
      }
      await handle.sync();
    } finally {
      replacement.fill(0);
    }
  } finally {
    await handle.close();
  }
  if ((await readWindowsPeSubsystem(path)) !== options.subsystem) {
    throw new Error("The Windows PE subsystem update could not be verified.");
  }
}

async function readPortableExecutable(path) {
  const bytes = await readFile(path);
  if (bytes.byteLength < 256 || bytes.byteLength > MAXIMUM_PE_BYTES) {
    bytes.fill(0);
    throw new Error("The Windows PE image size is invalid.");
  }
  try {
    if (bytes.toString("ascii", 0, 2) !== "MZ") {
      throw new Error("The Windows PE DOS signature is invalid.");
    }
    const peOffset = bytes.readUInt32LE(0x3c);
    const optionalHeaderOffset = peOffset + 24;
    const subsystemOffset = optionalHeaderOffset + OPTIONAL_HEADER_SUBSYSTEM_OFFSET;
    if (
      peOffset < 64 ||
      subsystemOffset + 2 > bytes.byteLength ||
      bytes.toString("binary", peOffset, peOffset + 4) !== "PE\0\0" ||
      bytes.readUInt16LE(peOffset + 20) < OPTIONAL_HEADER_SUBSYSTEM_OFFSET + 2 ||
      ![0x10b, 0x20b].includes(bytes.readUInt16LE(optionalHeaderOffset))
    ) {
      throw new Error("The Windows PE header is invalid.");
    }
    return { bytes, subsystemOffset };
  } catch (error) {
    bytes.fill(0);
    throw error;
  }
}
