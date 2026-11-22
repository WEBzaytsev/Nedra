import os
import unittest

from errors import SessionRequired
from helpers import VaultKey
from vault_sessions import Instant, VaultSessions


class Clock:
    def __init__(self) -> None:
        self.value = 1000.0

    def __call__(self) -> Instant:
        return Instant(self.value, self.value)

    def advance(self, seconds: float) -> None:
        self.value += seconds


class DesktopHandoffTests(unittest.TestCase):
    def sessions(self) -> tuple[VaultSessions, Clock, str]:
        clock = Clock()
        sessions = VaultSessions(idle_timeout_ms=60_000, clock=clock)
        web_token = sessions.open(VaultKey(os.urandom(32)), user_id=7)
        return sessions, clock, web_token

    def test_approval_is_required_and_redeem_is_single_use(self) -> None:
        sessions, _, web_token = self.sessions()
        request, secret = sessions.start_desktop_handoff()
        self.assertEqual(
            sessions.poll_desktop_handoff(request, secret), {"state": "pending"}
        )
        self.assertEqual(
            sessions.poll_desktop_handoff(request, "x" * 43), {"state": "unavailable"}
        )
        handle = sessions.answer_desktop_handoff(request, True, 7, web_token)
        self.assertIsNotNone(handle)
        approved = sessions.poll_desktop_handoff(request, secret)
        self.assertEqual(approved["state"], "approved")
        self.assertEqual(approved["id"], handle)
        sessions.resolve(approved["session_token"])
        self.assertEqual(
            sessions.poll_desktop_handoff(request, secret), {"state": "expired"}
        )

    def test_denial_never_issues_a_session(self) -> None:
        sessions, _, web_token = self.sessions()
        request, secret = sessions.start_desktop_handoff()
        self.assertEqual(
            sessions.answer_desktop_handoff(request, False, 7, web_token), ""
        )
        self.assertEqual(
            sessions.poll_desktop_handoff(request, secret), {"state": "denied"}
        )

    def test_expiry_removes_pending_and_approved_access(self) -> None:
        sessions, clock, web_token = self.sessions()
        pending, pending_secret = sessions.start_desktop_handoff()
        clock.advance(301)
        self.assertEqual(
            sessions.poll_desktop_handoff(pending, pending_secret), {"state": "expired"}
        )
        sessions, clock, web_token = self.sessions()
        approved, approved_secret = sessions.start_desktop_handoff()
        self.assertIsNotNone(
            sessions.answer_desktop_handoff(approved, True, 7, web_token)
        )
        clock.advance(301)
        self.assertEqual(
            sessions.poll_desktop_handoff(approved, approved_secret),
            {"state": "expired"},
        )

    def test_revoke_before_redeem_and_after_redeem(self) -> None:
        sessions, _, web_token = self.sessions()
        request, secret = sessions.start_desktop_handoff()
        handle = sessions.answer_desktop_handoff(request, True, 7, web_token)
        self.assertIsNotNone(handle)
        self.assertTrue(sessions.revoke_desktop(handle or "", 7))
        self.assertEqual(
            sessions.poll_desktop_handoff(request, secret), {"state": "revoked"}
        )

        request, secret = sessions.start_desktop_handoff()
        handle = sessions.answer_desktop_handoff(request, True, 7, web_token)
        approved = sessions.poll_desktop_handoff(request, secret)
        token = approved["session_token"]
        self.assertTrue(sessions.revoke_desktop(handle or "", 7))
        with self.assertRaises(SessionRequired):
            sessions.resolve(token)

    def test_cancel_prevents_approval_and_revokes_unclaimed_session(self) -> None:
        sessions, _, web_token = self.sessions()
        request, secret = sessions.start_desktop_handoff()
        sessions.cancel_desktop_handoff(request, "x" * 43)
        self.assertEqual(
            sessions.poll_desktop_handoff(request, secret), {"state": "pending"}
        )
        sessions.cancel_desktop_handoff(request, secret)
        self.assertIsNone(sessions.answer_desktop_handoff(request, True, 7, web_token))

        request, secret = sessions.start_desktop_handoff()
        handle = sessions.answer_desktop_handoff(request, True, 7, web_token)
        sessions.cancel_desktop_handoff(request, secret)
        self.assertFalse(sessions.revoke_desktop(handle or "", 7))
        self.assertEqual(
            sessions.poll_desktop_handoff(request, secret), {"state": "expired"}
        )


if __name__ == "__main__":
    unittest.main()
