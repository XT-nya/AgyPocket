"""Modular plugin & card registry modeled after dsh-Go contributions."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from app.agy.approvals import approval_manager
from app.config import load_settings
from app.desktop.power import get_system_telemetry


@dataclass
class PluginDefinition:
    id: str
    name: str
    version: str
    description: str
    slots: list[str]
    card_types: list[str] = field(default_factory=list)
    enabled: bool = True


ActionHandler = Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]


class PluginRegistry:
    """Registry for built-in and future custom UI/MCP/Skill plugin cards."""

    def __init__(self) -> None:
        self._plugins: dict[str, PluginDefinition] = {}
        self._handlers: dict[str, ActionHandler] = {}
        self._register_builtins()

    def register(self, plugin: PluginDefinition, handler: ActionHandler | None = None) -> None:
        self._plugins[plugin.id] = plugin
        if handler:
            self._handlers[plugin.id] = handler

    def _register_builtins(self) -> None:
        self.register(
            PluginDefinition(
                id="core.capsule",
                name="Obsidian 状态胶囊",
                version="2.0.0",
                description="底部常驻状态胶囊（桌面版联动灯、真实模型+思考强度、只读 Token 占用与手机审批策略）",
                slots=["bottom-capsule"],
            ),
            self._handle_capsule_action,
        )
        self.register(
            PluginDefinition(
                id="core.toolbar",
                name="快捷指令与插槽栏",
                version="1.0.0",
                description="输入框上方快捷芯片（/plan、/compact、附带当前电脑截屏；后续可扩展 agy-meme 贴图面板）",
                slots=["quick-toolbar"],
            ),
            self._handle_toolbar_action,
        )
        self.register(
            PluginDefinition(
                id="core.cards",
                name="核心交互卡片包",
                version="2.0.0",
                description="支持工具调用、文件变更、桌面版实时手机审批、系统速览与联动引导卡片",
                slots=["message-card"],
                card_types=[
                    "core.tool-call",
                    "core.diff-preview",
                    "core.approval",
                    "core.system-mini",
                    "core.auth-guide",
                ],
            ),
            self._handle_card_action,
        )

    async def _handle_capsule_action(self, action_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return {"ok": True, "plugin": "core.capsule", "action": action_id, "payload": payload}

    async def _handle_toolbar_action(self, action_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        if action_id == "system.snapshot_card":
            telemetry = get_system_telemetry()
            return {
                "ok": True,
                "emit_card": {
                    "cardType": "core.system-mini",
                    "id": "sys-mini",
                    "data": telemetry,
                },
            }
        return {"ok": True, "plugin": "core.toolbar", "action": action_id}

    async def _handle_card_action(self, action_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        if action_id == "system.refresh":
            return {"ok": True, "data": get_system_telemetry()}
        if action_id == "approval.decide":
            raw_decision = str(payload.get("decision") or "allow")
            mapped = (
                "auto_approve"
                if raw_decision in {"approve", "auto_approve"}
                else "deny"
                if raw_decision == "deny"
                else "allow"
            )
            approval_id = str(payload.get("approval_id") or payload.get("card_id") or "")
            resolved = False
            if approval_id:
                resolved = await approval_manager.resolve(approval_id, mapped)  # type: ignore[arg-type]
            return {"ok": True, "decision": mapped, "card_id": approval_id, "resolved": resolved}
        return {"ok": True, "action": action_id, "payload": payload}

    def get_contributions(self, agent_running: bool = False) -> dict[str, Any]:
        settings = load_settings()
        return {
            "plugins": [
                {
                    "id": p.id,
                    "name": p.name,
                    "version": p.version,
                    "description": p.description,
                    "slots": p.slots,
                    "card_types": p.card_types,
                    "enabled": p.enabled,
                }
                for p in self._plugins.values()
            ],
            "slots": {
                "bottom-capsule": {
                    "plugin_id": "core.capsule",
                    "model": settings.model or "自动选择模型",
                    "permission_mode": settings.default_permission_mode,
                    "approval_policy": settings.approval_policy,
                    "status": "running" if agent_running else "idle",
                    "prevent_sleep": settings.prevent_sleep,
                },
                "quick-toolbar": [
                    {"id": "slash_plan", "label": "/plan 规划", "insert": "/plan "},
                    {"id": "slash_compact", "label": "/compact 压缩", "insert": "/compact"},
                    {"id": "attach_screen", "label": "附带电脑截屏", "toggle": "attach_screenshot"},
                    {"id": "pc_status", "label": "电脑速览", "plugin_action": ("core.toolbar", "system.snapshot_card")},
                ],
            },
        }

    async def dispatch_action(self, plugin_id: str, action_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        handler = self._handlers.get(plugin_id)
        if not handler:
            return {"ok": False, "error": f"Unknown plugin: {plugin_id}"}
        return await handler(action_id, payload)


plugin_registry = PluginRegistry()
