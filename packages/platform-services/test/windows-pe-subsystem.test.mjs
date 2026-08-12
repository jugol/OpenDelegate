import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  WINDOWS_GUI_SUBSYSTEM,
  WINDOWS_CUI_SUBSYSTEM,
  readWindowsPeSubsystem,
  setWindowsPeSubsystem,
} from "../../../tooling/windows-pe-subsystem.mjs";

test("converts only the copied interactive helper from CUI to GUI subsystem", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-pe-subsystem-"));
  const executable = join(root, "opendelegate-session-helper.exe");
  try {
    const fixture = Buffer.alloc(512);
    fixture.write("MZ", 0, "ascii");
    fixture.writeUInt32LE(128, 0x3c);
    fixture.write("PE\0\0", 128, "binary");
    fixture.writeUInt16LE(240, 148);
    fixture.writeUInt16LE(0x20b, 152);
    fixture.writeUInt16LE(WINDOWS_CUI_SUBSYSTEM, 220);
    await writeFile(executable, fixture);

    assert.equal(await readWindowsPeSubsystem(executable), WINDOWS_CUI_SUBSYSTEM);
    await setWindowsPeSubsystem(executable, {
      expected: WINDOWS_CUI_SUBSYSTEM,
      subsystem: WINDOWS_GUI_SUBSYSTEM,
    });
    assert.equal(await readWindowsPeSubsystem(executable), WINDOWS_GUI_SUBSYSTEM);
    assert.equal((await readFile(executable)).byteLength, fixture.byteLength);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses an executable whose current subsystem is not the guarded predecessor", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-pe-subsystem-"));
  const executable = join(root, "unexpected.exe");
  try {
    const fixture = Buffer.alloc(512);
    fixture.write("MZ", 0, "ascii");
    fixture.writeUInt32LE(128, 0x3c);
    fixture.write("PE\0\0", 128, "binary");
    fixture.writeUInt16LE(240, 148);
    fixture.writeUInt16LE(0x20b, 152);
    fixture.writeUInt16LE(WINDOWS_GUI_SUBSYSTEM, 220);
    await writeFile(executable, fixture);

    await assert.rejects(
      setWindowsPeSubsystem(executable, {
        expected: WINDOWS_CUI_SUBSYSTEM,
        subsystem: WINDOWS_GUI_SUBSYSTEM,
      }),
      /subsystem does not match/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
