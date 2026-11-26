"""Dynamic real Antigravity model catalog & thinking effort tier grouping."""

from __future__ import annotations

import asyncio
import json
import re
import time
from pathlib import Path
from typing import Any

from app.agy.runner import build_agy_subprocess_env
from app.config import find_agy_binary, get_data_dir, load_settings

EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"]
EFFORT_DISPLAY = {
    "low": "Low",
    "medium": "Medium",
    "high": "High",
    "xhigh": "Extra",
    "max": "Max",
}
EFFORT_SUFFIX_RE = re.compile(r"^(.+)-(low|medium|high|xhigh|max)$", re.IGNORECASE)
ORCHESTRATOR_RE = re.compile(r"^gemini-pro-orchestrator(?:-(.+))?$", re.IGNORECASE)


def _strip_effort_label(display_name: str) -> str:
    return re.sub(r"\s*\((Low|Medium|High|XHigh|Extra|Max)\)\s*$", "", display_name, flags=re.IGNORECASE).strip()


def _detect_provider(family_id: str, display_name: str) -> str:
    low = f"{family_id} {display_name}".lower()
    if "orchestrator" in low:
        return "Orchestrator"
    if "claude" in low:
        return "Anthropic"
    if "gpt" in low:
        return "Partner"
    return "Google"


def parse_agy_models_output(raw_text: str) -> list[dict[str, Any]]:
    """Parse `agy models` stdout lines into structured model families & effort tiers."""
    families_order: list[str] = []
    families_map: dict[str, dict[str, Any]] = {}
    orchestrator_planners: list[dict[str, str]] = []

    for raw_line in (raw_text or "").splitlines():
        line = raw_line.strip()
        if not line or line.lower().startswith("fetching") or "\t" not in line:
            continue
        slug, display = line.split("\t", 1)
        slug = slug.strip()
        display = display.strip()
        if not slug:
            continue

        orch_m = ORCHESTRATOR_RE.match(slug)
        if orch_m:
            planner_id = (orch_m.group(1) or "carbon").lower()
            planner_label = planner_id.capitalize()
            m_disp = re.search(r"\(([^)]+)\)", display)
            if m_disp:
                planner_label = m_disp.group(1).strip()
            if "orchestrator" not in families_map:
                families_order.append("orchestrator")
                families_map["orchestrator"] = {
                    "family_id": "orchestrator",
                    "display_name": "Orchestrator (规划+执行)",
                    "provider": "Orchestrator",
                    "adjustable": False,
                    "default_model_id": slug,
                    "default_effort": "",
                    "efforts": [],
                    "planners": [],
                    "fixed_note": "自动双模型接力（规划模型 + 执行模型），使用固定思考预算",
                }
            orchestrator_planners.append(
                {
                    "id": planner_id,
                    "label": planner_label,
                    "model_id": slug,
                    "display_name": display,
                }
            )
            continue

        eff_m = EFFORT_SUFFIX_RE.match(slug)
        if eff_m:
            family_id = eff_m.group(1)
            effort_key = eff_m.group(2).lower()
            clean_name = _strip_effort_label(display)
            if family_id not in families_map:
                families_order.append(family_id)
                families_map[family_id] = {
                    "family_id": family_id,
                    "display_name": clean_name or family_id,
                    "provider": _detect_provider(family_id, clean_name),
                    "adjustable": True,
                    "default_model_id": slug,
                    "default_effort": effort_key,
                    "efforts": [],
                    "planners": [],
                    "fixed_note": "",
                }
            fam = families_map[family_id]
            if not any(e["effort"] == effort_key for e in fam["efforts"]):
                fam["efforts"].append(
                    {
                        "effort": effort_key,
                        "label": EFFORT_DISPLAY.get(effort_key, effort_key.capitalize()),
                        "model_id": slug,
                        "display_name": display,
                    }
                )
        else:
            if slug not in families_map:
                families_order.append(slug)
                families_map[slug] = {
                    "family_id": slug,
                    "display_name": display or slug,
                    "provider": _detect_provider(slug, display),
                    "adjustable": False,
                    "default_model_id": slug,
                    "default_effort": "",
                    "efforts": [],
                    "planners": [],
                    "fixed_note": "该模型使用固定思考配置",
                }

    out: list[dict[str, Any]] = []
    for fid in families_order:
        fam = families_map[fid]
        if fid == "orchestrator":
            fam["planners"] = orchestrator_planners
            if orchestrator_planners:
                fam["default_model_id"] = orchestrator_planners[0]["model_id"]
        elif fam["efforts"]:
            fam["efforts"].sort(
                key=lambda e: EFFORT_ORDER.index(e["effort"]) if e["effort"] in EFFORT_ORDER else 99
            )
            if len(fam["efforts"]) <= 1:
                only = fam["efforts"][0]
                fam["adjustable"] = False
                fam["default_model_id"] = only["model_id"]
                fam["default_effort"] = only["effort"]
                fam["fixed_note"] = f"仅提供 {only['label']} 档位"
            else:
                medium = next((e for e in fam["efforts"] if e["effort"] == "medium"), None)
                high = next((e for e in fam["efforts"] if e["effort"] == "high"), None)
                chosen = medium or high or fam["efforts"][0]
                fam["default_model_id"] = chosen["model_id"]
                fam["default_effort"] = chosen["effort"]
        out.append(fam)
    return out


