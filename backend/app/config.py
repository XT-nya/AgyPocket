"""Configuration and persistent store helpers for AgyPocket."""

from __future__ import annotations

import json
import os
import secrets
import shutil
import socket
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

PermissionTier = Literal["auto", "full", "controlled", "readonly"]
ApprovalPolicy = Literal["remote_smart", "remote_all", "desktop_only"]
TunnelMode = Literal["quick", "named", "external"]
ConnectionMode = Literal["fixed", "temp"]
MessageDispatchMode = Literal["native_first", "bridge_only"]

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def get_data_dir() -> Path:
    override = os.environ.get("AGYPOCKET_DATA_DIR")
    if override:
        path = Path(override)
    else:
        path = PROJECT_ROOT / "config"
    path.mkdir(parents=True, exist_ok=True)
    return path


def get_bin_dir() -> Path:
    return PROJECT_ROOT / "bin"


def find_agy_binary(configured_path: str = "") -> str | None:
    if configured_path and Path(configured_path).is_file():
        return configured_path
    found = shutil.which("agy")
    if found:
        return found
    candidates = [
        Path(os.environ.get("LOCALAPPDATA", "")) / "agy" / "bin" / "agy.exe",
        Path.home() / "AppData" / "Local" / "agy" / "bin" / "agy.exe",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    return None


class SettingsModel(BaseModel):
    port: int = Field(default=18765, ge=1024, le=65535)
    default_permission_mode: PermissionTier = "auto"
    approval_policy: ApprovalPolicy = "remote_smart"
    approval_timeout_seconds: int = Field(default=95, ge=15, le=115)
    default_project_id: str = ""
    workspace_dir: str = ""
    device_name: str = Field(default_factory=lambda: socket.gethostname() or "My-PC")
    connection_mode: ConnectionMode = "fixed"
    model: str = ""
    prevent_sleep: bool = True
    tunnel_mode: TunnelMode = "external"
    named_tunnel_token: str = ""
    external_public_url: str = ""
    cloudflared_path: str = ""
    message_dispatch_mode: MessageDispatchMode = "native_first"
    screen_fps: int = Field(default=2, ge=1, le=10)
    screen_quality: int = Field(default=65, ge=20, le=95)
    screen_scale: float = Field(default=0.75, ge=0.25, le=1.0)
    agy_path: str = ""


class AuthStoreModel(BaseModel):
    passphrase_salt: str = ""
    passphrase_hash: str = ""
    session_secret: str = Field(default_factory=lambda: secrets.token_hex(32))
    session_version: int = 1
    totp_enabled: bool = False
    totp_secret: str = ""
    totp_pending_secret: str = ""


def _atomic_write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def load_settings() -> SettingsModel:
    path = get_data_dir() / "settings.json"
    if not path.exists():
        settings = SettingsModel()
        save_settings(settings)
        return settings
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return SettingsModel(**raw)
    except Exception:
        settings = SettingsModel()
        save_settings(settings)
        return settings


def save_settings(settings: SettingsModel) -> None:
    path = get_data_dir() / "settings.json"
    _atomic_write_json(path, settings.model_dump())


def load_auth_store() -> AuthStoreModel:
    path = get_data_dir() / "auth.json"
    if not path.exists():
        store = AuthStoreModel()
        save_auth_store(store)
        return store
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        store = AuthStoreModel(**raw)
        if not store.session_secret:
            store.session_secret = secrets.token_hex(32)
            save_auth_store(store)
        return store
    except Exception:
        store = AuthStoreModel()
        save_auth_store(store)
        return store


def save_auth_store(store: AuthStoreModel) -> None:
    path = get_data_dir() / "auth.json"
    _atomic_write_json(path, store.model_dump())


def get_or_create_hook_secret() -> str:
    path = get_data_dir() / "internal_hook_secret.json"
    if path.exists():
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            secret = str(raw.get("secret") or "").strip()
            if len(secret) >= 32:
                return secret
        except Exception:
            pass
    secret = secrets.token_hex(32)
    _atomic_write_json(path, {"secret": secret})
    return secret


def get_backend_runtime_path() -> Path:
    runtime_override = os.environ.get("AGYPOCKET_RUNTIME_DIR")
    if runtime_override:
        return Path(runtime_override) / "agypocket_backend.json"
    data_override = os.environ.get("AGYPOCKET_DATA_DIR")
    if data_override:
        return Path(data_override) / "runtime" / "agypocket_backend.json"
    return (
        Path.home()
        / ".gemini"
        / "antigravity"
        / "sidecar_data"
        / "agy-pocket-bridge"
        / "agypocket_backend.json"
    )


def publish_backend_runtime(port: int) -> Path:
    path = get_backend_runtime_path()
    payload = {
        "port": int(port),
        "secret": get_or_create_hook_secret(),
        "pid": os.getpid(),
    }
    _atomic_write_json(path, payload)
    return path


def clear_backend_runtime() -> None:
    path = get_backend_runtime_path()
    try:
        if path.exists():
            path.unlink()
    except Exception:
        pass
