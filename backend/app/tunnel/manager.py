"""Cloudflare Quick Tunnel and Named Tunnel lifecycle manager."""

from __future__ import annotations

import asyncio
import os
import re
import shutil
import socket
import subprocess
import urllib.request
from contextlib import suppress
from pathlib import Path
from typing import Any

from app.agy.runner import build_agy_subprocess_env
from app.config import PROJECT_ROOT, SettingsModel, get_bin_dir, load_settings

TRYCLOUDFLARE_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com", re.IGNORECASE)


def _pick_free_metrics_port() -> int:
    for port in range(20241, 20250):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _probe_metrics_ready(metrics_addr: str) -> bool:
    if not metrics_addr:
        return False
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    req = urllib.request.Request(f"http://{metrics_addr}/ready", method="GET")
    try:
        with opener.open(req, timeout=3.0) as resp:
            return int(getattr(resp, "status", 0)) == 200
    except Exception:
        return False


def _build_tunnel_env(
    use_system_proxy: bool,
    base_env: dict[str, str] | None = None,
    detected_proxy: str | None = None,
) -> dict[str, str]:
    if use_system_proxy:
        env = build_agy_subprocess_env(base_env=base_env, detected_proxy=detected_proxy)
        env.pop("ALL_PROXY", None)
        env.pop("all_proxy", None)
        return env
    env = dict(base_env if base_env is not None else os.environ)
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        env.pop(key, None)
    return env


def _build_tunnel_command(
    binary: Path,
    settings: SettingsModel,
    metrics_addr: str = "",
    logfile_path: Path | None = None,
) -> tuple[str, list[str]]:
    common = [
        str(binary),
        "tunnel",
        "--no-autoupdate",
        "--protocol",
        "http2",
        "--retries",
        "9999",
    ]
    if metrics_addr:
        common.extend(["--metrics", metrics_addr])
    if logfile_path is not None:
        common.extend(["--logfile", str(logfile_path)])

    if settings.tunnel_mode == "named" and settings.named_tunnel_token.strip():
        return (
            "named",
            [
                *common,
                "run",
                "--token",
                settings.named_tunnel_token.strip(),
            ],
        )
    return (
        "quick",
        [
            *common,
            "--url",
            f"http://127.0.0.1:{settings.port}",
        ],
    )


def _is_error_line(line: str) -> bool:
    lower = line.lower()
    return any(tok in lower for tok in ("failed", "429", " err ", "error"))


