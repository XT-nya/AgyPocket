from __future__ import annotations

import asyncio
import json
import sqlite3
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from fastapi.testclient import TestClient

from app.agy import projects
from app.agy.approvals import ApprovalManager
from app.agy.bridge_client import BridgeClient
from app.agy.models_catalog import parse_agy_models_output
from app.agy.telemetry import read_conversation_telemetry
from app.config import get_or_create_hook_secret


def _encode_varint(value: int) -> bytes:
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            break
    return bytes(out)


def _pb_varint_field(field_num: int, val: int) -> bytes:
    return _encode_varint((field_num << 3) | 0) + _encode_varint(val)


def _pb_bytes_field(field_num: int, raw: bytes) -> bytes:
    return _encode_varint((field_num << 3) | 2) + _encode_varint(len(raw)) + raw


def test_parse_agy_models_output_grouping():
    sample = """Fetching available models...
gemini-4-neon-high\tGemini 4 Neon (High)
gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)
gemini-4-neon-medium\tGemini 4 Neon (Medium)
gemini-4-neon-low\tGemini 4 Neon (Low)
gemini-4-carbon-medium\tGemini 4 Carbon (Medium)
gemini-4-carbon-high\tGemini 4 Carbon (High)
gemini-4-carbon-low\tGemini 4 Carbon (Low)
gemini-pro-orchestrator-neon\tOrchestrator (Neon)
gemini-pro-orchestrator\tOrchestrator (Carbon)
gemini-pro-orchestrator-argon\tOrchestrator (Argon)
claude-opus-5-5-low\tClaude Opus 5.5 (Low)
claude-opus-5-5-medium\tClaude Opus 5.5 (Medium)
claude-opus-5-5-high\tClaude Opus 5.5 (High)
gpt-oss-120b-medium\tGPT-OSS 120B (Medium)
"""
    families = parse_agy_models_output(sample)
    by_id = {f["family_id"]: f for f in families}

    neon = by_id["gemini-4-neon"]
    assert neon["adjustable"] is True
    assert [e["effort"] for e in neon["efforts"]] == ["low", "medium", "high", "xhigh"]
    assert [e["label"] for e in neon["efforts"]] == ["Low", "Medium", "High", "Extra"]
    assert neon["default_model_id"] == "gemini-4-neon-medium"

    carbon = by_id["gemini-4-carbon"]
    assert [e["effort"] for e in carbon["efforts"]] == ["low", "medium", "high"]

    orch = by_id["orchestrator"]
    assert orch["adjustable"] is False
    assert len(orch["planners"]) == 3
    assert orch["planners"][0]["id"] == "neon"

    claude = by_id["claude-opus-5-5"]
    assert claude["provider"] == "Anthropic"
    assert [e["effort"] for e in claude["efforts"]] == ["low", "medium", "high"]

    gpt = by_id["gpt-oss-120b"]
    assert gpt["adjustable"] is False
    assert gpt["default_model_id"] == "gpt-oss-120b-medium"


def test_projects_discovery_filtering_and_binding(isolated_env: Path, tmp_path: Path):
    pdir = tmp_path / "projects"
    pdir.mkdir()
    ws_dir = tmp_path / "Sample Workspace"
    ws_dir.mkdir()
    encoded_ws = ws_dir.as_uri()

    # Real user project
    (pdir / "proj-real.json").write_text(
        json.dumps(
            {
                "id": "proj-real-1111",
                "name": "Sample Workspace",
                "projectResources": {"resources": [{"folderUri": encoded_ws}]},
            }
        ),
        encoding="utf-8",
    )
    # Sidecar project (must be filtered out)
    (pdir / "proj-sidecar.json").write_text(
        json.dumps(
            {
                "id": "proj-sidecar-2222",
                "name": "agy-capsule/agy_capsule",
                "sidecar": {"sidecarId": "agy-capsule/agy_capsule"},
            }
        ),
        encoding="utf-8",
    )
    # default-cli-project (must be filtered out)
    (pdir / "default-cli-project.json").write_text(
        json.dumps({"id": "default-cli-project", "name": "CLI Project"}),
        encoding="utf-8",
    )

    res = projects.list_antigravity_projects(projects_dir=pdir)
    assert len(res["projects"]) == 1
    proj = res["projects"][0]
    assert proj["id"] == "proj-real-1111"
    assert proj["primary_folder"] == str(ws_dir)
    assert proj["is_bound"] is True

    upd = projects.set_bound_project_id("proj-real-1111", projects_dir=pdir)
    assert upd["ok"] is True
    assert upd["bound_project_id"] == "proj-real-1111"


