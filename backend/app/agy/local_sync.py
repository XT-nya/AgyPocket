"""Read-only alignment and incremental pull from local Antigravity conversation stores."""

from __future__ import annotations

import json
import os
import re
import sqlite3
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from app.agy.media import (
    build_media_url,
    get_allowed_media_roots,
    is_image_path,
    load_sticker_map,
    resolve_allowed_media_path,
    rewrite_markdown_media,
)
from app.agy.sessions import ChatMessage, session_store
from app.agy.telemetry import read_conversation_telemetry

SYNC_SCHEMA_VERSION = "v3"
USER_REQUEST_RE = re.compile(r"<USER_REQUEST>\s*(.*?)\s*</USER_REQUEST>", re.DOTALL)
SYSTEM_MESSAGE_RE = re.compile(
    r"<SYSTEM_MESSAGE>\s*(\[Message\](?:(?!</SYSTEM_MESSAGE>).)*?)\s*</SYSTEM_MESSAGE>",
    re.DOTALL,
)
SYSTEM_SENDER_RE = re.compile(r"\bsender=system\b")
SYSTEM_HIGH_PRIO_RE = re.compile(r"\bpriority=MESSAGE_PRIORITY_HIGH\b")
ADDITIONAL_META_RE = re.compile(r"<ADDITIONAL_METADATA>.*?</ADDITIONAL_METADATA>", re.DOTALL)
SUBFRAC_RE = re.compile(r"(\.\d{6})\d+")


def get_default_antigravity_roots() -> list[Path]:
    home = Path.home()
    return [
        home / ".gemini" / "antigravity",
        home / ".gemini" / "antigravity-cli",
    ]


def _parse_iso_ts(raw: str | None) -> float:
    if not raw:
        return 0.0
    try:
        cleaned = SUBFRAC_RE.sub(r"\1", str(raw).strip()).replace("Z", "+00:00")
        return datetime.fromisoformat(cleaned).timestamp()
    except Exception:
        return 0.0


def _parse_workspace_uris(raw_json: str) -> str:
    if not raw_json:
        return ""
    try:
        arr = json.loads(raw_json)
        if not isinstance(arr, list) or not arr:
            return ""
        first = str(arr[0])
        parsed = urlparse(first)
        if parsed.scheme == "file":
            p = unquote(parsed.path)
            if os.name == "nt" and len(p) >= 3 and p[0] == "/" and p[2] == ":":
                p = p[1:].replace("/", "\\")
            return p
        return first
    except Exception:
        return ""


def _normalize_app_status(raw_status: str, not_fully_idle: Any) -> str:
    s = str(raw_status or "").upper()
    if "RUNNING" in s or bool(not_fully_idle):
        return "running"
    if "ERROR" in s or "FAIL" in s:
        return "error"
    return "idle"


@dataclass
class LocalConversationIndex:
    conversation_id: str
    title: str
    step_count: int
    updated_at: float
    workspace_dir: str
    transcript_path: Path | None
    full_path: Path | None
    fingerprint: str
    transcript_size: int = 0
    project_id: str = ""
    app_status: str = "idle"
    active_model: str = ""
    root_name: str = ""


def _query_summaries_safe(db_path: Path) -> list[dict[str, Any]]:
    con: sqlite3.Connection | None = None
    try:
        con = sqlite3.connect(f"file:{db_path.as_posix()}?mode=ro", uri=True, timeout=2.0)
        cols = {row[1] for row in con.execute("PRAGMA table_info(conversation_summaries)").fetchall()}
        wanted = [
            "conversation_id",
            "title",
            "step_count",
            "last_modified_time",
            "workspace_uris",
            "parent_conversation_id",
        ]
        optional = ["project_id", "status", "not_fully_idle"]
        select_cols = [c for c in wanted + optional if c in cols]
        if "conversation_id" not in select_cols:
            return []
        rows = con.execute(f"SELECT {', '.join(select_cols)} FROM conversation_summaries").fetchall()
        out: list[dict[str, Any]] = []
        for r in rows:
            item = dict(zip(select_cols, r))
            out.append(item)
        return out
    except Exception:
        return []
    finally:
        if con is not None:
            try:
                con.close()
            except Exception:
                pass


