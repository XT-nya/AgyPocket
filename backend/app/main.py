"""AgyPocket FastAPI gateway entrypoint."""

from __future__ import annotations

import asyncio
import hmac
import json
import mimetypes
import os
import socket
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal
from urllib.parse import quote

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response, WebSocket, WebSocketDisconnect, status
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app.agy.approvals import ApprovalDecision, approval_manager
from app.agy.bridge_client import bridge_client
from app.agy.live_watcher import live_coordinator
from app.agy.local_sync import align_local_sessions, pull_local_sessions
from app.agy.media import FORCE_ATTACHMENT_EXTENSIONS, resolve_allowed_media_path
from app.agy.models_catalog import model_catalog_service
from app.agy.permissions import list_permission_specs
from app.agy.projects import list_antigravity_projects, set_bound_project_id
from app.agy.runner import get_agy_cli_status
from app.agy.sessions import session_store
from app.agy.telemetry import read_conversation_telemetry
from app.config import (
    PROJECT_ROOT,
    ApprovalPolicy,
    ConnectionMode,
    MessageDispatchMode,
    PermissionTier,
    clear_backend_runtime,
    get_or_create_hook_secret,
    load_auth_store,
    load_settings,
    publish_backend_runtime,
    save_auth_store,
    save_settings,
)
from app.desktop.input_ctrl import (
    emergency_esc,
    ensure_dpi_awareness,
    perform_mouse_action,
    send_hotkey,
    type_unicode_text,
)
from app.desktop.power import get_system_telemetry, set_prevent_sleep
from app.desktop.screen import capture_screen_frame, list_monitors, save_scratch_screenshot
from app.desktop.uia import scan_controls
from app.plugins.registry import plugin_registry
from app.security.auth import (
    SESSION_COOKIE_NAME,
    PairingTokenStore,
    clear_session_cookies,
    hash_passphrase,
    is_direct_loopback,
    issue_session_cookies,
    require_authenticated_request,
    revoke_all_sessions,
    verify_passphrase,
    verify_session_token,
    verify_ws_authenticated,
)
from app.security.ratelimit import AuthRateLimiter, extract_client_ip
from app.security.totp import begin_totp_setup, disable_totp, enable_totp, verify_totp_code
from app.tunnel.manager import tunnel_manager

pairing_store = PairingTokenStore()
auth_rate_limiter = AuthRateLimiter(max_failures=5, window_seconds=600, lockout_seconds=900)
FRONTEND_DIST = PROJECT_ROOT / "frontend" / "dist"


@asynccontextmanager
async def lifespan(_app: FastAPI):
    ensure_dpi_awareness()
    settings = load_settings()
    set_prevent_sleep(settings.prevent_sleep)
    publish_backend_runtime(settings.port)
    if not session_store.list_sessions():
        session_store.create_session(title="主工作台")
    yield
    await live_coordinator.stop_all()
    clear_backend_runtime()
    set_prevent_sleep(False)
    await tunnel_manager.stop()


app = FastAPI(title="AgyPocket", version="2.1.0", lifespan=lifespan)


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "camera=(), microphone=()"
    return response


# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------

class SetupAuthReq(BaseModel):
    passphrase: str = Field(min_length=6, max_length=128)


class LoginReq(BaseModel):
    passphrase: str = Field(min_length=1, max_length=128)
    totp_code: str = ""


class TotpCodeReq(BaseModel):
    passphrase: str = Field(min_length=1, max_length=128)
    code: str = Field(min_length=6, max_length=12)


class SettingsPatchReq(BaseModel):
    default_permission_mode: PermissionTier | None = None
    approval_policy: ApprovalPolicy | None = None
    approval_timeout_seconds: int | None = Field(default=None, ge=15, le=115)
    default_project_id: str | None = None
    workspace_dir: str | None = None
    device_name: str | None = None
    connection_mode: ConnectionMode | None = None
    model: str | None = None
    prevent_sleep: bool | None = None
    screen_fps: int | None = Field(default=None, ge=1, le=10)
    screen_quality: int | None = Field(default=None, ge=20, le=95)
    screen_scale: float | None = Field(default=None, ge=0.25, le=1.0)
    tunnel_mode: Literal["quick", "named", "external"] | None = None
    named_tunnel_token: str | None = None
    external_public_url: str | None = None
    cloudflared_path: str | None = None
    message_dispatch_mode: MessageDispatchMode | None = None


