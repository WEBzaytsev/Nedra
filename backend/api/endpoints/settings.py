from fastapi import APIRouter, Depends

from api.endpoints.deps import (
    AdminContextDep,
    SettingsCRUDDep,
    get_vault_key,
    require_master_password,
)
from schemas import SettingsResponse, SettingsUpdate

router = APIRouter(
    tags=["settings"],
    dependencies=[Depends(require_master_password), Depends(get_vault_key)],
)


@router.get("", name="settings:get", response_model=SettingsResponse)
async def get_settings(crud: SettingsCRUDDep) -> SettingsResponse:
    return await crud.get_settings()


@router.patch("", name="settings:update", response_model=SettingsResponse)
async def update_settings(
    body: SettingsUpdate,
    crud: SettingsCRUDDep,
    _context: AdminContextDep,
) -> SettingsResponse:
    return await crud.update_settings(body)
