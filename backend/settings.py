from functools import lru_cache
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def _package_version() -> str:
    try:
        return version("backend")
    except PackageNotFoundError:
        import pathlib
        import tomllib

        try:
            pyproject = pathlib.Path(__file__).with_name("pyproject.toml")
            return tomllib.loads(pyproject.read_text())["project"]["version"]
        except Exception:
            return "0.0.0"


class APISettings(BaseSettings):
    debug: bool = False
    docs_url: str = "/docs"
    openapi_url: str = "/openapi.json"
    redoc_url: str = "/redoc"
    title: str = "CipherMoth API Service"
    version: str = _package_version()
    disable_docs: bool = False
    cors_origins: list[str] = ["http://localhost:3000"]
    webauthn_rp_ids: list[str] = ["localhost"]
    mcp_max_request_bytes: int = Field(default=1_048_576, ge=1_024, le=4_194_304)

    @field_validator("webauthn_rp_ids")
    @classmethod
    def _trusted_webauthn_rps(cls, value: list[str]) -> list[str]:
        if not value or any(
            not rp or "/" in rp or ":" in rp or rp != rp.lower() for rp in value
        ):
            raise ValueError("webauthn_rp_ids must contain host names only")
        return list(dict.fromkeys(value))

    @property
    def fastapi_kwargs(self) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            "debug": self.debug,
            "docs_url": self.docs_url,
            "openapi_url": self.openapi_url,
            "redoc_url": self.redoc_url,
            "title": self.title,
            "version": self.version,
        }
        if self.disable_docs:
            kwargs.update({"docs_url": None, "openapi_url": None, "redoc_url": None})
        return kwargs

    model_config = {"validate_assignment": True}


SETTINGS_DEFAULTS = {
    "inactivity_ms": 120_000,
    "warn_before_ms": 60_000,
    "hidden_ms": 60_000,
    "debounce_ms": 1_000,
    "clipboard_clear_ms": 30_000,
    "update_check_enabled": True,
}


class VaultDefaults(BaseSettings):
    inactivity_ms: int = Field(
        default=SETTINGS_DEFAULTS["inactivity_ms"], ge=30_000, le=3_600_000
    )
    warn_before_ms: int = Field(
        default=SETTINGS_DEFAULTS["warn_before_ms"], ge=5_000, le=600_000
    )
    hidden_ms: int = Field(
        default=SETTINGS_DEFAULTS["hidden_ms"], ge=10_000, le=3_600_000
    )
    debounce_ms: int = Field(
        default=SETTINGS_DEFAULTS["debounce_ms"], ge=100, le=10_000
    )
    clipboard_clear_ms: int = Field(
        default=SETTINGS_DEFAULTS["clipboard_clear_ms"], ge=5_000, le=600_000
    )
    update_check_enabled: bool = SETTINGS_DEFAULTS["update_check_enabled"]

    model_config = SettingsConfigDict(env_prefix="CIPHERMOTH_", extra="ignore")

    @model_validator(mode="after")
    def _warning_comes_before_the_lock(self) -> "VaultDefaults":
        if self.warn_before_ms >= self.inactivity_ms:
            raise ValueError("warn_before_ms must be shorter than inactivity_ms.")
        return self


@lru_cache
def get_vault_defaults() -> VaultDefaults:
    return VaultDefaults()


class StorageSettings(BaseSettings):
    data_dir: Path = Path("data")

    model_config = SettingsConfigDict(env_prefix="CIPHERMOTH_", extra="ignore")


@lru_cache
def get_api_settings() -> APISettings:
    return APISettings()


@lru_cache
def get_storage_settings() -> StorageSettings:
    return StorageSettings()
