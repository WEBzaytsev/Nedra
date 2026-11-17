from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from crud.engine import Database
from storage import identity_problem


async def schema_state(database: Database) -> str:
    try:
        async with database.engine.connect() as connection:
            application_id = await connection.scalar(text("PRAGMA application_id"))
            user_version = await connection.scalar(text("PRAGMA user_version"))
    except (SQLAlchemyError, OSError):
        return "unknown"
    if identity_problem(application_id or 0, user_version or 0):
        return "unknown"
    return "current"
