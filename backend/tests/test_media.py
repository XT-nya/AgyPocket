from __future__ import annotations

from pathlib import Path
from urllib.parse import quote

from fastapi.testclient import TestClient

from app.agy import media
from app.config import load_settings, save_settings

PNG_1X1 = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15c4\x00\x00\x00\rIDATx\x9cc`\x00\x00\x00\x02"
    b"\x00\x01H\xaf\xa4q\x00\x00\x00\x00IEND\xaeB`\x82"
)


def _setup_auth_and_workspace(client: TestClient, ws_dir: Path) -> None:
    res = client.post("/api/auth/setup", json={"passphrase": "StrongPassword123"})
    assert res.status_code == 200
    settings = load_settings()
    save_settings(settings.model_copy(update={"workspace_dir": str(ws_dir)}))


def test_media_requires_authentication(client: TestClient, tmp_path: Path):
    target = tmp_path / "demo.png"
    target.write_bytes(PNG_1X1)
    assert client.post("/api/auth/setup", json={"passphrase": "StrongPassword123"}).status_code == 200
    client.cookies.clear()
    r = client.get("/api/media", params={"path": str(target)})
    assert r.status_code == 401


def test_media_serves_whitelisted_and_blocks_outside_or_sensitive(client: TestClient, isolated_env: Path, tmp_path: Path):
    ws_dir = tmp_path / "workspace"
    ws_dir.mkdir(parents=True, exist_ok=True)
    outside_dir = tmp_path / "outside"
    outside_dir.mkdir(parents=True, exist_ok=True)

    _setup_auth_and_workspace(client, ws_dir)

    img = ws_dir / "截图_测试.png"
    img.write_bytes(PNG_1X1)
    svg = ws_dir / "diagram.svg"
    svg.write_text("<svg xmlns='http://www.w3.org/2000/svg'></svg>", encoding="utf-8")
    env_file = ws_dir / ".env"
    env_file.write_text("SECRET=1", encoding="utf-8")
    outside_file = outside_dir / "secret.txt"
    outside_file.write_text("nope", encoding="utf-8")

    # 1. Valid Windows path inside workspace
    r_img = client.get("/api/media", params={"path": str(img)})
    assert r_img.status_code == 200
    assert r_img.headers["content-type"].startswith("image/png")
    assert r_img.headers.get("cache-control") == "private, max-age=3600"
    assert r_img.content == PNG_1X1

    # 2. Valid file:/// URI with URL-encoded Chinese filename + download=1
    file_uri = img.as_uri()
    r_dl = client.get("/api/media", params={"path": file_uri, "download": "1"})
    assert r_dl.status_code == 200
    disp = r_dl.headers.get("content-disposition", "")
    assert "attachment" in disp
    assert quote("截图_测试.png", safe="") in disp

    # 3. SVG must force attachment disposition
    r_svg = client.get("/api/media", params={"path": str(svg)})
    assert r_svg.status_code == 200
    assert "attachment" in r_svg.headers.get("content-disposition", "")

    # 4. Missing file inside whitelist -> 404
    r_missing = client.get("/api/media", params={"path": str(ws_dir / "missing.png")})
    assert r_missing.status_code == 404

    # 5. Path traversal, outside whitelist, relative path, and sensitive files -> 403
    traversal = str(ws_dir / ".." / "outside" / "secret.txt")
    for bad in [
        traversal,
        str(outside_file),
        "relative/demo.png",
        str(env_file),
        str(isolated_env / "auth.json"),
    ]:
        r_bad = client.get("/api/media", params={"path": bad})
        assert r_bad.status_code == 403, f"Expected 403 for {bad}, got {r_bad.status_code}"


def test_decode_local_path_handles_encoded_uri_and_line_fragment():
    path_str, frag = media.decode_local_path("file:///d%3A/Antigravity%20work/%E7%AC%94%E8%AE%B0.md#L10-L25")
    assert path_str.lower().endswith("笔记.md")
    assert frag == "#L10-L25"
    assert media.decode_local_path("https://example.com/a.png") == ("", "")
