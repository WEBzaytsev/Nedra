"""In-memory full and browser-extension vault sessions."""

import hashlib
import re
import secrets
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, field
from enum import StrEnum
from typing import NamedTuple

from errors import SessionRequired, WrongScope
from helpers import VaultKey

TOKEN_BYTES = 32
HANDLE_BYTES = 16
EXPIRY_TOLERANCE_MS = 5_000
MAX_LIFETIME_MS = 12 * 60 * 60 * 1000
DEFAULT_MAX_SESSIONS = 32
DEFAULT_MAX_EXTENSION_SESSIONS = 8
HANDOFF_TTL_MS = 5 * 60 * 1000

_TOKEN = re.compile(r"[A-Za-z0-9_-]{43}", re.ASCII)
_ENDED = "Your session expired or was locked. Unlock the vault again."


class Scope(StrEnum):
    FULL = "full"
    EXTENSION = "extension"


class Instant(NamedTuple):
    monotonic: float
    wall: float

    def ms_since(self, earlier: "Instant") -> float:
        return 1000 * max(self.monotonic - earlier.monotonic, self.wall - earlier.wall)


def system_clock() -> Instant:
    return Instant(time.monotonic(), time.time())


def _digest(token: str) -> bytes:
    return hashlib.sha256(token.encode("ascii")).digest()


@dataclass(slots=True)
class _Session:
    key: VaultKey = field(repr=False)
    user_id: int
    credential_fingerprint: bytes | None = field(repr=False)
    created: Instant
    last_used: Instant
    scope: Scope = Scope.FULL
    handle: str = ""
    browser: str | None = None
    client: str | None = None


@dataclass(slots=True)
class _ExtensionHandoff:
    request_digest: bytes = field(repr=False)
    tab_digest: bytes = field(repr=False)
    client: str
    browser: str
    origin: str
    created: Instant
    user_id: int | None = None
    web_session_digest: bytes | None = field(default=None, repr=False)
    redeem_digest: bytes | None = field(default=None, repr=False)


@dataclass(frozen=True, slots=True)
class SessionInfo:
    idle_timeout_ms: int
    expires_in_ms: int


@dataclass(frozen=True, slots=True)
class ExtensionSessionInfo:
    handle: str
    browser: str
    created: float
    last_used: float


