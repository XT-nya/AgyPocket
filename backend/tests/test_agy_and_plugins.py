from __future__ import annotations

import json

from fastapi.testclient import TestClient

from app.agy.permissions import get_permission_flags, list_permission_specs
from app.agy.runner import (
    build_agy_command,
    build_agy_subprocess_env,
    parse_agy_stream_line,
    parse_windows_proxy_server,
)


def test_four_tier_permission_mapping():
    specs = {item["id"]: item for item in list_permission_specs()}
    assert set(specs.keys()) == {"auto", "full", "controlled", "readonly"}
    assert get_permission_flags("auto") == ["--mode", "auto"]
    assert get_permission_flags("full") == ["--dangerously-skip-permissions"]
    assert get_permission_flags("controlled") == ["--mode", "accept-edits"]
    assert get_permission_flags("readonly") == ["--mode", "plan", "--sandbox"]


def test_build_agy_command():
    cmd = build_agy_command(
        agy_bin="agy.exe",
        prompt="hello",
        permission_mode="auto",
        conversation_id="conv-123",
        model="gemini-4-flash",
    )
    assert cmd == [
        "agy.exe",
        "-p",
        "hello",
        "--output-format",
        "stream-json",
        "--mode",
        "auto",
        "--conversation",
        "conv-123",
        "--model",
        "gemini-4-flash",
    ]


def test_stream_json_parser_variants():
    # Thought delta
    evs = parse_agy_stream_line(
        json.dumps({"type": "content_block_delta", "delta": {"type": "thinking_delta", "thinking": "step 1"}})
    )
    assert evs == [{"type": "thought_delta", "text": "step 1"}]

    # Assistant message with tool_use & text & session_id
    evs2 = parse_agy_stream_line(
        json.dumps(
            {
                "type": "assistant",
                "session_id": "s-999",
                "message": {
                    "content": [
                        {"type": "tool_use", "id": "t1", "name": "run_command", "input": {"cmd": "dir"}},
                        {"type": "text", "text": "Done."},
                    ]
                },
            }
        )
    )
    assert any(e["type"] == "session_meta" and e["agy_conversation_id"] == "s-999" for e in evs2)
    assert any(e["type"] == "tool_start" and e["name"] == "run_command" for e in evs2)
    assert any(e["type"] == "token_delta" and e["text"] == "Done." for e in evs2)

    # Unauthenticated CLI message triggers auth-guide card
    evs3 = parse_agy_stream_line("Error: Please sign in to view available models.")
    assert len(evs3) == 1
    assert evs3[0]["type"] == "card_emit"
    assert evs3[0]["card"]["cardType"] == "core.auth-guide"


def test_plugin_contributions_and_actions(client: TestClient):
    client.post("/api/auth/setup", json={"passphrase": "StrongPassword123"})
    csrf = client.cookies.get("agypocket_csrf")

    res = client.get("/api/plugins/contributions")
    assert res.status_code == 200
    body = res.json()
    plugin_ids = {p["id"] for p in body["plugins"]}
    assert {"core.capsule", "core.toolbar", "core.cards"}.issubset(plugin_ids)
    assert body["slots"]["bottom-capsule"]["permission_mode"] == "auto"

    act = client.post(
        "/api/plugins/core.toolbar/action",
        json={"action_id": "system.snapshot_card", "payload": {}},
        headers={"X-CSRF-Token": csrf},
    )
    assert act.status_code == 200
    assert act.json()["emit_card"]["cardType"] == "core.system-mini"


def test_windows_proxy_parser_and_env_injection():
    assert parse_windows_proxy_server("127.0.0.1:47891") == "http://127.0.0.1:47891"
    assert parse_windows_proxy_server("socks5://127.0.0.1:1080") == "socks5://127.0.0.1:1080"
    assert (
        parse_windows_proxy_server("http=127.0.0.1:7890;https=127.0.0.1:7891")
        == "http://127.0.0.1:7891"
    )
    assert parse_windows_proxy_server("socks=127.0.0.1:1080") == "socks5://127.0.0.1:1080"
    assert parse_windows_proxy_server("") == ""

    env_injected = build_agy_subprocess_env(base_env={"PATH": "C:\\Windows"}, detected_proxy="http://127.0.0.1:47891")
    assert env_injected["HTTP_PROXY"] == "http://127.0.0.1:47891"
    assert env_injected["HTTPS_PROXY"] == "http://127.0.0.1:47891"
    assert "127.0.0.1" in env_injected["NO_PROXY"]

    # Explicit user env proxy is preserved without overwriting
    env_preserved = build_agy_subprocess_env(
        base_env={"HTTPS_PROXY": "http://127.0.0.1:9999", "NO_PROXY": "10.0.0.1"},
        detected_proxy="http://127.0.0.1:47891",
    )
    assert env_preserved["HTTPS_PROXY"] == "http://127.0.0.1:9999"
    assert "10.0.0.1" in env_preserved["NO_PROXY"]
    assert "127.0.0.1" in env_preserved["NO_PROXY"]
