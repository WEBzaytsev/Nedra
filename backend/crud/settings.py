from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from crud.base import BaseCRUD
from crud.engine import after_commit
from models import SettingsModel
from schemas import SettingsResponse, SettingsUpdate
from settings import get_vault_defaults
from vault_sessions import VaultSessions


class SettingsCRUD(BaseCRUD):
    def __init__(self, session: AsyncSession, vault_sessions: VaultSessions) -> None:
        super().__init__(session)
        self.vault_sessions = vault_sessions

    async def _stored(self) -> SettingsModel | None:
        return await self.session.scalar(
            select(SettingsModel).order_by(SettingsModel.id).limit(1)
        )

    async def _get_or_create(self) -> SettingsModel:
        model = await self._stored()
        if model is None:
            model = SettingsModel(**get_vault_defaults().model_dump())
            self.session.add(model)
            await self.session.flush()
        return model

    @staticmethod
    def _to_response(model: SettingsModel) -> SettingsResponse:
        return SettingsResponse(
            inactivity_ms=model.inactivity_ms,
            warn_before_ms=model.warn_before_ms,
            hidden_ms=model.hidden_ms,
            debounce_ms=model.debounce_ms,
            clipboard_clear_ms=model.clipboard_clear_ms,
            update_check_enabled=model.update_check_enabled,
        )

    async def inactivity_ms(self) -> int:
        stored = await self.session.scalar(
            select(SettingsModel.inactivity_ms).order_by(SettingsModel.id).limit(1)
        )
        return get_vault_defaults().inactivity_ms if stored is None else stored

    async def get_settings(self) -> SettingsResponse:
        model = await self._stored()
        if model is None:
            return SettingsResponse(**get_vault_defaults().model_dump())
        return self._to_response(model)

    async def update_settings(self, data: SettingsUpdate) -> SettingsResponse:
        model = await self._get_or_create()
        for field, value in data.model_dump().items():
            setattr(model, field, value)
        self.session.add(model)
        await self.session.flush()
        idle_timeout_ms = model.inactivity_ms
        after_commit(
            self.session, lambda: self.vault_sessions.set_idle_timeout(idle_timeout_ms)
        )
        return self._to_response(model)