class ModelCatalogService:
    """Fetches and caches real account models from `agy models`."""

    def __init__(self, ttl_seconds: int = 600) -> None:
        self.ttl_seconds = ttl_seconds
        self._families: list[dict[str, Any]] = []
        self._fetched_at: float = 0.0
        self._last_error: str = ""
        self._lock = asyncio.Lock()

    def _cache_path(self) -> Path:
        return get_data_dir() / "models_cache.json"

    def _load_disk_cache(self) -> bool:
        p = self._cache_path()
        if not p.is_file():
            return False
        try:
            raw = json.loads(p.read_text(encoding="utf-8"))
            fams = raw.get("families")
            if isinstance(fams, list) and fams:
                self._families = fams
                self._fetched_at = float(raw.get("fetched_at") or 0.0)
                return True
        except Exception:
            pass
        return False

    def _save_disk_cache(self) -> None:
        try:
            p = self._cache_path()
            tmp = p.with_suffix(".tmp")
            tmp.write_text(
                json.dumps(
                    {"fetched_at": self._fetched_at, "families": self._families},
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
            import os

            os.replace(tmp, p)
        except Exception:
            pass

    async def get_catalog(self, force_refresh: bool = False) -> dict[str, Any]:
        async with self._lock:
            now = time.time()
            if not self._families and not force_refresh:
                self._load_disk_cache()

            if self._families and not force_refresh and (now - self._fetched_at) < self.ttl_seconds:
                return {
                    "families": self._families,
                    "fetched_at": self._fetched_at,
                    "cached": True,
                    "error": self._last_error,
                }

            settings = load_settings()
            agy_bin = find_agy_binary(settings.agy_path)
            if not agy_bin:
                self._last_error = "未找到 agy.exe，无法拉取实时模型列表"
                return {
                    "families": self._families,
                    "fetched_at": self._fetched_at,
                    "cached": bool(self._families),
                    "error": self._last_error,
                }

            try:
                proc = await asyncio.create_subprocess_exec(
                    agy_bin,
                    "models",
                    env=build_agy_subprocess_env(),
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=20.0)
                stdout_s = stdout_b.decode("utf-8", errors="replace")
                stderr_s = stderr_b.decode("utf-8", errors="replace").strip()
                parsed = parse_agy_models_output(stdout_s)
                if parsed:
                    self._families = parsed
                    self._fetched_at = time.time()
                    self._last_error = ""
                    self._save_disk_cache()
                    return {
                        "families": self._families,
                        "fetched_at": self._fetched_at,
                        "cached": False,
                        "error": "",
                    }
                self._last_error = stderr_s or "agy models 未返回有效模型列表（请确认已完成登录）"
            except Exception as exc:
                self._last_error = f"获取模型列表失败: {exc}"

            return {
                "families": self._families,
                "fetched_at": self._fetched_at,
                "cached": bool(self._families),
                "error": self._last_error,
            }

    def resolve_display_label(self, model_id: str) -> str:
        target = (model_id or "").strip()
        if not target:
            return ""
        if not self._families:
            self._load_disk_cache()
        for fam in self._families:
            if fam.get("default_model_id") == target and not fam.get("efforts") and not fam.get("planners"):
                return str(fam.get("display_name") or target)
            for eff in fam.get("efforts") or []:
                if eff.get("model_id") == target:
                    return str(eff.get("display_name") or target)
            for pl in fam.get("planners") or []:
                if pl.get("model_id") == target:
                    return str(pl.get("display_name") or target)
        return target


model_catalog_service = ModelCatalogService()
