from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path

from fastapi.testclient import TestClient

from app.agy import local_sync


def _make_fake_agy_root(root: Path) -> tuple[str, Path]:
    conv_id = "conv-local-111122223333"
    sub_id = "conv-sub-9999"

    db_path = root / "conversation_summaries.db"
    con = sqlite3.connect(db_path)
    con.execute(
        """
        CREATE TABLE conversation_summaries (
            conversation_id TEXT PRIMARY KEY,
            title TEXT NOT NULL DEFAULT '',
            step_count INTEGER NOT NULL DEFAULT 0,
            last_modified_time TEXT NOT NULL DEFAULT '',
            workspace_uris TEXT NOT NULL DEFAULT '',
            parent_conversation_id TEXT NOT NULL DEFAULT ''
        )
        """
    )
    con.execute(
        "INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?)",
        (
            conv_id,
            "远程终端测试会话",
            4,
            "2026-11-24 07:34:06.2707703+00:00",
            '["file:///d%3A/SampleWorkspace"]',
            "",
        ),
    )
    # Subagent conversation must be filtered out
    con.execute(
        "INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?)",
        (
            sub_id,
            "内部子智能体",
            2,
            "2026-11-24 07:34:06+00:00",
            '["file:///d%3A/SampleWorkspace"]',
            conv_id,
        ),
    )
    con.commit()
    con.close()

    logs_dir = root / "brain" / conv_id / ".system_generated" / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    t_path = logs_dir / "transcript.jsonl"
    f_path = logs_dir / "transcript_full.jsonl"

    lines = [
        {
            "step_index": 0,
            "type": "USER_INPUT",
            "created_at": "2026-11-24T07:00:00Z",
            "content": "<USER_REQUEST>\n帮我看下文件\n</USER_REQUEST>\n<ADDITIONAL_METADATA>ignored</ADDITIONAL_METADATA>",
        },
        {
            "step_index": 1,
            "type": "PLANNER_RESPONSE",
            "created_at": "2026-11-24T07:00:02Z",
            "thinking": "Checking directory first.",
            "tool_calls": [{"name": "run_command", "arguments": {"cmd": "dir"}}],
        },
        {
            "step_index": 2,
            "type": "PLANNER_RESPONSE",
            "created_at": "2026-11-24T07:00:04Z",
            "content": "truncated preview...",
            "truncated_fields": ["content"],
        },
    ]
    full_lines = [
        lines[0],
        lines[1],
        {
            "step_index": 2,
            "type": "PLANNER_RESPONSE",
            "created_at": "2026-11-24T07:00:04Z",
            "content": "完整回复内容：目录检查完成，共 3 个文件。",
        },
    ]
    t_path.write_text("\n".join(json.dumps(x, ensure_ascii=False) for x in lines) + "\n", encoding="utf-8")
    f_path.write_text("\n".join(json.dumps(x, ensure_ascii=False) for x in full_lines) + "\n", encoding="utf-8")
    return conv_id, t_path


def test_align_pull_and_zero_reparse_caching(isolated_env: Path, tmp_path: Path, monkeypatch):
    agy_root = tmp_path / "fake_agy"
    agy_root.mkdir(parents=True, exist_ok=True)
    conv_id, t_path = _make_fake_agy_root(agy_root)

    monkeypatch.setattr(local_sync, "get_default_antigravity_roots", lambda: [agy_root])

    # 1. Align with empty client cache -> marked "new"
    a1 = local_sync.align_local_sessions({})
    assert a1["counts"] == {"total": 1, "new": 1, "needs_update": 0, "up_to_date": 0}
    item = a1["items"][0]
    assert item["conversation_id"] == conv_id
    assert item["status"] == "new"
    fp1 = item["fingerprint"]

    # 2. Pull once -> parses transcript, loads truncated content from transcript_full, persists to sessions.json
    p1 = local_sync.pull_local_sessions([conv_id], {})
    assert p1["parsed_count"] == 1
    assert p1["cache_hit_count"] == 0
    msgs = p1["synced_sessions"][0]["messages"]
    assert len(msgs) == 2
    assert msgs[0]["role"] == "user"
    assert msgs[0]["content"] == "帮我看下文件"
    assert msgs[1]["role"] == "assistant"
    assert "完整回复内容" in msgs[1]["content"]
    assert "Checking directory first." in msgs[1]["thought"]
    assert msgs[1]["cards"][0]["cardType"] == "core.tool-call"

    # 3. Align with client fingerprint matching -> up_to_date & server_cached
    a2 = local_sync.align_local_sessions({conv_id: fp1})
    assert a2["counts"] == {"total": 1, "new": 0, "needs_update": 0, "up_to_date": 1}
    assert a2["items"][0]["server_cached"] is True

    # 4. Pull forced from another device when server cache already matches -> 0 parses (cache hit!)
    p2 = local_sync.pull_local_sessions([conv_id], {})
    assert p2["parsed_count"] == 0
    assert p2["cache_hit_count"] == 1

    # 5. Append a new turn to transcript.jsonl -> align detects needs_update -> incremental pull updates
    with t_path.open("a", encoding="utf-8") as fh:
        fh.write(
            json.dumps(
                {
                    "step_index": 3,
                    "type": "USER_INPUT",
                    "created_at": "2026-11-24T07:05:00Z",
                    "content": "<USER_REQUEST>\n继续下一步\n</USER_REQUEST>",
                },
                ensure_ascii=False,
            )
            + "\n"
        )
    st = t_path.stat()
    os.utime(t_path, (st.st_atime, st.st_mtime + 5))

    a3 = local_sync.align_local_sessions({conv_id: fp1})
    assert a3["counts"]["needs_update"] == 1
    p3 = local_sync.pull_local_sessions([conv_id], {conv_id: fp1})
    assert p3["parsed_count"] == 1
    assert len(p3["synced_sessions"][0]["messages"]) == 3