def scan_local_antigravity_index(roots: list[Path] | None = None) -> list[LocalConversationIndex]:
    """Scan metadata & transcript file stat without reading full transcript bodies."""
    target_roots = roots if roots is not None else get_default_antigravity_roots()
    merged: dict[str, LocalConversationIndex] = {}

    for root in target_roots:
        if not root.is_dir():
            continue
        is_app_root = root.name == "antigravity"
        conv_db_dir = root / "conversations"
        db_path = root / "conversation_summaries.db"
        if db_path.is_file():
            rows = _query_summaries_safe(db_path)
            for row in rows:
                if str(row.get("parent_conversation_id") or "").strip():
                    continue
                cid = str(row.get("conversation_id") or "").strip()
                if not cid:
                    continue
                logs_dir = root / "brain" / cid / ".system_generated" / "logs"
                t_path = logs_dir / "transcript.jsonl"
                f_path = logs_dir / "transcript_full.jsonl"
                has_t = t_path.is_file()
                has_f = f_path.is_file()
                t_size = 0
                t_mtime = 0
                if has_t:
                    st = t_path.stat()
                    t_size = st.st_size
                    t_mtime = int(st.st_mtime)
                sc = int(row.get("step_count") or 0)
                last_mod = row.get("last_modified_time")
                app_status = _normalize_app_status(
                    str(row.get("status") or ""),
                    row.get("not_fully_idle", 0),
                )
                project_id = str(row.get("project_id") or "").strip()
                fp = (
                    f"{SYNC_SCHEMA_VERSION}:{t_size}:{t_mtime}:{sc}:{project_id}"
                    if has_t
                    else f"{SYNC_SCHEMA_VERSION}:db:{last_mod}:{sc}:{project_id}"
                )
                updated_ts = max(_parse_iso_ts(last_mod), float(t_mtime))

                active_model = ""
                if is_app_root and conv_db_dir.is_dir():
                    tel = read_conversation_telemetry(cid, conversations_dir=conv_db_dir)
                    if tel and tel.get("model_name"):
                        active_model = str(tel["model_name"])

                entry = LocalConversationIndex(
                    conversation_id=cid,
                    title=(str(row.get("title") or "").strip() or f"会话 {cid[:8]}"),
                    step_count=sc,
                    updated_at=updated_ts,
                    workspace_dir=_parse_workspace_uris(str(row.get("workspace_uris") or "")),
                    transcript_path=t_path if has_t else None,
                    full_path=f_path if has_f else None,
                    fingerprint=fp,
                    transcript_size=t_size,
                    project_id=project_id,
                    app_status=app_status,
                    active_model=active_model,
                    root_name=root.name,
                )
                prev = merged.get(cid)
                if prev is None:
                    merged[cid] = entry
                else:
                    # Prefer desktop App root (`antigravity`) or newer/larger transcript
                    prev_is_app = prev.root_name == "antigravity"
                    if (is_app_root and not prev_is_app) or (
                        is_app_root == prev_is_app
                        and (entry.transcript_size > prev.transcript_size or entry.updated_at > prev.updated_at)
                    ):
                        merged[cid] = entry

        # Also pick up brain transcripts not yet indexed in sqlite
        brain_dir = root / "brain"
        if brain_dir.is_dir():
            for t_path in brain_dir.glob("*/.system_generated/logs/transcript.jsonl"):
                cid = t_path.parents[2].name
                if cid in merged:
                    continue
                st = t_path.stat()
                f_path = t_path.with_name("transcript_full.jsonl")
                fp = f"{SYNC_SCHEMA_VERSION}:{st.st_size}:{int(st.st_mtime)}:0"
                merged[cid] = LocalConversationIndex(
                    conversation_id=cid,
                    title=f"反重力会话 {cid[:8]}",
                    step_count=0,
                    updated_at=float(st.st_mtime),
                    workspace_dir="",
                    transcript_path=t_path,
                    full_path=f_path if f_path.is_file() else None,
                    fingerprint=fp,
                    transcript_size=st.st_size,
                    root_name=root.name,
                )

    items = list(merged.values())
    items.sort(key=lambda x: x.updated_at, reverse=True)
    return items