class CreateSessionReq(BaseModel):
    title: str | None = None
    workspace_dir: str | None = None
    permission_mode: PermissionTier | None = None
    model: str | None = None
    project_id: str | None = None


class UpdateSessionReq(BaseModel):
    title: str | None = None
    workspace_dir: str | None = None
    permission_mode: PermissionTier | None = None
    model: str | None = None
    project_id: str | None = None


class ForkModelReq(BaseModel):
    model: str = Field(min_length=1)
    prompt: str = ""


class DefaultProjectReq(BaseModel):
    project_id: str = Field(min_length=1)


class ApprovalDecideReq(BaseModel):
    decision: ApprovalDecision
    reason: str = ""


class PluginActionReq(BaseModel):
    action_id: str
    payload: dict[str, Any] = Field(default_factory=dict)


class DesktopActionReq(BaseModel):
    kind: Literal["mouse", "text", "hotkey"]
    action: str = "click"
    x: int = 0
    y: int = 0
    delta: int = 0
    count: int = Field(default=1, ge=1, le=20)
    interval_ms: int = Field(default=55, ge=20, le=500)
    to_x: int | None = None
    to_y: int | None = None
    text: str = ""
    hotkey: str = ""


class ClickControlReq(BaseModel):
    x: int
    y: int
    action: Literal["click", "double_click", "right_click"] = "click"


class AlignLocalReq(BaseModel):
    client_fingerprints: dict[str, str] = Field(default_factory=dict)


class PullLocalReq(BaseModel):
    conversation_ids: list[str] | None = None
    client_fingerprints: dict[str, str] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# Internal Hook Guard (Loopback + Local Secret ONLY)
# ---------------------------------------------------------------------------

def require_internal_hook(request: Request) -> None:
    if not is_direct_loopback(request):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Internal hook endpoint is loopback-only")
    supplied = request.headers.get("X-AgyPocket-Hook-Secret", "")
    expected = get_or_create_hook_secret()
    if not supplied or not hmac.compare_digest(supplied, expected):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid hook secret")


# ---------------------------------------------------------------------------
# Health & Auth
# ---------------------------------------------------------------------------

@app.get("/api/health")
def health() -> dict[str, Any]:
    settings = load_settings()
    return {
        "ok": True,
        "service": "agypocket",
        "version": app.version,
        "pid": os.getpid(),
        "instance_id": os.environ.get("AGYPOCKET_INSTANCE_ID", ""),
        "device_name": settings.device_name,
        "connection_mode": settings.connection_mode,
    }


@app.get("/api/auth/status")
def auth_status(request: Request) -> dict[str, Any]:
    store = load_auth_store()
    settings = load_settings()
    needs_setup = not bool(store.passphrase_hash)
    session_cookie = request.cookies.get(SESSION_COOKIE_NAME, "")
    authenticated = (not needs_setup) and verify_session_token(session_cookie, store)
    return {
        "authenticated": authenticated,
        "needs_setup": needs_setup,
        "totp_enabled": store.totp_enabled,
        "is_loopback": is_direct_loopback(request),
        "device_name": settings.device_name,
        "connection_mode": settings.connection_mode,
    }


@app.post("/api/auth/setup")
def auth_setup(req: SetupAuthReq, request: Request, response: Response) -> dict[str, Any]:
    if not is_direct_loopback(request):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Initial setup is only allowed locally")
    store = load_auth_store()
    if store.passphrase_hash:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Passphrase already configured")
    salt_hex, hash_hex = hash_passphrase(req.passphrase)
    store.passphrase_salt = salt_hex
    store.passphrase_hash = hash_hex
    save_auth_store(store)
    csrf = issue_session_cookies(response, request, store)
    return {"ok": True, "csrf_token": csrf}


@app.post("/api/auth/login")
def auth_login(req: LoginReq, request: Request, response: Response) -> dict[str, Any]:
    client_ip = extract_client_ip(request)
    rate = auth_rate_limiter.check(client_ip)
    if not rate.allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"尝试次数过多，请 {rate.retry_after_seconds} 秒后再试",
            headers={"Retry-After": str(rate.retry_after_seconds)},
        )

    store = load_auth_store()
    if not store.passphrase_hash:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Passphrase not configured yet")

    if not verify_passphrase(req.passphrase, store):
        fail_state = auth_rate_limiter.record_failure(client_ip)
        if not fail_state.allowed:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=f"口令错误次数过多，已锁定 {fail_state.retry_after_seconds} 秒",
                headers={"Retry-After": str(fail_state.retry_after_seconds)},
            )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"访问口令错误（剩余 {fail_state.remaining_attempts} 次机会）",
        )

    if store.totp_enabled:
        if not req.totp_code.strip():
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="TOTP_REQUIRED",
            )
        if not verify_totp_code(store.totp_secret, req.totp_code):
            fail_state = auth_rate_limiter.record_failure(client_ip)
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail=f"6 位动态验证码错误（剩余 {fail_state.remaining_attempts} 次机会）",
            )

    auth_rate_limiter.reset(client_ip)
    csrf = issue_session_cookies(response, request, store)
    return {"ok": True, "csrf_token": csrf}


