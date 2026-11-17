import logging
from typing import Literal

from sqlalchemy import select

from crud.base import BaseCRUD
from crud.records import open_attachment_content, open_attachment_metadata, open_entry
from errors import InvalidRequest, NotFound, VaultDamaged
from helpers import VaultKey
from models import AttachmentModel, EntryModel
from schemas import DamagedRows, PasswordDelete

logger = logging.getLogger(__name__)

DamagedKind = Literal["entries", "attachments"]


def entry_is_damaged(key: VaultKey, entry: EntryModel) -> bool:
    try:
        open_entry(key, entry)
    except VaultDamaged:
        return True
    return False


class DamageCRUD(BaseCRUD):
    """
    Rows that fail authenticated decryption or their format check. Listings
    skip them so the rest of the vault stays usable; this finds them and
    removes one only after checking, under the write lock, that it really
    cannot be read. Backups and master password changes refuse to run while
    any remain.
    """

    def __init__(
        self,
        session,
        *,
        entry_ids: list[int] | None = None,
        owner_id: int | None = None,
    ) -> None:
        super().__init__(session)
        self.entry_ids = entry_ids
        self.owner_id = owner_id

    async def _attachment_is_damaged(
        self, key: VaultKey, attachment: AttachmentModel
    ) -> bool:
        entry = await self.session.get(EntryModel, attachment.entry_id)
        if entry is None:
            return True
        try:
            open_attachment_metadata(key, attachment, entry.uid)
            open_attachment_content(key, attachment, entry.uid)
        except VaultDamaged:
            return True
        return False

    async def find(self, key: VaultKey) -> DamagedRows:
        entry_statement = select(EntryModel).order_by(EntryModel.id)
        attachment_statement = select(AttachmentModel.id).order_by(AttachmentModel.id)
        if self.entry_ids is not None:
            entry_statement = entry_statement.where(EntryModel.id.in_(self.entry_ids))
            attachment_statement = attachment_statement.where(
                AttachmentModel.entry_id.in_(self.entry_ids)
            )
        entries = [
            entry.id
            for entry in (await self.session.scalars(entry_statement))
            if entry_is_damaged(key, entry)
        ]
        attachments = []
        ids = (await self.session.scalars(attachment_statement)).all()
        for attachment_id in ids:
            attachment = await self.session.get_one(AttachmentModel, attachment_id)
            if await self._attachment_is_damaged(key, attachment):
                attachments.append(attachment_id)
            self.session.expunge(attachment)
        return DamagedRows(entries=entries, attachments=attachments)

    async def remove(
        self, key: VaultKey, kind: DamagedKind, row_id: int
    ) -> PasswordDelete:
        if kind == "entries":
            row = await self.session.get(EntryModel, row_id)
            if (
                row is not None
                and self.owner_id is not None
                and row.owner_id != self.owner_id
            ):
                raise NotFound("No such row.")
            damaged = row is not None and entry_is_damaged(key, row)
        else:
            row = await self.session.get(AttachmentModel, row_id)
            entry = (
                await self.session.get(EntryModel, row.entry_id)
                if row is not None
                else None
            )
            if (
                row is not None
                and self.owner_id is not None
                and (entry is None or entry.owner_id != self.owner_id)
            ):
                raise NotFound("No such row.")
            damaged = row is not None and await self._attachment_is_damaged(key, row)
        if row is None:
            raise NotFound("No such row.")
        if not damaged:
            raise InvalidRequest("That row is not damaged; nothing was removed.")
        await self.session.delete(row)
        await self.session.flush()
        logger.warning("Removed damaged %s row #%s.", kind, row_id)
        return PasswordDelete(deleted=True, detail="Damaged row removed.")