def _render_user_media_items(
    media_items: Any,
    allowed_roots: list[Path],
) -> tuple[list[str], int]:
    """Convert USER_INPUT.media entries into Markdown image embeds or file download links."""
    if not isinstance(media_items, list) or not media_items:
        return [], 0

    rendered: list[str] = []
    unresolved = 0
    for item in media_items:
        if not isinstance(item, dict):
            unresolved += 1
            continue
        raw_ref = str(item.get("uri") or item.get("path") or item.get("file_path") or "").strip()
        mime_type = str(item.get("mime_type") or item.get("mimeType") or "").strip()
        if not raw_ref:
            unresolved += 1
            continue
        try:
            resolved = resolve_allowed_media_path(raw_ref, allowed_roots=allowed_roots)
        except Exception:
            unresolved += 1
            continue
        if is_image_path(resolved, mime_type=mime_type):
            rendered.append(f"![附件图片]({build_media_url(resolved, download=False)})")
        else:
            rendered.append(f"[{resolved.name}]({build_media_url(resolved, download=True)})")
    return rendered, unresolved


def _clean_user_text(
    raw: str,
    media_items: Any = None,
    allowed_roots: list[Path] | None = None,
    sticker_map: dict[str, Path] | None = None,
) -> str:
    text = raw or ""
    m = USER_REQUEST_RE.search(text)
    if m:
        extracted = m.group(1).strip()
    else:
        extracted = ADDITIONAL_META_RE.sub("", text).strip()

    roots = allowed_roots if allowed_roots is not None else get_allowed_media_roots()
    if extracted:
        extracted = rewrite_markdown_media(extracted, allowed_roots=roots, sticker_map=sticker_map)

    media_md, unresolved = _render_user_media_items(media_items, roots)
    parts: list[str] = []
    if extracted:
        parts.append(extracted)
    elif "approved this document" in text.lower():
        parts.append("✅ 已批准方案继续执行")

    if media_md:
        parts.extend(media_md)
    elif unresolved > 0:
        parts.append("[发送了图片/附件]" if not parts else "[附带了图片/附件]")

    return "\n\n".join(parts).strip()


def _extract_agentapi_user_message(
    raw: str,
    allowed_roots: list[Path] | None = None,
    sticker_map: dict[str, Path] | None = None,
) -> str:
    """Extract user messages relayed via agentapi send-message inside SYSTEM_MESSAGE."""
    text = raw or ""
    if not text or "<SYSTEM_MESSAGE>" not in text:
        return ""
    blocks = SYSTEM_MESSAGE_RE.findall(text)
    if not blocks:
        return ""

    roots = allowed_roots if allowed_roots is not None else get_allowed_media_roots()
    for block in blocks:
        stripped = block.strip()
        if not stripped.startswith("[Message]") or "content=" not in stripped:
            continue
        header, body = stripped.split("content=", 1)
        if not (SYSTEM_SENDER_RE.search(header) and SYSTEM_HIGH_PRIO_RE.search(header)):
            continue
        cleaned = body.strip()
        if not cleaned:
            continue
        if cleaned.startswith("[Notice") or cleaned.startswith("[plan review"):
            continue
        return rewrite_markdown_media(cleaned, allowed_roots=roots, sticker_map=sticker_map)
    return ""