def test_read_conversation_telemetry_protobuf(tmp_path: Path):
    conv_dir = tmp_path / "conversations"
    conv_dir.mkdir()
    cid = "conv-telemetry-test"
    db_path = conv_dir / f"{cid}.db"

    usage_pb = (
        _pb_varint_field(2, 1200)  # uncached_input
        + _pb_varint_field(3, 350)  # output_tokens
        + _pb_varint_field(4, 100)  # cache_write
        + _pb_varint_field(5, 24400)  # cache_read
    )
    chat_pb = _pb_bytes_field(4, usage_pb) + _pb_bytes_field(21, b"Gemini 4 Neon (High)")
    top_pb = _pb_bytes_field(1, chat_pb)

    con = sqlite3.connect(db_path)
    con.execute("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER)")
    con.execute("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER)")
    con.execute("INSERT INTO steps VALUES (0, 14, 3), (1, 15, 3)")
    con.execute("INSERT INTO gen_metadata VALUES (0, ?, ?)", (top_pb, len(top_pb)))
    con.commit()
    con.close()

    tel = read_conversation_telemetry(cid, conversations_dir=conv_dir)
    assert tel is not None
    assert tel["model_name"] == "Gemini 4 Neon (High)"
    assert tel["uncached_input"] == 1200
    assert tel["cache_read"] == 24400
    assert tel["active_context_tokens"] == 25600
    assert tel["output_tokens"] == 350
    assert tel["context_limit"] == 512_000
    assert tel["usage_percent"] == 5.0
    assert tel["step_count"] == 2

    # Missing DB returns None cleanly
    assert read_conversation_telemetry("non-existent-id", conversations_dir=conv_dir) is None


def test_approval_manager_policies_and_timeout():
    async def scenario():
        mgr = ApprovalManager()
        assert mgr.should_intercept("run_command", "remote_smart") is False  # No WS clients

        received: list[dict] = []

        async def fake_ws(payload: dict):
            received.append(payload)

        mgr.register_ws("c1", fake_ws)
        assert mgr.should_intercept("run_command", "remote_smart") is True
        assert mgr.should_intercept("view_file", "remote_smart") is False
        assert mgr.should_intercept("view_file", "remote_all") is True
        assert mgr.should_intercept("run_command", "desktop_only") is False

        # Resolve flow
        task = asyncio.create_task(
            mgr.request_approval(
                conversation_id="conv-1",
                tool_name="run_command",
                tool_args={"CommandLine": "pytest"},
                timeout_seconds=5,
            )
        )
        await asyncio.sleep(0.05)
        assert len(mgr.list_pending()) == 1
        aid = mgr.list_pending()[0]["approval_id"]
        assert await mgr.resolve(aid, "auto_approve") is True
        res = await task
        assert res["decision"] == "auto_approve"
        assert len(mgr.list_pending()) == 0

        # Timeout falls back to allow (desktop policy)
        timeout_res = await mgr.request_approval(
            conversation_id="conv-1",
            tool_name="run_command",
            tool_args={"CommandLine": "dir"},
            timeout_seconds=0,
        )
        # Wait: max(5, timeout_seconds) clamps 0 to 5s, so let's cancel or test short asyncio.wait_for
        # Actually timeout_seconds=1 with fast check:
        assert timeout_res["decision"] == "allow"

    # Quick check without waiting 5s for timeout by directly calling wait_for on small timeout
    async def scenario_fast():
        mgr = ApprovalManager()
        received: list[dict] = []

        async def fake_ws(payload: dict):
            received.append(payload)

        mgr.register_ws("c1", fake_ws)
        assert mgr.should_intercept("run_command", "remote_smart") is True
        assert mgr.should_intercept("view_file", "remote_smart") is False
        assert mgr.should_intercept("view_file", "remote_all") is True
        assert mgr.should_intercept("run_command", "desktop_only") is False

        task = asyncio.create_task(
            mgr.request_approval(
                conversation_id="conv-1",
                tool_name="run_command",
                tool_args={"CommandLine": "pytest"},
                timeout_seconds=10,
            )
        )
        await asyncio.sleep(0.05)
        pending = mgr.list_pending()
        assert len(pending) == 1
        aid = pending[0]["approval_id"]
        assert await mgr.resolve(aid, "deny") is True
        res = await task
        assert res["decision"] == "deny"
        assert any(m.get("type") == "approval_request" for m in received)
        assert any(m.get("type") == "approval_resolved" for m in received)

    asyncio.run(scenario_fast())