@app.post("/api/auth/logout")
def auth_logout(request: Request, response: Response) -> dict[str, Any]:
    clear_session_cookies(response, request)
    return {"ok": True}


@app.post("/api/auth/revoke-all")
def auth_revoke_all(request: Request, response: Response) -> dict[str, Any]:
    if not is_direct_loopback(request):
        require_authenticated_request(request)
    revoke_all_sessions()
    clear_session_cookies(response, request)
    return {"ok": True, "message": "已注销所有已登录设备"}


@app.post("/api/auth/pair-token")
def create_pair_token(request: Request) -> dict[str, Any]:
    if not is_direct_loopback(request):
        require_authenticated_request(request)
    store = load_auth_store()
    if not store.passphrase_hash:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Please configure passphrase first")
    settings = load_settings()
    token, expires_at = pairing_store.create()
    pair_path = f"/pair?t={token}"
    qr_path = f"/pair?t={token}&mode={settings.connection_mode}&name={quote(settings.device_name, safe='')}"
    return {
        "token": token,
        "expires_at": expires_at,
        "pair_path": pair_path,
        "mode": settings.connection_mode,
        "device_name": settings.device_name,
        "qr_path": qr_path,
    }


@app.get("/pair")
def pair_with_token(request: Request, t: str = Query(default="")) -> Response:
    client_ip = extract_client_ip(request)
    rate = auth_rate_limiter.check(client_ip)
    if not rate.allowed:
        return HTMLResponse(
            content=f"<h3>验证锁定中</h3><p>请 {rate.retry_after_seconds} 秒后再试。</p>",
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        )
    store = load_auth_store()
    if not store.passphrase_hash:
        return HTMLResponse(content="<h3>请先在电脑端完成初始化口令设置</h3>", status_code=400)
    if not pairing_store.consume(t):
        auth_rate_limiter.record_failure(client_ip)
        return HTMLResponse(
            content=(
                "<!doctype html><html lang='zh-CN'><meta charset='utf-8'>"
                "<body style='background:#0a0c12;color:#e5e7eb;font-family:sans-serif;padding:2rem;text-align:center'>"
                "<h2>配对码已过期或已使用</h2>"
                "<p>一次性扫码令牌仅 2 分钟有效且只能使用一次。请在电脑端按 [R] 刷新二维码，或手动访问首页输入访问口令。</p>"
                "<a href='/' style='color:#60a5fa'>前往口令登录页 →</a>"
                "</body></html>"
            ),
            status_code=status.HTTP_401_UNAUTHORIZED,
        )
    auth_rate_limiter.reset(client_ip)
    redirect = RedirectResponse(url="/", status_code=status.HTTP_302_FOUND)
    issue_session_cookies(redirect, request, store)
    return redirect


@app.post("/api/auth/totp/setup")
def totp_setup(_store=Depends(require_authenticated_request)) -> dict[str, Any]:
    return begin_totp_setup()


@app.post("/api/auth/totp/enable")
def totp_enable(req: TotpCodeReq, store=Depends(require_authenticated_request)) -> dict[str, Any]:
    if not verify_passphrase(req.passphrase, store):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="访问口令不正确")
    try:
        enable_totp(req.code)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return {"ok": True, "totp_enabled": True}


@app.post("/api/auth/totp/disable")
def totp_disable(req: TotpCodeReq, store=Depends(require_authenticated_request)) -> dict[str, Any]:
    if not verify_passphrase(req.passphrase, store):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="访问口令不正确")
    try:
        disable_totp(req.code)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return {"ok": True, "totp_enabled": False}


# ---------------------------------------------------------------------------
# Settings, Projects, Models, Bridge & Approvals
# ---------------------------------------------------------------------------

