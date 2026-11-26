"""Session persistence for mobile chat workbench."""

from __future__ import annotations

import json
import os
import threading
import time
import uuid
from typing import Any

from pydantic import BaseModel, Field

from app.config import PermissionTier, get_data_dir, load_settings


class ChatMessage(BaseModel):
    id: str = Field(default_factory=lambda: uuid.uuid4().hex[:12])
    role: str  # "user" | "assistant" | "system"
    content: str = ""
    thought: str = ""
    cards: list[dict[str, Any]] = Field(default_factory=list)
    timestamp: float = Field(default_factory=time.time)
    status: str = "done"  # "streaming" | "done" | "error" | "aborted"


class ChatSession(BaseModel):
    id: str = Field(default_factory=lambda: uuid.uuid4().hex[:12])
    title: str = "新对话"
    agy_conversation_id: str = ""
    project_id: str = ""
    workspace_dir: str = ""
    permission_mode: PermissionTier = "auto"
    model: str = ""
    active_model: str = ""
    app_status: str = "idle"
    source: str = "pocket"  # "pocket" | "antigravity_local"
    sync_fingerprint: str = ""
    last_synced_at: float = 0.0
    step_count: int = 0
    created_at: float = Field(default_factory=time.time)
    updated_at: float = Field(default_factory=time.time)
    messages: list[ChatMessage] = Field(default_factory=list)


class SessionStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()

    def _path(self):
        return get_data_dir() / "sessions.json"

    def _read_all_unlocked(self) -> list[ChatSession]:
        path = self._path()
        if not path.exists():
            return []
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            return [ChatSession(**item) for item in raw]
        except Exception:
            return []

    def _write_all_unlocked(self, sessions: list[ChatSession]) -> None:
        path = self._path()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        payload = [s.model_dump() for s in sessions]
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, path)

    def list_sessions(self) -> list[dict[str, Any]]:
        with self._lock:
            sessions = self._read_all_unlocked()
            sessions.sort(key=lambda s: s.updated_at, reverse=True)
            return [
                {
                    "id": s.id,
                    "title": s.title,
                    "agy_conversation_id": s.agy_conversation_id,
                    "project_id": s.project_id,
                    "workspace_dir": s.workspace_dir,
                    "permission_mode": s.permission_mode,
                    "model": s.model,
                    "active_model": s.active_model,
                    "app_status": s.app_status,
                    "created_at": s.created_at,
                    "updated_at": s.updated_at,
                    "message_count": len(s.messages),
                    "source": s.source,
                    "sync_fingerprint": s.sync_fingerprint,
                    "last_synced_at": s.last_synced_at,
                    "step_count": s.step_count,
                }
                for s in sessions
            ]

    def create_session(
        self,
        title: str | None = None,
        workspace_dir: str | None = None,
        permission_mode: PermissionTier | None = None,
        model: str | None = None,
        project_id: str | None = None,
    ) -> ChatSession:
        settings = load_settings()
        chosen_model = model if model is not None else settings.model
        session = ChatSession(
            title=(title or "新对话").strip() or "新对话",
            project_id=project_id if project_id is not None else settings.default_project_id,
            workspace_dir=workspace_dir or settings.workspace_dir,
            permission_mode=permission_mode or settings.default_permission_mode,
            model=chosen_model,
            active_model=chosen_model,
        )
        with self._lock:
            sessions = self._read_all_unlocked()
            sessions.insert(0, session)
            self._write_all_unlocked(sessions)
        return session

    def get_session(self, session_id: str) -> ChatSession | None:
        with self._lock:
            for s in self._read_all_unlocked():
                if s.id == session_id:
                    return s
        return None

    def update_session(self, session_id: str, **updates: Any) -> ChatSession | None:
        with self._lock:
            sessions = self._read_all_unlocked()
            for idx, s in enumerate(sessions):
                if s.id == session_id:
                    data = s.model_dump()
                    for k, v in updates.items():
                        if v is not None and k in data:
                            data[k] = v
                    data["updated_at"] = time.time()
                    updated = ChatSession(**data)
                    sessions[idx] = updated
                    self._write_all_unlocked(sessions)
                    return updated
        return None

    def append_message(self, session_id: str, msg: ChatMessage) -> ChatSession | None:
        with self._lock:
            sessions = self._read_all_unlocked()
            for idx, s in enumerate(sessions):
                if s.id == session_id:
                    if s.title == "新对话" and msg.role == "user" and msg.content.strip():
                        clean = " ".join(msg.content.strip().split())
                        s.title = clean[:28] + ("..." if len(clean) > 28 else "")
                    s.messages.append(msg)
                    s.updated_at = time.time()
                    sessions[idx] = s
                    self._write_all_unlocked(sessions)
                    return s
        return None

    def update_last_assistant_message(
        self,
        session_id: str,
        msg_id: str,
        content: str,
        thought: str,
        cards: list[dict[str, Any]],
        status: str,
        agy_conversation_id: str | None = None,
    ) -> None:
        with self._lock:
            sessions = self._read_all_unlocked()
            for idx, s in enumerate(sessions):
                if s.id == session_id:
                    if agy_conversation_id:
                        s.agy_conversation_id = agy_conversation_id
                    for m_idx in range(len(s.messages) - 1, -1, -1):
                        if s.messages[m_idx].id == msg_id:
                            s.messages[m_idx].content = content
                            s.messages[m_idx].thought = thought
                            s.messages[m_idx].cards = cards
                            s.messages[m_idx].status = status
                            break
                    s.updated_at = time.time()
                    sessions[idx] = s
                    self._write_all_unlocked(sessions)
                    return

    def delete_session(self, session_id: str) -> bool:
        with self._lock:
            sessions = self._read_all_unlocked()
            remaining = [s for s in sessions if s.id != session_id]
            if len(remaining) == len(sessions):
                return False
            self._write_all_unlocked(remaining)
            return True

    def find_by_agy_conversation_id(self, agy_conv_id: str) -> ChatSession | None:
        if not agy_conv_id:
            return None
        with self._lock:
            for s in self._read_all_unlocked():
                if s.agy_conversation_id == agy_conv_id:
                    return s
        return None

    def upsert_synced_session(
        self,
        agy_conv_id: str,
        title: str,
        workspace_dir: str,
        messages: list[ChatMessage],
        sync_fingerprint: str,
        step_count: int,
        updated_at: float,
        project_id: str = "",
        active_model: str = "",
        app_status: str = "idle",
    ) -> ChatSession:
        now = time.time()
        settings = load_settings()
        with self._lock:
            sessions = self._read_all_unlocked()
            for idx, s in enumerate(sessions):
                if s.agy_conversation_id == agy_conv_id:
                    updated = s.model_copy(
                        update={
                            "title": title or s.title,
                            "project_id": project_id or s.project_id,
                            "workspace_dir": workspace_dir or s.workspace_dir,
                            "active_model": active_model or s.active_model or s.model,
                            "app_status": app_status or s.app_status,
                            "source": "antigravity_local",
                            "sync_fingerprint": sync_fingerprint,
                            "last_synced_at": now,
                            "step_count": step_count,
                            "updated_at": updated_at or now,
                            "messages": messages,
                        }
                    )
                    sessions[idx] = updated
                    self._write_all_unlocked(sessions)
                    return updated

            created = ChatSession(
                id=f"local-{agy_conv_id[:12]}",
                title=title or f"反重力会话 {agy_conv_id[:8]}",
                agy_conversation_id=agy_conv_id,
                project_id=project_id,
                workspace_dir=workspace_dir or settings.workspace_dir,
                permission_mode=settings.default_permission_mode,
                model=active_model or settings.model,
                active_model=active_model or settings.model,
                app_status=app_status or "idle",
                source="antigravity_local",
                sync_fingerprint=sync_fingerprint,
                last_synced_at=now,
                step_count=step_count,
                created_at=updated_at or now,
                updated_at=updated_at or now,
                messages=messages,
            )
            sessions.insert(0, created)
            self._write_all_unlocked(sessions)
            return created


session_store = SessionStore()