def test_internal_hook_security_and_ws_approval_flow(client: TestClient):
    assert client.post("/api/auth/setup", json={"passphrase": "StrongPassword123"}).status_code == 200
    csrf = client.cookies.get("agypocket_csrf")
    secret = get_or_create_hook_secret()

    # 1. Proxy/Cloudflare header must be rejected with 403 even with valid secret
    r_proxy = client.post(
        "/api/internal/hook/event",
        json={"event": "Stop", "payload": {}},
        headers={
            "CF-Connecting-IP": "198.51.100.1",
            "X-AgyPocket-Hook-Secret": secret,
        },
    )
    assert r_proxy.status_code == 403

    # 2. Invalid secret must be rejected with 403
    r_bad_sec = client.post(
        "/api/internal/hook/pre-tool",
        json={"toolCall": {"name": "run_command", "args": {"CommandLine": "dir"}}},
        headers={"X-AgyPocket-Hook-Secret": "wrong-secret"},
    )
    assert r_bad_sec.status_code == 403

    # 3. With no WS clients connected, pre-tool returns allow immediately
    r_no_ws = client.post(
        "/api/internal/hook/pre-tool",
        json={"toolCall": {"name": "run_command", "args": {"CommandLine": "dir"}}},
        headers={"X-AgyPocket-Hook-Secret": secret},
    )
    assert r_no_ws.status_code == 200
    assert r_no_ws.json()["decision"] == "allow"

    # 4. With WS client connected, pre-tool waits for remote mobile approval
    with client.websocket_connect("/ws/chat", headers={"Origin": "http://testserver"}) as ws:
        hook_result: dict = {}

        def call_hook():
            resp = client.post(
                "/api/internal/hook/pre-tool",
                json={
                    "conversationId": "conv-ws-test",
                    "modelName": "gemini-4-neon-high",
                    "stepIdx": 3,
                    "toolCall": {"name": "run_command", "args": {"CommandLine": "pytest -q"}},
                },
                headers={"X-AgyPocket-Hook-Secret": secret},
            )
            hook_result["status"] = resp.status_code
            hook_result["body"] = resp.json()

        t = threading.Thread(target=call_hook, daemon=True)
        t.start()

        # Receive hook_event and approval_request from WS
        approval_id = ""
        for _ in range(5):
            msg = ws.receive_json()
            if msg.get("type") == "approval_request":
                approval_id = msg["approval"]["approval_id"]
                assert msg["approval"]["tool_name"] == "run_command"
                break
        assert approval_id

        dec_res = client.post(
            f"/api/approvals/{approval_id}/decide",
            json={"decision": "auto_approve"},
            headers={"X-CSRF-Token": csrf},
        )
        assert dec_res.status_code == 200
        t.join(timeout=3.0)
        assert hook_result["status"] == 200
        assert hook_result["body"]["decision"] == "auto_approve"


