from __future__ import annotations

import pyotp
from fastapi.testclient import TestClient

from app.config import load_auth_store
from app.security.auth import PairingTokenStore, hash_passphrase, verify_passphrase
from app.security.ratelimit import AuthRateLimiter


def test_scrypt_hash_and_verify(isolated_env):
    salt, digest = hash_passphrase("MyDormPass#2026")
    store = load_auth_store()
    store.passphrase_salt = salt
    store.passphrase_hash = digest
    assert verify_passphrase("MyDormPass#2026", store) is True
    assert verify_passphrase("wrong-pass", store) is False


def test_pairing_token_single_use_and_expiry():
    store = PairingTokenStore(ttl_seconds=120)
    token, _ = store.create(now=1000.0)
    assert store.consume(token, now=1050.0) is True
    # Replay must fail
    assert store.consume(token, now=1051.0) is False

    token2, _ = store.create(now=1000.0)
    # Expired after 120s
    assert store.consume(token2, now=1125.0) is False


def test_rate_limiter_lockout():
    limiter = AuthRateLimiter(max_failures=5, window_seconds=600, lockout_seconds=900)
    for idx in range(4):
        st = limiter.record_failure("203.0.113.10", now=100.0 + idx)
        assert st.allowed is True
    st5 = limiter.record_failure("203.0.113.10", now=105.0)
    assert st5.allowed is False
    assert st5.retry_after_seconds == 900

    # Other IP remains unaffected
    other = limiter.check("203.0.113.11", now=106.0)
    assert other.allowed is True


def test_setup_remote_blocked_and_csrf_enforced(client: TestClient):
    # Remote Cloudflare proxied request cannot run initial setup
    res_remote = client.post(
        "/api/auth/setup",
        json={"passphrase": "StrongPassword123"},
        headers={"CF-Connecting-IP": "198.51.100.2"},
    )
    assert res_remote.status_code == 403

    # Direct loopback setup succeeds
    res_local = client.post("/api/auth/setup", json={"passphrase": "StrongPassword123"})
    assert res_local.status_code == 200
    csrf = client.cookies.get("agypocket_csrf")
    assert csrf

    # Mutating request without CSRF header fails with 403
    res_no_csrf = client.patch("/api/settings", json={"model": "gemini-test"})
    assert res_no_csrf.status_code == 403

    # Mutating request with CSRF header succeeds
    res_ok = client.patch(
        "/api/settings",
        json={"model": "gemini-test"},
        headers={"X-CSRF-Token": csrf},
    )
    assert res_ok.status_code == 200
    assert res_ok.json()["settings"]["model"] == "gemini-test"


def test_pair_login_brute_force_and_revoke_all(client: TestClient):
    assert client.post("/api/auth/setup", json={"passphrase": "StrongPassword123"}).status_code == 200
    csrf = client.cookies.get("agypocket_csrf")

    # Generate 2-min pairing token
    pair_res = client.post("/api/auth/pair-token", headers={"X-CSRF-Token": csrf})
    assert pair_res.status_code == 200
    pair_path = pair_res.json()["pair_path"]

    # Fresh client pairs with QR link -> redirects to / and sets session cookie
    phone = TestClient(client.app)
    r_pair = phone.get(pair_path, follow_redirects=False)
    assert r_pair.status_code == 302
    assert r_pair.headers["location"] == "/"
    assert phone.get("/api/auth/status").json()["authenticated"] is True

    # Replaying same pairing token fails
    r_replay = TestClient(client.app).get(pair_path, follow_redirects=False)
    assert r_replay.status_code == 401

    # Revoke-all immediately invalidates the phone session
    assert client.post("/api/auth/revoke-all", headers={"X-CSRF-Token": csrf}).status_code == 200
    assert phone.get("/api/auth/status").json()["authenticated"] is False

    # 5 wrong logins from same CF-Connecting-IP triggers 429 lockout
    attacker = TestClient(client.app)
    for i in range(4):
        r = attacker.post(
            "/api/auth/login",
            json={"passphrase": "bad"},
            headers={"CF-Connecting-IP": "198.51.100.77"},
        )
        assert r.status_code == 401
    r5 = attacker.post(
        "/api/auth/login",
        json={"passphrase": "bad"},
        headers={"CF-Connecting-IP": "198.51.100.77"},
    )
    assert r5.status_code == 429