@app.get("/api/settings")
async def get_settings(_store=Depends(require_authenticated_request)) -> dict[str, Any]:
    settings = load_settings()
    data = settings.model_dump()
    data["named_tunnel_configured"] = bool(settings.named_tunnel_token.strip())
    data.pop("named_tunnel_token", None)
    return {
        "settings": data,
        "permission_tiers": list_permission_specs(),
        "agy": get_agy_cli_status(),
        "bridge": await bridge_client.get_status(),
        "projects": list_antigravity_projects(),
    }


@app.patch("/api/settings")
def update_settings(req: SettingsPatchReq, _store=Depends(require_authenticated_request)) -> dict[str, Any]:
    settings = load_settings()
    updates = req.model_dump(exclude_none=True)
    if "workspace_dir" in updates:
        ws_raw = updates["workspace_dir"].strip()
        if ws_raw:
            cand = Path(ws_raw)
            if not cand.is_dir():
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="指定的工作区目录在电脑上不存在")
            updates["workspace_dir"] = str(cand)
        else:
            updates["workspace_dir"] = ""
    if "device_name" in updates:
        updates["device_name"] = updates["device_name"].strip() or socket.gethostname() or "My-PC"
    if "cloudflared_path" in updates:
        updates["cloudflared_path"] = updates["cloudflared_path"].strip()
    if "external_public_url" in updates:
        ext_url = updates["external_public_url"].strip().rstrip("/")
        if ext_url and not (ext_url.startswith("http://") or ext_url.startswith("https://")):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="外部穿透地址必须以 http:// 或 https:// 开头",
            )
        updates["external_public_url"] = ext_url
    updated = settings.model_copy(update=updates)
    save_settings(updated)
    if "prevent_sleep" in updates:
        set_prevent_sleep(updated.prevent_sleep)
    out = updated.model_dump()
    out["named_tunnel_configured"] = bool(updated.named_tunnel_token.strip())
    out.pop("named_tunnel_token", None)
    return {"ok": True, "settings": out}


@app.get("/api/agy/status")
def agy_status(_store=Depends(require_authenticated_request)) -> dict[str, Any]:
    return get_agy_cli_status()


@app.get("/api/projects")
def get_projects(_store=Depends(require_authenticated_request)) -> dict[str, Any]:
    return list_antigravity_projects()


@app.post("/api/projects/default")
def set_default_project(
    req: DefaultProjectReq,
    _store=Depends(require_authenticated_request),
) -> dict[str, Any]:
    try:
        res = set_bound_project_id(req.project_id)
        settings = load_settings()
        listing = list_antigravity_projects()
        match = next((p for p in listing["projects"] if p["id"] == req.project_id), None)
        updates: dict[str, Any] = {"default_project_id": req.project_id}
        if match and match.get("primary_folder") and Path(match["primary_folder"]).is_dir():
            updates["workspace_dir"] = match["primary_folder"]
        save_settings(settings.model_copy(update=updates))
        return res
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


@app.get("/api/models")
async def get_models(
    refresh: bool = Query(default=False),
    _store=Depends(require_authenticated_request),
) -> dict[str, Any]:
    return await model_catalog_service.get_catalog(force_refresh=refresh)


@app.get("/api/bridge/status")
async def get_bridge_status(_store=Depends(require_authenticated_request)) -> dict[str, Any]:
    return await bridge_client.get_status()


@app.get("/api/approvals/pending")
def get_pending_approvals(_store=Depends(require_authenticated_request)) -> dict[str, Any]:
    return {"pending": approval_manager.list_pending()}


@app.post("/api/approvals/{approval_id}/decide")
async def decide_approval(
    approval_id: str,
    req: ApprovalDecideReq,
    _store=Depends(require_authenticated_request),
) -> dict[str, Any]:
    ok = await approval_manager.resolve(approval_id, req.decision, reason=req.reason)
    if not ok:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="审批请求已失效或已处理")
    return {"ok": True, "approval_id": approval_id, "decision": req.decision}


# ---------------------------------------------------------------------------
# Internal Loopback Hook Endpoints
# ---------------------------------------------------------------------------