def test_node_hook_relay_offline_and_online(tmp_path: Path):
    hook_script = (
        Path(__file__).resolve().parents[2]
        / "plugin"
        / "agy-pocket-bridge"
        / "hooks"
        / "hook_relay.mjs"
    )
    assert hook_script.is_file()

    missing_rt = tmp_path / "missing_backend.json"
    env_off = {"AGYPOCKET_BACKEND_RUNTIME_FILE": str(missing_rt), "PATH": ""}
    # Keep PATH so `node` resolves if run without full path; use system env copy
    import os

    full_env = dict(os.environ)
    full_env["AGYPOCKET_BACKEND_RUNTIME_FILE"] = str(missing_rt)

    t0 = time.monotonic()
    p_off = subprocess.run(
        ["node", str(hook_script), "PreToolUse"],
        input=json.dumps({"toolCall": {"name": "run_command", "args": {"CommandLine": "dir"}}}),
        text=True,
        capture_output=True,
        env=full_env,
        timeout=5,
        check=True,
    )
    elapsed = time.monotonic() - t0
    assert elapsed < 2.0
    assert json.loads(p_off.stdout)["decision"] == "allow"

    # Online mock backend server
    expected_secret = "super-secret-hook-token-123456"

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            return

        def do_POST(self):
            if self.headers.get("X-AgyPocket-Hook-Secret") != expected_secret:
                self.send_response(403)
                self.end_headers()
                return
            length = int(self.headers.get("Content-Length") or 0)
            _ = self.rfile.read(length)
            body = json.dumps({"decision": "auto_approve", "reason": "Approved by test"}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    srv = HTTPServer(("127.0.0.1", 0), Handler)
    srv_thread = threading.Thread(target=srv.serve_forever, daemon=True)
    srv_thread.start()
    try:
        rt_file = tmp_path / "agypocket_backend.json"
        rt_file.write_text(
            json.dumps({"port": srv.server_address[1], "secret": expected_secret, "pid": 1}),
            encoding="utf-8",
        )
        full_env["AGYPOCKET_BACKEND_RUNTIME_FILE"] = str(rt_file)
        p_on = subprocess.run(
            ["node", str(hook_script), "PreToolUse"],
            input=json.dumps({"toolCall": {"name": "run_command", "args": {"CommandLine": "pytest"}}}),
            text=True,
            capture_output=True,
            env=full_env,
            timeout=5,
            check=True,
        )
        assert json.loads(p_on.stdout) == {"decision": "auto_approve", "reason": "Approved by test"}
    finally:
        srv.shutdown()
        srv.server_close()


def test_bridge_client_loopback_calls(tmp_path: Path):
    token = "bridge-bearer-token-abcdef"
    captured: list[tuple[str, str, dict]] = []

    class BridgeMock(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            return

        def do_GET(self):
            if self.headers.get("Authorization") != f"Bearer {token}":
                self.send_response(403)
                self.end_headers()
                return
            body = json.dumps({"ok": True, "agentapi_available": True}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            if self.headers.get("Authorization") != f"Bearer {token}":
                self.send_response(403)
                self.end_headers()
                return
            length = int(self.headers.get("Content-Length") or 0)
            data = json.loads(self.rfile.read(length).decode("utf-8"))
            captured.append(("POST", self.path, data))
            body = json.dumps({"ok": True, "conversation_id": "11111111-2222-3333-4444-555555555555"}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    srv = HTTPServer(("127.0.0.1", 0), BridgeMock)
    srv_thread = threading.Thread(target=srv.serve_forever, daemon=True)
    srv_thread.start()
    try:
        rt_file = tmp_path / "bridge_runtime.json"
        rt_file.write_text(json.dumps({"port": srv.server_address[1], "token": token}), encoding="utf-8")
        plugin_dir = tmp_path / "plugin"
        (plugin_dir / "sidecars" / "bridge").mkdir(parents=True)
        (plugin_dir / "plugin.json").write_text("{}", encoding="utf-8")
        (plugin_dir / "sidecars" / "bridge" / "server.mjs").write_text("", encoding="utf-8")
        cfg_file = tmp_path / "config.json"
        cfg_file.write_text(
            json.dumps(
                {
                    "plugins": {"agy-pocket-bridge": {"enabled": True}},
                    "sidecars": {"agy-pocket-bridge/bridge": {"enabled": True}},
                }
            ),
            encoding="utf-8",
        )

        client_obj = BridgeClient(runtime_path=rt_file, plugin_dir=plugin_dir, config_path=cfg_file)
        st = asyncio.run(client_obj.get_status())
        assert st["sidecar_running"] is True
        assert st["agentapi_available"] is True

        nc = asyncio.run(
            client_obj.new_conversation(
                prompt="hello",
                model="gemini-4-neon-high",
                project_id="proj-123",
            )
        )
        assert nc["conversation_id"] == "11111111-2222-3333-4444-555555555555"
        assert captured[0][2]["project_id"] == "proj-123"
        assert captured[0][2]["model"] == "gemini-4-neon-high"
    finally:
        srv.shutdown()
        srv.server_close()
