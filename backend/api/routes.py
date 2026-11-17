from fastapi import APIRouter, FastAPI
from fastapi.exceptions import RequestValidationError
from starlette.responses import JSONResponse

from api.endpoints import (
    auth,
    extension,
    folders,
    groups,
    health,
    master_password,
    meta,
    password,
    password_access,
    security,
    settings,
    users,
    vault,
)
from api.endpoints.deps import CredentialDep
from api.exceptions import validation_handler, vault_error_handler
from api.responses import inject_responses
from errors import VaultError


def make_api_router() -> APIRouter:
    api_router = APIRouter()

    api_router.responses = inject_responses()

    api_router.include_router(auth.router, prefix="/auth")
    api_router.include_router(extension.router, prefix="/extension")
    api_router.include_router(folders.router, prefix="/folders")
    api_router.include_router(groups.router, prefix="/groups")
    api_router.include_router(master_password.router, prefix="/master_password")
    api_router.include_router(health.router, prefix="/health")
    api_router.include_router(meta.router, prefix="/meta")
    api_router.include_router(password_access.router, prefix="/passwords")
    api_router.include_router(password.router, prefix="/passwords")
    api_router.include_router(security.router, prefix="/security")
    api_router.include_router(settings.router, prefix="/settings")
    api_router.include_router(vault.router, prefix="/vault")
    api_router.include_router(users.router, prefix="/users")

    @api_router.api_route(
        "/{unmatched_path:path}",
        methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        include_in_schema=False,
    )
    async def api_not_found(
        unmatched_path: str, credential: CredentialDep
    ) -> JSONResponse:
        del unmatched_path, credential
        return JSONResponse({"detail": "Not Found"}, status_code=404)

    return api_router


def make_api_exceptions(app: FastAPI) -> None:
    app.add_exception_handler(VaultError, vault_error_handler)
    app.add_exception_handler(RequestValidationError, validation_handler)
