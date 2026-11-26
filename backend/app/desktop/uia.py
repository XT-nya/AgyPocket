"""Windows UI Automation interactive control enumerator."""

from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import mss

from app.desktop.power import get_foreground_window_title

_UIA_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="agypocket-uia")

INTERACTIVE_CONTROL_TYPES = {
    "ButtonControl",
    "EditControl",
    "TabItemControl",
    "MenuItemControl",
    "HyperlinkControl",
    "CheckBoxControl",
    "RadioButtonControl",
    "ComboBoxControl",
    "ListItemControl",
    "SplitButtonControl",
    "TreeItemControl",
}

ROLE_LABELS = {
    "ButtonControl": "Button",
    "EditControl": "Edit",
    "TabItemControl": "Tab",
    "MenuItemControl": "Menu",
    "HyperlinkControl": "Link",
    "CheckBoxControl": "CheckBox",
    "RadioButtonControl": "Radio",
    "ComboBoxControl": "ComboBox",
    "ListItemControl": "ListItem",
    "SplitButtonControl": "SplitButton",
    "TreeItemControl": "TreeItem",
}


def _get_monitor_bounds(monitor_index: int = 1) -> tuple[int, int, int, int]:
    try:
        with mss.MSS() as sct:
            monitors = sct.monitors
            idx = monitor_index if 1 <= monitor_index < len(monitors) else (1 if len(monitors) > 1 else 0)
            mon = monitors[idx]
            return mon["left"], mon["top"], mon["width"], mon["height"]
    except Exception:
        return 0, 0, 1920, 1080


def _scan_controls_sync(monitor_index: int = 1, max_controls: int = 80) -> dict[str, Any]:
    import uiautomation as uia

    mon_left, mon_top, mon_w, mon_h = _get_monitor_bounds(monitor_index)
    win_title = get_foreground_window_title()
    controls_raw: list[dict[str, Any]] = []
    seen_centers: list[tuple[int, int]] = []

    with uia.UIAutomationInitializerInThread(debug=False):
        uia.SetGlobalSearchTimeout(1.2)
        fg = uia.GetForegroundControl()
        if fg is None:
            fg = uia.GetRootControl()

        # BFS up to depth 7 so deep Electron/UWP UIs remain bounded & snappy
        queue: list[tuple[Any, int]] = [(fg, 0)]
        visited = 0
        max_visit = 900

        while queue and visited < max_visit and len(controls_raw) < max_controls * 2:
            node, depth = queue.pop(0)
            visited += 1
            try:
                ctype = node.ControlTypeName
                rect = node.BoundingRectangle
                is_offscreen = bool(node.IsOffscreen)
                is_enabled = bool(node.IsEnabled)
            except Exception:
                continue

            if rect and not is_offscreen:
                w = rect.width()
                h = rect.height()
                if w >= 8 and h >= 8 and is_enabled:
                    cx = rect.left + w // 2
                    cy = rect.top + h // 2
                    in_mon = (mon_left <= cx <= mon_left + mon_w) and (mon_top <= cy <= mon_top + mon_h)
                    if in_mon and ctype in INTERACTIVE_CONTROL_TYPES:
                        # Deduplicate controls with near-identical center points
                        duplicate = any(abs(cx - px) <= 6 and abs(cy - py) <= 6 for px, py in seen_centers)
                        if not duplicate:
                            try:
                                name = (node.Name or "").strip()
                            except Exception:
                                name = ""
                            if not name and ctype == "EditControl":
                                name = "输入框"
                            if name or ctype in {"ButtonControl", "EditControl", "ComboBoxControl"}:
                                seen_centers.append((cx, cy))
                                clipped_x = max(mon_left, rect.left)
                                clipped_y = max(mon_top, rect.top)
                                clipped_w = min(mon_left + mon_w, rect.right) - clipped_x
                                clipped_h = min(mon_top + mon_h, rect.bottom) - clipped_y
                                if clipped_w >= 6 and clipped_h >= 6:
                                    controls_raw.append(
                                        {
                                            "name": (name or ROLE_LABELS.get(ctype, ctype))[:48],
                                            "role": ROLE_LABELS.get(ctype, ctype),
                                            "rect": [clipped_x, clipped_y, clipped_w, clipped_h],
                                            "center": [cx, cy],
                                            "norm_rect": [
                                                round((clipped_x - mon_left) / max(1, mon_w), 4),
                                                round((clipped_y - mon_top) / max(1, mon_h), 4),
                                                round(clipped_w / max(1, mon_w), 4),
                                                round(clipped_h / max(1, mon_h), 4),
                                            ],
                                            "norm_center": [
                                                round((cx - mon_left) / max(1, mon_w), 4),
                                                round((cy - mon_top) / max(1, mon_h), 4),
                                            ],
                                        }
                                    )

            if depth < 7:
                try:
                    children = node.GetChildren()
                    for child in children:
                        queue.append((child, depth + 1))
                except Exception:
                    pass

    # Sort top-to-bottom (bucketed every 24px), then left-to-right
    controls_raw.sort(key=lambda c: (c["rect"][1] // 24, c["rect"][0]))
    final_controls = []
    for idx, ctrl in enumerate(controls_raw[:max_controls], start=1):
        ctrl["index"] = idx
        final_controls.append(ctrl)

    return {
        "window_title": win_title or "Desktop",
        "monitor_index": monitor_index,
        "screen_left": mon_left,
        "screen_top": mon_top,
        "screen_width": mon_w,
        "screen_height": mon_h,
        "controls": final_controls,
    }


async def scan_controls(monitor_index: int = 1, max_controls: int = 80) -> dict[str, Any]:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_UIA_EXECUTOR, _scan_controls_sync, monitor_index, max_controls)
