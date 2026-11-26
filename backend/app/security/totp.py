"""Optional TOTP two-factor authentication management."""

from __future__ import annotations

import base64
import io

import pyotp
import qrcode

from app.config import AuthStoreModel, load_auth_store, save_auth_store

ISSUER_NAME = "AgyPocket"


def begin_totp_setup(account_label: str = "DormPC") -> dict[str, str]:
    store = load_auth_store()
    secret = pyotp.random_base32()
    store.totp_pending_secret = secret
    save_auth_store(store)

    uri = pyotp.TOTP(secret).provisioning_uri(name=account_label, issuer_name=ISSUER_NAME)
    img = qrcode.make(uri)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    qr_b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return {
        "secret": secret,
        "otpauth_uri": uri,
        "qr_png_base64": f"data:image/png;base64,{qr_b64}",
    }


def verify_totp_code(secret: str, code: str) -> bool:
    cleaned = "".join(ch for ch in (code or "") if ch.isdigit())
    if len(cleaned) != 6 or not secret:
        return False
    return bool(pyotp.TOTP(secret).verify(cleaned, valid_window=1))


def enable_totp(code: str) -> AuthStoreModel:
    store = load_auth_store()
    if not store.totp_pending_secret:
        raise ValueError("No pending TOTP setup found")
    if not verify_totp_code(store.totp_pending_secret, code):
        raise ValueError("Invalid 6-digit TOTP code")
    store.totp_secret = store.totp_pending_secret
    store.totp_pending_secret = ""
    store.totp_enabled = True
    save_auth_store(store)
    return store


def disable_totp(code: str) -> AuthStoreModel:
    store = load_auth_store()
    if not store.totp_enabled or not store.totp_secret:
        raise ValueError("TOTP is not currently enabled")
    if not verify_totp_code(store.totp_secret, code):
        raise ValueError("Invalid 6-digit TOTP code")
    store.totp_enabled = False
    store.totp_secret = ""
    store.totp_pending_secret = ""
    save_auth_store(store)
    return store
