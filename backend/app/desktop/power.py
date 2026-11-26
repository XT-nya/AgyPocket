"""Windows system telemetry, active window title, and prevent-sleep control."""

from __future__ import annotations

import ctypes
import os
import time
from typing import Any

import psutil

ES_CONTINUOUS = 0x80000000
ES_SYSTEM_REQUIRED = 0x00000001

_prevent_sleep_active = False


def set_prevent_sleep(enabled: bool) -> bool:
    global _prevent_sleep_active
    _prevent_sleep_active = bool(enabled)
    if os.name == "nt":
        try:
            flags = ES_CONTINUOUS | ES_SYSTEM_REQUIRED if enabled else ES_CONTINUOUS
            ctypes.windll.kernel32.SetThreadExecutionState(flags)
        except Exception:
            pass
    return _prevent_sleep_active


def is_prevent_sleep_active() -> bool:
    return _prevent_sleep_active


def get_foreground_window_title() -> str:
    if os.name != "nt":
        return ""
    try:
        user32 = ctypes.windll.user32
        hwnd = user32.GetForegroundWindow()
        if not hwnd:
            return ""
        length = user32.GetWindowTextLengthW(hwnd)
        if length <= 0:
            return ""
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        return buf.value
    except Exception:
        return ""


def get_system_telemetry() -> dict[str, Any]:
    mem = psutil.virtual_memory()
    try:
        disk = psutil.disk_usage("C:\\" if os.name == "nt" else "/")
        disk_percent = round(disk.percent, 1)
    except Exception:
        disk_percent = 0.0

    battery_info = None
    try:
        batt = psutil.sensors_battery()
        if batt is not None:
            battery_info = {
                "percent": round(batt.percent, 1),
                "plugged_in": bool(batt.power_plugged),
            }
    except Exception:
        battery_info = None

    uptime_sec = max(0, int(time.time() - psutil.boot_time()))
    return {
        "cpu_percent": round(psutil.cpu_percent(interval=None), 1),
        "ram_percent": round(mem.percent, 1),
        "ram_used_gb": round(mem.used / (1024 ** 3), 1),
        "ram_total_gb": round(mem.total / (1024 ** 3), 1),
        "disk_percent": disk_percent,
        "battery": battery_info,
        "foreground_window": get_foreground_window_title(),
        "uptime_seconds": uptime_sec,
        "prevent_sleep": _prevent_sleep_active,
    }