def test_sync_endpoints_and_pwa_headers(client: TestClient, tmp_path: Path, monkeypatch):
    agy_root = tmp_path / "fake_agy_api"
    agy_root.mkdir(parents=True, exist_ok=True)
    conv_id, _ = _make_fake_agy_root(agy_root)
    monkeypatch.setattr(local_sync, "get_default_antigravity_roots", lambda: [agy_root])

    assert client.post("/api/auth/setup", json={"passphrase": "StrongPassword123"}).status_code == 200
    csrf = client.cookies.get("agypocket_csrf")

    r_align = client.post(
        "/api/sync/local/align",
        json={"client_fingerprints": {}},
        headers={"X-CSRF-Token": csrf},
    )
    assert r_align.status_code == 200
    assert r_align.json()["counts"]["new"] == 1

    r_pull = client.post(
        "/api/sync/local/pull",
        json={"conversation_ids": [conv_id], "client_fingerprints": {}},
        headers={"X-CSRF-Token": csrf},
    )
    assert r_pull.status_code == 200
    assert len(r_pull.json()["synced_sessions"]) == 1

    # Check PWA manifest & service worker headers
    r_man = client.get("/manifest.json")
    assert r_man.status_code == 200
    assert "application/manifest+json" in r_man.headers["content-type"]

    r_sw = client.get("/sw.js")
    assert r_sw.status_code == 200
    assert r_sw.headers.get("cache-control") == "no-cache"
    assert r_sw.headers.get("service-worker-allowed") == "/"


def test_media_sticker_and_file_link_rewriting(isolated_env: Path, tmp_path: Path, monkeypatch):
    from urllib.parse import quote
    from app.agy import media

    agy_root = tmp_path / "fake_agy_media"
    conv_id = "conv-media-test"
    brain_dir = agy_root / "brain" / conv_id
    logs_dir = brain_dir / ".system_generated" / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)

    sticker_dir = tmp_path / "stickers"
    sticker_dir.mkdir(parents=True, exist_ok=True)
    sticker_file = sticker_dir / "10_流口水_🤤.png"
    sticker_file.write_bytes(b"pngdata")

    shot = brain_dir / "用户截图.png"
    shot.write_bytes(b"shotdata")
    artifact = brain_dir / "产物图.png"
    artifact.write_bytes(b"artifactdata")
    notes = brain_dir / "notes.md"
    notes.write_text("line1\nline2\n", encoding="utf-8")

    monkeypatch.setattr(local_sync, "get_default_antigravity_roots", lambda: [agy_root])
    monkeypatch.setattr(local_sync, "get_allowed_media_roots", lambda: [agy_root / "brain", sticker_dir])
    monkeypatch.setattr(local_sync, "load_sticker_map", lambda: {"流口水": sticker_file})
    monkeypatch.setattr(media, "get_allowed_media_roots", lambda: [agy_root / "brain", sticker_dir])

    t_path = logs_dir / "transcript.jsonl"
    lines = [
        {
            "step_index": 0,
            "type": "USER_INPUT",
            "created_at": "2026-11-24T08:00:00Z",
            "content": "<USER_REQUEST>\n看下这张图 :流口水:\n</USER_REQUEST>",
            "media": [
                {"uri": shot.as_uri(), "mime_type": "image/png"},
                {"uri": str(notes), "mime_type": "text/markdown"},
            ],
        },
        {
            "step_index": 1,
            "type": "PLANNER_RESPONSE",
            "created_at": "2026-11-24T08:00:05Z",
            "content": (
                f"![生成结果]({artifact.as_uri()})\n"
                f"请查看 [notes.md]({notes.as_uri()}#L10-L20) 与 :流口水:\n"
                "代码块内保留 `:流口水:` 不替换。\n"
                "```\n:流口水:\n```"
            ),
        },
    ]
    t_path.write_text("\n".join(json.dumps(x, ensure_ascii=False) for x in lines) + "\n", encoding="utf-8")

    aligned = local_sync.align_local_sessions({})
    assert aligned["items"][0]["fingerprint"].startswith("v3:")

    pulled = local_sync.pull_local_sessions([conv_id], {})
    msgs = pulled["synced_sessions"][0]["messages"]
    assert len(msgs) == 2

    user_content = msgs[0]["content"]
    assert f"![附件图片](/api/media?path={quote(str(shot.resolve()), safe='')})" in user_content
    assert f"[notes.md](/api/media?path={quote(str(notes.resolve()), safe='')}&download=1)" in user_content
    assert f"![agy-meme · 流口水](/api/media?path={quote(str(sticker_file.resolve()), safe='')})" in user_content

    ai_content = msgs[1]["content"]
    assert f"![生成结果](/api/media?path={quote(str(artifact.resolve()), safe='')})" in ai_content
    assert f"[notes.md#L10-L20](/api/media?path={quote(str(notes.resolve()), safe='')}&download=1)" in ai_content
    assert f"![agy-meme · 流口水](/api/media?path={quote(str(sticker_file.resolve()), safe='')})" in ai_content
    assert "`:流口水:`" in ai_content
    assert "```\n:流口水:\n```" in ai_content


