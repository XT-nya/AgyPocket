"""Official agy CLI subprocess runner and NDJSON stream parser."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable

from app.agy.permissions import get_permission_flags
from app.agy.sessions import ChatMessage, session_store
from app.config import PermissionTier, find_agy_binary, get_data_dir, load_settings

AUTH_ERROR_HINTS = (
    "please sign in",
    "launch the cli without arguments to sign in",
    "authentication required",
    "not signed in",
    "login required",
)


def is_auth_error_text(text: str) -> bool:
    lower = (text or "").lower()
    return any(hint in lower for hint in AUTH_ERROR_HINTS)


def parse_windows_proxy_server(raw: str) -> str:
    """Normalize WinINET ProxyServer string into an HTTP/SOCKS proxy URL."""
    val = (raw or "").strip()
    if not val:
        return ""
    if "://" in val and "=" not in val:
        return val
    if "=" in val:
        mapping: dict[str, str] = {}
        for part in val.split(";"):
            if "=" not in part:
                continue
            scheme, addr = part.split("=", 1)
            scheme_l = scheme.strip().lower()
            addr_s = addr.strip()
            if scheme_l and addr_s:
                mapping[scheme_l] = addr_s
        for key in ("https", "http", "socks"):
            if key in mapping:
                target = mapping[key]
                if "://" in target:
                    return target
                prefix = "socks5://" if key == "socks" else "http://"
                return f"{prefix}{target}"
        return ""
    return f"http://{val}"


def detect_windows_system_proxy() -> str:
    """Read active HKCU Windows system proxy if ProxyEnable == 1."""
    if os.name != "nt":
        return ""
    try:
        import winreg

        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Internet Settings",
        ) as key:
            enabled, _ = winreg.QueryValueEx(key, "ProxyEnable")
            if int(enabled) != 1:
                return ""
            server, _ = winreg.QueryValueEx(key, "ProxyServer")
            return parse_windows_proxy_server(str(server))
    except Exception:
        return ""


def build_agy_subprocess_env(
    base_env: dict[str, str] | None = None,
    detected_proxy: str | None = None,
) -> dict[str, str]:
    """Ensure Go-based agy CLI subprocesses inherit Windows system proxy settings."""
    env = dict(base_env if base_env is not None else os.environ)
    has_proxy = any(
        bool(env.get(k, "").strip())
        for k in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy")
    )
    if not has_proxy:
        proxy = detected_proxy if detected_proxy is not None else detect_windows_system_proxy()
        if proxy:
            env["HTTP_PROXY"] = proxy
            env["HTTPS_PROXY"] = proxy
            env["http_proxy"] = proxy
            env["https_proxy"] = proxy

    existing_no_proxy = env.get("NO_PROXY") or env.get("no_proxy") or ""
    parts = [p.strip() for p in existing_no_proxy.split(",") if p.strip()]
    for local_item in ("127.0.0.1", "localhost", "::1"):
        if local_item not in parts:
            parts.append(local_item)
    joined = ",".join(parts)
    env["NO_PROXY"] = joined
    env["no_proxy"] = joined
    return env


def build_agy_command(
    agy_bin: str,
    prompt: str,
    permission_mode: PermissionTier,
    conversation_id: str = "",
    model: str = "",
) -> list[str]:
    cmd = [agy_bin, "-p", prompt, "--output-format", "stream-json"]
    cmd.extend(get_permission_flags(permission_mode))
    if conversation_id:
        cmd.extend(["--conversation", conversation_id])
    if model:
        cmd.extend(["--model", model])
    return cmd


def _extract_text_blocks(content: Any) -> tuple[list[str], list[str], list[dict[str, Any]]]:
    texts: list[str] = []
    thoughts: list[str] = []
    tools: list[dict[str, Any]] = []
    if isinstance(content, str):
        if content:
            texts.append(content)
        return texts, thoughts, tools
    if isinstance(content, list):
        for block in content:
            if not isinstance(block, dict):
                continue
            btype = block.get("type", "")
            if btype in {"text", "output_text"} and block.get("text"):
                texts.append(str(block["text"]))
            elif btype in {"thinking", "thought", "reasoning"}:
                val = block.get("thinking") or block.get("text") or ""
                if val:
                    thoughts.append(str(val))
            elif btype == "tool_use":
                tools.append(
                    {
                        "tool_id": str(block.get("id") or uuid.uuid4().hex[:8]),
                        "name": str(block.get("name") or "tool"),
                        "args": block.get("input") or block.get("args") or {},
                    }
                )
            elif btype == "tool_result":
                tools.append(
                    {
                        "result_for": str(block.get("tool_use_id") or block.get("id") or ""),
                        "output": block.get("content") or block.get("output") or "",
                        "is_error": bool(block.get("is_error", False)),
                    }
                )
    return texts, thoughts, tools


def parse_agy_stream_line(raw_line: str) -> list[dict[str, Any]]:
    """Parse one stdout line from `agy --output-format stream-json` into normalized events."""
    line = (raw_line or "").strip()
    if not line:
        return []

    if is_auth_error_text(line):
        return [
            {
                "type": "card_emit",
                "card": {
                    "cardType": "core.auth-guide",
                    "id": f"auth-{uuid.uuid4().hex[:6]}",
                    "data": {
                        "title": "需要在电脑端完成一次 agy 登录授权",
                        "message": line,
                        "command": "agy",
                    },
                },
            }
        ]

    if not line.startswith("{"):
        return [{"type": "token_delta", "text": line + "\n"}]

    try:
        obj = json.loads(line)
    except json.JSONDecodeError:
        return [{"type": "token_delta", "text": line + "\n"}]

    if not isinstance(obj, dict):
        return []

    events: list[dict[str, Any]] = []
    conv_id = obj.get("conversation_id") or obj.get("session_id") or obj.get("conversationId")
    if conv_id:
        events.append({"type": "session_meta", "agy_conversation_id": str(conv_id)})

    ev_type = str(obj.get("type") or "").lower()

    if ev_type in {"error", "fatal"}:
        err_msg = str(obj.get("message") or obj.get("error") or line)
        if is_auth_error_text(err_msg):
            events.append(
                {
                    "type": "card_emit",
                    "card": {
                        "cardType": "core.auth-guide",
                        "id": f"auth-{uuid.uuid4().hex[:6]}",
                        "data": {
                            "title": "需要在电脑端完成一次 agy 登录授权",
                            "message": err_msg,
                            "command": "agy",
                        },
                    },
                }
            )
        else:
            events.append({"type": "run_error", "message": err_msg})
        return events

    if ev_type in {"content_block_delta", "stream_event", "delta"}:
        delta = obj.get("delta") if isinstance(obj.get("delta"), dict) else obj
        dtype = str(delta.get("type") or "").lower()
        if dtype in {"thinking_delta", "thought_delta"} or delta.get("thinking"):
            t = str(delta.get("thinking") or delta.get("text") or "")
            if t:
                events.append({"type": "thought_delta", "text": t})
        elif delta.get("text") or delta.get("token"):
            events.append({"type": "token_delta", "text": str(delta.get("text") or delta.get("token"))})
        return events

    if ev_type in {"thought", "thinking"}:
        t = str(obj.get("text") or obj.get("thinking") or obj.get("content") or "")
        if t:
            events.append({"type": "thought_delta", "text": t})
        return events

    if ev_type == "tool_use":
        events.append(
            {
                "type": "tool_start",
                "tool_id": str(obj.get("id") or obj.get("tool_id") or uuid.uuid4().hex[:8]),
                "name": str(obj.get("name") or obj.get("tool") or "tool"),
                "args": obj.get("input") or obj.get("args") or {},
            }
        )
        return events

    if ev_type == "tool_result":
        events.append(
            {
                "type": "tool_result",
                "tool_id": str(obj.get("tool_use_id") or obj.get("id") or ""),
                "output": obj.get("content") or obj.get("output") or "",
                "is_error": bool(obj.get("is_error", False)),
            }
        )
        return events

    if ev_type in {"assistant", "message"}:
        msg_obj = obj.get("message") if isinstance(obj.get("message"), dict) else obj
        texts, thoughts, tools = _extract_text_blocks(msg_obj.get("content"))
        for th in thoughts:
            events.append({"type": "thought_delta", "text": th})
        for tx in texts:
            events.append({"type": "token_delta", "text": tx})
        for tl in tools:
            if "result_for" in tl:
                events.append(
                    {
                        "type": "tool_result",
                        "tool_id": tl["result_for"],
                        "output": tl["output"],
                        "is_error": tl["is_error"],
                    }
                )
            else:
                events.append({"type": "tool_start", **tl})
        usage = obj.get("usage") or msg_obj.get("usage")
        if isinstance(usage, dict):
            events.append({"type": "usage_update", "usage": usage})
        return events

    if ev_type == "result":
        usage = obj.get("usage")
        if isinstance(usage, dict):
            events.append({"type": "usage_update", "usage": usage})
        res_text = obj.get("result")
        if isinstance(res_text, str) and res_text:
            events.append({"type": "final_result_text", "text": res_text})
        if obj.get("is_error") and res_text:
            if is_auth_error_text(res_text):
                events.append(
                    {
                        "type": "card_emit",
                        "card": {
                            "cardType": "core.auth-guide",
                            "id": f"auth-{uuid.uuid4().hex[:6]}",
                            "data": {
                                "title": "需要在电脑端完成一次 agy 登录授权",
                                "message": res_text,
                                "command": "agy",
                            },
                        },
                    }
                )
            else:
                events.append({"type": "run_error", "message": res_text})
        return events

    # Generic fallback for unknown JSON lines carrying text/delta
    if isinstance(obj.get("text"), str) and obj["text"]:
        events.append({"type": "token_delta", "text": obj["text"]})
    return events


class AgyRunManager:
    """Manages active agy CLI executions and supports instant abort."""

    def __init__(self) -> None:
        self._active_procs: dict[str, asyncio.subprocess.Process] = {}
        self._aborted_sessions: set[str] = set()
        self._lock = asyncio.Lock()

    def is_running(self, session_id: str) -> bool:
        proc = self._active_procs.get(session_id)
        return proc is not None and proc.returncode is None

    def any_running(self) -> bool:
        return any(p.returncode is None for p in self._active_procs.values())

    async def abort(self, session_id: str) -> bool:
        proc = self._active_procs.get(session_id)
        if not proc or proc.returncode is not None:
            return False
        self._aborted_sessions.add(session_id)
        try:
            proc.terminate()
        except Exception:
            pass
        if os.name == "nt" and proc.pid:
            try:
                subprocess.run(
                    ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                    capture_output=True,
                    timeout=3,
                    check=False,
                )
            except Exception:
                pass
        return True

    async def run_turn(
        self,
        session_id: str,
        prompt: str,
        emit: Callable[[dict[str, Any]], Awaitable[None]],
        attach_screenshot_path: str | None = None,
    ) -> None:
        settings = load_settings()
        session = session_store.get_session(session_id)
        if not session:
            session = session_store.create_session()
            session_id = session.id

        if self.is_running(session_id):
            await emit({"type": "run_error", "session_id": session_id, "message": "当前会话仍在运行中，请先等待完成或点击急停。"})
            return

        effective_prompt = prompt.strip()
        if attach_screenshot_path:
            effective_prompt = (
                f"{effective_prompt}\n\n[附带远程电脑当前屏幕截图路径: {attach_screenshot_path}]"
            )

        user_msg = ChatMessage(role="user", content=prompt.strip(), status="done")
        session_store.append_message(session_id, user_msg)

        assistant_msg = ChatMessage(role="assistant", content="", thought="", cards=[], status="streaming")
        session_store.append_message(session_id, assistant_msg)

        agy_bin = find_agy_binary(settings.agy_path)
        if not agy_bin:
            err_card = {
                "cardType": "core.auth-guide",
                "id": f"missing-{uuid.uuid4().hex[:6]}",
                "data": {
                    "title": "未检测到官方 agy CLI",
                    "message": "请确认已运行 `irm https://antigravity.google/cli/install.ps1 | iex` 安装官方 CLI，或在设置中检查路径。",
                    "command": "irm https://antigravity.google/cli/install.ps1 | iex",
                },
            }
            session_store.update_last_assistant_message(
                session_id, assistant_msg.id, "", "", [err_card], "error"
            )
            await emit({"type": "run_start", "session_id": session_id, "message_id": assistant_msg.id})
            await emit({"type": "card_emit", "session_id": session_id, "message_id": assistant_msg.id, "card": err_card})
            await emit({"type": "run_done", "session_id": session_id, "message_id": assistant_msg.id, "status": "error"})
            return

        workspace = session.workspace_dir or settings.workspace_dir
        if not Path(workspace).is_dir():
            workspace = str(Path.cwd())

        perm = session.permission_mode or settings.default_permission_mode
        model = session.model if session.model != "" else settings.model
        cmd = build_agy_command(
            agy_bin=agy_bin,
            prompt=effective_prompt,
            permission_mode=perm,
            conversation_id=session.agy_conversation_id,
            model=model,
        )

        await emit(
            {
                "type": "run_start",
                "session_id": session_id,
                "message_id": assistant_msg.id,
                "permission_mode": perm,
                "model": model or "default",
            }
        )

        content_acc = ""
        thought_acc = ""
        cards_acc: list[dict[str, Any]] = []
        tool_card_index: dict[str, int] = {}
        new_conv_id = session.agy_conversation_id
        final_status = "done"

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                cwd=workspace,
                env=build_agy_subprocess_env(),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            self._active_procs[session_id] = proc
            self._aborted_sessions.discard(session_id)

            async def handle_stream(stream: asyncio.StreamReader | None, is_stderr: bool = False) -> None:
                nonlocal content_acc, thought_acc, new_conv_id, final_status
                if stream is None:
                    return
                while True:
                    raw = await stream.readline()
                    if not raw:
                        break
                    line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
                    if not line:
                        continue
                    if is_stderr:
                        if is_auth_error_text(line):
                            events = parse_agy_stream_line(line)
                        else:
                            events = [{"type": "stderr_note", "text": line}]
                    else:
                        events = parse_agy_stream_line(line)

                    for ev in events:
                        etype = ev["type"]
                        if etype == "session_meta":
                            new_conv_id = ev["agy_conversation_id"]
                        elif etype == "token_delta":
                            content_acc += ev["text"]
                            await emit(
                                {
                                    "type": "token_delta",
                                    "session_id": session_id,
                                    "message_id": assistant_msg.id,
                                    "text": ev["text"],
                                }
                            )
                        elif etype == "final_result_text":
                            if not content_acc.strip():
                                content_acc = ev["text"]
                                await emit(
                                    {
                                        "type": "token_delta",
                                        "session_id": session_id,
                                        "message_id": assistant_msg.id,
                                        "text": ev["text"],
                                    }
                                )
                        elif etype == "thought_delta":
                            thought_acc += ev["text"]
                            await emit(
                                {
                                    "type": "thought_delta",
                                    "session_id": session_id,
                                    "message_id": assistant_msg.id,
                                    "text": ev["text"],
                                }
                            )
                        elif etype == "tool_start":
                            card = {
                                "cardType": "core.tool-call",
                                "id": ev["tool_id"],
                                "data": {
                                    "name": ev["name"],
                                    "args": ev["args"],
                                    "status": "running",
                                    "output": "",
                                },
                            }
                            tool_card_index[ev["tool_id"]] = len(cards_acc)
                            cards_acc.append(card)
                            await emit(
                                {
                                    "type": "card_emit",
                                    "session_id": session_id,
                                    "message_id": assistant_msg.id,
                                    "card": card,
                                }
                            )
                        elif etype == "tool_result":
                            tid = ev["tool_id"]
                            idx = tool_card_index.get(tid)
                            out_val = ev["output"]
                            out_text = out_val if isinstance(out_val, str) else json.dumps(out_val, ensure_ascii=False)
                            status_str = "error" if ev["is_error"] else "done"
                            if idx is not None and idx < len(cards_acc):
                                cards_acc[idx]["data"]["status"] = status_str
                                cards_acc[idx]["data"]["output"] = out_text
                                updated_card = cards_acc[idx]
                            else:
                                updated_card = {
                                    "cardType": "core.tool-call",
                                    "id": tid or uuid.uuid4().hex[:8],
                                    "data": {"name": "tool", "args": {}, "status": status_str, "output": out_text},
                                }
                                cards_acc.append(updated_card)
                            await emit(
                                {
                                    "type": "card_emit",
                                    "session_id": session_id,
                                    "message_id": assistant_msg.id,
                                    "card": updated_card,
                                }
                            )
                        elif etype == "card_emit":
                            cards_acc.append(ev["card"])
                            await emit(
                                {
                                    "type": "card_emit",
                                    "session_id": session_id,
                                    "message_id": assistant_msg.id,
                                    "card": ev["card"],
                                }
                            )
                        elif etype == "usage_update":
                            await emit(
                                {
                                    "type": "usage_update",
                                    "session_id": session_id,
                                    "usage": ev["usage"],
                                }
                            )
                        elif etype == "run_error":
                            final_status = "error"
                            if not content_acc:
                                content_acc = f"执行出错：{ev['message']}"
                            await emit(
                                {
                                    "type": "run_error",
                                    "session_id": session_id,
                                    "message_id": assistant_msg.id,
                                    "message": ev["message"],
                                }
                            )
                        elif etype == "stderr_note":
                            # Keep non-auth stderr notes as subtle diagnostic tail only if run fails
                            thought_acc += f"\n[stderr] {ev['text']}"

            await asyncio.gather(handle_stream(proc.stdout, False), handle_stream(proc.stderr, True))
            rc = await proc.wait()

            if session_id in self._aborted_sessions:
                final_status = "aborted"
            elif rc != 0 and final_status == "done" and not cards_acc:
                final_status = "error"
                if not content_acc:
                    content_acc = f"agy CLI 退出码 {rc}，请展开思考日志查看详情或检查是否已完成首次登录。"
        except Exception as exc:
            final_status = "error"
            content_acc = content_acc or f"启动 agy CLI 失败: {exc}"
            await emit(
                {
                    "type": "run_error",
                    "session_id": session_id,
                    "message_id": assistant_msg.id,
                    "message": str(exc),
                }
            )
        finally:
            self._active_procs.pop(session_id, None)
            self._aborted_sessions.discard(session_id)
            session_store.update_last_assistant_message(
                session_id=session_id,
                msg_id=assistant_msg.id,
                content=content_acc,
                thought=thought_acc,
                cards=cards_acc,
                status=final_status,
                agy_conversation_id=new_conv_id,
            )
            await emit(
                {
                    "type": "run_done",
                    "session_id": session_id,
                    "message_id": assistant_msg.id,
                    "status": final_status,
                    "agy_conversation_id": new_conv_id,
                    "timestamp": time.time(),
                }
            )


agy_run_manager = AgyRunManager()


def get_agy_cli_status() -> dict[str, Any]:
    settings = load_settings()
    bin_path = find_agy_binary(settings.agy_path)
    return {
        "installed": bool(bin_path),
        "path": bin_path or "",
        "running": agy_run_manager.any_running(),
    }
