"""Fast Windows screen capture with mss and Pillow JPEG encoding."""

from __future__ import annotations

import io
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import mss
import mss.exception
from PIL import Image

from app.config import get_data_dir

PRESET_PARAMS: dict[str, tuple[float, int]] = {
    "fast": (0.55, 55),
    "balanced": (0.75, 68),
    "hd": (1.0, 85),
}


@dataclass
class FrameCapture:
    jpeg_bytes: bytes
    width: int
    height: int
    monitor_left: int
    monitor_top: int
    monitor_width: int
    monitor_height: int
    screen_locked: bool = False


def list_monitors() -> list[dict[str, Any]]:
    try:
        with mss.MSS() as sct:
            result = []
            # monitors[0] is the virtual all-in-one bounding monitor; 1..N are physical monitors
            for idx, mon in enumerate(sct.monitors[1:], start=1):
                result.append(
                    {
                        "index": idx,
                        "left": mon["left"],
                        "top": mon["top"],
                        "width": mon["width"],
                        "height": mon["height"],
                    }
                )
            return result
    except Exception:
        return []


def capture_screen_frame(
    monitor_index: int = 1,
    preset: str | None = None,
    scale: float | None = None,
    quality: int | None = None,
) -> FrameCapture:
    if preset and preset in PRESET_PARAMS:
        eff_scale, eff_quality = PRESET_PARAMS[preset]
    else:
        eff_scale = scale if scale is not None else 0.75
        eff_quality = quality if quality is not None else 68

    eff_scale = max(0.25, min(1.0, float(eff_scale)))
    eff_quality = max(20, min(95, int(eff_quality)))

    try:
        with mss.MSS() as sct:
            monitors = sct.monitors
            if monitor_index < 1 or monitor_index >= len(monitors):
                monitor_index = 1 if len(monitors) > 1 else 0
            mon = monitors[monitor_index]
            shot = sct.grab(mon)
            img = Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")

            if eff_scale < 0.99:
                target_w = max(320, int(img.width * eff_scale))
                target_h = max(180, int(img.height * eff_scale))
                resample = Image.Resampling.LANCZOS if eff_quality >= 80 else Image.Resampling.BILINEAR
                img = img.resize((target_w, target_h), resample)

            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=eff_quality, optimize=False)
            return FrameCapture(
                jpeg_bytes=buf.getvalue(),
                width=img.width,
                height=img.height,
                monitor_left=mon["left"],
                monitor_top=mon["top"],
                monitor_width=mon["width"],
                monitor_height=mon["height"],
                screen_locked=False,
            )
    except (mss.exception.ScreenShotError, OSError):
        return FrameCapture(
            jpeg_bytes=b"",
            width=0,
            height=0,
            monitor_left=0,
            monitor_top=0,
            monitor_width=0,
            monitor_height=0,
            screen_locked=True,
        )


def save_scratch_screenshot(monitor_index: int = 1) -> Path | None:
    frame = capture_screen_frame(monitor_index=monitor_index, preset="hd")
    if frame.screen_locked or not frame.jpeg_bytes:
        return None
    scratch_dir = get_data_dir() / "scratch"
    scratch_dir.mkdir(parents=True, exist_ok=True)
    # Keep at most 10 recent scratch screenshots
    existing = sorted(scratch_dir.glob("screen_*.jpg"), key=lambda p: p.stat().st_mtime)
    for old in existing[:-9]:
        try:
            old.unlink()
        except OSError:
            pass
    out_path = scratch_dir / f"screen_{int(time.time())}.jpg"
    out_path.write_bytes(frame.jpeg_bytes)
    return out_path
