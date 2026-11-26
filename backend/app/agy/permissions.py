"""Four-tier permission mapping aligned with Antigravity defaults."""

from __future__ import annotations

from dataclasses import dataclass

from app.config import PermissionTier


@dataclass(frozen=True)
class PermissionSpec:
    id: PermissionTier
    label: str
    short_label: str
    description: str
    cli_flags: tuple[str, ...]


PERMISSION_TIERS: dict[PermissionTier, PermissionSpec] = {
    "auto": PermissionSpec(
        id="auto",
        label="自动（推荐）",
        short_label="自动",
        description="反重力自主判断常规读写与命令，平衡效率与安全（默认档位）",
        cli_flags=("--mode", "auto"),
    ),
    "full": PermissionSpec(
        id="full",
        label="完全权限",
        short_label="完全权限",
        description="自动放行所有文件修改与终端命令，适合放手执行长任务",
        cli_flags=("--dangerously-skip-permissions",),
    ),
    "controlled": PermissionSpec(
        id="controlled",
        label="受控审批",
        short_label="受控",
        description="自动允许编辑工作区文件，敏感命令与外部操作按受控策略处理",
        cli_flags=("--mode", "accept-edits"),
    ),
    "readonly": PermissionSpec(
        id="readonly",
        label="只读观察",
        short_label="只读",
        description="仅分析和规划回答，禁止修改文件与运行写命令",
        cli_flags=("--mode", "plan", "--sandbox"),
    ),
}


def get_permission_flags(tier: PermissionTier) -> list[str]:
    spec = PERMISSION_TIERS.get(tier) or PERMISSION_TIERS["auto"]
    return list(spec.cli_flags)


def list_permission_specs() -> list[dict[str, object]]:
    return [
        {
            "id": spec.id,
            "label": spec.label,
            "short_label": spec.short_label,
            "description": spec.description,
            "cli_flags": list(spec.cli_flags),
        }
        for spec in PERMISSION_TIERS.values()
    ]
