"""Local media/sticker path resolution, whitelist enforcement, and Markdown rewriting."""

from __future__ import annotations

import json
import os
import re
import sqlite3
from pathlib import Path
from typing import Iterable
from urllib.parse import quote, unquote, urlparse

from app.agy.projects import list_antigravity_projects
from app.config import PROJECT_ROOT, get_data_dir, load_settings

MAX_MEDIA_BYTES = 50 * 1024 * 1024

IMAGE_EXTENSIONS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".bmp",
    ".avif",
    ".ico",
}

FORCE_ATTACHMENT_EXTENSIONS = {
    ".svg",
    ".html",
    ".htm",
    ".xhtml",
    ".xml",
    ".js",
    ".mjs",
}

SENSITIVE_FILENAMES = {
    ".env",
    "auth.json",
    "internal_hook_secret.json",
    "sessions.json",
    "settings.json",
    "id_rsa",
    "id_ed25519",
    "id_ecdsa",
    "id_dsa",
}

SENSITIVE_SUFFIXES = {
    ".pem",
    ".key",
    ".p12",
    ".pfx",
    ".db",
    ".sqlite",
    ".sqlite3",
    ".db-wal",
    ".db-shm",
}

CODE_SPAN_OR_FENCE_RE = re.compile(r"```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`")
MD_LINK_OR_IMG_RE = re.compile(r"(!?)\[([^\]\n]*)\]\((<[^>\n]+>|[^)\n]+)\)")
STICKER_TOKEN_RE = re.compile(r"(?<![A-Za-z0-9_/\\]):([^:\[\]\s\x00-\x1f]{1,40}):(?![A-Za-z0-9_])")
LINE_FRAGMENT_RE = re.compile(r"#(L\d+(?:-L?\d+)?)$", re.IGNORECASE)
WIN_DRIVE_PATH_RE = re.compile(r"^[A-Za-z]:[/\\]")

_sticker_cache: dict[str, object] = {
    "sig": None,
    "map": {},
}


def get_allowed_media_roots() -> list[Path]:
    """Return canonical whitelist root directories permitted for /api/media."""
    home = Path.home()
    candidates: list[Path] = [
        home / ".gemini" / "antigravity" / "brain",
        home / ".gemini" / "antigravity-cli" / "brain",
        home / ".gemini" / "config" / "plugins" / "agy-meme" / "assets",
        home / ".gemini" / "config" / "agy-meme-data" / "images",
    ]

    settings = load_settings()
    ws = (settings.workspace_dir or "").strip()
    if ws:
        candidates.append(Path(ws))

    try:
        proj_info = list_antigravity_projects()
        for proj in proj_info.get("projects") or []:
            for folder in proj.get("folders") or []:
                f_str = str(folder or "").strip()
                if f_str:
                    candidates.append(Path(f_str))
    except Exception:
        pass

    roots: list[Path] = []
    seen: set[str] = set()
    for cand in candidates:
        try:
            resolved = cand.resolve()
        except Exception:
            continue
        key = str(resolved).lower() if os.name == "nt" else str(resolved)
        if key not in seen:
            seen.add(key)
            roots.append(resolved)
    return roots


def is_denied_sensitive_path(resolved: Path) -> bool:
    """Reject AgyPocket secrets/config files, databases, env files, and private keys."""
    for cfg_root in (PROJECT_ROOT / "config", get_data_dir() / "runtime"):
        try:
            if resolved.is_relative_to(cfg_root.resolve()):
                return True
        except Exception:
            pass

    try:
        data_dir = get_data_dir().resolve()
        if resolved.parent == data_dir and resolved.suffix.lower() in {".json", ".tmp", ".log"}:
            return True
    except Exception:
        pass

    name_lower = resolved.name.lower()
    if name_lower in SENSITIVE_FILENAMES or name_lower.startswith(".env."):
        return True
    if resolved.suffix.lower() in SENSITIVE_SUFFIXES:
        return True
    return False


