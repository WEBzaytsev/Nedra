from typing import Annotated

from fastapi import APIRouter, Depends, Response, status

from api.endpoints.deps import get_database
from crud.engine import Database
from crud.health import schema_state
from schemas import HealthResponse
from settings import get_api_settings

router = APIRouter(tags=["health"])


@router.get(
    "",
    name="health:get",
    response_model=HealthResponse,
    responses={status.HTTP_503_SERVICE_UNAVAILABLE: {"model": HealthResponse}},
)
async def get_health(
    database: Annotated[Database, Depends(get_database)], response: Response
) -> HealthResponse:
    schema = await schema_state(database)
    healthy = schema == "current"
    if not healthy:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return HealthResponse(
        status="ok" if healthy else "error",
        version=get_api_settings().version,
        schema_state=schema,
    )