class TunnelManager:
    def __init__(self) -> None:
        self._proc: asyncio.subprocess.Process | None = None
        self._public_url: str = ""
        self._mode: str = "quick"
        self._status: str = "stopped"  # stopped | starting | running | degraded | error
        self._connected: bool = False
        self._last_error: str = ""
        self._metrics_addr: str = ""
        self._stopping: bool = False
        self._supervisor_task: asyncio.Task | None = None
        self._watchdog_task: asyncio.Task | None = None

    def cloudflared_path(self) -> Path | None:
        settings = load_settings()
        configured = (settings.cloudflared_path or "").strip()
        if configured:
            cand = Path(configured)
            if cand.is_file():
                return cand
        which_path = shutil.which("cloudflared")
        if which_path:
            cand = Path(which_path)
            if cand.is_file():
                return cand
        exe_name = "cloudflared" + (".exe" if os.name == "nt" else "")
        local_cand = get_bin_dir() / exe_name
        if local_cand.is_file():
            return local_cand
        return None

    def get_status(self) -> dict[str, Any]:
        running = self._proc is not None and self._proc.returncode is None
        supervisor_active = self._supervisor_task is not None and not self._supervisor_task.done()
        if self._mode != "external" and not running and not supervisor_active and self._status in {"running", "degraded"}:
            self._status = "stopped"
            self._connected = False
        bin_path = self.cloudflared_path()
        return {
            "status": self._status,
            "mode": self._mode,
            "public_url": self._public_url,
            "connected": self._connected,
            "binary_exists": bin_path is not None and bin_path.is_file(),
            "binary_path": str(bin_path) if bin_path else "",
            "last_error": self._last_error,
            "metrics_addr": self._metrics_addr,
        }

    async def start(self) -> dict[str, Any]:
        settings = load_settings()
        if settings.tunnel_mode == "external":
            if (self._proc is not None and self._proc.returncode is None) or (
                self._supervisor_task is not None and not self._supervisor_task.done()
            ):
                await self.stop()
            url = settings.external_public_url.strip().rstrip("/")
            self._stopping = False
            self._mode = "external"
            self._metrics_addr = ""
            self._public_url = url
            self._connected = bool(url)
            self._status = "running" if url else "error"
            self._last_error = "" if url else "请先在设置中配置外部穿透地址（如局域网地址、SakuraFrp 或 Tailscale）"
            return self.get_status()

        if (self._proc is not None and self._proc.returncode is None) or (
            self._supervisor_task is not None and not self._supervisor_task.done()
        ):
            return self.get_status()

        binary = self.cloudflared_path()
        if binary is None or not binary.is_file():
            self._status = "error"
            self._last_error = (
                "未检测到 cloudflared。请自行安装 cloudflared 并加入系统 PATH（或在设置中填写路径），"
                "或将 tunnel_mode 设为 external 使用局域网 / SakuraFrp / Tailscale。"
            )
            return self.get_status()

        metrics_addr = f"127.0.0.1:{_pick_free_metrics_port()}"
        logfile_path = PROJECT_ROOT / "cloudflared.log"
        self._mode, cmd = _build_tunnel_command(
            binary,
            settings,
            metrics_addr=metrics_addr,
            logfile_path=logfile_path,
        )
        self._metrics_addr = metrics_addr
        self._public_url = ""
        self._connected = False
        self._last_error = ""
        self._stopping = False
        self._status = "starting"

        self._supervisor_task = asyncio.create_task(self._run_supervisor(cmd))
        return self.get_status()

    async def restart(self) -> dict[str, Any]:
        await self.stop()
        return await self.start()

    async def _terminate_proc(self, proc: asyncio.subprocess.Process | None) -> None:
        if not proc or proc.returncode is not None:
            return
        pid = proc.pid
        try:
            proc.terminate()
        except Exception:
            pass
        try:
            await asyncio.wait_for(proc.wait(), timeout=2.5)
        except asyncio.TimeoutError:
            if pid and os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, check=False)

    async def _monitor_output(
        self,
        proc: asyncio.subprocess.Process,
        ready_event: asyncio.Event,
    ) -> None:
        async def drain(stream: asyncio.StreamReader | None) -> None:
            if stream is None:
                return
            while True:
                raw = await stream.readline()
                if not raw:
                    break
                line = raw.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                lower = line.lower()
                match = TRYCLOUDFLARE_RE.search(line)
                if match:
                    self._public_url = match.group(0)
                    self._status = "running"
                    self._last_error = ""
                    ready_event.set()
                elif "registered tunnel connection" in lower:
                    self._connected = True
                    self._last_error = ""
                    if self._mode == "named" or self._public_url:
                        self._status = "running"
                    if self._mode == "named":
                        ready_event.set()
                elif "unregister" in lower or "lost connection" in lower:
                    self._connected = False
                    self._last_error = line[-240:]
                elif _is_error_line(line):
                    self._last_error = line[-240:]

        await asyncio.gather(drain(proc.stdout), drain(proc.stderr))
        await proc.wait()

    async def _run_ready_watchdog(self, proc: asyncio.subprocess.Process, metrics_addr: str) -> None:
        if not metrics_addr:
            return
        failures = 0
        while proc.returncode is None and not self._stopping:
            await asyncio.sleep(25)
            if proc.returncode is not None or self._stopping:
                break
            ok = await asyncio.to_thread(_probe_metrics_ready, metrics_addr)
            if ok:
                failures = 0
                self._connected = True
                if self._status == "degraded":
                    self._status = "running"
                    self._last_error = ""
            else:
                failures += 1
                if failures >= 3:
                    self._connected = False
                    self._last_error = "cloudflared 隧道连接已断开（/ready 持续异常）"
                    if self._mode == "named":
                        await self._terminate_proc(proc)
                        break
                    self._status = "degraded"

    async def _run_supervisor(self, cmd: list[str]) -> None:
        proxy_probe = _build_tunnel_env(use_system_proxy=True)
        has_proxy = bool(proxy_probe.get("HTTPS_PROXY") or proxy_probe.get("HTTP_PROXY"))

        named_backoff = (3.0, 10.0, 20.0)
        named_restart_idx = 0

        while not self._stopping:
            if self._mode == "named":
                attempts = [(has_proxy, 0.0)]
            else:
                attempts = [
                    (has_proxy, 0.0),
                    (not has_proxy, 1.5),
                    (True if has_proxy else False, 2.5),
                ]

            reconnected_named = False
            for idx, (use_proxy, delay) in enumerate(attempts):
                if self._stopping:
                    return
                if delay > 0:
                    await asyncio.sleep(delay)
                    if self._stopping:
                        return

                self._public_url = ""
                self._connected = False
                env = _build_tunnel_env(use_system_proxy=use_proxy)
                proc = await asyncio.create_subprocess_exec(
                    *cmd,
                    env=env,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                self._proc = proc
                ready_event = asyncio.Event()
                monitor_task = asyncio.create_task(self._monitor_output(proc, ready_event))

                # Wait up to 15s for URL/named registration, or until process exits early
                wait_ready = asyncio.create_task(ready_event.wait())
                await asyncio.wait(
                    {monitor_task, wait_ready},
                    timeout=15.0,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if not wait_ready.done():
                    wait_ready.cancel()

                if ready_event.is_set() and not self._stopping:
                    self._watchdog_task = asyncio.create_task(self._run_ready_watchdog(proc, self._metrics_addr))
                    try:
                        await monitor_task
                    finally:
                        if self._watchdog_task and not self._watchdog_task.done():
                            self._watchdog_task.cancel()
                            with suppress(asyncio.CancelledError):
                                await self._watchdog_task
                        self._watchdog_task = None

                    if self._stopping:
                        return
                    self._connected = False
                    self._proc = None
                    if not self._last_error:
                        self._last_error = "cloudflared 进程已退出"
                    if self._mode == "named":
                        self._status = "degraded"
                        reconnected_named = True
                        break
                    self._status = "stopped"
                    return

                # Attempt failed or timed out before obtaining URL -> clean up and retry if attempts remain
                await self._terminate_proc(proc)
                if not monitor_task.done():
                    try:
                        await asyncio.wait_for(monitor_task, timeout=2.0)
                    except asyncio.TimeoutError:
                        monitor_task.cancel()
                self._proc = None

                if not self._last_error and idx == len(attempts) - 1:
                    self._last_error = "cloudflared 未能在规定时间内建立连接"

            if self._mode == "named" and not self._stopping:
                wait_s = named_backoff[min(named_restart_idx, len(named_backoff) - 1)]
                named_restart_idx = 0 if reconnected_named else named_restart_idx + 1
                self._status = "starting"
                await asyncio.sleep(wait_s)
                continue

            if not self._stopping:
                self._status = "error"
            return

    async def stop(self) -> dict[str, Any]:
        self._stopping = True
        self._status = "stopped"
        if self._watchdog_task and not self._watchdog_task.done():
            self._watchdog_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._watchdog_task
        self._watchdog_task = None
        if self._supervisor_task and not self._supervisor_task.done():
            self._supervisor_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._supervisor_task
        self._supervisor_task = None
        await self._terminate_proc(self._proc)
        self._proc = None
        self._public_url = ""
        self._connected = False
        self._metrics_addr = ""
        return self.get_status()


tunnel_manager = TunnelManager()
