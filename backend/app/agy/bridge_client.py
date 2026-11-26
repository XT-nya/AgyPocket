"""Client for communicating with the local official Antigravity Sidecar bridge."""

from __future__ import annotations

import asyncio
import json
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from app.agy.projects import get_gemini_config_path, read_bound_project_id


def get_bridge_plugin_dir() -> Path:
    return Path.home() / ".gemini" / "config" / "plugins" / "agy-pocket-bridge"


def get_bridge_runtime_path() -> Path:
    return (
        Path.home()
        / ".gemini"
        / "antigravity"
        / "sidecar_data"
        / "agy-pocket-bridge"
        / "bridge"
        / "data"
        / "bridge_runtime.json"
    )


def _read_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        obj = json.loads(path.read_text(encoding="utf-8"))
        return obj if isinstance(obj, dict) else {}
    except Exception:
        return {}


class BridgeClient:
    """Loopback-only HTTP client talking to `agy-pocket-bridge/bridge` Sidecar."""

    def __init__(
        self,
        runtime_path: Path | None = None,
        plugin_dir: Path | None = None,
        config_path: Path | None = None,
    ) -> None:
        self._runtime_path = runtime_path
        self._plugin_dir = plugin_dir
        self._config_path = config_path

    def _runtime_file(self) -> Path:
        return self._runtime_path or get_bridge_runtime_path()

    def _plugin_root(self) -> Path:
        return self._plugin_dir or get_bridge_plugin_dir()

    def _cfg_file(self) -> Path:
        return self._config_path or get_gemini_config_path()

    def _load_runtime(self) -> dict[str, Any] | None:
        data = _read_json(self._runtime_file())
        port = int(data.get("port") or 0)
        token = str(data.get("token") or "").strip()
        if port <= 0 or not token:
            return None
        return data

    def _request_sync(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        timeout: float = 15.0,
    ) -> dict[str, Any]:
        rt = self._load_runtime()
        if not rt:
            raise RuntimeError("Antigravity Sidecar bridge 未运行（请先重启一次桌面版 Antigravity）")
        port = int(rt["port"])
        token = str(rt["token"])
        url = f"http://127.0.0.1:{port}{path}"
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
        }
        body: bytes | None = None
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"

        req = urllib.request.Request(url=url, data=body, headers=headers, method=method)
        # Explicitly bypass Windows system HTTP_PROXY/HTTPS_PROXY for loopback Sidecar calls
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            err_body = exc.read().decode("utf-8", errors="replace")
            try:
                parsed = json.loads(err_body)
                detail = parsed.get("error") or err_body
            except Exception:
                detail = err_body or str(exc)
            raise RuntimeError(f"Sidecar HTTP {exc.code}: {detail}") from exc
        except Exception as exc:
            raise RuntimeError(f"无法连接本地 Sidecar ({exc})") from exc

    async def get_status(self) -> dict[str, Any]:
        plugin_dir = self._plugin_root()
        cfg = _read_json(self._cfg_file())
        plugin_installed = (plugin_dir / "plugin.json").is_file() and (
            plugin_dir / "sidecars" / "bridge" / "server.mjs"
        ).is_file()
        plugin_enabled = bool(cfg.get("plugins", {}).get("agy-pocket-bridge", {}).get("enabled", False))
        sidecar_enabled = bool(
            cfg.get("sidecars", {}).get("agy-pocket-bridge/bridge", {}).get("enabled", False)
        )
        bound_project_id = read_bound_project_id()

        rt = self._load_runtime()
        sidecar_running = False
        agentapi_available = False
        detail = ""

        if rt:
            try:
                health = await asyncio.to_thread(self._request_sync, "GET", "/health", None, 2.0)
                if health.get("ok"):
                    sidecar_running = True
                    agentapi_available = bool(health.get("agentapi_available", False))
            except Exception as exc:
                detail = str(exc)

        needs_app_restart = plugin_installed and plugin_enabled and sidecar_enabled and not sidecar_running
        if not plugin_installed:
            detail = "尚未安装 agy-pocket-bridge 官方插件"
        elif needs_app_restart:
            detail = "插件已安装并启用，请重启电脑端 Antigravity 桌面版以拉起 Sidecar"
        elif sidecar_running:
            detail = "Antigravity 桌面版 Sidecar 联动在线"

        return {
            "plugin_installed": plugin_installed,
            "plugin_enabled": plugin_enabled and sidecar_enabled,
            "sidecar_running": sidecar_running,
            "agentapi_available": agentapi_available,
            "bound_project_id": bound_project_id,
            "needs_app_restart": needs_app_restart,
            "detail": detail,
        }

    async def new_conversation(
        self,
        prompt: str,
        model: str = "",
        title: str = "",
        project_id: str = "",
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"prompt": prompt}
        if model:
            payload["model"] = model
        if title:
            payload["title"] = title
        if project_id:
            payload["project_id"] = project_id
        return await asyncio.to_thread(self._request_sync, "POST", "/new-conversation", payload, 45.0)

    async def send_message(
        self,
        conversation_id: str,
        prompt: str,
        title: str = "",
        project_id: str = "",
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"conversation_id": conversation_id, "prompt": prompt}
        if title:
            payload["title"] = title
        if project_id:
            payload["project_id"] = project_id
        return await asyncio.to_thread(self._request_sync, "POST", "/send-message", payload, 45.0)

    async def get_conversation_metadata(self, conversation_id: str) -> dict[str, Any]:
        return await asyncio.to_thread(
            self._request_sync,
            "GET",
            f"/conversation-metadata?id={conversation_id}",
            None,
            15.0,
        )


bridge_client = BridgeClient()
