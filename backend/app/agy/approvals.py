"""Remote mobile tool-permission approval manager and WS hub."""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal

ApprovalDecision = Literal["auto_approve", "deny", "allow"]

SMART_APPROVAL_TOOLS = {
    "run_command",
    "write_to_file",
    "replace_file_content",
    "multi_replace_file_content",
    "write_file",
    "edit_file",
    "ask_permission",
    "call_mcp_tool",
}

WsBroadcastCallback = Callable[[dict[str, Any]], Awaitable[None]]


def summarize_tool_request(tool_name: str, tool_args: dict[str, Any]) -> tuple[str, str]:
    name = (tool_name or "tool").strip()
    args = tool_args or {}
    if name == "run_command":
        cmd = str(args.get("CommandLine") or args.get("command") or "").strip()
        cwd = str(args.get("Cwd") or "").strip()
        summary = f"执行命令: {cmd[:80]}" if cmd else "执行终端命令"
        detail = f"命令: {cmd}\n目录: {cwd}" if cwd else f"命令: {cmd}"
        return summary, detail.strip()
    if name in {"write_to_file", "replace_file_content", "multi_replace_file_content", "write_file", "edit_file"}:
        target = str(args.get("TargetFile") or args.get("Path") or "").strip()
        desc = str(args.get("Description") or args.get("Instruction") or "").strip()
        summary = f"修改文件: {target or name}"
        detail = f"文件: {target}\n说明: {desc}".strip()
        return summary, detail
    if name == "ask_permission":
        action = str(args.get("Action") or "")
        target = str(args.get("Target") or "")
        reason = str(args.get("Reason") or "")
        return f"请求授权: {action} {target}".strip(), reason
    try:
        preview = json.dumps(args, ensure_ascii=False)
    except Exception:
        preview = str(args)
    return f"调用工具: {name}", preview[:500]


@dataclass
class PendingApproval:
    approval_id: str
    conversation_id: str
    tool_name: str
    tool_args: dict[str, Any]
    summary: str
    detail: str
    model_name: str
    step_idx: int | None
    created_at: float
    expires_at: float
    status: str = "pending"
    decision: str = ""
    future: asyncio.Future[dict[str, str]] | None = field(default=None, repr=False)

    def to_public_dict(self) -> dict[str, Any]:
        return {
            "approval_id": self.approval_id,
            "conversation_id": self.conversation_id,
            "tool_name": self.tool_name,
            "tool_args": self.tool_args,
            "summary": self.summary,
            "detail": self.detail,
            "model_name": self.model_name,
            "step_idx": self.step_idx,
            "created_at": self.created_at,
            "expires_at": self.expires_at,
            "status": self.status,
            "decision": self.decision,
        }


class ApprovalManager:
    """Coordinates live WebSocket subscribers and PreToolUse approval futures."""

    def __init__(self) -> None:
        self._ws_clients: dict[str, WsBroadcastCallback] = {}
        self._pending: dict[str, PendingApproval] = {}

    def register_ws(self, client_id: str, sender: WsBroadcastCallback) -> None:
        self._ws_clients[client_id] = sender

    def unregister_ws(self, client_id: str) -> None:
        self._ws_clients.pop(client_id, None)

    @property
    def connected_client_count(self) -> int:
        return len(self._ws_clients)

    async def broadcast(self, payload: dict[str, Any]) -> None:
        if not self._ws_clients:
            return
        senders = list(self._ws_clients.values())
        await asyncio.gather(*(self._safe_call(fn, payload) for fn in senders), return_exceptions=True)

    @staticmethod
    async def _safe_call(fn: WsBroadcastCallback, payload: dict[str, Any]) -> None:
        try:
            await fn(payload)
        except Exception:
            pass

    def should_intercept(self, tool_name: str, policy: str) -> bool:
        if policy == "desktop_only":
            return False
        if self.connected_client_count <= 0:
            return False
        if policy == "remote_all":
            return True
        name = (tool_name or "").strip()
        return name in SMART_APPROVAL_TOOLS or name.startswith("browser_")

    def list_pending(self) -> list[dict[str, Any]]:
        now = time.time()
        return [
            item.to_public_dict()
            for item in self._pending.values()
            if item.status == "pending" and item.expires_at > now
        ]

    async def request_approval(
        self,
        conversation_id: str,
        tool_name: str,
        tool_args: dict[str, Any],
        model_name: str = "",
        step_idx: int | None = None,
        timeout_seconds: int = 95,
    ) -> dict[str, str]:
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[dict[str, str]] = loop.create_future()
        now = time.time()
        approval_id = f"apr-{uuid.uuid4().hex[:10]}"
        summary, detail = summarize_tool_request(tool_name, tool_args)

        record = PendingApproval(
            approval_id=approval_id,
            conversation_id=conversation_id,
            tool_name=tool_name,
            tool_args=tool_args,
            summary=summary,
            detail=detail,
            model_name=model_name,
            step_idx=step_idx,
            created_at=now,
            expires_at=now + max(5, timeout_seconds),
            future=fut,
        )
        self._pending[approval_id] = record
        await self.broadcast({"type": "approval_request", "approval": record.to_public_dict()})

        try:
            result = await asyncio.wait_for(fut, timeout=float(timeout_seconds))
            return result
        except asyncio.TimeoutError:
            record.status = "timed_out"
            record.decision = "allow"
            await self.broadcast(
                {
                    "type": "approval_resolved",
                    "approval_id": approval_id,
                    "conversation_id": conversation_id,
                    "decision": "allow",
                    "status": "timed_out",
                }
            )
            return {
                "decision": "allow",
                "reason": "AgyPocket 手机审批超时，交由桌面版原权限策略处理。",
            }
        finally:
            self._pending.pop(approval_id, None)

    async def resolve(
        self,
        approval_id: str,
        decision: ApprovalDecision,
        reason: str = "",
    ) -> bool:
        record = self._pending.get(approval_id)
        if not record or record.status != "pending":
            return False

        record.status = "resolved"
        record.decision = decision
        if decision == "auto_approve":
            default_reason = "Approved remotely from AgyPocket mobile"
        elif decision == "deny":
            default_reason = "Denied remotely from AgyPocket mobile"
        else:
            default_reason = "Deferred to Antigravity Desktop prompt from AgyPocket mobile"

        payload = {"decision": decision, "reason": reason or default_reason}
        if record.future and not record.future.done():
            record.future.set_result(payload)

        await self.broadcast(
            {
                "type": "approval_resolved",
                "approval_id": approval_id,
                "conversation_id": record.conversation_id,
                "decision": decision,
                "status": "resolved",
            }
        )
        return True


approval_manager = ApprovalManager()
