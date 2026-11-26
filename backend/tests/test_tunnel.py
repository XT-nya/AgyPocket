from __future__ import annotations

import asyncio
from pathlib import Path

from app.config import SettingsModel, load_settings, save_settings
from app.tunnel.manager import (
    TRYCLOUDFLARE_RE,
    TunnelManager,
    _build_tunnel_command,
    _build_tunnel_env,
    _is_error_line,
)


def test_tunnel_env_proxy_toggle():
    direct_env = _build_tunnel_env(
        use_system_proxy=False,
        base_env={
            "PATH": "C:\\Windows",
            "HTTP_PROXY": "http://127.0.0.1:47891",
            "HTTPS_PROXY": "http://127.0.0.1:47891",
            "ALL_PROXY": "socks5://127.0.0.1:17890",
            "https_proxy": "http://127.0.0.1:47891",
        },
    )
    for k in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        assert k not in direct_env

    proxy_env = _build_tunnel_env(
        use_system_proxy=True,
        base_env={"PATH": "C:\\Windows"},
        detected_proxy="http://127.0.0.1:47891",
    )
    assert proxy_env["HTTP_PROXY"] == "http://127.0.0.1:47891"
    assert proxy_env["HTTPS_PROXY"] == "http://127.0.0.1:47891"
    assert "127.0.0.1" in proxy_env["NO_PROXY"]


def test_tunnel_command_uses_http2_and_regex():
    settings = SettingsModel(port=18765, tunnel_mode="quick")
    mode, cmd = _build_tunnel_command(Path("cloudflared"), settings)
    assert mode == "quick"
    assert "--protocol" in cmd
    assert "http2" in cmd
    assert "http://127.0.0.1:18765" in cmd

    named = SettingsModel(port=18765, tunnel_mode="named", named_tunnel_token="tok-abc")
    mode2, cmd2 = _build_tunnel_command(Path("cloudflared"), named)
    assert mode2 == "named"
    assert "--protocol" in cmd2
    assert "http2" in cmd2
    assert "tok-abc" in cmd2

    line = "2026-11-24T07:32:08Z INF |  https://diploma-edgar-reaching-processors.trycloudflare.com  |"
    m = TRYCLOUDFLARE_RE.search(line)
    assert m is not None
    assert m.group(0) == "https://diploma-edgar-reaching-processors.trycloudflare.com"

    assert _is_error_line("quick tunnel provisioning failed with status 429") is True
    assert _is_error_line("Thank you for trying Cloudflare Tunnel.") is False


def test_tunnel_command_retries_metrics_and_logfile(tmp_path):
    settings = SettingsModel(port=18765, tunnel_mode="quick")
    log_path = tmp_path / "cloudflared.log"
    mode, cmd = _build_tunnel_command(
        Path("cloudflared"),
        settings,
        metrics_addr="127.0.0.1:20245",
        logfile_path=log_path,
    )
    assert mode == "quick"
    assert "--retries" in cmd
    assert "9999" in cmd
    assert "--metrics" in cmd
    assert "127.0.0.1:20245" in cmd
    assert "--logfile" in cmd
    assert str(log_path) in cmd


def test_external_tunnel_mode_sets_url_without_spawning(monkeypatch, tmp_path):
    monkeypatch.setenv("AGYPOCKET_DATA_DIR", str(tmp_path))
    s = load_settings()
    s.tunnel_mode = "external"
    s.external_public_url = "https://remote.example.com:8443/"
    save_settings(s)

    mgr = TunnelManager()
    st = asyncio.run(mgr.start())
    assert st["mode"] == "external"
    assert st["status"] == "running"
    assert st["connected"] is True
    assert st["public_url"] == "https://remote.example.com:8443"
    assert mgr._proc is None


def test_cloudflared_discovery_and_missing_hint(monkeypatch, tmp_path):
    monkeypatch.setenv("AGYPOCKET_DATA_DIR", str(tmp_path))
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr("app.tunnel.manager.get_bin_dir", lambda: bin_dir)
    monkeypatch.setattr("app.tunnel.manager.shutil.which", lambda _name: None)

    s = load_settings()
    s.tunnel_mode = "quick"
    s.cloudflared_path = ""
    save_settings(s)

    mgr = TunnelManager()
    assert mgr.cloudflared_path() is None
    st = asyncio.run(mgr.start())
    assert st["status"] == "error"
    assert "cloudflared" in st["last_error"]
    assert "external" in st["last_error"]

    custom_cf = tmp_path / "custom-cloudflared"
    custom_cf.write_text("stub", encoding="utf-8")
    s.cloudflared_path = str(custom_cf)
    save_settings(s)
    assert mgr.cloudflared_path() == custom_cf