@app.post("/api/internal/hook/pre-tool")
async def internal_hook_pre_tool(
    request: Request,
    _auth=Depends(require_internal_hook),
) -> dict[str, Any]:
    try:
        payload = await request.json()
    except Exception:
        return {"decision": "allow"}
    if not isinstance(payload, dict):
        return {"decision": "allow"}

    tool_call = payload.get("toolCall") if isinstance(payload.get("toolCall"), dict) else {}
    tool_name = str(tool_call.get("name") or "").strip()
    tool_args = tool_call.get("args") if isinstance(tool_call.get("args"), dict) else {}
    conv_id = str(payload.get("conversationId") or "").strip()
    model_name = str(payload.get("modelName") or "").strip()
    step_idx_raw = payload.get("stepIdx")
    step_idx = int(step_idx_raw) if isinstance(step_idx_raw, int) else None

    if conv_id:
        await live_coordinator.handle_hook_event("PreToolUse", payload)

    settings = load_settings()
    if not approval_manager.should_intercept(tool_name, settings.approval_policy):
        return {"decision": "allow"}

    return await approval_manager.request_approval(
        conversation_id=conv_id,
        tool_name=tool_name,
        tool_args=tool_args,
        model_name=model_name,
        step_idx=step_idx,
        timeout_seconds=settings.approval_timeout_seconds,
    )


@app.post("/api/internal/hook/event")
async def internal_hook_event(
    request: Request,
    _auth=Depends(require_internal_hook),
) -> dict[str, Any]:
    try:
        body = await request.json()
    except Exception:
        return {"ok": True}
    if isinstance(body, dict):
        event_type = str(body.get("event") or "").strip()
        payload = body.get("payload") if isinstance(body.get("payload"), dict) else {}
        if event_type:
            await live_coordinator.handle_hook_event(event_type, payload)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Sessions & Local Sync
# ---------------------------------------------------------------------------

@app.get("/api/sessions")
def list_sessions(_store=Depends(require_authenticated_request)) -> dict[str, Any]:
    return {"sessions": session_store.list_sessions()}


@app.post("/api/sessions")
def create_session(req: CreateSessionReq, _store=Depends(require_authenticated_request)) -> dict[str, Any]:
    if req.workspace_dir and not Path(req.workspace_dir).is_dir():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="工作区目录不存在")
    sess = session_store.create_session(
        title=req.title,
        workspace_dir=req.workspace_dir,
        permission_mode=req.permission_mode,
        model=req.model,
        project_id=req.project_id,
    )
    return {"session": sess.model_dump()}


@app.get("/api/sessions/{session_id}")
def get_session(session_id: str, _store=Depends(require_authenticated_request)) -> dict[str, Any]:
    sess = session_store.get_session(session_id)
    if not sess:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="会话不存在")
    telemetry = read_conversation_telemetry(sess.agy_conversation_id) if sess.agy_conversation_id else None
    return {
        "session": sess.model_dump(),
        "running": live_coordinator.is_running(session_id),
        "telemetry": telemetry,
    }


@app.get("/api/sessions/{session_id}/telemetry")
def get_session_telemetry(session_id: str, _store=Depends(require_authenticated_request)) -> dict[str, Any]:
    sess = session_store.get_session(session_id)
    if not sess:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="会话不存在")
    telemetry = read_conversation_telemetry(sess.agy_conversation_id) if sess.agy_conversation_id else None
    return {"telemetry": telemetry}


@app.post("/api/sessions/{session_id}/fork-model")
async def fork_session_model(
    session_id: str,
    req: ForkModelReq,
    _store=Depends(require_authenticated_request),
) -> dict[str, Any]:
    try:
        created = await live_coordinator.fork_with_model(
            session_id=session_id,
            new_model_id=req.model,
            user_prompt=req.prompt,
        )
        return {"session": created.model_dump()}
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc


@app.patch("/api/sessions/{session_id}")
def patch_session(
    session_id: str,
    req: UpdateSessionReq,
    _store=Depends(require_authenticated_request),
) -> dict[str, Any]:
    updates = req.model_dump(exclude_none=True)
    if "workspace_dir" in updates and not Path(updates["workspace_dir"]).is_dir():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="工作区目录不存在")
    sess = session_store.update_session(session_id, **updates)
    if not sess:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="会话不存在")
    return {"session": sess.model_dump()}


@app.delete("/api/sessions/{session_id}")
def delete_session(session_id: str, _store=Depends(require_authenticated_request)) -> dict[str, Any]:
    if live_coordinator.is_running(session_id):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="请先停止当前会话的任务后再删除")
    ok = session_store.delete_session(session_id)
    if not ok:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="会话不存在")
    if not session_store.list_sessions():
        session_store.create_session(title="主工作台")
    return {"ok": True}


@app.post("/api/sync/local/align")
def sync_local_align(
    req: AlignLocalReq,
    _store=Depends(require_authenticated_request),
) -> dict[str, Any]:
    return align_local_sessions(client_fingerprints=req.client_fingerprints)


