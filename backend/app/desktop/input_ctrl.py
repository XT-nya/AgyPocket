"""Win32 SendInput mouse, Unicode text, hotkey, and emergency Esc controller."""

from __future__ import annotations

import ctypes
import os
import threading
import time
from ctypes import wintypes

_input_lock = threading.Lock()
_dpi_initialized = False

INPUT_MOUSE = 0
INPUT_KEYBOARD = 1

MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_WHEEL = 0x0800
MOUSEEVENTF_VIRTUALDESK = 0x4000
MOUSEEVENTF_ABSOLUTE = 0x8000

KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004

SM_XVIRTUALSCREEN = 76
SM_YVIRTUALSCREEN = 77
SM_CXVIRTUALSCREEN = 78
SM_CYVIRTUALSCREEN = 79

VK_CODES: dict[str, int] = {
    "BACKSPACE": 0x08,
    "TAB": 0x09,
    "ENTER": 0x0D,
    "SHIFT": 0x10,
    "CTRL": 0x11,
    "CONTROL": 0x11,
    "ALT": 0x12,
    "ESC": 0x1B,
    "ESCAPE": 0x1B,
    "SPACE": 0x20,
    "PGUP": 0x21,
    "PGDN": 0x22,
    "END": 0x23,
    "HOME": 0x24,
    "LEFT": 0x25,
    "UP": 0x26,
    "RIGHT": 0x27,
    "DOWN": 0x28,
    "DELETE": 0x2E,
    "WIN": 0x5B,
    "LWIN": 0x5B,
}


def ensure_dpi_awareness() -> None:
    global _dpi_initialized
    if _dpi_initialized or os.name != "nt":
        return
    _dpi_initialized = True
    try:
        # DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4
        ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


def normalize_to_sendinput(
    x: int,
    y: int,
    vx: int,
    vy: int,
    vw: int,
    vh: int,
) -> tuple[int, int]:
    """Convert virtual-desktop pixel coordinates to Win32 SendInput [0, 65535] coordinates."""
    clamped_x = max(vx, min(vx + max(1, vw) - 1, int(x)))
    clamped_y = max(vy, min(vy + max(1, vh) - 1, int(y)))
    abs_x = int(((clamped_x - vx) * 65535) / max(1, vw - 1))
    abs_y = int(((clamped_y - vy) * 65535) / max(1, vh - 1))
    return abs_x, abs_y


