#!/usr/bin/python3
"""OpenDelegate Ubuntu 24.04 GNOME Wayland Computer Use helper.

This executable is a private stdio child of an ADR-0011 authenticated graphical
session helper. It never opens a listener. Portal consent is owner-visible and is
never bypassed. All protocol failures are fail-closed and deliberately redacted.
"""

from __future__ import annotations

import argparse
import base64
import fcntl
import hashlib
import json
import os
import re
import signal
import stat as stat_module
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


PROTOCOL_VERSION = 1
BACKEND_ID = "linux-atspi-xdg-portal-pipewire"
LINUX_TARGET = "ubuntu-24.04-gnome-wayland"
MAX_FRAME_BYTES = 16 * 1024 * 1024
MAX_TEXT_BYTES = 1024 * 1024
MAX_CONTROLS = 2048
PORTAL_TIMEOUT_SECONDS = 60
CAPTURE_TIMEOUT_SECONDS = 10
REQUIRED_BINDING_KEYS = {
    "authentication",
    "helperInstanceId",
    "osSessionIdentity",
    "releaseVersion",
    "serviceEpoch",
}
IDENTIFIER_RE = re.compile(r"^[^\x00-\x1f\x7f]{1,256}$")


class HelperFailure(Exception):
    """A bounded public failure code. The original exception is never serialized."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class StreamBinding:
    node_id: int
    width: int
    height: int
    position_x: int
    position_y: int
    mapping_id: str

    @property
    def fingerprint(self) -> str:
        payload = json.dumps(
            {
                "node": self.node_id,
                "logicalSize": [self.width, self.height],
                "position": [self.position_x, self.position_y],
                "mappingId": self.mapping_id,
                "waylandDisplay": os.environ.get("WAYLAND_DISPLAY", ""),
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        return "portal-stream:sha256:" + hashlib.sha256(payload).hexdigest()


@dataclass
class AccessibleControl:
    control_id: str
    role: str
    label: str
    accessible: Any
    value: str | None = None
    selected: bool | None = None


class PortalSession:
    def __init__(self) -> None:
        self.bus: Any | None = None
        self.remote: Any | None = None
        self.screen_cast: Any | None = None
        self.session_handle: str | None = None
        self.pipewire_fd: int | None = None
        self.stream: StreamBinding | None = None
        self.devices = 0
        self.closed = False
        self.portal_version = 0
        self.screen_cast_version = 0

    def start(self) -> None:
        Gio, GLib, _Gst, _Atspi = load_gnome_modules()
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        if self.bus is None:
            raise HelperFailure("UNAVAILABLE")
        self.remote = Gio.DBusProxy.new_sync(
            self.bus,
            Gio.DBusProxyFlags.NONE,
            None,
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.RemoteDesktop",
            None,
        )
        self.screen_cast = Gio.DBusProxy.new_sync(
            self.bus,
            Gio.DBusProxyFlags.NONE,
            None,
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.ScreenCast",
            None,
        )
        self.portal_version = variant_uint(self.remote.get_cached_property("version"))
        self.screen_cast_version = variant_uint(
            self.screen_cast.get_cached_property("version")
        )
        available_devices = variant_uint(
            self.remote.get_cached_property("AvailableDeviceTypes")
        )
        available_sources = variant_uint(
            self.screen_cast.get_cached_property("AvailableSourceTypes")
        )
        if self.portal_version < 2 or (available_devices & 3) != 3:
            raise HelperFailure("UNAVAILABLE")
        if self.screen_cast_version < 3 or (available_sources & 3) == 0:
            raise HelperFailure("UNAVAILABLE")

        create = self._request(
            self.remote,
            "CreateSession",
            "(a{sv})",
            ({
                "handle_token": GLib.Variant("s", portal_token("create")),
                "session_handle_token": GLib.Variant("s", portal_token("session")),
            },),
        )
        session_handle = create.get("session_handle")
        if not isinstance(session_handle, str) or not session_handle.startswith(
            "/org/freedesktop/portal/desktop/session/"
        ):
            raise HelperFailure("UNAVAILABLE")
        self.session_handle = session_handle

        self._request(
            self.screen_cast,
            "SelectSources",
            "(oa{sv})",
            (
                session_handle,
                {
                    "handle_token": GLib.Variant("s", portal_token("sources")),
                    "types": GLib.Variant("u", available_sources & 3),
                    "multiple": GLib.Variant("b", False),
                    "cursor_mode": GLib.Variant("u", 2),
                },
            ),
        )
        self._request(
            self.remote,
            "SelectDevices",
            "(oa{sv})",
            (
                session_handle,
                {
                    "handle_token": GLib.Variant("s", portal_token("devices")),
                    "types": GLib.Variant("u", 3),
                    "persist_mode": GLib.Variant("u", 0),
                },
            ),
        )
        started = self._request(
            self.remote,
            "Start",
            "(osa{sv})",
            (
                session_handle,
                "",
                {"handle_token": GLib.Variant("s", portal_token("start"))},
            ),
        )
        devices = native_value(started.get("devices"))
        streams = native_value(started.get("streams"))
        if not isinstance(devices, int) or (devices & 3) != 3:
            raise HelperFailure("PERMISSION_DENIED")
        if not isinstance(streams, (list, tuple)) or len(streams) != 1:
            # v1 deliberately binds one owner-selected source. Multiple-source
            # coordinate mapping is not guessed.
            raise HelperFailure("UNAVAILABLE")
        self.devices = devices
        self.stream = parse_stream(streams[0])
        self.pipewire_fd = self._open_pipewire_remote()
        if self.pipewire_fd < 0:
            raise HelperFailure("UNAVAILABLE")
        self._subscribe_closed()

    def capture_png(self) -> tuple[bytes, int, int]:
        if (
            self.closed
            or self.stream is None
            or self.pipewire_fd is None
            or self.pipewire_fd < 0
        ):
            raise HelperFailure("UNAVAILABLE")
        _Gio, _GLib, Gst, _Atspi = load_gnome_modules()
        pipeline = Gst.parse_launch(
            "pipewiresrc name=source do-timestamp=true ! "
            "videoconvert ! video/x-raw,format=RGBA ! "
            "pngenc snapshot=true ! appsink name=sink max-buffers=1 drop=true"
        )
        source = pipeline.get_by_name("source")
        sink = pipeline.get_by_name("sink")
        if source is None or sink is None:
            raise HelperFailure("UNAVAILABLE")
        # The FD remains owned by this helper. GStreamer receives a duplicate so
        # one capture cannot invalidate the portal session.
        capture_fd = os.dup(self.pipewire_fd)
        source.set_property("fd", capture_fd)
        source.set_property("path", str(self.stream.node_id))
        try:
            if pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
                raise HelperFailure("UNAVAILABLE")
            sample = sink.emit(
                "try-pull-sample", CAPTURE_TIMEOUT_SECONDS * Gst.SECOND
            )
            if sample is None:
                raise HelperFailure("TIMEOUT")
            caps = sample.get_caps()
            structure = caps.get_structure(0) if caps is not None else None
            width = structure.get_value("width") if structure is not None else None
            height = structure.get_value("height") if structure is not None else None
            buffer = sample.get_buffer()
            if (
                not isinstance(width, int)
                or width <= 0
                or not isinstance(height, int)
                or height <= 0
                or buffer is None
            ):
                raise HelperFailure("UNAVAILABLE")
            mapped, info = buffer.map(Gst.MapFlags.READ)
            if not mapped:
                raise HelperFailure("UNAVAILABLE")
            try:
                result = bytes(info.data)
            finally:
                buffer.unmap(info)
            if (
                len(result) < 8
                or len(result) > MAX_FRAME_BYTES
                or result[:8] != b"\x89PNG\r\n\x1a\n"
            ):
                raise HelperFailure("UNAVAILABLE")
            return result, width, height
        finally:
            pipeline.set_state(Gst.State.NULL)
            os.close(capture_fd)

    def notify_text(self, text: str) -> None:
        if self.remote is None or self.session_handle is None or (self.devices & 1) == 0:
            raise HelperFailure("PERMISSION_DENIED")
        Gio, GLib, _Gst, _Atspi = load_gnome_modules()
        del Gio
        for character in text:
            keysym = ord(character)
            if keysym > 0xFF:
                keysym |= 0x01000000
            for state in (1, 0):
                self.remote.call_sync(
                    "NotifyKeyboardKeysym",
                    GLib.Variant(
                        "(oa{sv}iu)",
                        (self.session_handle, {}, keysym, state),
                    ),
                    0,
                    5_000,
                    None,
                )

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        if self.session_handle is not None and self.bus is not None:
            try:
                Gio, GLib, _Gst, _Atspi = load_gnome_modules()
                self.bus.call_sync(
                    "org.freedesktop.portal.Desktop",
                    self.session_handle,
                    "org.freedesktop.portal.Session",
                    "Close",
                    GLib.Variant("()", ()),
                    None,
                    Gio.DBusCallFlags.NONE,
                    5_000,
                    None,
                )
            except Exception:
                pass
        if self.pipewire_fd is not None:
            try:
                os.close(self.pipewire_fd)
            except OSError:
                pass
            self.pipewire_fd = None

    def _request(
        self, proxy: Any, method: str, signature: str, parameters: tuple[Any, ...]
    ) -> dict[str, Any]:
        if self.bus is None:
            raise HelperFailure("UNAVAILABLE")
        Gio, GLib, _Gst, _Atspi = load_gnome_modules()
        token = extract_handle_token(parameters)
        sender = self.bus.get_unique_name()
        if not isinstance(sender, str) or not sender.startswith(":"):
            raise HelperFailure("UNAVAILABLE")
        sender_path = sender[1:].replace(".", "_")
        expected_path = (
            f"/org/freedesktop/portal/desktop/request/{sender_path}/{token}"
        )
        outcome: dict[str, Any] = {}

        def response(
            _connection: Any,
            _sender_name: str,
            _object_path: str,
            _interface_name: str,
            _signal_name: str,
            values: Any,
            _user_data: Any,
        ) -> None:
            response_code, results = values.unpack()
            outcome["code"] = response_code
            outcome["results"] = native_value(results)

        subscription = self.bus.signal_subscribe(
            "org.freedesktop.portal.Desktop",
            "org.freedesktop.portal.Request",
            "Response",
            expected_path,
            None,
            Gio.DBusSignalFlags.NONE,
            response,
            None,
        )
        try:
            returned = proxy.call_sync(
                method,
                GLib.Variant(signature, parameters),
                Gio.DBusCallFlags.NONE,
                PORTAL_TIMEOUT_SECONDS * 1_000,
                None,
            )
            returned_path = returned.unpack()[0]
            if returned_path != expected_path:
                raise HelperFailure("UNAVAILABLE")
            context = GLib.MainContext.default()
            deadline = time.monotonic() + PORTAL_TIMEOUT_SECONDS
            while "code" not in outcome:
                if time.monotonic() >= deadline:
                    raise HelperFailure("TIMEOUT")
                # A blocking iteration could wait forever when a broken portal
                # returns a Request handle but never emits Response.
                while context.pending():
                    context.iteration(False)
                time.sleep(0.01)
        finally:
            self.bus.signal_unsubscribe(subscription)
        if outcome.get("code") != 0:
            raise HelperFailure("PERMISSION_DENIED")
        results = outcome.get("results")
        if not isinstance(results, dict):
            raise HelperFailure("UNAVAILABLE")
        return results

    def _open_pipewire_remote(self) -> int:
        if self.screen_cast is None or self.session_handle is None:
            raise HelperFailure("UNAVAILABLE")
        Gio, GLib, _Gst, _Atspi = load_gnome_modules()
        result, descriptors = self.screen_cast.call_with_unix_fd_list_sync(
            "OpenPipeWireRemote",
            GLib.Variant("(oa{sv})", (self.session_handle, {})),
            Gio.DBusCallFlags.NONE,
            30_000,
            None,
            None,
        )
        index = result.unpack()[0]
        if descriptors is None or not isinstance(index, int):
            raise HelperFailure("UNAVAILABLE")
        return descriptors.get(index)

    def _subscribe_closed(self) -> None:
        if self.bus is None or self.session_handle is None:
            return
        Gio, _GLib, _Gst, _Atspi = load_gnome_modules()

        def closed(*_arguments: Any) -> None:
            self.closed = True

        self.bus.signal_subscribe(
            "org.freedesktop.portal.Desktop",
            "org.freedesktop.portal.Session",
            "Closed",
            self.session_handle,
            None,
            Gio.DBusSignalFlags.NONE,
            closed,
            None,
        )


class NativeRuntime:
    def __init__(
        self,
        binding: dict[str, Any],
        parent_pid: int,
        fixture_result_directory: Path | None,
    ) -> None:
        self.binding = binding
        self.parent_pid = parent_pid
        self.fixture_result_directory = fixture_result_directory
        self.portal: PortalSession | None = None
        self.portal_failure: str | None = None
        self.controls: dict[str, AccessibleControl] = {}
        self.action_sequence = 0
        self.cancelled_executions: set[str] = set()
        self.emergency_stopped = False
        self.active_execution: str | None = None

    def dispatch(self, request: dict[str, Any]) -> Any:
        self._verify_parent()
        operation = request["operation"]
        if operation == "probe":
            return self.probe()
        if operation in {"observe", "capture", "act"}:
            execution = validate_execution(request.get("execution"), self.binding)
            self._require_execution_active(execution["executionHandleId"])
            self._claim_execution(execution["executionHandleId"])
            self._require_display(execution["expectedDisplayFingerprint"])
            if operation == "observe":
                return self.observe(execution)
            if operation == "capture":
                return self.capture()
            return self.act(execution, validate_action(request.get("action")))
        if operation in {"cancel", "emergency-stop"}:
            control = validate_control(request.get("control"))
            if operation == "cancel":
                self.cancelled_executions.add(control["executionHandleId"])
            else:
                self.emergency_stopped = True
                if self.portal is not None:
                    self.portal.close()
            return {"stopped": True}
        raise HelperFailure("UNAVAILABLE")

    def probe(self) -> dict[str, Any]:
        checks: dict[str, dict[str, str]] = {}
        checks["helper-authentication"] = passing(
            "Private inherited stdio is bound to the ADR-0011 authenticated helper."
        )
        if not supported_ubuntu():
            checks["interactive-session"] = failing(
                "The host did not prove Ubuntu 24.04 GNOME Wayland.",
                "Use the declared Ubuntu 24.04 GNOME Wayland target.",
            )
        elif not parent_alive(self.parent_pid):
            checks["interactive-session"] = failing(
                "The authenticated parent session helper is unavailable.",
                "Restart the OpenDelegate graphical user service.",
            )
        else:
            checks["interactive-session"] = passing(
                "Ubuntu 24.04 GNOME Wayland and the graphical session bus are active."
            )

        lock_state = gnome_session_locked()
        if lock_state is False:
            checks["unlocked-session"] = passing(
                "GNOME reports that the owner session is unlocked."
            )
        elif lock_state is True:
            checks["unlocked-session"] = failing(
                "GNOME reports that the owner session is locked.",
                "Unlock the owner session before Computer Use.",
            )
        else:
            checks["unlocked-session"] = failing(
                "The helper could not positively verify GNOME lock state.",
                "Verify the GNOME screen-lock service and restart the user helper.",
            )

        atspi_ready = False
        try:
            controls = enumerate_accessible_controls()
            self.controls = {control.control_id: control for control in controls}
            atspi_ready = len(controls) > 0
        except Exception:
            atspi_ready = False
        checks["accessibility"] = (
            passing("AT-SPI returned a bounded live accessibility tree.")
            if atspi_ready
            else failing(
                "AT-SPI did not return a live actionable accessibility tree.",
                "Install and enable AT-SPI, then expose the intended application.",
            )
        )

        frame_ready = False
        if checks["interactive-session"]["status"] == "pass" and lock_state is False:
            try:
                if self.portal is None or self.portal.closed:
                    self.portal = PortalSession()
                    self.portal.start()
                self.portal.capture_png()
                frame_ready = True
                self.portal_failure = None
            except HelperFailure as error:
                self.portal_failure = error.code
                self.portal.close()
                self.portal = None
            except Exception:
                self.portal_failure = "UNAVAILABLE"
                self.portal.close()
                self.portal = None
        checks["screen-capture"] = (
            passing(
                "The owner-approved ScreenCast portal returned a current PipeWire PNG frame."
            )
            if frame_ready
            else failing(
                "ScreenCast consent or current PipeWire frame flow is unavailable.",
                "Complete the GNOME sharing prompt and select one intended source.",
            )
        )
        input_ready = (
            self.portal is not None
            and not self.portal.closed
            and (self.portal.devices & 3) == 3
        )
        checks["input"] = (
            passing(
                "RemoteDesktop portal consent includes keyboard and pointer devices."
            )
            if input_ready
            else failing(
                "RemoteDesktop keyboard and pointer consent is unavailable.",
                "Approve keyboard and pointer control in the GNOME portal prompt.",
            )
        )
        ordered = [
            checks["interactive-session"],
            checks["unlocked-session"],
            checks["screen-capture"],
            checks["accessibility"],
            checks["input"],
            checks["helper-authentication"],
        ]
        names = [
            "interactive-session",
            "unlocked-session",
            "screen-capture",
            "accessibility",
            "input",
            "helper-authentication",
        ]
        return {
            "osFamily": "linux",
            "backendId": BACKEND_ID,
            "helperInstanceId": self.binding["helperInstanceId"],
            "serviceEpoch": self.binding["serviceEpoch"],
            "displayFingerprint": (
                self.portal.stream.fingerprint
                if frame_ready and self.portal is not None and self.portal.stream is not None
                else None
            ),
            "linuxTarget": LINUX_TARGET,
            "checks": [
                {"name": name, **check} for name, check in zip(names, ordered)
            ],
        }

    def observe(self, execution: dict[str, Any]) -> dict[str, Any]:
        controls = enumerate_accessible_controls()
        self.controls = {control.control_id: control for control in controls}
        result: dict[str, Any] = {
            "displayFingerprint": self._display_fingerprint(),
            "accessibilityTree": [
                {
                    "controlId": control.control_id,
                    "role": control.role,
                    "label": control.label,
                    **({"value": control.value} if control.value is not None else {}),
                    **(
                        {"selected": control.selected}
                        if control.selected is not None
                        else {}
                    ),
                }
                for control in controls
            ],
        }
        fixture = self._fixture_observation(execution["runId"])
        if fixture is not None:
            result["fixture"] = fixture
        return result

    def capture(self) -> dict[str, Any]:
        if self.portal is None:
            raise HelperFailure("UNAVAILABLE")
        png, width, height = self.portal.capture_png()
        return {
            "displayFingerprint": self._display_fingerprint(),
            "mediaType": "image/png",
            "width": width,
            "height": height,
            "bytesBase64": base64.b64encode(png).decode("ascii"),
        }

    def act(self, execution: dict[str, Any], action: dict[str, Any]) -> dict[str, Any]:
        control_id = action["controlId"]
        controls = enumerate_accessible_controls()
        self.controls = {control.control_id: control for control in controls}
        control = self.controls.get(control_id)
        if control is None:
            raise HelperFailure("UNAVAILABLE")
        if action["kind"] == "click":
            invoke_accessible(control)
        else:
            focus_accessible(control)
            clear_accessible_text(control)
            if self.portal is None:
                raise HelperFailure("PERMISSION_DENIED")
            self.portal.notify_text(action["text"])
        self.action_sequence += 1
        return {
            "displayFingerprint": self._display_fingerprint(),
            "sequence": self.action_sequence,
        }

    def close(self) -> None:
        self.emergency_stopped = True
        if self.portal is not None:
            self.portal.close()

    def _claim_execution(self, execution_handle: str) -> None:
        if self.active_execution is None:
            self.active_execution = execution_handle
        elif self.active_execution != execution_handle:
            # The deterministic Worker resource lease is the primary capacity-one
            # authority. This local guard independently rejects a second controller.
            raise HelperFailure("UNAVAILABLE")

    def _require_execution_active(self, execution_handle: str) -> None:
        if self.emergency_stopped:
            raise HelperFailure("EMERGENCY_STOPPED")
        if execution_handle in self.cancelled_executions:
            raise HelperFailure("CANCELLED")
        if gnome_session_locked() is not False:
            raise HelperFailure("SESSION_LOCKED")

    def _require_display(self, expected: str) -> None:
        if expected != self._display_fingerprint():
            raise HelperFailure("DISPLAY_CHANGED")

    def _display_fingerprint(self) -> str:
        if (
            self.portal is None
            or self.portal.closed
            or self.portal.stream is None
        ):
            raise HelperFailure("UNAVAILABLE")
        return self.portal.stream.fingerprint

    def _verify_parent(self) -> None:
        if os.getppid() != self.parent_pid or not parent_alive(self.parent_pid):
            self.close()
            raise HelperFailure("HELPER_CRASHED")

    def _fixture_observation(self, run_id: str) -> dict[str, Any] | None:
        if self.fixture_result_directory is None:
            return fixture_from_controls(self.controls, run_id, None)
        filename = f"fixture-result-{run_id}.json"
        path = self.fixture_result_directory / filename
        file_bytes: bytes | None = None
        if path.exists():
            descriptor = os.open(
                path,
                os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
            )
            try:
                metadata = os.fstat(descriptor)
                if (
                    not stat_module.S_ISREG(metadata.st_mode)
                    or metadata.st_size <= 0
                    or metadata.st_size > 1024 * 1024
                ):
                    raise HelperFailure("UNAVAILABLE")
                file_bytes = os.read(descriptor, metadata.st_size + 1)
            finally:
                os.close(descriptor)
            if len(file_bytes) != metadata.st_size:
                raise HelperFailure("UNAVAILABLE")
        return fixture_from_controls(self.controls, run_id, (filename, file_bytes))


def load_gnome_modules() -> tuple[Any, Any, Any, Any]:
    try:
        import gi  # type: ignore

        gi.require_version("Gio", "2.0")
        gi.require_version("Gst", "1.0")
        gi.require_version("Atspi", "2.0")
        from gi.repository import Atspi, Gio, GLib, Gst  # type: ignore

        Gst.init(None)
        Atspi.init()
        return Gio, GLib, Gst, Atspi
    except Exception as error:
        raise HelperFailure("UNAVAILABLE") from error


def enumerate_accessible_controls() -> list[AccessibleControl]:
    _Gio, _GLib, _Gst, Atspi = load_gnome_modules()
    desktop = Atspi.get_desktop(0)
    if desktop is None:
        raise HelperFailure("UNAVAILABLE")
    controls: list[AccessibleControl] = []

    def visit(accessible: Any, path: tuple[int, ...], depth: int) -> None:
        if depth > 32 or len(controls) >= MAX_CONTROLS:
            return
        try:
            role_name = str(accessible.get_role_name() or "").lower()
            label = str(accessible.get_name() or "").strip()
        except Exception:
            return
        role = normalized_role(role_name)
        if role is not None and label:
            control_id = canonical_fixture_id(label) or stable_control_id(
                path, role_name, label
            )
            value: str | None = None
            selected: bool | None = None
            if role == "textbox":
                try:
                    text = accessible.get_text_iface()
                    count = min(int(text.get_character_count()), 4096)
                    value = str(text.get_text(0, count))
                except Exception:
                    value = ""
            if role == "radio":
                try:
                    states = accessible.get_state_set()
                    selected = bool(
                        states.contains(Atspi.StateType.CHECKED)
                        or states.contains(Atspi.StateType.SELECTED)
                    )
                except Exception:
                    selected = False
            controls.append(
                AccessibleControl(
                    control_id=control_id,
                    role=role,
                    label=label,
                    accessible=accessible,
                    value=value,
                    selected=selected,
                )
            )
        try:
            count = min(int(accessible.get_child_count()), 1024)
        except Exception:
            count = 0
        for index in range(count):
            try:
                child = accessible.get_child_at_index(index)
            except Exception:
                continue
            if child is not None:
                visit(child, (*path, index), depth + 1)

    visit(desktop, (), 0)
    return controls


def invoke_accessible(control: AccessibleControl) -> None:
    try:
        action = control.accessible.get_action_iface()
        count = int(action.get_n_actions())
        preferred = 0
        for index in range(count):
            name = str(action.get_action_name(index) or "").lower()
            if name in {"click", "press", "activate", "toggle"}:
                preferred = index
                break
        if count <= 0 or not action.do_action(preferred):
            raise HelperFailure("UNAVAILABLE")
    except HelperFailure:
        raise
    except Exception as error:
        raise HelperFailure("UNAVAILABLE") from error


def focus_accessible(control: AccessibleControl) -> None:
    try:
        component = control.accessible.get_component_iface()
        if component is None or not component.grab_focus():
            raise HelperFailure("UNAVAILABLE")
    except HelperFailure:
        raise
    except Exception as error:
        raise HelperFailure("UNAVAILABLE") from error


def clear_accessible_text(control: AccessibleControl) -> None:
    try:
        editable = control.accessible.get_editable_text_iface()
        if editable is not None:
            editable.set_text_contents("")
    except Exception as error:
        raise HelperFailure("UNAVAILABLE") from error


def fixture_from_controls(
    controls: dict[str, AccessibleControl],
    run_id: str,
    result: tuple[str, bytes | None] | None,
) -> dict[str, Any] | None:
    required = {"task-text", "option-alpha", "option-beta", "submit"}
    if not required.issubset(controls):
        return None
    text = controls["task-text"].value or ""
    selected = (
        "Beta"
        if controls["option-beta"].selected
        else "Alpha"
        if controls["option-alpha"].selected
        else None
    )
    result_file = None
    state = "editing"
    if result is not None and result[1] is not None:
        state = "success"
        result_file = {
            "filename": result[0],
            "mediaType": "application/json",
            "bytesBase64": base64.b64encode(result[1]).decode("ascii"),
        }
    return {
        "runIdentifier": run_id,
        "state": state,
        "textValue": text,
        "selectedOption": selected,
        "resultFile": result_file,
    }


def gnome_session_locked() -> bool | None:
    try:
        Gio, GLib, _Gst, _Atspi = load_gnome_modules()
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        result = bus.call_sync(
            "org.gnome.ScreenSaver",
            "/org/gnome/ScreenSaver",
            "org.gnome.ScreenSaver",
            "GetActive",
            None,
            GLib.VariantType.new("(b)"),
            Gio.DBusCallFlags.NONE,
            5_000,
            None,
        )
        active = result.unpack()[0]
        return active if isinstance(active, bool) else None
    except Exception:
        return None


def supported_ubuntu() -> bool:
    if (
        os.environ.get("XDG_SESSION_TYPE") != "wayland"
        or "gnome"
        not in os.environ.get("XDG_CURRENT_DESKTOP", "").lower().split(":")
        or not os.environ.get("DBUS_SESSION_BUS_ADDRESS", "").startswith("unix:")
        or not os.environ.get("WAYLAND_DISPLAY")
    ):
        return False
    try:
        values: dict[str, str] = {}
        with open("/etc/os-release", "r", encoding="utf-8") as release_file:
            for line in release_file:
                if "=" in line:
                    key, raw = line.rstrip("\n").split("=", 1)
                    values[key] = raw.strip().strip('"')
        return values.get("ID") == "ubuntu" and values.get("VERSION_ID") == "24.04"
    except OSError:
        return False


def parse_stream(value: Any) -> StreamBinding:
    native = native_value(value)
    if not isinstance(native, (list, tuple)) or len(native) != 2:
        raise HelperFailure("UNAVAILABLE")
    node_id, properties = native
    if not isinstance(node_id, int) or node_id <= 0 or not isinstance(properties, dict):
        raise HelperFailure("UNAVAILABLE")
    logical_size = native_value(properties.get("logical_size"))
    size = native_value(properties.get("size"))
    dimensions = logical_size if valid_pair(logical_size) else size
    if not valid_pair(dimensions) or dimensions[0] <= 0 or dimensions[1] <= 0:
        raise HelperFailure("UNAVAILABLE")
    position = native_value(properties.get("position"))
    if not valid_pair(position):
        position = (0, 0)
    mapping_id = native_value(properties.get("mapping_id"))
    if mapping_id is None:
        mapping_id = ""
    if not isinstance(mapping_id, str) or len(mapping_id.encode("utf-8")) > 256:
        raise HelperFailure("UNAVAILABLE")
    return StreamBinding(
        node_id=node_id,
        width=int(dimensions[0]),
        height=int(dimensions[1]),
        position_x=int(position[0]),
        position_y=int(position[1]),
        mapping_id=mapping_id,
    )


def validate_request(value: Any, binding: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise HelperFailure("UNAVAILABLE")
    allowed = {
        "protocolVersion",
        "requestId",
        "sequence",
        "binding",
        "operation",
        "execution",
        "control",
        "action",
    }
    required = {"protocolVersion", "requestId", "sequence", "binding", "operation"}
    if not required.issubset(value) or not set(value).issubset(allowed):
        raise HelperFailure("UNAVAILABLE")
    if value["protocolVersion"] != PROTOCOL_VERSION:
        raise HelperFailure("UNAVAILABLE")
    require_identifier(value["requestId"])
    if not isinstance(value["sequence"], int) or value["sequence"] <= 0:
        raise HelperFailure("UNAVAILABLE")
    if value["binding"] != binding:
        raise HelperFailure("HELPER_CRASHED")
    if value["operation"] not in {
        "probe",
        "observe",
        "capture",
        "act",
        "cancel",
        "emergency-stop",
    }:
        raise HelperFailure("UNAVAILABLE")
    return value


def validate_execution(value: Any, binding: dict[str, Any]) -> dict[str, Any]:
    keys = {
        "executionHandleId",
        "taskId",
        "deviceId",
        "runId",
        "helperInstanceId",
        "serviceEpoch",
        "persistenceGeneration",
        "leaseId",
        "fencingToken",
        "expectedDisplayFingerprint",
    }
    if not isinstance(value, dict) or set(value) != keys:
        raise HelperFailure("UNAVAILABLE")
    for key in (
        "executionHandleId",
        "taskId",
        "deviceId",
        "runId",
        "helperInstanceId",
        "leaseId",
        "expectedDisplayFingerprint",
    ):
        require_identifier(value[key])
    for key in ("serviceEpoch", "persistenceGeneration", "fencingToken"):
        if not isinstance(value[key], int) or value[key] <= 0:
            raise HelperFailure("UNAVAILABLE")
    if (
        value["helperInstanceId"] != binding["helperInstanceId"]
        or value["serviceEpoch"] != binding["serviceEpoch"]
    ):
        raise HelperFailure("HELPER_CRASHED")
    return value


def validate_control(value: Any) -> dict[str, Any]:
    keys = {"executionHandleId", "taskId", "deviceId", "runId"}
    if not isinstance(value, dict) or set(value) != keys:
        raise HelperFailure("UNAVAILABLE")
    for key in keys:
        require_identifier(value[key])
    return value


def validate_action(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("kind") not in {"click", "type-text"}:
        raise HelperFailure("UNAVAILABLE")
    expected = (
        {"kind", "controlId"}
        if value["kind"] == "click"
        else {"kind", "controlId", "text"}
    )
    if set(value) != expected:
        raise HelperFailure("UNAVAILABLE")
    require_identifier(value["controlId"])
    if value["kind"] == "type-text":
        text = value["text"]
        if (
            not isinstance(text, str)
            or not text
            or len(text.encode("utf-8")) > MAX_TEXT_BYTES
        ):
            raise HelperFailure("UNAVAILABLE")
    return value


def validate_binding(arguments: argparse.Namespace) -> dict[str, Any]:
    binding = {
        "authentication": "adr-0011-hmac-sha256",
        "helperInstanceId": arguments.helper_instance_id,
        "osSessionIdentity": arguments.os_session_identity,
        "releaseVersion": arguments.release_version,
        "serviceEpoch": arguments.service_epoch,
    }
    if set(binding) != REQUIRED_BINDING_KEYS:
        raise HelperFailure("UNAVAILABLE")
    for key in (
        "helperInstanceId",
        "osSessionIdentity",
        "releaseVersion",
    ):
        require_identifier(binding[key])
    if not isinstance(binding["serviceEpoch"], int) or binding["serviceEpoch"] <= 0:
        raise HelperFailure("UNAVAILABLE")
    return binding


def response_envelope(
    request: dict[str, Any], binding: dict[str, Any], result: Any = None, error: str | None = None
) -> dict[str, Any]:
    envelope: dict[str, Any] = {
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request["requestId"],
        "sequence": request["sequence"],
        "binding": binding,
        "ok": error is None,
    }
    if error is None:
        envelope["result"] = result
    else:
        envelope["error"] = {"code": error}
    return envelope


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--stdio-child", action="store_true", required=True)
    parser.add_argument("--helper-instance-id", required=True)
    parser.add_argument("--service-epoch", required=True, type=int)
    parser.add_argument("--os-session-identity", required=True)
    parser.add_argument("--release-version", required=True)
    parser.add_argument("--parent-pid", required=True, type=int)
    parser.add_argument("--fixture-result-directory")
    arguments = parser.parse_args()
    if not arguments.stdio_child or arguments.parent_pid <= 0:
        raise HelperFailure("UNAVAILABLE")
    return arguments


def main() -> int:
    arguments = parse_arguments()
    binding = validate_binding(arguments)
    result_directory = (
        None
        if arguments.fixture_result_directory is None
        else safe_directory(Path(arguments.fixture_result_directory))
    )
    runtime_directory = safe_directory(Path(os.environ["XDG_RUNTIME_DIR"]))
    lock_path = runtime_directory / "opendelegate-computer-use-native.lock"
    lock_descriptor = os.open(
        lock_path,
        os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    fcntl.flock(lock_descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    runtime = NativeRuntime(binding, arguments.parent_pid, result_directory)

    def stop(_signum: int, _frame: Any) -> None:
        runtime.close()
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        while True:
            raw = sys.stdin.buffer.readline(MAX_FRAME_BYTES + 1)
            if raw == b"":
                break
            if len(raw) > MAX_FRAME_BYTES or not raw.endswith(b"\n"):
                break
            request: dict[str, Any] | None = None
            try:
                request = validate_request(
                    json.loads(raw[:-1].decode("utf-8")), binding
                )
                result = runtime.dispatch(request)
                response = response_envelope(request, binding, result=result)
            except HelperFailure as error:
                if request is None:
                    break
                response = response_envelope(request, binding, error=error.code)
            except Exception:
                if request is None:
                    break
                response = response_envelope(
                    request, binding, error="HELPER_CRASHED"
                )
            encoded = json.dumps(
                response, ensure_ascii=False, separators=(",", ":")
            ).encode("utf-8")
            if len(encoded) + 1 > MAX_FRAME_BYTES:
                break
            sys.stdout.buffer.write(encoded + b"\n")
            sys.stdout.buffer.flush()
    finally:
        runtime.close()
        os.close(lock_descriptor)
    return 0


def passing(evidence: str) -> dict[str, str]:
    return {"status": "pass", "evidence": evidence}


def failing(evidence: str, remediation: str) -> dict[str, str]:
    return {
        "status": "fail",
        "evidence": evidence,
        "remediation": remediation,
    }


def parent_alive(parent_pid: int) -> bool:
    try:
        os.kill(parent_pid, 0)
        return True
    except OSError:
        return False


def safe_directory(path: Path) -> Path:
    if not path.is_absolute() or "\x00" in str(path):
        raise HelperFailure("UNAVAILABLE")
    resolved = path.resolve(strict=True)
    if not resolved.is_dir() or resolved != path:
        raise HelperFailure("UNAVAILABLE")
    return resolved


def require_identifier(value: Any) -> str:
    if not isinstance(value, str) or value != value.strip() or not IDENTIFIER_RE.fullmatch(value):
        raise HelperFailure("UNAVAILABLE")
    return value


def portal_token(prefix: str) -> str:
    return f"opendelegate_{prefix}_{os.getpid()}_{time.monotonic_ns()}"


def extract_handle_token(parameters: tuple[Any, ...]) -> str:
    for item in reversed(parameters):
        if isinstance(item, dict) and "handle_token" in item:
            token = native_value(item["handle_token"])
            if isinstance(token, str):
                return token
    raise HelperFailure("UNAVAILABLE")


def native_value(value: Any) -> Any:
    if hasattr(value, "unpack"):
        return native_value(value.unpack())
    if isinstance(value, dict):
        return {key: native_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return tuple(native_value(item) for item in value)
    return value


def variant_uint(value: Any) -> int:
    native = native_value(value)
    if not isinstance(native, int) or native < 0:
        raise HelperFailure("UNAVAILABLE")
    return native


def valid_pair(value: Any) -> bool:
    return (
        isinstance(value, (list, tuple))
        and len(value) == 2
        and all(isinstance(item, int) for item in value)
    )


def normalized_role(role_name: str) -> str | None:
    if role_name in {"push button", "button"}:
        return "button"
    if role_name in {"radio button", "radio"}:
        return "radio"
    if role_name in {"entry", "text", "text frame", "password text"}:
        return "textbox"
    return None


def canonical_fixture_id(label: str) -> str | None:
    return {
        "Task text": "task-text",
        "Alpha": "option-alpha",
        "Beta": "option-beta",
        "Submit": "submit",
    }.get(label)


def stable_control_id(path: tuple[int, ...], role: str, label: str) -> str:
    payload = f"{'/'.join(str(index) for index in path)}\0{role}\0{label}".encode(
        "utf-8"
    )
    return "atspi:" + hashlib.sha256(payload).hexdigest()[:32]


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (HelperFailure, BlockingIOError, KeyError, OSError):
        # stderr remains generic. Portal details, paths, and typed text never leave
        # the helper protocol boundary.
        sys.stderr.write("OpenDelegate Linux Computer Use helper unavailable.\n")
        raise SystemExit(1)