def decode_local_path(raw: str) -> tuple[str, str]:
    """Decode a file:/// URI or Windows absolute path into (path_str, line_fragment).

    Returns ("", "") for web/non-local schemes or empty strings.
    """
    text = (raw or "").strip()
    if not text or "\x00" in text:
        return "", ""

    if text.startswith("<") and text.endswith(">") and len(text) > 2:
        text = text[1:-1].strip()

    fragment = ""
    frag_match = LINE_FRAGMENT_RE.search(text)
    if frag_match:
        fragment = f"#{frag_match.group(1)}"
        text = text[: frag_match.start()]

    if WIN_DRIVE_PATH_RE.match(text):
        return text, fragment

    parsed = urlparse(text)
    if parsed.scheme.lower() == "file":
        if parsed.netloc and parsed.netloc.lower() != "localhost":
            # UNC path
            path_part = unquote(parsed.path or "")
            return f"\\\\{parsed.netloc}{path_part.replace('/', chr(92))}", fragment
        path_str = unquote(parsed.path or "")
        if len(path_str) >= 3 and path_str[0] == "/" and path_str[1].isalpha() and path_str[2] == ":":
            path_str = path_str[1:]
        if os.name == "nt":
            path_str = path_str.replace("/", "\\")
        if not fragment and parsed.fragment:
            fragment = f"#{parsed.fragment}"
        return path_str, fragment

    if parsed.scheme:
        # Reject http://, https://, data:, javascript:, etc.
        return "", ""

    if text.startswith("/") or text.startswith("\\\\"):
        return text, fragment

    return "", ""


def resolve_allowed_media_path(
    raw_path: str,
    allowed_roots: Iterable[Path] | None = None,
) -> Path:
    """Resolve raw local path or file:/// URI and enforce whitelist & file checks."""
    decoded, _ = decode_local_path(raw_path)
    if not decoded:
        raise PermissionError("仅允许访问白名单内的本地绝对路径或 file:/// 资源")

    candidate = Path(decoded)
    if not candidate.is_absolute():
        raise PermissionError("拒绝相对路径访问")

    try:
        resolved = candidate.resolve()
    except Exception as exc:
        raise PermissionError("路径解析失败") from exc

    roots = list(allowed_roots) if allowed_roots is not None else get_allowed_media_roots()
    in_whitelist = False
    for root in roots:
        try:
            root_resolved = root.resolve()
        except Exception:
            continue
        if resolved.is_relative_to(root_resolved):
            in_whitelist = True
            break

    if not in_whitelist or is_denied_sensitive_path(resolved):
        raise PermissionError("目标路径不在允许访问的目录白名单内")

    if not resolved.is_file():
        raise FileNotFoundError("请求的媒体或文件不存在")

    size = resolved.stat().st_size
    if size > MAX_MEDIA_BYTES:
        raise ValueError("文件超过 50 MiB 传输限制")

    return resolved


def is_image_path(path_or_str: Path | str, mime_type: str = "") -> bool:
    """Return True if mime_type or extension indicates a safe inline raster image."""
    mime = (mime_type or "").strip().lower()
    if mime.startswith("image/") and "svg" not in mime:
        return True
    suffix = Path(str(path_or_str)).suffix.lower()
    return suffix in IMAGE_EXTENSIONS


def build_media_url(path: Path | str, download: bool = False) -> str:
    """Construct /api/media relative URL for frontend consumption."""
    encoded = quote(str(path), safe="")
    if download:
        return f"/api/media?path={encoded}&download=1"
    return f"/api/media?path={encoded}"