@app.post("/api/sync/local/pull")
def sync_local_pull(
    req: PullLocalReq,
    _store=Depends(require_authenticated_request),
) -> dict[str, Any]:
    return pull_local_sessions(
        conversation_ids=req.conversation_ids,
        client_fingerprints=req.client_fingerprints,
    )


@app.get("/api/media")
def get_local_media(
    path: str = Query(min_length=1),
    download: bool = Query(default=False),
    _store=Depends(require_authenticated_request),
) -> Response:
    try:
        resolved = resolve_allowed_media_path(path)
    except PermissionError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail=str(exc)) from exc

    mime, _ = mimetypes.guess_type(str(resolved))
    media_type = mime or "application/octet-stream"
    headers = {"Cache-Control": "private, max-age=3600"}
    if download or resolved.suffix.lower() in FORCE_ATTACHMENT_EXTENSIONS:
        encoded_name = quote(resolved.name, safe="")
        headers["Content-Disposition"] = f"attachment; filename*=UTF-8''{encoded_name}"

    return FileResponse(resolved, media_type=media_type, headers=headers)


# ---------------------------------------------------------------------------
# Plugins & Cards
# ---------------------------------------------------------------------------

@app.get("/api/plugins/contributions")
def plugin_contributions(_store=Depends(require_authenticated_request)) -> dict[str, Any]:
    return plugin_registry.get_contributions(agent_running=live_coordinator.any_running())


@app.post("/api/plugins/{plugin_id}/action")
async def plugin_action(
    plugin_id: str,
    req: PluginActionReq,
    _store=Depends(require_authenticated_request),
) -> dict[str, Any]:
    return await plugin_registry.dispatch_action(plugin_id, req.action_id, req.payload)


# ---------------------------------------------------------------------------
# Desktop Remote Control & Telemetry
# ---------------------------------------------------------------------------

@app.get("/api/desktop/telemetry")
def desktop_telemetry(_store=Depends(require_authenticated_request)) -> dict[str, Any]:
    return get_system_telemetry()


@app.get("/api/desktop/monitors")
def desktop_monitors(_store=Depends(require_authenticated_request)) -> dict[str, Any]:
    return {"monitors": list_monitors()}


@app.get("/api/desktop/snapshot")
def desktop_snapshot(
    monitor_index: int = Query(default=1, ge=1, le=8),
    preset: str = Query(default="hd"),
    _store=Depends(require_authenticated_request),
) -> Response:
    frame = capture_screen_frame(monitor_index=monitor_index, preset=preset)
    if frame.screen_locked or not frame.jpeg_bytes:
        return JSONResponse(
            status_code=status.HTTP_423_LOCKED,
            content={"screen_locked": True, "detail": "Windows 当前处于锁屏或受保护桌面，无法抓取屏幕画面"},
        )
    return Response(
        content=frame.jpeg_bytes,
        media_type="image/jpeg",
        headers={
            "Cache-Control": "no-store",
            "X-Screen-Width": str(frame.monitor_width),
            "X-Screen-Height": str(frame.monitor_height),
            "X-Image-Width": str(frame.width),
            "X-Image-Height": str(frame.height),
        },
    )


@app.get("/api/desktop/controls")
async def desktop_controls(
    monitor_index: int = Query(default=1, ge=1, le=8),
    _store=Depends(require_authenticated_request),
) -> dict[str, Any]:
    return await scan_controls(monitor_index=monitor_index)


@app.post("/api/desktop/click-control")
def desktop_click_control(
    req: ClickControlReq,
    _store=Depends(require_authenticated_request),
) -> dict[str, Any]:
    perform_mouse_action(req.action, req.x, req.y)
    return {"ok": True, "action": req.action, "x": req.x, "y": req.y}


@app.post("/api/desktop/action")
def desktop_action(
    req: DesktopActionReq,
    _store=Depends(require_authenticated_request),
) -> dict[str, Any]:
    if req.kind == "mouse":
        perform_mouse_action(
            req.action,
            req.x,
            req.y,
            req.delta,
            count=req.count,
            interval_ms=req.interval_ms,
            to_x=req.to_x,
            to_y=req.to_y,
        )
    elif req.kind == "text":
        type_unicode_text(req.text)
    elif req.kind == "hotkey":
        try:
            send_hotkey(req.hotkey)
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return {"ok": True}


