"""Authentication, scrypt passphrase hashing, signed cookies, CSRF, and one-time QR pairing."""

from __future__ import annotations

import hashlib
import hmac
import secrets
import threading
import time
from dataclasses import dataclass
from urllib.parse import urlparse

from fastapi import HTTPException, Request, Response, WebSocket, status

from app.config import AuthStoreModel, load_auth_store, save_auth_store

SESSION_COOKIE_NAME = "agypocket_session"
CSRF_COOKIE_NAME = "agypocket_csrf"
SESSION_TTL_SECONDS = 7 * 24 * 3600
PAIR_TOKEN_TTL_SECONDS = 120


def hash_passphrase(passphrase: str, salt: bytes | None = None) -> tuple[str, str]:
    if not passphrase:
        raise ValueError("Passphrase cannot be empty")
    salt_bytes = salt if salt is not None else secrets.token_bytes(16)
    derived = hashlib.scrypt(
        passphrase.encode("utf-8"),
        salt=salt_bytes,
        n=16384,
        r=8,
        p=1,
        dklen=32,
    )
    return salt_bytes.hex(), derived.hex()


def verify_passphrase(passphrase: str, store: AuthStoreModel) -> bool:
    if not store.passphrase_salt or not store.passphrase_hash or not passphrase:
        return False
    try:
        salt_bytes = bytes.fromhex(store.passphrase_salt)
        _, candidate_hex = hash_passphrase(passphrase, salt=salt_bytes)
        return hmac.compare_digest(candidate_hex, store.passphrase_hash)
    except Exception:
        return False


def _extract_host_name(host_header: str) -> str:
    raw = (host_header or "").strip().lower()
    if not raw:
        return ""
    if raw.startswith("["):
        end = raw.find("]")
        if end != -1:
            return raw[1:end]
    return raw.split(":", 1)[0]


def is_direct_loopback(request: Request) -> bool:
    """True only when invoked directly on loopback without any proxy/tunnel headers or external Host."""
    client_host = request.client.host if request.client else ""
    if client_host not in {"127.0.0.1", "::1", "localhost"}:
        return False
    lower_headers = {k.lower() for k in request.headers.keys()}
    proxy_headers = {
        "cf-connecting-ip",
        "cf-ray",
        "x-forwarded-for",
        "x-forwarded-host",
        "x-forwarded-proto",
        "x-real-ip",
        "forwarded",
    }
    if lower_headers & proxy_headers:
        return False
    host_name = _extract_host_name(request.headers.get("host", ""))
    if host_name and host_name not in {"127.0.0.1", "localhost", "::1", "testserver"}:
        return False
    return True


def is_https_request(request: Request) -> bool:
    proto = request.headers.get("x-forwarded-proto", "").lower()
    if proto == "https":
        return True
    return request.url.scheme == "https"


def _sign_payload(secret: str, payload: str) -> str:
    return hmac.new(secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()


def create_session_token(store: AuthStoreModel, now: int | None = None) -> str:
    ts = now if now is not None else int(time.time())
    session_id = secrets.token_urlsafe(16)
    payload = f"{session_id}.{ts}.{store.session_version}"
    sig = _sign_payload(store.session_secret, payload)
    return f"{payload}.{sig}"


def verify_session_token(token: str, store: AuthStoreModel, now: int | None = None) -> bool:
    if not token or not store.session_secret:
        return False
    parts = token.split(".")
    if len(parts) != 4:
        return False
    session_id, ts_str, ver_str, sig = parts
    if not session_id:
        return False
    try:
        issued_at = int(ts_str)
        version = int(ver_str)
    except ValueError:
        return False
    if version != store.session_version:
        return False
    current_ts = now if now is not None else int(time.time())
    if issued_at > current_ts + 60 or (current_ts - issued_at) > SESSION_TTL_SECONDS:
        return False
    payload = f"{session_id}.{ts_str}.{ver_str}"
    expected_sig = _sign_payload(store.session_secret, payload)
    return hmac.compare_digest(sig, expected_sig)


def issue_session_cookies(response: Response, request: Request, store: AuthStoreModel) -> str:
    secure = is_https_request(request)
    session_token = create_session_token(store)
    csrf_token = secrets.token_urlsafe(24)
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=session_token,
        max_age=SESSION_TTL_SECONDS,
        httponly=True,
        secure=secure,
        samesite="strict",
        path="/",
    )
    response.set_cookie(
        key=CSRF_COOKIE_NAME,
        value=csrf_token,
        max_age=SESSION_TTL_SECONDS,
        httponly=False,
        secure=secure,
        samesite="strict",
        path="/",
    )
    return csrf_token