def test_parse_agentapi_system_message_and_filter_noise(isolated_env: Path, tmp_path: Path):
    logs_dir = tmp_path / "brain" / "conv-sys" / ".system_generated" / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    t_path = logs_dir / "transcript.jsonl"
    f_path = logs_dir / "transcript_full.jsonl"

    lines = [
        {
            "step_index": 0,
            "type": "USER_INPUT",
            "created_at": "2026-11-25T10:00:00Z",
            "content": "<USER_REQUEST>\n第一轮消息\n</USER_REQUEST>",
        },
        {
            "step_index": 1,
            "type": "PLANNER_RESPONSE",
            "created_at": "2026-11-25T10:00:02Z",
            "content": "收到第一轮",
        },
        # Internal noise 1: Reminder
        {
            "step_index": 2,
            "type": "SYSTEM_MESSAGE",
            "created_at": "2026-11-25T10:00:03Z",
            "content": "<SYSTEM_MESSAGE>\nReminder: work efficiently.\n</SYSTEM_MESSAGE>",
        },
        # Internal noise 2: Subagent message (sender != system)
        {
            "step_index": 3,
            "type": "SYSTEM_MESSAGE",
            "created_at": "2026-11-25T10:00:04Z",
            "content": "<SYSTEM_MESSAGE>\n[Message] timestamp=1 sender=abc/task-6 priority=MESSAGE_PRIORITY_HIGH content=subagent done\n</SYSTEM_MESSAGE>",
        },
        # Internal noise 3: Low priority or [Notice
        {
            "step_index": 4,
            "type": "SYSTEM_MESSAGE",
            "created_at": "2026-11-25T10:00:05Z",
            "content": "<SYSTEM_MESSAGE>\n[Message] timestamp=2 sender=system priority=MESSAGE_PRIORITY_LOW content=low notice\n</SYSTEM_MESSAGE>",
        },
        {
            "step_index": 5,
            "type": "SYSTEM_MESSAGE",
            "created_at": "2026-11-25T10:00:06Z",
            "content": "<SYSTEM_MESSAGE>\n[Message] timestamp=3 sender=system priority=MESSAGE_PRIORITY_HIGH content=[Notice: tool finished]\n</SYSTEM_MESSAGE>",
        },
        # Valid multi-line user follow-up via agentapi send-message (truncated in transcript.jsonl)
        {
            "step_index": 6,
            "type": "SYSTEM_MESSAGE",
            "created_at": "2026-11-25T10:01:00Z",
            "content": "truncated...",
            "truncated_fields": ["content"],
        },
        {
            "step_index": 7,
            "type": "PLANNER_RESPONSE",
            "created_at": "2026-11-25T10:01:05Z",
            "content": "第二轮回复完成",
        },
    ]
    full_lines = [
        {
            "step_index": 6,
            "type": "SYSTEM_MESSAGE",
            "created_at": "2026-11-25T10:01:00Z",
            "content": (
                "The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n"
                "<SYSTEM_MESSAGE>\n"
                "[Message] timestamp=2026-11-25T10:01:00Z sender=system priority=MESSAGE_PRIORITY_HIGH "
                "content=第二轮手机发来的消息\n包含第二行正文\n"
                "</SYSTEM_MESSAGE>"
            ),
        }
    ]
    t_path.write_text("\n".join(json.dumps(x, ensure_ascii=False) for x in lines) + "\n", encoding="utf-8")
    f_path.write_text("\n".join(json.dumps(x, ensure_ascii=False) for x in full_lines) + "\n", encoding="utf-8")

    msgs = local_sync.parse_transcript_messages(t_path, f_path)
    assert len(msgs) == 4
    assert [m.role for m in msgs] == ["user", "assistant", "user", "assistant"]
    assert msgs[0].content == "第一轮消息"
    assert msgs[1].content == "收到第一轮"
    assert msgs[2].id == "agy-su-6"
    assert msgs[2].content == "第二轮手机发来的消息\n包含第二行正文"
    assert msgs[3].content == "第二轮回复完成"