@app.post("/api/desktop/emergency-esc")
def desktop_emergency_esc(_store=Depends(require_authenticated_request)) -> dict[str, Any]:
    emergency_esc()
    return {"ok": True, "message": "已发送系统级 Esc 急停按键"}


# ---------------------------------------------------------------------------
# Cloudflare Tunnel Controls
# ---------------------------------------------------------------------------

@app.get("/api/tunnel/status")
def tunnel_status(request: Request) -> dict[str, Any]:
    if not is_direct_loopback(request):
        require_authenticated_request(request)
    return tunnel_manager.get_status()


@app.post("/api/tunnel/start")
async def tunnel_start(request: Request) -> dict[str, Any]:
    if not is_direct_loopback(request):
        require_authenticated_request(request)
    return await tunnel_manager.start()


@app.post("/api/tunnel/restart")
async def tunnel_restart(request: Request) -> dict[str, Any]:
    if not is_direct_loopback(request):
        require_authenticated_request(request)
    return await tunnel_manager.restart()


@app.post("/api/tunnel/kill")
async def tunnel_kill(request: Request) -> dict[str, Any]:
    if not is_direct_loopback(request):
        require_authenticated_request(request)
    return await tunnel_manager.stop()


# ---------------------------------------------------------------------------
# WebSockets: /ws/chat & /ws/desktop
# ---------------------------------------------------------------------------

@app.websocket("/ws/chat")
async def ws_chat(websocket: WebSocket) -> None:
    if not verify_ws_authenticated(websocket):
        await websocket.close(code=4401)
        return
    await websocket.accept()
    client_id = f"ws-{uuid.uuid4().hex[:8]}"
    send_lock = asyncio.Lock()
    active_tasks: set[asyncio.Task[Any]] = set()

    async def safe_send(payload: dict[str, Any]) -> None:
        async with send_lock:
            try:
                await websocket.send_json(payload)
            except Exception:
                pass

    approval_manager.register_ws(client_id, safe_send)
    try:
        # Push any pending remote approvals immediately upon connect when non-empty
        pending = approval_manager.list_pending()
        if pending:
            await safe_send({"type": "pending_approvals", "approvals": pending})

        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            mtype = msg.get("type")
            if mtype == "ping":
                await safe_send({"type": "pong"})
            elif mtype == "hello":
                bridge_st = await bridge_client.get_status()
                await safe_send({"type": "bridge_status", "bridge": bridge_st})
            elif mtype == "abort":
                sid = str(msg.get("session_id") or "")
                if sid:
                    await live_coordinator.stop_watching_session(sid)
            elif mtype == "watch_session":
                sid = str(msg.get("session_id") or "")
                sess = session_store.get_session(sid) if sid else None
                if sess and sess.agy_conversation_id:
                    live_coordinator.ensure_watching(sess.id, sess.agy_conversation_id)
            elif mtype == "approval_decide":
                aid = str(msg.get("approval_id") or "")
                dec = str(msg.get("decision") or "allow")
                if aid and dec in {"auto_approve", "deny", "allow"}:
                    await approval_manager.resolve(aid, dec)  # type: ignore[arg-type]
            elif mtype == "send_prompt":
                sid = str(msg.get("session_id") or "")
                prompt = str(msg.get("prompt") or "").strip()
                model_id = str(msg.get("model") or "").strip()
                project_id = str(msg.get("project_id") or "").strip()
                attach_screen = bool(msg.get("attach_screenshot", False))
                if not prompt:
                    continue
                screenshot_path = None
                if attach_screen:
                    saved = save_scratch_screenshot()
                    if saved is not None:
                        screenshot_path = str(saved)
                task = asyncio.create_task(
                    live_coordinator.send_prompt(
                        session_id=sid,
                        prompt=prompt,
                        model_id=model_id,
                        project_id=project_id,
                        attach_screenshot_path=screenshot_path,
                    )
                )
                active_tasks.add(task)
                task.add_done_callback(active_tasks.discard)
            elif mtype == "fork_with_model":
                sid = str(msg.get("session_id") or "")
                model_id = str(msg.get("model") or "").strip()
                prompt = str(msg.get("prompt") or "").strip()
                if sid and model_id:
                    try:
                        await live_coordinator.fork_with_model(
                            session_id=sid,
                            new_model_id=model_id,
                            user_prompt=prompt,
                        )
                    except Exception as exc:
                        await safe_send({"type": "run_error", "session_id": sid, "message": str(exc)})
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        approval_manager.unregister_ws(client_id)