def clear_session_cookies(response: Response, request: Request) -> None:
    secure = is_https_request(request)
    response.delete_cookie(SESSION_COOKIE_NAME, path="/", secure=secure, samesite="strict")
    response.delete_cookie(CSRF_COOKIE_NAME, path="/", secure=secure, samesite="strict")


def revoke_all_sessions() -> AuthStoreModel:
    store = load_auth_store()
    store.session_secret = secrets.token_hex(32)
    store.session_version += 1
    save_auth_store(store)
    return store


@dataclass
class PairingEntry:
    token_hash: str
    expires_at: float


class PairingTokenStore:
    """Single-use short-lived QR pairing token registry."""

    def __init__(self, ttl_seconds: int = PAIR_TOKEN_TTL_SECONDS) -> None:
        self.ttl_seconds = ttl_seconds
        self._entries: dict[str, PairingEntry] = {}
        self._lock = threading.Lock()

    @staticmethod
    def _hash_token(token: str) -> str:
        return hashlib.sha256(token.encode("utf-8")).hexdigest()

    def _prune(self, now: float) -> None:
        expired = [k for k, v in self._entries.items() if v.expires_at <= now]
        for k in expired:
            del self._entries[k]

    def create(self, now: float | None = None) -> tuple[str, int]:
        ts = now if now is not None else time.time()
        raw_token = secrets.token_urlsafe(32)
        digest = self._hash_token(raw_token)
        expires_at = ts + self.ttl_seconds
        with self._lock:
            self._prune(ts)
            self._entries[digest] = PairingEntry(token_hash=digest, expires_at=expires_at)
        return raw_token, int(expires_at)

    def consume(self, token: str, now: float | None = None) -> bool:
        if not token:
            return False
        ts = now if now is not None else time.time()
        candidate = self._hash_token(token)
        with self._lock:
            self._prune(ts)
            matched_key: str | None = None
            for key in list(self._entries.keys()):
                if hmac.compare_digest(key, candidate):
                    matched_key = key
            if matched_key is not None:
                entry = self._entries.pop(matched_key)
                return entry.expires_at > ts
        return False


def require_authenticated_request(request: Request) -> AuthStoreModel:
    store = load_auth_store()
    if not store.passphrase_hash:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Auth setup required")
    session_cookie = request.cookies.get(SESSION_COOKIE_NAME, "")
    if not verify_session_token(session_cookie, store):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired session")
    if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        csrf_cookie = request.cookies.get(CSRF_COOKIE_NAME, "")
        csrf_header = request.headers.get("X-CSRF-Token", "")
        if not csrf_cookie or not csrf_header or not hmac.compare_digest(csrf_cookie, csrf_header):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="CSRF verification failed")
    return store


def verify_ws_authenticated(websocket: WebSocket) -> bool:
    store = load_auth_store()
    if not store.passphrase_hash:
        return False
    session_cookie = websocket.cookies.get(SESSION_COOKIE_NAME, "")
    if not verify_session_token(session_cookie, store):
        return False
    origin = websocket.headers.get("origin", "")
    if origin:
        origin_host = (urlparse(origin).hostname or "").lower()
        target_host_raw = websocket.headers.get("x-forwarded-host") or websocket.headers.get("host") or ""
        target_host = target_host_raw.split(":")[0].lower()
        if target_host and origin_host != target_host:
            return False
    return True
