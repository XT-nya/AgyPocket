"""IP-based sliding-window brute-force rate limiter."""

from __future__ import annotations

import threading
import time
from collections import deque
from dataclasses import dataclass

from fastapi import Request


def extract_client_ip(request: Request) -> str:
    """Return real client IP preferring Cloudflare's CF-Connecting-IP header."""
    cf_ip = request.headers.get("CF-Connecting-IP", "").strip()
    if cf_ip:
        return cf_ip
    if request.client and request.client.host:
        return request.client.host
    return "unknown"


@dataclass
class RateLimitState:
    allowed: bool
    retry_after_seconds: int = 0
    remaining_attempts: int = 5


class AuthRateLimiter:
    """Locks out an IP for lockout_seconds after max_failures within window_seconds."""

    def __init__(
        self,
        max_failures: int = 5,
        window_seconds: int = 600,
        lockout_seconds: int = 900,
    ) -> None:
        self.max_failures = max_failures
        self.window_seconds = window_seconds
        self.lockout_seconds = lockout_seconds
        self._failures: dict[str, deque[float]] = {}
        self._locked_until: dict[str, float] = {}
        self._lock = threading.Lock()

    def _prune(self, ip: str, now: float) -> deque[float]:
        dq = self._failures.setdefault(ip, deque())
        cutoff = now - self.window_seconds
        while dq and dq[0] < cutoff:
            dq.popleft()
        return dq

    def check(self, ip: str, now: float | None = None) -> RateLimitState:
        ts = now if now is not None else time.monotonic()
        with self._lock:
            locked_until = self._locked_until.get(ip, 0.0)
            if locked_until > ts:
                return RateLimitState(
                    allowed=False,
                    retry_after_seconds=max(1, int(locked_until - ts + 0.999)),
                    remaining_attempts=0,
                )
            if ip in self._locked_until:
                del self._locked_until[ip]
            dq = self._prune(ip, ts)
            remaining = max(0, self.max_failures - len(dq))
            return RateLimitState(allowed=True, remaining_attempts=remaining)

    def record_failure(self, ip: str, now: float | None = None) -> RateLimitState:
        ts = now if now is not None else time.monotonic()
        with self._lock:
            dq = self._prune(ip, ts)
            dq.append(ts)
            if len(dq) >= self.max_failures:
                self._locked_until[ip] = ts + self.lockout_seconds
                dq.clear()
                return RateLimitState(
                    allowed=False,
                    retry_after_seconds=self.lockout_seconds,
                    remaining_attempts=0,
                )
            return RateLimitState(
                allowed=True,
                remaining_attempts=max(0, self.max_failures - len(dq)),
            )

    def reset(self, ip: str) -> None:
        with self._lock:
            self._failures.pop(ip, None)
            self._locked_until.pop(ip, None)

    def clear_all(self) -> None:
        with self._lock:
            self._failures.clear()
            self._locked_until.clear()