class VaultSessions:
    def __init__(
        self,
        *,
        idle_timeout_ms: int,
        tolerance_ms: int = EXPIRY_TOLERANCE_MS,
        max_lifetime_ms: int = MAX_LIFETIME_MS,
        max_sessions: int = DEFAULT_MAX_SESSIONS,
        max_extension_sessions: int = DEFAULT_MAX_EXTENSION_SESSIONS,
        clock: Callable[[], Instant] = system_clock,
    ) -> None:
        if max_sessions < 1 or max_extension_sessions < 1:
            raise ValueError("session limits must be at least 1")
        self._idle_timeout_ms = idle_timeout_ms
        self._tolerance_ms = tolerance_ms
        self._max_lifetime_ms = max_lifetime_ms
        self._max_sessions = max_sessions
        self._max_extension_sessions = max_extension_sessions
        self._clock = clock
        self._sessions: OrderedDict[bytes, _Session] = OrderedDict()
        self._handoffs: dict[bytes, _ExtensionHandoff] = {}
        self._lock = threading.Lock()

    @property
    def idle_timeout_ms(self) -> int:
        return self._idle_timeout_ms

    def set_idle_timeout(self, idle_timeout_ms: int) -> None:
        now = self._clock()
        with self._lock:
            self._drop_expired(now)
            self._idle_timeout_ms = idle_timeout_ms

    def __len__(self) -> int:
        with self._lock:
            return len(self._sessions)

    def open(
        self,
        key: VaultKey,
        user_id: int = 0,
        credential_fingerprint: bytes | None = None,
    ) -> str:
        return self._open(key, user_id, credential_fingerprint, Scope.FULL, None, None)[
            0
        ]

    def open_extension(
        self,
        key: VaultKey,
        user_id: int,
        credential_fingerprint: bytes | None,
        browser: str,
        client: str | None,
    ) -> tuple[str, str]:
        return self._open(
            key, user_id, credential_fingerprint, Scope.EXTENSION, browser, client
        )

    def start_extension_handoff(
        self, request: str, tab: str, origin: str, browser: str, client: str
    ) -> bool:
        now = self._clock()
        request_digest = _digest(request)
        with self._lock:
            self._drop_expired(now)
            if request_digest in self._handoffs:
                return False
            self._handoffs[request_digest] = _ExtensionHandoff(
                request_digest=request_digest,
                tab_digest=_digest(tab),
                origin=origin,
                browser=browser,
                client=client,
                created=now,
            )
            return True

    def approve_extension_handoff(
        self,
        request: str,
        tab: str,
        origin: str,
        browser: str,
        client: str,
        user_id: int,
        web_token: str,
    ) -> str | None:
        now = self._clock()
        request_digest = _digest(request)
        with self._lock:
            self._drop_expired(now)
            handoff = self._handoffs.get(request_digest)
            if (
                handoff is None
                or handoff.user_id is not None
                or handoff.origin != origin
                or handoff.browser != browser
                or handoff.client != client
                or not secrets.compare_digest(handoff.tab_digest, _digest(tab))
            ):
                return None
            redeem = secrets.token_urlsafe(HANDLE_BYTES)
            handoff.user_id = user_id
            handoff.web_session_digest = _digest(web_token)
            handoff.redeem_digest = _digest(redeem)
            return redeem

    def redeem_extension_handoff(
        self, request: str, tab: str, redeem: str, browser: str, client: str
    ) -> tuple[str, str] | None:
        now = self._clock()
        request_digest = _digest(request)
        with self._lock:
            self._drop_expired(now)
            handoff = self._handoffs.pop(request_digest, None)
            if (
                handoff is None
                or handoff.user_id is None
                or handoff.web_session_digest is None
                or handoff.redeem_digest is None
                or handoff.browser != browser
                or handoff.client != client
                or not secrets.compare_digest(handoff.tab_digest, _digest(tab))
                or not secrets.compare_digest(handoff.redeem_digest, _digest(redeem))
            ):
                return None
            source = self._sessions.get(handoff.web_session_digest)
            if (
                source is None
                or source.scope is not Scope.FULL
                or source.user_id != handoff.user_id
                or self._remaining_ms(source, now) <= 0
            ):
                return None
            return self._open_locked(
                source.key,
                source.user_id,
                source.credential_fingerprint,
                Scope.EXTENSION,
                browser,
                client,
            )

    def cancel_extension_handoff(self, request: str, tab: str, client: str) -> None:
        request_digest = _digest(request)
        with self._lock:
            handoff = self._handoffs.get(request_digest)
            if (
                handoff is not None
                and handoff.client == client
                and secrets.compare_digest(handoff.tab_digest, _digest(tab))
            ):
                del self._handoffs[request_digest]

    def _open(
        self,
        key: VaultKey,
        user_id: int,
        credential_fingerprint: bytes | None,
        scope: Scope,
        browser: str | None,
        client: str | None,
    ) -> tuple[str, str]:
        now = self._clock()
        with self._lock:
            self._drop_expired(now)
            return self._open_locked(
                key, user_id, credential_fingerprint, scope, browser, client
            )

    def _open_locked(
        self,
        key: VaultKey,
        user_id: int,
        credential_fingerprint: bytes | None,
        scope: Scope,
        browser: str | None,
        client: str | None,
    ) -> tuple[str, str]:
        token = secrets.token_urlsafe(TOKEN_BYTES)
        handle = secrets.token_urlsafe(HANDLE_BYTES)
        now = self._clock()
        if client is not None:
            for digest in [
                digest
                for digest, session in self._sessions.items()
                if session.scope is Scope.EXTENSION and session.client == client
            ]:
                del self._sessions[digest]
        cap = (
            self._max_extension_sessions
            if scope is Scope.EXTENSION
            else self._max_sessions
        )
        matching = [
            digest
            for digest, session in self._sessions.items()
            if session.scope is scope
        ]
        while len(matching) >= cap:
            del self._sessions[matching.pop(0)]
        self._sessions[_digest(token)] = _Session(
            key=key,
            user_id=user_id,
            credential_fingerprint=credential_fingerprint,
            created=now,
            last_used=now,
            scope=scope,
            handle=handle,
            browser=browser,
            client=client,
        )
        return token, handle

    def resolve(
        self, token: str | None, *, refresh: bool = True, scope: Scope = Scope.FULL
    ) -> VaultKey:
        now = self._clock()
        with self._lock:
            digest, session = self._live(token, now, scope)
            if refresh:
                session.last_used = now
                self._sessions.move_to_end(digest)
            return session.key

    def info(self, token: str | None, *, scope: Scope = Scope.FULL) -> SessionInfo:
        now = self._clock()
        with self._lock:
            _, session = self._live(token, now, scope)
            return SessionInfo(
                idle_timeout_ms=self._idle_timeout_ms,
                expires_in_ms=max(
                    0, int(self._remaining_ms(session, now, tolerance=False))
                ),
            )

    def user_id(self, token: str | None, *, scope: Scope = Scope.FULL) -> int:
        now = self._clock()
        with self._lock:
            _, session = self._live(token, now, scope)
            return session.user_id

    def credential_fingerprint(
        self, token: str | None, *, scope: Scope = Scope.FULL
    ) -> bytes | None:
        now = self._clock()
        with self._lock:
            _, session = self._live(token, now, scope)
            return session.credential_fingerprint

    def user_ids(self) -> tuple[int, ...]:
        with self._lock:
            return tuple(session.user_id for session in self._sessions.values())

    def revoke(self, token: str | None, *, scope: Scope | None = None) -> bool:
        if token is None or not _TOKEN.fullmatch(token):
            return False
        with self._lock:
            digest = _digest(token)
            session = self._sessions.get(digest)
            if session is None or (scope is not None and session.scope is not scope):
                return False
            del self._sessions[digest]
            for handoff_digest, handoff in list(self._handoffs.items()):
                if handoff.web_session_digest == digest:
                    del self._handoffs[handoff_digest]
            return True

    def revoke_all(self) -> int:
        with self._lock:
            count = len(self._sessions)
            self._sessions.clear()
            self._handoffs.clear()
            return count

    def revoke_user(self, user_id: int) -> int:
        with self._lock:
            matching = [
                digest
                for digest, session in self._sessions.items()
                if session.user_id == user_id
            ]
            for digest in matching:
                del self._sessions[digest]
            for digest, handoff in list(self._handoffs.items()):
                if handoff.user_id == user_id:
                    del self._handoffs[digest]
            return len(matching)

    def revoke_user_except(self, user_id: int, token: str) -> int:
        keep = _digest(token)
        with self._lock:
            matching = [
                digest
                for digest, session in self._sessions.items()
                if session.user_id == user_id and digest != keep
            ]
            for digest in matching:
                del self._sessions[digest]
            return len(matching)

    def extension_sessions(self, user_id: int) -> list[ExtensionSessionInfo]:
        now = self._clock()
        with self._lock:
            self._drop_expired(now)
            return [
                ExtensionSessionInfo(
                    handle=session.handle,
                    browser=session.browser or "Browser",
                    created=session.created.wall,
                    last_used=session.last_used.wall,
                )
                for session in reversed(self._sessions.values())
                if session.scope is Scope.EXTENSION and session.user_id == user_id
            ]

    def revoke_extension(self, handle: str, user_id: int) -> bool:
        with self._lock:
            for digest, session in self._sessions.items():
                if (
                    session.scope is Scope.EXTENSION
                    and session.user_id == user_id
                    and secrets.compare_digest(session.handle.encode(), handle.encode())
                ):
                    del self._sessions[digest]
                    return True
        return False

    def drop_expired(self) -> int:
        with self._lock:
            return self._drop_expired(self._clock())

    def _live(
        self, token: str | None, now: Instant, scope: Scope
    ) -> tuple[bytes, _Session]:
        if token is None or not _TOKEN.fullmatch(token):
            raise SessionRequired(_ENDED)
        digest = _digest(token)
        session = self._sessions.get(digest)
        if session is None:
            raise SessionRequired(_ENDED)
        if session.scope is not scope:
            raise WrongScope(
                "A browser extension session can only fill logins. "
                "Open Nedra to do this."
            )
        if self._remaining_ms(session, now) <= 0:
            del self._sessions[digest]
            raise SessionRequired(_ENDED)
        return digest, session

    def _remaining_ms(
        self, session: _Session, now: Instant, *, tolerance: bool = True
    ) -> float:
        idle_limit = self._idle_timeout_ms + (self._tolerance_ms if tolerance else 0)
        return min(
            idle_limit - now.ms_since(session.last_used),
            self._max_lifetime_ms - now.ms_since(session.created),
        )

    def _drop_expired(self, now: Instant) -> int:
        expired = [
            digest
            for digest, session in self._sessions.items()
            if self._remaining_ms(session, now) <= 0
        ]
        for digest in expired:
            del self._sessions[digest]
        for digest, handoff in list(self._handoffs.items()):
            if now.ms_since(handoff.created) >= HANDOFF_TTL_MS:
                del self._handoffs[digest]
        return len(expired)
