import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

if (
  typeof HTMLDialogElement !== "undefined" &&
  HTMLDialogElement.prototype.showModal === undefined
) {
  HTMLDialogElement.prototype.showModal = function showModal(): void {
    this.open = true;
  };
}

if (typeof HTMLDialogElement !== "undefined" && HTMLDialogElement.prototype.close === undefined) {
  HTMLDialogElement.prototype.close = function close(): void {
    this.open = false;
  };
}

afterEach(() => {
  cleanup();
});