def load_sticker_map(
    assets_dir: Path | None = None,
    data_dir: Path | None = None,
) -> dict[str, Path]:
    """Load read-only mapping of :sticker_name: -> local image file path."""
    target_assets = assets_dir or (
        Path.home() / ".gemini" / "config" / "plugins" / "agy-meme" / "assets" / "sticker"
    )
    target_data = data_dir or Path(
        os.getenv("PLUGIN_DATA") or (Path.home() / ".gemini" / "config" / "agy-meme-data")
    )

    index_path = target_assets / "stickers_index.json"
    db_path = target_data / "collection.sqlite3"
    idx_mtime = index_path.stat().st_mtime if index_path.is_file() else 0.0
    db_mtime = db_path.stat().st_mtime if db_path.is_file() else 0.0
    sig = (str(target_assets), idx_mtime, str(target_data), db_mtime)

    if _sticker_cache["sig"] == sig and isinstance(_sticker_cache["map"], dict):
        return _sticker_cache["map"]  # type: ignore[return-value]

    mapping: dict[str, Path] = {}
    if index_path.is_file():
        try:
            items = json.loads(index_path.read_text(encoding="utf-8"))
            if isinstance(items, list):
                for row in items:
                    if not isinstance(row, dict):
                        continue
                    name = str(row.get("name") or "").strip()
                    fname = str(row.get("filename") or "").strip()
                    if not name or not fname:
                        continue
                    fpath = (target_assets / fname).resolve()
                    if fpath.is_file():
                        mapping[name] = fpath
        except Exception:
            pass

    images_dir = target_data / "images"
    if db_path.is_file() and images_dir.is_dir():
        import hashlib

        con: sqlite3.Connection | None = None
        try:
            con = sqlite3.connect(f"file:{db_path.as_posix()}?mode=ro", uri=True, timeout=1.5)
            rows = con.execute("SELECT name, ext, image FROM stickers").fetchall()
            for name_raw, ext_raw, blob in rows:
                name = str(name_raw or "").strip()
                ext = str(ext_raw or "").strip().lstrip(".")
                if not name or not ext or not isinstance(blob, (bytes, bytearray)):
                    continue
                digest = hashlib.sha256(bytes(blob)).hexdigest()
                img_path = (images_dir / f"{digest}.{ext}").resolve()
                if img_path.is_file():
                    mapping[name] = img_path
        except Exception:
            pass
        finally:
            if con is not None:
                try:
                    con.close()
                except Exception:
                    pass

    _sticker_cache["sig"] = sig
    _sticker_cache["map"] = mapping
    return mapping


def _split_markdown_target(raw_target: str) -> str:
    t = raw_target.strip()
    if t.startswith("<") and t.endswith(">"):
        return t[1:-1].strip()
    m = re.match(r'^(.+?)\s+(?:"[^"]*"|\'[^\']*\')$', t)
    if m:
        return m.group(1).strip()
    return t


def rewrite_markdown_media(
    text: str,
    allowed_roots: Iterable[Path] | None = None,
    sticker_map: dict[str, Path] | None = None,
) -> str:
    """Rewrite local file:/// or Windows path Markdown links/images and :sticker: tokens."""
    if not text:
        return text

    roots = list(allowed_roots) if allowed_roots is not None else get_allowed_media_roots()
    stickers = sticker_map if sticker_map is not None else load_sticker_map()

    masked: list[str] = []

    def _mask(value: str) -> str:
        idx = len(masked)
        masked.append(value)
        return f"\x00AGYMASK{idx}\x00"

    # 1. Protect fenced code blocks & inline code spans
    working = CODE_SPAN_OR_FENCE_RE.sub(lambda m: _mask(m.group(0)), text)

    # 2. Rewrite Markdown images & links referencing allowed local paths
    def _replace_link(match: re.Match[str]) -> str:
        bang = match.group(1)
        label = match.group(2)
        target = _split_markdown_target(match.group(3))
        decoded, frag = decode_local_path(target)
        if not decoded:
            return match.group(0)
        try:
            resolved = resolve_allowed_media_path(target, allowed_roots=roots)
        except Exception:
            return match.group(0)

        if bang == "!":
            alt = label or resolved.name
            return _mask(f"![{alt}]({build_media_url(resolved, download=False)})")

        is_img = is_image_path(resolved)
        disp_label = label or resolved.name
        if frag and frag.lower() not in disp_label.lower():
            disp_label = f"{disp_label}{frag}"
        return _mask(f"[{disp_label}]({build_media_url(resolved, download=not is_img)})")

    working = MD_LINK_OR_IMG_RE.sub(_replace_link, working)

    # 3. Replace known :sticker: tokens outside code/links
    if stickers:
        def _replace_sticker(match: re.Match[str]) -> str:
            name = match.group(1)
            fpath = stickers.get(name)
            if not fpath:
                return match.group(0)
            try:
                resolved = resolve_allowed_media_path(str(fpath), allowed_roots=roots)
            except Exception:
                return match.group(0)
            return f"![agy-meme · {name}]({build_media_url(resolved, download=False)})"

        working = STICKER_TOKEN_RE.sub(_replace_sticker, working)

    # 4. Restore masked spans
    for idx, original in enumerate(masked):
        working = working.replace(f"\x00AGYMASK{idx}\x00", original)

    return working
