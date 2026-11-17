"""Read-only, ACL-authorized data for Nedra's browser extension."""

import logging
import time
from dataclasses import dataclass

from sqlalchemy import select

from crud.access import EntryACL
from crud.auth import AuthContext
from crud.base import BaseCRUD
from crud.records import EntryDocument, open_entry
from errors import InvalidRequest, NotFound, OriginMismatch, VaultDamaged
from helpers import VaultKey, generate_totp
from models import EntryModel
from schemas import (
    EntryPermission,
    ExtensionCredential,
    ExtensionLogin,
    ExtensionLogins,
    ExtensionTotp,
)
from url_match import Origin, candidate_filter, could_match, normalize, origins_match
from validators import normalize_totp_secret

logger = logging.getLogger(__name__)
MAX_RESULTS = 50
TOTP_PERIOD = 30


@dataclass(frozen=True, slots=True)
class _Login:
    model: EntryModel
    document: EntryDocument
    origin: Origin | None


def _display_host(origin: object | None) -> str | None:
    if origin is None:
        return None
    text = str(origin)
    return text if text.startswith("http://") else text.removeprefix("https://")


class ExtensionCRUD(BaseCRUD):
    def __init__(self, session, context: AuthContext) -> None:
        super().__init__(session)
        self.acl = EntryACL(session, context)

    @staticmethod
    def _page(origin: str):
        page = normalize(origin)
        if page is None:
            raise InvalidRequest("This page has no web address Nedra can fill.")
        return page

    async def _logins(self, key: VaultKey, needle: str | None = None) -> list[_Login]:
        # The client supplies neither IDs nor access selection: effective ACL is
        # recomputed for every request, including direct, group, folder and expiry.
        ids = await self.acl.visible_ids(deleted=False)
        if not ids:
            return []
        models = (
            await self.session.scalars(
                select(EntryModel).where(
                    EntryModel.id.in_(ids), EntryModel.deleted.is_(None)
                )
            )
        ).all()
        logins: list[_Login] = []
        for model in models:
            try:
                document = open_entry(key, model)
            except VaultDamaged:
                logger.warning("Entry #%s is damaged; not listed.", model.id)
                continue
            if document.kind != "login" or (
                needle is not None
                and not (document.url and could_match(needle, document.url))
            ):
                continue
            logins.append(_Login(model, document, normalize(document.url)))
        return logins

    @staticmethod
    def _listing(logins: list[_Login]) -> ExtensionLogins:
        logins.sort(
            key=lambda login: (
                not login.document.favorite,
                login.document.name.casefold(),
                login.document.name,
                login.model.id,
            )
        )
        return ExtensionLogins(
            logins=[
                ExtensionLogin(
                    id=login.model.id,
                    name=login.document.name,
                    username=login.document.username,
                    host=_display_host(login.origin),
                    favorite=login.document.favorite,
                    has_totp=bool(login.document.totp_secret),
                )
                for login in logins[:MAX_RESULTS]
            ],
            truncated=len(logins) > MAX_RESULTS,
        )

    async def matches(
        self, key: VaultKey, origin: str, *, subdomains: bool
    ) -> ExtensionLogins:
        page = self._page(origin)
        needle = candidate_filter(page, subdomains=subdomains)
        return self._listing(
            [
                login
                for login in await self._logins(key, needle)
                if login.origin is not None
                and origins_match(page, login.origin, subdomains=subdomains)
            ]
        )

    async def search(self, key: VaultKey, query: str) -> ExtensionLogins:
        needle = query.strip().casefold()
        return self._listing(
            [
                login
                for login in await self._logins(key)
                if not needle
                or any(
                    needle in value.casefold()
                    for value in (
                        login.document.name,
                        login.document.username or "",
                        _display_host(login.origin) or "",
                    )
                )
            ]
        )

    async def _login(
        self,
        key: VaultKey,
        entry_id: int,
        origin: str,
        *,
        subdomains: bool,
        confirmed_mismatch: bool,
    ) -> EntryDocument:
        page = self._page(origin)
        await self.acl.require(entry_id, EntryPermission.read)
        model = await self.session.scalar(
            select(EntryModel).where(
                EntryModel.id == entry_id, EntryModel.deleted.is_(None)
            )
        )
        if model is None:
            raise NotFound("No such login in the vault.")
        document = open_entry(key, model)
        if document.kind != "login":
            raise NotFound("No such login in the vault.")
        saved = normalize(document.url)
        if (
            saved is None or not origins_match(page, saved, subdomains=subdomains)
        ) and not confirmed_mismatch:
            raise OriginMismatch(
                "This login is saved for another site. Confirm in the extension first."
            )
        return document

    async def credential(
        self,
        key: VaultKey,
        entry_id: int,
        origin: str,
        *,
        subdomains: bool,
        confirmed_mismatch: bool,
    ) -> ExtensionCredential:
        document = await self._login(
            key,
            entry_id,
            origin,
            subdomains=subdomains,
            confirmed_mismatch=confirmed_mismatch,
        )
        return ExtensionCredential(username=document.username, password=document.value)

    async def totp(
        self,
        key: VaultKey,
        entry_id: int,
        origin: str,
        *,
        subdomains: bool,
        confirmed_mismatch: bool,
    ) -> ExtensionTotp:
        document = await self._login(
            key,
            entry_id,
            origin,
            subdomains=subdomains,
            confirmed_mismatch=confirmed_mismatch,
        )
        try:
            secret = normalize_totp_secret(document.totp_secret)
        except ValueError:
            raise InvalidRequest("This login's 2FA secret is not valid.") from None
        if secret is None:
            raise NotFound("This login has no 2FA code.")
        now = int(time.time())
        try:
            code = generate_totp(secret, period=TOTP_PERIOD, now=now)
        except ValueError:
            raise InvalidRequest("This login's 2FA secret is not valid.") from None
        return ExtensionTotp(code=code, expires_in=TOTP_PERIOD - now % TOTP_PERIOD)
