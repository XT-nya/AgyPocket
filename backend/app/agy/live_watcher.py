"""Live Antigravity Desktop coordinator: Sidecar dispatch, Hook events & active-only transcript sync."""

from __future__ import annotations

import asyncio
import time
import uuid
from typing import Any

from app.agy.approvals import approval_manager
from app.agy.bridge_client import bridge_client
from app.agy.desktop_composer import try_send_via_desktop_ui
from app.agy.local_sync import (
    get_single_conversation_snapshot,
    parse_transcript_messages,
    scan_local_antigravity_index,
)
from app.agy.sessions import ChatMessage, ChatSession, session_store
from app.agy.telemetry import read_conversation_telemetry
from app.config import PROJECT_ROOT, load_settings


class DesktopLiveCoordinator:
    """Manages active Antigravity Desktop App sessions without running CLI subprocesses."""

    def __init__(self) -> None:
        self._watchers: dict[str, asyncio.Task[None]] = {}
        self._wake_events: dict[str, asyncio.Event] = {}
        self._live_models: dict[str, str] = {}
        self._pending_prompts: dict[str, tuple[str, ChatMessage, ChatMessage, float]] = {}
        self._active_sessions: set[str] = set()

    def is_running(self, session_id: str) -> bool:
        if session_id in self._active_sessions:
            return True
        sess = session_store.get_session(session_id)
        return bool(sess and sess.app_status == "running")

    def any_running(self) -> bool:
        return bool(self._active_sessions) or any(
            s.get("app_status") == "running" for s in session_store.list_sessions()
        )

    def get_live_model(self, conversation_id: str) -> str:
        return self._live_models.get(conversation_id, "")

    def _wake(self, conversation_id: str) -> None:
        ev = self._wake_events.get(conversation_id)
        if ev is not None:
            ev.set()

    def ensure_watching(self, session_id: str, conversation_id: str) -> None:
        cid = (conversation_id or "").strip()
        if not cid:
            return
        existing = self._watchers.get(cid)
        if existing and not existing.done():
            self._wake(cid)
            return
        self._wake_events[cid] = asyncio.Event()
        task = asyncio.create_task(self._watch_loop(session_id, cid))
        self._watchers[cid] = task

    async def stop_all(self) -> None:
        tasks = list(self._watchers.values())
        for t in tasks:
            t.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._watchers.clear()
        self._wake_events.clear()
        self._active_sessions.clear()

    async def stop_watching_session(self, session_id: str) -> bool:
        self._active_sessions.discard(session_id)
        self._pending_prompts.pop(session_id, None)
        sess = session_store.get_session(session_id)
        if sess:
            session_store.update_session(session_id, app_status="idle")
            if sess.agy_conversation_id:
                task = self._watchers.pop(sess.agy_conversation_id, None)
                if task and not task.done():
                    task.cancel()
                return True
        return False

    async def handle_hook_event(self, event_type: str, payload: dict[str, Any]) -> None:
        conv_id = str(payload.get("conversationId") or "").strip()
        model_name = str(payload.get("modelName") or "").strip()

        if conv_id and model_name:
            self._live_models[conv_id] = model_name
            sess = session_store.find_by_agy_conversation_id(conv_id)
            if sess:
                session_store.update_session(sess.id, active_model=model_name)
            await approval_manager.broadcast(
                {
                    "type": "active_model",
                    "conversation_id": conv_id,
                    "session_id": sess.id if sess else "",
                    "model_name": model_name,
                }
            )

        await approval_manager.broadcast(
            {
                "type": "hook_event",
                "event": event_type,
                "conversation_id": conv_id,
                "model_name": model_name,
            }
        )

        if not conv_id:
            return

        sess = session_store.find_by_agy_conversation_id(conv_id)
        if event_type == "Stop":
            fully_idle = bool(payload.get("fullyIdle", True))
            if sess:
                await self._sync_once(sess.id, conv_id, force_idle=fully_idle)
                if fully_idle:
                    self._active_sessions.discard(sess.id)
                    pending_entry = self._pending_prompts.get(sess.id)
                    if pending_entry and (time.time() - pending_entry[3]) > 15.0:
                        self._pending_prompts.pop(sess.id, None)
            self._wake(conv_id)
            return

        if sess:
            self.ensure_watching(sess.id, conv_id)
        self._wake(conv_id)

    async def send_prompt(
        self,
        session_id: str,
        prompt: str,
        model_id: str = "",
        project_id: str = "",
        attach_screenshot_path: str | None = None,
    ) -> None:
        settings = load_settings()
        sess = session_store.get_session(session_id)
        if not sess:
            sess = session_store.create_session(model=model_id or settings.model, project_id=project_id)
            session_id = sess.id

        effective_prompt = prompt.strip()
        if attach_screenshot_path:
            effective_prompt = (
                f"{effective_prompt}\n\n[附带远程电脑当前屏幕截图路径: {attach_screenshot_path}]"
            )

        user_msg = ChatMessage(role="user", content=prompt.strip(), status="done")
        session_store.append_message(session_id, user_msg)

        assistant_msg = ChatMessage(role="assistant", content="", thought="", cards=[], status="streaming")
        session_store.append_message(session_id, assistant_msg)

        chosen_model = (model_id or sess.model or settings.model).strip()
        await approval_manager.broadcast(
            {
                "type": "run_start",
                "session_id": session_id,
                "message_id": assistant_msg.id,
                "permission_mode": sess.permission_mode or settings.default_permission_mode,
                "model": chosen_model or "default",
            }
        )

        status = await bridge_client.get_status()
        if not status.get("sidecar_running"):
            install_script = PROJECT_ROOT / "install-bridge-plugin.ps1"
            guide_card = {
                "cardType": "core.auth-guide",
                "id": f"bridge-{uuid.uuid4().hex[:6]}",
                "data": {
                    "title": "请先重启桌面版 Antigravity 以启用联动插件",
                    "message": status.get("detail")
                    or "agy-pocket-bridge Sidecar 尚未在线，请确认已运行 install-bridge-plugin.ps1 并重启桌面版 Antigravity。",
                    "command": f'powershell -ExecutionPolicy Bypass -File "{install_script}"',
                },
            }
            session_store.update_last_assistant_message(
                session_id,
                assistant_msg.id,
                "桌面版联动 Sidecar 尚未连接。",
                "",
                [guide_card],
                "error",
            )
            await approval_manager.broadcast(
                {
                    "type": "card_emit",
                    "session_id": session_id,
                    "message_id": assistant_msg.id,
                    "card": guide_card,
                }
            )
            await approval_manager.broadcast(
                {
                    "type": "run_done",
                    "session_id": session_id,
                    "message_id": assistant_msg.id,
                    "status": "error",
                    "timestamp": time.time(),
                }
            )
            return

        self._active_sessions.add(session_id)
        self._pending_prompts[session_id] = (prompt.strip(), user_msg, assistant_msg, time.time())
        session_store.update_session(session_id, app_status="running")

        try:
            conv_id = (sess.agy_conversation_id or "").strip()
            target_project_id = (project_id or sess.project_id or str(status.get("bound_project_id") or "")).strip()
            if not conv_id:
                before_ids = {item.conversation_id for item in scan_local_antigravity_index()}
                title_hint = sess.title if sess.title not in {"新对话", "主工作台"} else ""
                resp = await bridge_client.new_conversation(
                    prompt=effective_prompt,
                    model=chosen_model,
                    title=title_hint,
                    project_id=target_project_id,
                )
                conv_id = str(resp.get("conversation_id") or "").strip()
                if not conv_id:
                    await asyncio.sleep(0.5)
                    for item in scan_local_antigravity_index():
                        if item.conversation_id not in before_ids:
                            conv_id = item.conversation_id
                            break
                if not conv_id:
                    raise RuntimeError("agentapi new-conversation 未返回 conversation_id")

                session_store.update_session(
                    session_id,
                    agy_conversation_id=conv_id,
                    model=chosen_model or sess.model,
                    active_model=chosen_model or sess.active_model,
                    project_id=target_project_id,
                    source="antigravity_local",
                    app_status="running",
                )
            else:
                dispatched_native = False
                if settings.message_dispatch_mode == "native_first":
                    base_idx, base_msgs = await asyncio.to_thread(get_single_conversation_snapshot, conv_id)
                    before_size = base_idx.transcript_size if base_idx else 0
                    before_steps = base_idx.step_count if base_idx else 0
                    before_count = len(base_msgs) if base_msgs is not None else 0
                    ui_ok, _ = await asyncio.to_thread(
                        try_send_via_desktop_ui,
                        effective_prompt,
                        sess.title,
                        conv_id,
                    )
                    if ui_ok:
                        for _ in range(8):
                            await asyncio.sleep(0.25)
                            cur_idx, cur_msgs = await asyncio.to_thread(get_single_conversation_snapshot, conv_id)
                            if cur_idx and (
                                cur_idx.transcript_size > before_size
                                or cur_idx.step_count > before_steps
                                or cur_idx.app_status == "running"
                            ):
                                dispatched_native = True
                                break
                            if cur_msgs is not None and len(cur_msgs) > before_count:
                                dispatched_native = True
                                break

                if not dispatched_native:
                    await bridge_client.send_message(
                        conversation_id=conv_id,
                        prompt=effective_prompt,
                        project_id=target_project_id,
                    )
                session_store.update_session(session_id, app_status="running")

            self.ensure_watching(session_id, conv_id)
            await self._sync_once(session_id, conv_id)
        except Exception as exc:
            self._active_sessions.discard(session_id)
            self._pending_prompts.pop(session_id, None)
            session_store.update_session(session_id, app_status="error")
            session_store.update_last_assistant_message(
                session_id,
                assistant_msg.id,
                f"发送到 Antigravity 桌面版失败：{exc}",
                "",
                [],
                "error",
            )
            await approval_manager.broadcast(
                {
                    "type": "run_error",
                    "session_id": session_id,
                    "message_id": assistant_msg.id,
                    "message": str(exc),
                }
            )
            await approval_manager.broadcast(
                {
                    "type": "run_done",
                    "session_id": session_id,
                    "message_id": assistant_msg.id,
                    "status": "error",
                    "timestamp": time.time(),
                }
            )

    async def fork_with_model(
        self,
        session_id: str,
        new_model_id: str,
        user_prompt: str = "",
    ) -> ChatSession:
        src = session_store.get_session(session_id)
        if not src:
            raise ValueError("源会话不存在")
        target_model = (new_model_id or "").strip()
        if not target_model:
            raise ValueError("请先选择目标模型与思考强度")

        status = await bridge_client.get_status()
        if not status.get("sidecar_running"):
            raise RuntimeError(status.get("detail") or "Antigravity Sidecar 未运行")

        # Build concise handoff prompt from recent turns
        snippets: list[str] = []
        for m in src.messages[-4:]:
            role_label = "用户" if m.role == "user" else "助手"
            body = (m.content or "").strip()
            if body:
                snippets.append(f"[{role_label}]: {body[:500]}")
        context_block = "\n".join(snippets)[-2200:]

        if user_prompt.strip():
            handoff = (
                f"这是从桌面会话「{src.title}」切换模型后的同项目续聊。\n"
                f"工作区: {src.workspace_dir or '默认项目'}\n\n"
                f"近期上下文摘要：\n{context_block}\n\n"
                f"请基于上述上下文继续执行用户最新需求：\n{user_prompt.strip()}"
            )
        else:
            handoff = (
                f"这是从桌面会话「{src.title}」切换模型后的同项目续聊。\n"
                f"工作区: {src.workspace_dir or '默认项目'}\n\n"
                f"近期上下文摘要：\n{context_block}\n\n"
                "请简短确认已承接以上上下文，并等待我下一条指令。"
            )

        new_title = f"{src.title[:24]} (续)"
        target_project_id = (src.project_id or str(status.get("bound_project_id") or "")).strip()
        before_ids = {item.conversation_id for item in scan_local_antigravity_index()}
        resp = await bridge_client.new_conversation(
            prompt=handoff,
            model=target_model,
            title=new_title,
            project_id=target_project_id,
        )
        conv_id = str(resp.get("conversation_id") or "").strip()
        if not conv_id:
            await asyncio.sleep(0.5)
            for item in scan_local_antigravity_index():
                if item.conversation_id not in before_ids:
                    conv_id = item.conversation_id
                    break
        if not conv_id:
            raise RuntimeError("新开续聊成功但未捕获到新的 conversation_id")

        created = session_store.upsert_synced_session(
            agy_conv_id=conv_id,
            title=new_title,
            workspace_dir=src.workspace_dir,
            messages=[
                ChatMessage(role="user", content=user_prompt.strip() or f"[切换模型为 {target_model} 续聊]", status="done"),
                ChatMessage(role="assistant", content="", thought="", cards=[], status="streaming"),
            ],
            sync_fingerprint="",
            step_count=0,
            updated_at=time.time(),
            project_id=src.project_id or str(status.get("bound_project_id") or ""),
            active_model=target_model,
            app_status="running",
        )
        self._active_sessions.add(created.id)
        self.ensure_watching(created.id, conv_id)
        await approval_manager.broadcast(
            {
                "type": "session_synced",
                "session_id": created.id,
                "agy_conversation_id": conv_id,
                "session": created.model_dump(),
                "app_status": "running",
            }
        )
        return created

    async def _sync_once(
        self,
        session_id: str,
        conversation_id: str,
        force_idle: bool = False,
    ) -> str:
        idx_item, parsed_msgs = await asyncio.to_thread(
            get_single_conversation_snapshot,
            conversation_id,
        )
        telemetry = await asyncio.to_thread(read_conversation_telemetry, conversation_id)
        live_model = self._live_models.get(conversation_id, "")
        tel_model = str(telemetry.get("model_name") or "") if telemetry else ""

        sess = session_store.get_session(session_id)
        if not sess:
            return "idle"

        app_status = "idle" if force_idle else (idx_item.app_status if idx_item else sess.app_status)
        final_model = live_model or tel_model or (idx_item.active_model if idx_item else "") or sess.active_model or sess.model

        messages_to_store = sess.messages
        if parsed_msgs is not None:
            pending = self._pending_prompts.get(session_id)
            if pending:
                pending_text, u_msg, a_msg, _pending_ts = pending
                pending_norm = " ".join(pending_text.split())
                has_user_in_transcript = bool(pending_norm) and any(
                    m.role == "user"
                    and (
                        pending_norm[:40] in " ".join(m.content.split())
                        or " ".join(m.content.split()) in pending_norm
                    )
                    for m in parsed_msgs[-6:]
                )
                if not has_user_in_transcript:
                    messages_to_store = [*parsed_msgs, u_msg, a_msg]
                else:
                    # Transcript caught up; clear pending placeholder
                    self._pending_prompts.pop(session_id, None)
                    messages_to_store = parsed_msgs
                    if app_status == "running" and messages_to_store and messages_to_store[-1].role == "user":
                        messages_to_store = [
                            *messages_to_store,
                            ChatMessage(role="assistant", content="", thought="", cards=[], status="streaming"),
                        ]
            elif parsed_msgs:
                messages_to_store = parsed_msgs
                if app_status == "running" and messages_to_store[-1].role == "user":
                    messages_to_store = [
                        *messages_to_store,
                        ChatMessage(role="assistant", content="", thought="", cards=[], status="streaming"),
                    ]

        updated = session_store.update_session(
            session_id,
            title=(idx_item.title if idx_item and idx_item.title else sess.title),
            project_id=(idx_item.project_id if idx_item and idx_item.project_id else sess.project_id),
            workspace_dir=(idx_item.workspace_dir if idx_item and idx_item.workspace_dir else sess.workspace_dir),
            active_model=final_model,
            app_status=app_status,
            sync_fingerprint=(idx_item.fingerprint if idx_item else sess.sync_fingerprint),
            step_count=(idx_item.step_count if idx_item else sess.step_count),
            last_synced_at=time.time(),
            messages=messages_to_store,
        )

        if updated:
            await approval_manager.broadcast(
                {
                    "type": "session_synced",
                    "session_id": updated.id,
                    "agy_conversation_id": conversation_id,
                    "session": updated.model_dump(),
                    "app_status": app_status,
                    "telemetry": telemetry,
                }
            )
            if app_status == "idle":
                self._active_sessions.discard(session_id)
                await approval_manager.broadcast(
                    {
                        "type": "run_done",
                        "session_id": updated.id,
                        "status": "done",
                        "agy_conversation_id": conversation_id,
                        "timestamp": time.time(),
                    }
                )
        return app_status

    async def _watch_loop(self, session_id: str, conversation_id: str) -> None:
        wake = self._wake_events.get(conversation_id)
        quiet_ticks = 0
        started_at = time.time()
        try:
            while (time.time() - started_at) < 900.0:
                app_status = await self._sync_once(session_id, conversation_id)
                if app_status == "idle" and session_id not in self._pending_prompts:
                    quiet_ticks += 1
                    if quiet_ticks >= 3:
                        break
                else:
                    quiet_ticks = 0

                if wake is not None:
                    wake.clear()
                    try:
                        await asyncio.wait_for(wake.wait(), timeout=1.2)
                    except asyncio.TimeoutError:
                        pass
                else:
                    await asyncio.sleep(1.2)
        except asyncio.CancelledError:
            pass
        finally:
            self._watchers.pop(conversation_id, None)
            self._wake_events.pop(conversation_id, None)
            self._active_sessions.discard(session_id)


live_coordinator = DesktopLiveCoordinator()
