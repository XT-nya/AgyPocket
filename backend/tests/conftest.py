from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.main import app, auth_rate_limiter, pairing_store  # noqa: E402


@pytest.fixture()
def isolated_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("AGYPOCKET_DATA_DIR", str(tmp_path))
    auth_rate_limiter.clear_all()
    pairing_store._entries.clear()
    yield tmp_path


@pytest.fixture()
def client(isolated_env: Path):
    with TestClient(app, client=("127.0.0.1", 50000)) as c:
        yield c