@app.websocket("/ws/desktop")
async def ws_desktop(websocket: WebSocket) -> None:
    if not verify_ws_authenticated(websocket):
        await websocket.close(code=4401)
        return
    await websocket.accept()

    settings = load_settings()
    state = {
        "preset": "balanced",
        "fps": settings.screen_fps,
        "monitor_index": 1,
        "paused": False,
    }
    stop_event = asyncio.Event()

    async def receiver() -> None:
        try:
            while not stop_event.is_set():
                raw = await websocket.receive_text()
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                mtype = msg.get("type")
                if mtype == "config":
                    if msg.get("preset") in {"fast", "balanced", "hd"}:
                        state["preset"] = msg["preset"]
                    if isinstance(msg.get("fps"), int):
                        state["fps"] = max(1, min(8, msg["fps"]))
                    if isinstance(msg.get("monitor_index"), int):
                        state["monitor_index"] = max(1, min(8, msg["monitor_index"]))
                    if "paused" in msg:
                        state["paused"] = bool(msg["paused"])
                elif mtype == "mouse":
                    perform_mouse_action(
                        str(msg.get("action") or "click"),
                        int(msg.get("x") or 0),
                        int(msg.get("y") or 0),
                        int(msg.get("delta") or 0),
                        count=int(msg.get("count") or 1),
                        interval_ms=int(msg.get("interval_ms") or 55),
                        to_x=int(msg["to_x"]) if msg.get("to_x") is not None else None,
                        to_y=int(msg["to_y"]) if msg.get("to_y") is not None else None,
                    )
                elif mtype == "text":
                    type_unicode_text(str(msg.get("text") or ""))
                elif mtype == "hotkey":
                    try:
                        send_hotkey(str(msg.get("hotkey") or ""))
                    except ValueError:
                        pass
                elif mtype == "esc":
                    emergency_esc()
        except WebSocketDisconnect:
            stop_event.set()
        except Exception:
            stop_event.set()

    async def streamer() -> None:
        loop = asyncio.get_running_loop()
        tick = 0
        try:
            while not stop_event.is_set():
                if state["paused"]:
                    await asyncio.sleep(0.25)
                    continue
                frame = await loop.run_in_executor(
                    None,
                    capture_screen_frame,
                    state["monitor_index"],
                    state["preset"],
                )
                meta = {
                    "type": "frame_meta",
                    "width": frame.width,
                    "height": frame.height,
                    "monitor_left": frame.monitor_left,
                    "monitor_top": frame.monitor_top,
                    "monitor_width": frame.monitor_width,
                    "monitor_height": frame.monitor_height,
                    "screen_locked": frame.screen_locked,
                }
                await websocket.send_json(meta)
                if not frame.screen_locked and frame.jpeg_bytes:
                    await websocket.send_bytes(frame.jpeg_bytes)

                if tick % max(1, state["fps"] * 2) == 0:
                    telemetry = await loop.run_in_executor(None, get_system_telemetry)
                    await websocket.send_json({"type": "telemetry", "data": telemetry})
                tick += 1
                await asyncio.sleep(1.0 / max(1, state["fps"]))
        except Exception:
            stop_event.set()

    await asyncio.gather(receiver(), streamer())


# ---------------------------------------------------------------------------
# Static PWA Hosting
# ---------------------------------------------------------------------------

if (FRONTEND_DIST / "assets").is_dir():
    app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIST / "assets")), name="assets")


@app.get("/{full_path:path}")
def serve_spa(full_path: str) -> Response:
    if full_path.startswith("api/") or full_path.startswith("ws/"):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    candidate = (FRONTEND_DIST / full_path).resolve()
    if FRONTEND_DIST.is_dir() and candidate.is_file() and str(candidate).startswith(str(FRONTEND_DIST.resolve())):
        if full_path == "manifest.json":
            return FileResponse(
                candidate,
                media_type="application/manifest+json",
                headers={"Cache-Control": "no-cache"},
            )
        if full_path == "sw.js":
            return FileResponse(
                candidate,
                media_type="application/javascript",
                headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"},
            )
        return FileResponse(candidate)
    index_file = FRONTEND_DIST / "index.html"
    if index_file.is_file():
        return FileResponse(index_file)
    return HTMLResponse(
        content="<h3>AgyPocket 后端已就绪</h3><p>前端静态资源尚未构建（请先在 frontend 目录执行 npm run build）。</p>",
        status_code=200,
    )