if os.name == "nt":
    ULONG_PTR = ctypes.POINTER(ctypes.c_ulong)

    class MOUSEINPUT(ctypes.Structure):
        _fields_ = [
            ("dx", wintypes.LONG),
            ("dy", wintypes.LONG),
            ("mouseData", wintypes.DWORD),
            ("dwFlags", wintypes.DWORD),
            ("time", wintypes.DWORD),
            ("dwExtraInfo", ULONG_PTR),
        ]

    class KEYBDINPUT(ctypes.Structure):
        _fields_ = [
            ("wVk", wintypes.WORD),
            ("wScan", wintypes.WORD),
            ("dwFlags", wintypes.DWORD),
            ("time", wintypes.DWORD),
            ("dwExtraInfo", ULONG_PTR),
        ]

    class HARDWAREINPUT(ctypes.Structure):
        _fields_ = [
            ("uMsg", wintypes.DWORD),
            ("wParamL", wintypes.WORD),
            ("wParamH", wintypes.WORD),
        ]

    class _INPUT_UNION(ctypes.Union):
        _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]

    class INPUT(ctypes.Structure):
        _fields_ = [("type", wintypes.DWORD), ("union", _INPUT_UNION)]

    def _send_inputs(items: list[INPUT]) -> None:
        if not items:
            return
        arr = (INPUT * len(items))(*items)
        ctypes.windll.user32.SendInput(len(items), arr, ctypes.sizeof(INPUT))

    def _get_virtual_screen_rect() -> tuple[int, int, int, int]:
        ensure_dpi_awareness()
        user32 = ctypes.windll.user32
        vx = user32.GetSystemMetrics(SM_XVIRTUALSCREEN)
        vy = user32.GetSystemMetrics(SM_YVIRTUALSCREEN)
        vw = user32.GetSystemMetrics(SM_CXVIRTUALSCREEN) or 1920
        vh = user32.GetSystemMetrics(SM_CYVIRTUALSCREEN) or 1080
        return vx, vy, vw, vh

    def _make_mouse_input(dx: int, dy: int, flags: int, data: int = 0) -> INPUT:
        return INPUT(
            type=INPUT_MOUSE,
            union=_INPUT_UNION(mi=MOUSEINPUT(dx=dx, dy=dy, mouseData=data, dwFlags=flags, time=0, dwExtraInfo=None)),
        )

    def _make_key_input(vk: int = 0, scan: int = 0, flags: int = 0) -> INPUT:
        return INPUT(
            type=INPUT_KEYBOARD,
            union=_INPUT_UNION(ki=KEYBDINPUT(wVk=vk, wScan=scan, dwFlags=flags, time=0, dwExtraInfo=None)),
        )

    def perform_mouse_action(
        action: str,
        x: int,
        y: int,
        delta: int = 0,
        count: int = 1,
        interval_ms: int = 55,
        to_x: int | None = None,
        to_y: int | None = None,
    ) -> None:
        with _input_lock:
            vx, vy, vw, vh = _get_virtual_screen_rect()
            ax, ay = normalize_to_sendinput(x, y, vx, vy, vw, vh)
            move_flags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK

            if action == "move":
                _send_inputs([_make_mouse_input(ax, ay, move_flags)])
            elif action == "click":
                _send_inputs(
                    [
                        _make_mouse_input(ax, ay, move_flags),
                        _make_mouse_input(ax, ay, move_flags | MOUSEEVENTF_LEFTDOWN),
                        _make_mouse_input(ax, ay, move_flags | MOUSEEVENTF_LEFTUP),
                    ]
                )
            elif action == "double_click":
                _send_inputs(
                    [
                        _make_mouse_input(ax, ay, move_flags),
                        _make_mouse_input(ax, ay, move_flags | MOUSEEVENTF_LEFTDOWN),
                        _make_mouse_input(ax, ay, move_flags | MOUSEEVENTF_LEFTUP),
                    ]
                )
                time.sleep(0.05)
                _send_inputs(
                    [
                        _make_mouse_input(ax, ay, move_flags | MOUSEEVENTF_LEFTDOWN),
                        _make_mouse_input(ax, ay, move_flags | MOUSEEVENTF_LEFTUP),
                    ]
                )
            elif action == "right_click":
                _send_inputs(
                    [
                        _make_mouse_input(ax, ay, move_flags),
                        _make_mouse_input(ax, ay, move_flags | MOUSEEVENTF_RIGHTDOWN),
                        _make_mouse_input(ax, ay, move_flags | MOUSEEVENTF_RIGHTUP),
                    ]
                )
            elif action == "left_down":
                _send_inputs(
                    [
                        _make_mouse_input(ax, ay, move_flags),
                        _make_mouse_input(ax, ay, move_flags | MOUSEEVENTF_LEFTDOWN),
                    ]
                )
            elif action == "left_up":
                _send_inputs(
                    [
                        _make_mouse_input(ax, ay, move_flags),
                        _make_mouse_input(ax, ay, move_flags | MOUSEEVENTF_LEFTUP),
                    ]
                )
            elif action == "right_down":
                _send_inputs(
                    [
                        _make_mouse_input(ax, ay, move_flags),
                        _make_mouse_input(ax, ay, move_flags | MOUSEEVENTF_RIGHTDOWN),
                    ]
                )
            elif action == "right_up":
                _send_inputs(
                    [
                        _make_mouse_input(ax, ay, move_flags),
                        _make_mouse_input(ax, ay, move_flags | MOUSEEVENTF_RIGHTUP),
                    ]
                )
            elif action == "rapid_click":
                n = max(2, min(20, int(count)))
                delay_s = max(20, min(500, int(interval_ms))) / 1000.0
                _send_inputs([_make_mouse_input(ax, ay, move_flags)])
                for i in range(n):
                    _send_inputs(
                        [
                            _make_mouse_input(ax, ay, move_flags | MOUSEEVENTF_LEFTDOWN),
                            _make_mouse_input(ax, ay, move_flags | MOUSEEVENTF_LEFTUP),
                        ]
                    )
                    if i < n - 1:
                        time.sleep(delay_s)
            elif action == "drag":
                if to_x is not None and to_y is not None:
                    tax, tay = normalize_to_sendinput(to_x, to_y, vx, vy, vw, vh)
                    _send_inputs(
                        [
                            _make_mouse_input(ax, ay, move_flags),
                            _make_mouse_input(ax, ay, move_flags | MOUSEEVENTF_LEFTDOWN),
                        ]
                    )
                    time.sleep(0.03)
                    steps = 8
                    for step in range(1, steps + 1):
                        ix = int(ax + ((tax - ax) * step) / steps)
                        iy = int(ay + ((tay - ay) * step) / steps)
                        _send_inputs([_make_mouse_input(ix, iy, move_flags)])
                        time.sleep(0.015)
                    _send_inputs([_make_mouse_input(tax, tay, move_flags | MOUSEEVENTF_LEFTUP)])
                else:
                    _send_inputs(
                        [
                            _make_mouse_input(ax, ay, move_flags),
                            _make_mouse_input(ax, ay, move_flags | MOUSEEVENTF_LEFTDOWN),
                        ]
                    )
            elif action == "scroll":
                wheel_amount = delta if delta != 0 else 240
                _send_inputs(
                    [
                        _make_mouse_input(ax, ay, move_flags),
                        _make_mouse_input(0, 0, MOUSEEVENTF_WHEEL, data=wheel_amount & 0xFFFFFFFF),
                    ]
                )

    def type_unicode_text(text: str) -> None:
        if not text:
            return
        utf16_bytes = text.encode("utf-16-le")
        code_units = [int.from_bytes(utf16_bytes[i : i + 2], "little") for i in range(0, len(utf16_bytes), 2)]
        inputs: list[INPUT] = []
        for unit in code_units:
            if unit == 0x000A:  # newline -> Enter
                inputs.append(_make_key_input(vk=VK_CODES["ENTER"]))
                inputs.append(_make_key_input(vk=VK_CODES["ENTER"], flags=KEYEVENTF_KEYUP))
                continue
            inputs.append(_make_key_input(vk=0, scan=unit, flags=KEYEVENTF_UNICODE))
            inputs.append(_make_key_input(vk=0, scan=unit, flags=KEYEVENTF_UNICODE | KEYEVENTF_KEYUP))
        with _input_lock:
            # Send in chunks of 64 events to stay well inside OS input buffer limits
            for i in range(0, len(inputs), 64):
                _send_inputs(inputs[i : i + 64])

    def send_hotkey(chord: str) -> None:
        parts = [p.strip().upper() for p in (chord or "").split("+") if p.strip()]
        if not parts:
            return
        vks: list[int] = []
        for part in parts:
            if part in VK_CODES:
                vks.append(VK_CODES[part])
            elif len(part) == 1 and ("A" <= part <= "Z" or "0" <= part <= "9"):
                vks.append(ord(part))
            else:
                raise ValueError(f"Unsupported key in chord: {part}")
        inputs: list[INPUT] = [_make_key_input(vk=vk) for vk in vks]
        for vk in reversed(vks):
            inputs.append(_make_key_input(vk=vk, flags=KEYEVENTF_KEYUP))
        with _input_lock:
            _send_inputs(inputs)

    def emergency_esc() -> None:
        with _input_lock:
            # Release any held mouse buttons & modifier keys, then trigger Esc cleanly
            _send_inputs(
                [
                    _make_mouse_input(0, 0, MOUSEEVENTF_LEFTUP | MOUSEEVENTF_RIGHTUP),
                    _make_key_input(vk=VK_CODES["CTRL"], flags=KEYEVENTF_KEYUP),
                    _make_key_input(vk=VK_CODES["ALT"], flags=KEYEVENTF_KEYUP),
                    _make_key_input(vk=VK_CODES["SHIFT"], flags=KEYEVENTF_KEYUP),
                    _make_key_input(vk=VK_CODES["ESC"]),
                    _make_key_input(vk=VK_CODES["ESC"], flags=KEYEVENTF_KEYUP),
                ]
            )
else:
    def perform_mouse_action(
        action: str,
        x: int,
        y: int,
        delta: int = 0,
        count: int = 1,
        interval_ms: int = 55,
        to_x: int | None = None,
        to_y: int | None = None,
    ) -> None:
        pass

    def type_unicode_text(text: str) -> None:
        pass

    def send_hotkey(chord: str) -> None:
        pass

    def emergency_esc() -> None:
        pass