def test_totp_enable_login_disable(client: TestClient):
    assert client.post("/api/auth/setup", json={"passphrase": "StrongPassword123"}).status_code == 200
    csrf = client.cookies.get("agypocket_csrf")

    setup_res = client.post("/api/auth/totp/setup", headers={"X-CSRF-Token": csrf})
    assert setup_res.status_code == 200
    secret = setup_res.json()["secret"]
    code = pyotp.TOTP(secret).now()

    en_res = client.post(
        "/api/auth/totp/enable",
        json={"passphrase": "StrongPassword123", "code": code},
        headers={"X-CSRF-Token": csrf},
    )
    assert en_res.status_code == 200
    assert en_res.json()["totp_enabled"] is True

    # Login without TOTP code is rejected with TOTP_REQUIRED
    phone = TestClient(client.app)
    r_no_totp = phone.post("/api/auth/login", json={"passphrase": "StrongPassword123"})
    assert r_no_totp.status_code == 401
    assert r_no_totp.json()["detail"] == "TOTP_REQUIRED"

    # Login with valid 6-digit TOTP succeeds
    r_ok = phone.post(
        "/api/auth/login",
        json={"passphrase": "StrongPassword123", "totp_code": pyotp.TOTP(secret).now()},
    )
    assert r_ok.status_code == 200

    # Disable TOTP
    dis_res = client.post(
        "/api/auth/totp/disable",
        json={"passphrase": "StrongPassword123", "code": pyotp.TOTP(secret).now()},
        headers={"X-CSRF-Token": csrf},
    )
    assert dis_res.status_code == 200
    assert dis_res.json()["totp_enabled"] is False


def test_websocket_auth_and_origin_check(client: TestClient):
    assert client.post("/api/auth/setup", json={"passphrase": "StrongPassword123"}).status_code == 200

    # Unauthenticated WS must fail
    unauth = TestClient(client.app)
    try:
        with unauth.websocket_connect("/ws/chat"):
            assert False, "Expected unauthenticated WebSocket to close"
    except Exception:
        pass

    # Cross-origin WS with valid cookie must also fail (CSWSH defense)
    try:
        with client.websocket_connect("/ws/chat", headers={"Origin": "https://evil.example"}):
            assert False, "Expected cross-origin WebSocket to close"
    except Exception:
        pass

    # Valid same-origin WS succeeds
    with client.websocket_connect("/ws/chat", headers={"Origin": "http://testserver"}) as ws:
        ws.send_json({"type": "ping"})
        assert ws.receive_json() == {"type": "pong"}


def test_frp_external_host_not_treated_as_loopback(client: TestClient):
    assert client.post("/api/auth/setup", json={"passphrase": "StrongPassword123"}).status_code == 200
    unauth = TestClient(client.app)

    status_res = unauth.get("/api/auth/status", headers={"Host": "remote.example.com:8443"})
    assert status_res.status_code == 200
    assert status_res.json()["is_loopback"] is False

    pair_res = unauth.post("/api/auth/pair-token", headers={"Host": "remote.example.com:8443"})
    assert pair_res.status_code == 401


def test_health_auth_and_pair_token_include_device_metadata(client: TestClient):
    assert client.post("/api/auth/setup", json={"passphrase": "StrongPassword123"}).status_code == 200
    csrf = client.cookies.get("agypocket_csrf")
    patch_res = client.patch(
        "/api/settings",
        json={"device_name": "Lab PC", "connection_mode": "temp"},
        headers={"X-CSRF-Token": csrf},
    )
    assert patch_res.status_code == 200

    health_res = client.get("/api/health").json()
    assert health_res["device_name"] == "Lab PC"
    assert health_res["connection_mode"] == "temp"

    status_res = client.get("/api/auth/status").json()
    assert status_res["device_name"] == "Lab PC"
    assert status_res["connection_mode"] == "temp"

    pair_res = client.post("/api/auth/pair-token", headers={"X-CSRF-Token": csrf}).json()
    assert pair_res["mode"] == "temp"
    assert pair_res["device_name"] == "Lab PC"
    assert pair_res["qr_path"] == f"/pair?t={pair_res['token']}&mode=temp&name=Lab%20PC"

    # /pair must ignore extra mode/name query params and issue session redirect
    pair_login = client.get(pair_res["qr_path"], follow_redirects=False)
    assert pair_login.status_code == 302