def _load_full_lookup(full_path: Path | None) -> dict[int, dict[str, Any]]:
    if not full_path or not full_path.is_file():
        return {}
    lookup: dict[int, dict[str, Any]] = {}
    try:
        with full_path.open("r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(obj, dict) and "step_index" in obj:
                    lookup[int(obj["step_index"])] = obj
    except Exception:
        return {}
    return lookup


def parse_transcript_messages(transcript_path: Path | None, full_path: Path | None = None) -> list[ChatMessage]:
    """Parse transcript.jsonl into mobile-friendly ChatMessage turns."""
    if not transcript_path or not transcript_path.is_file():
        return []

    allowed_roots = get_allowed_media_roots()
    if len(transcript_path.parents) >= 4 and transcript_path.parents[3].name == "brain":
        brain_root = transcript_path.parents[3].resolve()
        if brain_root not in allowed_roots:
            allowed_roots.append(brain_root)
    sticker_map = load_sticker_map()

    messages: list[ChatMessage] = []
    full_lookup: dict[int, dict[str, Any]] | None = None

    pending_thoughts: list[str] = []
    pending_contents: list[str] = []
    pending_cards: list[dict[str, Any]] = []
    pending_ts: float = 0.0
    extra_tool_count = 0

    def flush_assistant() -> None:
        nonlocal pending_thoughts, pending_contents, pending_cards, pending_ts, extra_tool_count
        if not pending_thoughts and not pending_contents and not pending_cards:
            return
        thought_text = "\n\n".join(pending_thoughts).strip()
        if len(thought_text) > 12000:
            thought_text = thought_text[:12000] + "\n...（思考日志已折叠截断）"
        content_text = "\n\n".join(pending_contents).strip()
        if content_text:
            content_text = rewrite_markdown_media(
                content_text,
                allowed_roots=allowed_roots,
                sticker_map=sticker_map,
            )
        cards = list(pending_cards)
        if extra_tool_count > 0:
            cards.append(
                {
                    "cardType": "core.tool-call",
                    "id": f"tc-more-{len(messages)}",
                    "data": {
                        "name": "tool_summary",
                        "args": {"omitted_calls": extra_tool_count},
                        "status": "done",
                        "output": f"本轮共折叠省略了其余 {extra_tool_count} 次工具调用以保持手机端流畅",
                    },
                }
            )
        messages.append(
            ChatMessage(
                id=f"agy-a-{len(messages)}",
                role="assistant",
                content=content_text,
                thought=thought_text,
                cards=cards,
                timestamp=pending_ts or time.time(),
                status="done",
            )
        )
        pending_thoughts = []
        pending_contents = []
        pending_cards = []
        pending_ts = 0.0
        extra_tool_count = 0

    with transcript_path.open("r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(obj, dict):
                continue

            stype = str(obj.get("type") or "")
            step_idx = obj.get("step_index")
            truncated = obj.get("truncated_fields") or []
            if isinstance(truncated, list) and "content" in truncated and full_path is not None:
                if full_lookup is None:
                    full_lookup = _load_full_lookup(full_path)
                if isinstance(step_idx, int) and step_idx in full_lookup:
                    full_obj = full_lookup[step_idx]
                    if full_obj.get("content") is not None:
                        obj["content"] = full_obj["content"]

            ts = _parse_iso_ts(obj.get("created_at")) or time.time()

            if stype == "USER_INPUT":
                flush_assistant()
                clean = _clean_user_text(
                    str(obj.get("content") or ""),
                    media_items=obj.get("media"),
                    allowed_roots=allowed_roots,
                    sticker_map=sticker_map,
                )
                if clean:
                    messages.append(
                        ChatMessage(
                            id=f"agy-u-{step_idx if step_idx is not None else len(messages)}",
                            role="user",
                            content=clean,
                            timestamp=ts,
                            status="done",
                        )
                    )
            elif stype == "SYSTEM_MESSAGE":
                extracted = _extract_agentapi_user_message(
                    str(obj.get("content") or ""),
                    allowed_roots=allowed_roots,
                    sticker_map=sticker_map,
                )
                if extracted:
                    flush_assistant()
                    messages.append(
                        ChatMessage(
                            id=f"agy-su-{step_idx if step_idx is not None else len(messages)}",
                            role="user",
                            content=extracted,
                            timestamp=ts,
                            status="done",
                        )
                    )
            elif stype == "PLANNER_RESPONSE":
                if not pending_ts:
                    pending_ts = ts
                th = str(obj.get("thinking") or "").strip()
                if th:
                    pending_thoughts.append(th)
                for tc_idx, tc in enumerate(obj.get("tool_calls") or []):
                    if not isinstance(tc, dict):
                        continue
                    if len(pending_cards) < 20:
                        pending_cards.append(
                            {
                                "cardType": "core.tool-call",
                                "id": f"tc-{step_idx}-{tc_idx}",
                                "data": {
                                    "name": str(tc.get("name") or "tool"),
                                    "args": tc.get("arguments") or tc.get("args") or tc.get("input") or {},
                                    "status": "done",
                                    "output": "",
                                },
                            }
                        )
                    else:
                        extra_tool_count += 1
                ct = str(obj.get("content") or "").strip()
                if ct:
                    pending_contents.append(ct)

    flush_assistant()
    return messages


def align_local_sessions(
    client_fingerprints: dict[str, str] | None = None,
    roots: list[Path] | None = None,
) -> dict[str, Any]:
    """Compare lightweight fingerprints against client & server caches without parsing transcripts."""
    fp_map = client_fingerprints or {}
    local_items = scan_local_antigravity_index(roots=roots)

    out_items: list[dict[str, Any]] = []
    counts = {"total": len(local_items), "new": 0, "needs_update": 0, "up_to_date": 0}

    for item in local_items:
        cid = item.conversation_id
        client_fp = fp_map.get(cid, "")
        srv = session_store.find_by_agy_conversation_id(cid)
        server_cached = bool(srv and srv.sync_fingerprint == item.fingerprint)

        if not client_fp:
            sync_status = "new"
            counts["new"] += 1
        elif client_fp != item.fingerprint:
            sync_status = "needs_update"
            counts["needs_update"] += 1
        else:
            sync_status = "up_to_date"
            counts["up_to_date"] += 1

        out_items.append(
            {
                "conversation_id": cid,
                "session_id": srv.id if srv else f"local-{cid[:12]}",
                "title": item.title,
                "project_id": item.project_id,
                "workspace_dir": item.workspace_dir,
                "active_model": item.active_model or (srv.active_model if srv else ""),
                "app_status": item.app_status,
                "step_count": item.step_count,
                "updated_at": item.updated_at,
                "fingerprint": item.fingerprint,
                "status": sync_status,
                "server_cached": server_cached,
            }
        )

    return {"items": out_items, "counts": counts}


def pull_local_sessions(
    conversation_ids: list[str] | None = None,
    client_fingerprints: dict[str, str] | None = None,
    roots: list[Path] | None = None,
) -> dict[str, Any]:
    """Incrementally parse only changed local conversations and persist to PC cache."""
    fp_map = client_fingerprints or {}
    local_items = scan_local_antigravity_index(roots=roots)
    requested = set(conversation_ids) if conversation_ids is not None else None

    synced_sessions: list[dict[str, Any]] = []
    parsed_count = 0
    cache_hit_count = 0

    for item in local_items:
        cid = item.conversation_id
        if requested is not None:
            if cid not in requested:
                continue
        elif fp_map.get(cid) == item.fingerprint:
            continue

        srv = session_store.find_by_agy_conversation_id(cid)
        if srv and srv.sync_fingerprint == item.fingerprint:
            cache_hit_count += 1
            if item.app_status != srv.app_status or (item.active_model and item.active_model != srv.active_model):
                updated_srv = session_store.update_session(
                    srv.id,
                    app_status=item.app_status,
                    active_model=item.active_model or srv.active_model,
                    project_id=item.project_id or srv.project_id,
                )
                if updated_srv:
                    srv = updated_srv
            synced_sessions.append(srv.model_dump())
            continue

        parsed_msgs = parse_transcript_messages(item.transcript_path, item.full_path)
        parsed_count += 1
        saved = session_store.upsert_synced_session(
            agy_conv_id=cid,
            title=item.title,
            workspace_dir=item.workspace_dir,
            messages=parsed_msgs,
            sync_fingerprint=item.fingerprint,
            step_count=item.step_count,
            updated_at=item.updated_at,
            project_id=item.project_id,
            active_model=item.active_model,
            app_status=item.app_status,
        )
        synced_sessions.append(saved.model_dump())

    return {
        "synced_sessions": synced_sessions,
        "parsed_count": parsed_count,
        "cache_hit_count": cache_hit_count,
    }


def get_single_conversation_snapshot(
    conversation_id: str,
    roots: list[Path] | None = None,
) -> tuple[LocalConversationIndex | None, list[ChatMessage] | None]:
    """Read lightweight index & parsed messages for one live conversation."""
    cid = (conversation_id or "").strip()
    if not cid:
        return None, None
    for item in scan_local_antigravity_index(roots=roots):
        if item.conversation_id == cid:
            msgs = parse_transcript_messages(item.transcript_path, item.full_path)
            return item, msgs
    return None, None
