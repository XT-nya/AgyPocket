from __future__ import annotations

from fastapi.testclient import TestClient

from app.desktop import input_ctrl
from app.desktop.input_ctrl import normalize_to_sendinput


def test_normalize_to_sendinput_math():
    assert normalize_to_sendinput(0, 0, 0, 0, 1920, 1080) == (0, 0)
    assert normalize_to_sendinput(1919, 1079, 0, 0, 1920, 1080) == (65535, 65535)
    # Multi-monitor negative left offset
    ax, ay = normalize_to_sendinput(0, 540, -1920, 0, 3840, 1080)
    assert 32700 <= ax <= 32850
    assert 32700 <= ay <= 32850


def test_desktop_smoke_endpoints_and_spa(client: TestClient):
    client.post("/api/auth/setup", json={"passphrase": "StrongPassword123"})
    csrf = client.cookies.get("agypocket_csrf")

    # Telemetry
    tel = client.get("/api/desktop/telemetry")
    assert tel.status_code == 200
    t_data = tel.json()
    assert "cpu_percent" in t_data
    assert "ram_percent" in t_data

    # Snapshot (returns JPEG bytes or 423 if locked desktop)
    snap = client.get("/api/desktop/snapshot?preset=fast")
    assert snap.status_code in (200, 423)
    if snap.status_code == 200:
        assert snap.headers["content-type"].startswith("image/jpeg")
        assert snap.content[:2] == b"\xff\xd8"

    # UIA controls
    ctrls = client.get("/api/desktop/controls")
    assert ctrls.status_code == 200
    c_data = ctrls.json()
    assert "controls" in c_data
    assert isinstance(c_data["controls"], list)

    # Emergency Esc
    esc = client.post("/api/desktop/emergency-esc", headers={"X-CSRF-Token": csrf})
    assert esc.status_code == 200
    assert esc.json()["ok"] is True

    # Built PWA SPA index
    spa = client.get("/")
    assert spa.status_code == 200
    assert "AgyPocket" in spa.text


def test_advanced_mouse_actions_and_emergency_release(client: TestClient, monkeypatch):
    sent_batches: list[list] = []
    monkeypatch.setattr(input_ctrl, "_send_inputs", lambda items: sent_batches.append(list(items)))
    monkeypatch.setattr(input_ctrl, "_get_virtual_screen_rect", lambda: (0, 0, 1920, 1080))
    monkeypatch.setattr(input_ctrl.time, "sleep", lambda _sec: None)

    input_ctrl.perform_mouse_action("left_down", 100, 200)
    assert any(item.union.mi.dwFlags & input_ctrl.MOUSEEVENTF_LEFTDOWN for item in sent_batches[-1])

    input_ctrl.perform_mouse_action("left_up", 100, 200)
    assert any(item.union.mi.dwFlags & input_ctrl.MOUSEEVENTF_LEFTUP for item in sent_batches[-1])

    input_ctrl.perform_mouse_action("right_down", 150, 250)
    assert any(item.union.mi.dwFlags & input_ctrl.MOUSEEVENTF_RIGHTDOWN for item in sent_batches[-1])

    input_ctrl.perform_mouse_action("right_up", 150, 250)
    assert any(item.union.mi.dwFlags & input_ctrl.MOUSEEVENTF_RIGHTUP for item in sent_batches[-1])

    sent_batches.clear()
    input_ctrl.perform_mouse_action("rapid_click", 300, 400, count=4, interval_ms=30)
    # 1 move batch + 4 click batches
    assert len(sent_batches) == 5

    sent_batches.clear()
    input_ctrl.perform_mouse_action("drag", 100, 100, to_x=500, to_y=600)
    # start down + 8 move steps + end up
    assert len(sent_batches) == 10
    assert sent_batches[-1][0].union.mi.dwFlags & input_ctrl.MOUSEEVENTF_LEFTUP

    sent_batches.clear()
    input_ctrl.emergency_esc()
    first = sent_batches[0][0]
    assert first.type == input_ctrl.INPUT_MOUSE
    assert first.union.mi.dwFlags == (input_ctrl.MOUSEEVENTF_LEFTUP | input_ctrl.MOUSEEVENTF_RIGHTUP)

    client.post("/api/auth/setup", json={"passphrase": "StrongPassword123"})
    csrf = client.cookies.get("agypocket_csrf")
    res = client.post(
        "/api/desktop/action",
        json={"kind": "mouse", "action": "rapid_click", "x": 120, "y": 140, "count": 3, "interval_ms": 40},
        headers={"X-CSRF-Token": csrf},
    )
    assert res.status_code == 200
    assert res.json()["ok"] is True
