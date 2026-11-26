"""Shared Antigravity project discovery and default project binding."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from app.config import load_settings, save_settings

SIDECAR_KEY = "agy-pocket-bridge/bridge"


def get_projects_dir() -> Path:
    return Path.home() / ".gemini" / "config" / "projects"


def get_gemini_config_path() -> Path:
    return Path.home() / ".gemini" / "config" / "config.json"


def decode_folder_uri(uri: str) -> str:
    raw = (uri or "").strip()
    if not raw:
        return ""
    parsed = urlparse(raw)
    if parsed.scheme == "file":
        path_str = unquote(parsed.path)
        if os.name == "nt" and len(path_str) >= 3 and path_str[0] == "/" and path_str[2] == ":":
            path_str = path_str[1:].replace("/", "\\")
        return path_str
    return raw


def _read_json_safe(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _scan_real_projects(projects_dir: Path | None = None) -> list[dict[str, Any]]:
    pdir = projects_dir or get_projects_dir()
    projects: list[dict[str, Any]] = []

    if pdir.is_dir():
        for fpath in sorted(pdir.glob("*.json")):
            obj = _read_json_safe(fpath)
            if not obj:
                continue
            pid = str(obj.get("id") or "").strip()
            if not pid or pid == "default-cli-project":
                continue
            if "sidecar" in obj and obj["sidecar"]:
                continue

            folders: list[str] = []
            res = obj.get("projectResources")
            if isinstance(res, dict):
                for item in res.get("resources") or []:
                    if isinstance(item, dict) and item.get("folderUri"):
                        decoded = decode_folder_uri(str(item["folderUri"]))
                        if decoded:
                            folders.append(decoded)

            projects.append(
                {
                    "id": pid,
                    "name": str(obj.get("name") or pid[:12]).strip(),
                    "folders": folders,
                    "primary_folder": folders[0] if folders else "",
                    "is_bound": False,
                }
            )
    return projects


def read_bound_project_id(
    projects_dir: Path | None = None,
    _config_path: Path | None = None,
) -> str:
    settings = load_settings()
    real = _scan_real_projects(projects_dir=projects_dir)
    valid_ids = {p["id"] for p in real}
    if settings.default_project_id and settings.default_project_id in valid_ids:
        return settings.default_project_id

    # Prefer project matching configured workspace_dir, then first discovered project
    ws_norm = (settings.workspace_dir or "").strip().lower()
    if ws_norm:
        for p in real:
            if any(f.lower() == ws_norm for f in p["folders"]):
                return str(p["id"])
    return str(real[0]["id"]) if real else ""


def list_antigravity_projects(
    projects_dir: Path | None = None,
    config_path: Path | None = None,
) -> dict[str, Any]:
    projects = _scan_real_projects(projects_dir=projects_dir)
    bound_id = read_bound_project_id(projects_dir=projects_dir, _config_path=config_path)
    for p in projects:
        p["is_bound"] = p["id"] == bound_id

    projects.sort(key=lambda p: (not p["is_bound"], p["name"].lower()))
    return {
        "projects": projects,
        "bound_project_id": bound_id,
    }


def set_bound_project_id(
    project_id: str,
    projects_dir: Path | None = None,
    config_path: Path | None = None,
) -> dict[str, Any]:
    pid = (project_id or "").strip()
    listing = list_antigravity_projects(projects_dir=projects_dir, config_path=config_path)
    match = next((p for p in listing["projects"] if p["id"] == pid), None)
    if not match:
        raise ValueError(f"Unknown Antigravity project id: {pid}")

    settings = load_settings()
    updates: dict[str, Any] = {"default_project_id": pid}
    primary = str(match.get("primary_folder") or "")
    if primary and Path(primary).is_dir():
        updates["workspace_dir"] = primary
    save_settings(settings.model_copy(update=updates))

    return {
        "ok": True,
        "bound_project_id": pid,
        "restart_recommended": False,
    }
