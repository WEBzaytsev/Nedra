import asyncio
import os
from pathlib import Path

from fastapi import FastAPI
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from main import get_application

_WROTE = "paused_server_wrote"


def create_app() -> FastAPI:
    """The real app, except that a write transaction stops right before its
    commit, after every change was flushed to SQLite, and announces it with a
    marker file, so a test can kill the process at that point."""
    marker = Path(os.environ["NEDRA_TEST_PAUSE_MARKER"])
    commit = AsyncSession.commit

    @event.listens_for(Session, "after_flush")
    def wrote(session: Session, _context: object) -> None:
        session.info[_WROTE] = True

    async def paused_commit(self: AsyncSession) -> None:
        if self.sync_session.info.get(_WROTE):
            marker.touch()
            await asyncio.Event().wait()
        await commit(self)

    AsyncSession.commit = paused_commit
    return get_application()
