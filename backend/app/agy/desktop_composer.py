"""Native Windows UI Automation composer sync for Antigravity Desktop."""

from __future__ import annotations

import ctypes
import os
import time
from typing import Any

from app.desktop.input_ctrl import send_hotkey

CF_UNICODETEXT = 13
GMEM_MOVEABLE = 0x0002
DESKTOP_SWITCHDESKTOP = 0x0100
DESKTOP_READOBJECTS = 0x0001

AMBIGUOUS_TITLES = {"新对话", "主工作台"}
EXCLUDED_EDIT_HINTS = ("search", "搜索", "filter", "筛选", "find", "查找", "address", "地址")


def _is_desktop_unlocked() -> bool:
    if os.name != "nt":
        return False
    try:
        user32 = ctypes.windll.user32
        hdesk = user32.OpenInputDesktop(0, False, DESKTOP_READOBJECTS | DESKTOP_SWITCHDESKTOP)
        if not hdesk:
            return False
        user32.CloseDesktop(hdesk)
        return True
    except Exception:
        return False


def _get_clipboard_unicode_text() -> tuple[bool, str]:
    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    if not user32.IsClipboardFormatAvailable(CF_UNICODETEXT):
        return False, ""
    if not user32.OpenClipboard(None):
        return False, ""
    try:
        handle = user32.GetClipboardData(CF_UNICODETEXT)
        if not handle:
            return False, ""
        ptr = kernel32.GlobalLock(handle)
        if not ptr:
            return False, ""
        try:
            return True, ctypes.wstring_at(ptr)
        finally:
            kernel32.GlobalUnlock(handle)
    finally:
        user32.CloseClipboard()


def _set_clipboard_unicode_text(text: str) -> bool:
    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    raw = (text + "\0").encode("utf-16-le")
    for _ in range(3):
        if user32.OpenClipboard(None):
            break
        time.sleep(0.03)
    else:
        return False

    try:
        user32.EmptyClipboard()
        hmem = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(raw))
        if not hmem:
            return False
        ptr = kernel32.GlobalLock(hmem)
        if not ptr:
            kernel32.GlobalFree(hmem)
            return False
        try:
            ctypes.memmove(ptr, raw, len(raw))
        finally:
            kernel32.GlobalUnlock(hmem)
        if not user32.SetClipboardData(CF_UNICODETEXT, hmem):
            kernel32.GlobalFree(hmem)
            return False
        return True
    finally:
        user32.CloseClipboard()


def _is_ambiguous_title(title: str) -> bool:
    clean = " ".join((title or "").split())
    if not clean or clean in AMBIGUOUS_TITLES:
        return True
    if clean.startswith("会话 ") or clean.startswith("反重力会话 "):
        return True
    return False


def try_send_via_desktop_ui(
    prompt: str,
    expected_title: str = "",
    conversation_id: str = "",
) -> tuple[bool, str]:
    """Attempt to inject prompt into the matching Antigravity Desktop composer input."""
    del conversation_id
    if os.name != "nt":
        return False, "windows_only"
    clean_prompt = (prompt or "").strip()
    if not clean_prompt:
        return False, "empty_prompt"
    if _is_ambiguous_title(expected_title):
        return False, "ambiguous_title"
    if not _is_desktop_unlocked():
        return False, "desktop_locked"

    try:
        import uiautomation as uia
    except Exception:
        return False, "uia_unavailable"

    title_norm = " ".join(expected_title.split()).lower()
    title_prefix = title_norm[:18]

    try:
        with uia.UIAutomationInitializerInThread(debug=False):
            uia.SetGlobalSearchTimeout(1.0)
            root = uia.GetRootControl()
            antigravity_win = None
            for child in root.GetChildren():
                try:
                    if child.ControlTypeName != "WindowControl":
                        continue
                    if bool(child.IsOffscreen):
                        continue
                    wname = (child.Name or "").lower()
                    if "antigravity" in wname:
                        antigravity_win = child
                        break
                except Exception:
                    continue

            if antigravity_win is None:
                return False, "window_not_found"

            title_matched = title_norm in (antigravity_win.Name or "").lower()
            candidates: list[tuple[int, int, Any]] = []
            queue: list[tuple[Any, int]] = [(antigravity_win, 0)]
            visited = 0
            max_visit = 1200

            while queue and visited < max_visit:
                node, depth = queue.pop(0)
                visited += 1
                try:
                    ctype = node.ControlTypeName
                    name = (node.Name or "").strip()
                    is_offscreen = bool(node.IsOffscreen)
                    is_enabled = bool(node.IsEnabled)
                    rect = node.BoundingRectangle
                except Exception:
                    continue

                if not is_offscreen and name:
                    name_norm = " ".join(name.split()).lower()
                    if title_norm in name_norm or (len(title_prefix) >= 6 and title_prefix in name_norm):
                        title_matched = True

                if (
                    not is_offscreen
                    and is_enabled
                    and ctype in {"EditControl", "DocumentControl"}
                    and rect
                ):
                    w = rect.width()
                    h = rect.height()
                    lower_name = name.lower()
                    if (
                        w >= 150
                        and h >= 20
                        and not any(tok in lower_name for tok in EXCLUDED_EDIT_HINTS)
                    ):
                        cx = rect.left + w // 2
                        cy = rect.top + h // 2
                        candidates.append((rect.bottom, w * h, (node, cx, cy)))

                if depth < 10:
                    try:
                        for child in node.GetChildren():
                            queue.append((child, depth + 1))
                    except Exception:
                        pass

            if not title_matched:
                return False, "title_mismatch"
            if not candidates:
                return False, "input_not_found"

            candidates.sort(key=lambda item: (item[0], item[1]), reverse=True)
            target_node, cx, cy = candidates[0][2]

            try:
                antigravity_win.SetActive()
            except Exception:
                pass
            try:
                target_node.SetFocus()
            except Exception:
                pass
            uia.Click(cx, cy)
            time.sleep(0.06)

            had_prev, prev_text = _get_clipboard_unicode_text()
            if not _set_clipboard_unicode_text(clean_prompt):
                return False, "clipboard_busy"
            try:
                send_hotkey("CTRL+V")
                time.sleep(0.12)
                send_hotkey("ENTER")
                time.sleep(0.18)
            finally:
                if had_prev:
                    _set_clipboard_unicode_text(prev_text)
            return True, "ok"
    except Exception as exc:
        return False, f"uia_error:{exc.__class__.__name__}"
