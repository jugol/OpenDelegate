#!/usr/bin/python3
"""Deterministic GTK4 fixture for the live GNOME Wayland conformance lab."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import gi  # type: ignore

gi.require_version("Gtk", "4.0")
from gi.repository import Gtk  # type: ignore  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--result-directory", required=True)
    arguments = parser.parse_args()
    result_directory = Path(arguments.result_directory).resolve(strict=True)
    if not result_directory.is_dir():
        raise ValueError("Result directory is unavailable.")

    application = Gtk.Application(application_id="dev.opendelegate.ComputerUseFixture")

    def activate(app: Gtk.Application) -> None:
        window = Gtk.ApplicationWindow(application=app)
        window.set_title("OpenDelegate Computer Use Fixture")
        window.set_default_size(720, 420)
        layout = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=16)
        layout.set_margin_top(24)
        layout.set_margin_bottom(24)
        layout.set_margin_start(24)
        layout.set_margin_end(24)

        entry = Gtk.Entry()
        entry.update_property([Gtk.AccessibleProperty.LABEL], ["Task text"])
        entry.set_placeholder_text("Task text")
        alpha = Gtk.CheckButton(label="Alpha")
        beta = Gtk.CheckButton(label="Beta")
        beta.set_group(alpha)
        submit = Gtk.Button(label="Submit")
        status = Gtk.Label(label="Ready")

        def complete(_button: Gtk.Button) -> None:
            selected = "Beta" if beta.get_active() else "Alpha" if alpha.get_active() else None
            document = {
                "runIdentifier": arguments.run_id,
                "state": "success",
                "textValue": entry.get_text(),
                "selectedOption": selected,
            }
            target = result_directory / f"fixture-result-{arguments.run_id}.json"
            with target.open("x", encoding="utf-8") as output:
                json.dump(document, output, sort_keys=True, separators=(",", ":"))
                output.write("\n")
            status.set_text("Success")

        submit.connect("clicked", complete)
        for widget in (entry, alpha, beta, submit, status):
            layout.append(widget)
        window.set_child(layout)
        window.present()

    application.connect("activate", activate)
    return application.run(None)


if __name__ == "__main__":
    raise SystemExit(main())
