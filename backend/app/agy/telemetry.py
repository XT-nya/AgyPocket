"""Read-only ground-truth SQLite telemetry parser for Antigravity conversation DBs."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any


def get_conversations_db_dir() -> Path:
    return Path.home() / ".gemini" / "antigravity" / "conversations"


def _read_varint(buf: bytes, offset: int) -> tuple[int, int]:
    result = 0
    shift = 0
    while offset < len(buf):
        b = buf[offset]
        offset += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            return result, offset
        shift += 7
        if shift > 63:
            raise ValueError("Varint overflow")
    raise ValueError("Truncated varint")


def _decode_pb_map(buf: bytes) -> dict[int, list[Any]]:
    fields: dict[int, list[Any]] = {}
    offset = 0
    length = len(buf)
    while offset < length:
        try:
            tag, offset = _read_varint(buf, offset)
        except ValueError:
            break
        field_num = tag >> 3
        wire_type = tag & 0x07
        if field_num == 0:
            break
        if wire_type == 0:
            try:
                val, offset = _read_varint(buf, offset)
            except ValueError:
                break
            fields.setdefault(field_num, []).append(val)
        elif wire_type == 1:
            if offset + 8 > length:
                break
            fields.setdefault(field_num, []).append(buf[offset : offset + 8])
            offset += 8
        elif wire_type == 2:
            try:
                sub_len, offset = _read_varint(buf, offset)
            except ValueError:
                break
            if sub_len < 0 or offset + sub_len > length:
                break
            fields.setdefault(field_num, []).append(buf[offset : offset + sub_len])
            offset += sub_len
        elif wire_type == 5:
            if offset + 4 > length:
                break
            fields.setdefault(field_num, []).append(buf[offset : offset + 4])
            offset += 4
        else:
            break
    return fields


def _first_bytes(fields: dict[int, list[Any]], num: int) -> bytes:
    vals = fields.get(num)
    if vals and isinstance(vals[0], (bytes, bytearray)):
        return bytes(vals[0])
    return b""


def _first_int(fields: dict[int, list[Any]], num: int) -> int:
    vals = fields.get(num)
    if vals and isinstance(vals[0], int):
        return int(vals[0])
    return 0


def _first_text(fields: dict[int, list[Any]], num: int) -> str:
    raw = _first_bytes(fields, num)
    if not raw:
        return ""
    return raw.decode("utf-8", errors="replace").strip()


def infer_context_limit(model_name: str) -> int | None:
    low = (model_name or "").lower()
    if not low:
        return None
    if any(k in low for k in ("neon", "carbon", "hydrogen", "argon")):
        return 512_000
    if "3.8" in low or "3.7" in low or "3.6" in low or "flash" in low:
        return 1_000_000
    if "claude" in low:
        return 200_000
    if "gpt-oss" in low:
        return 128_000
    return None


def parse_gen_metadata_blob(data: bytes) -> dict[str, Any] | None:
    """Decode CortexStepGeneratorMetadata protobuf blob without external dependencies."""
    if not data:
        return None
    top = _decode_pb_map(data)
    chat_bytes = _first_bytes(top, 1)
    if not chat_bytes:
        return None
    chat = _decode_pb_map(chat_bytes)
    usage_bytes = _first_bytes(chat, 4)
    usage = _decode_pb_map(usage_bytes) if usage_bytes else {}

    uncached_input = _first_int(usage, 2)
    output_tokens = _first_int(usage, 3)
    cache_write = _first_int(usage, 4)
    cache_read = _first_int(usage, 5)
    model_name = _first_text(chat, 21) or _first_text(chat, 19)

    if not any((uncached_input, output_tokens, cache_write, cache_read)) and not model_name:
        return None

    active_context = uncached_input + cache_read
    limit = infer_context_limit(model_name)
    usage_pct = round((active_context / limit) * 100, 1) if limit and active_context > 0 else None

    return {
        "model_name": model_name,
        "uncached_input": uncached_input,
        "cache_read": cache_read,
        "cache_write": cache_write,
        "output_tokens": output_tokens,
        "active_context_tokens": active_context,
        "context_limit": limit,
        "usage_percent": usage_pct,
    }


def read_conversation_telemetry(
    conversation_id: str,
    conversations_dir: Path | None = None,
) -> dict[str, Any] | None:
    """Read latest request token & model telemetry from ~/.gemini/antigravity/conversations/<id>.db."""
    cid = (conversation_id or "").strip()
    if not cid:
        return None
    db_path = (conversations_dir or get_conversations_db_dir()) / f"{cid}.db"
    if not db_path.is_file():
        return None

    con: sqlite3.Connection | None = None
    try:
        con = sqlite3.connect(f"file:{db_path.as_posix()}?mode=ro", uri=True, timeout=1.5)
        has_gen = con.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='gen_metadata'"
        ).fetchone()
        if not has_gen:
            return None

        rows = con.execute("SELECT idx, data FROM gen_metadata ORDER BY idx DESC LIMIT 12").fetchall()
        step_count_row = con.execute("SELECT count(*) FROM steps").fetchone()
        step_count = int(step_count_row[0]) if step_count_row else 0
        total_req_row = con.execute("SELECT count(*) FROM gen_metadata").fetchone()
        request_count = int(total_req_row[0]) if total_req_row else 0

        for _, blob in rows:
            if not isinstance(blob, (bytes, bytearray)):
                continue
            parsed = parse_gen_metadata_blob(bytes(blob))
            if parsed and (parsed["active_context_tokens"] > 0 or parsed["output_tokens"] > 0):
                parsed["step_count"] = step_count
                parsed["request_count"] = request_count
                return parsed
            if parsed and parsed["model_name"]:
                parsed["step_count"] = step_count
                parsed["request_count"] = request_count
                return parsed
    except Exception:
        return None
    finally:
        if con is not None:
            try:
                con.close()
            except Exception:
                pass
    return None
