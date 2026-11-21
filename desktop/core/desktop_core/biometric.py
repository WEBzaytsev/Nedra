import base64
import json

from crud.auth import AuthCRUD
from crud.device_unlock import DeviceUnlockCRUD
from crud.security_factor import SecurityFactorCRUD
from errors import Forbidden, InvalidRequest, NotFound, SessionRequired, VaultError
from schemas import SecurityKeyAssertion


def _decode(value: object, *, minimum: int, maximum: int) -> bytes:
    if not isinstance(value, str) or len(value) > maximum * 2:
        raise InvalidRequest("The Touch ID request is malformed.")
    try:
        result = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (ValueError, TypeError):
        raise InvalidRequest("The Touch ID request is malformed.") from None
    if not minimum <= len(result) <= maximum:
        raise InvalidRequest("The Touch ID request is malformed.")
    return result


def _assertion(value: object) -> SecurityKeyAssertion | None:
    if value is None:
        return None
    try:
        return SecurityKeyAssertion.model_validate(value)
    except ValueError:
        raise InvalidRequest("The security-key assertion is malformed.") from None


def _body(raw: bytes) -> dict[str, object]:
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise InvalidRequest("The Touch ID request is malformed.") from None
    if not isinstance(value, dict):
        raise InvalidRequest("The Touch ID request is malformed.")
    return value


def _text(value: object, *, maximum: int, optional: bool = False) -> str | None:
    if value is None and optional:
        return None
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise InvalidRequest("The Touch ID request is malformed.")
    return value


def _id(value: object) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise InvalidRequest("The Touch ID request is malformed.")
    return value


def _response(value: object, status: int = 200):
    return status, [], json.dumps(value, separators=(",", ":")).encode()


async def _call(app, header, raw: bytes):
    operation = header.get("native")
    fields = _body(raw) if raw else {}
    database = app.state.database
    sessions = app.state.vault_sessions
    write = operation in {"biometric_enroll", "biometric_login", "biometric_remove"}
    async with database.transaction(write=write) as session:
        auth = AuthCRUD(session, sessions, database)
        factors = SecurityFactorCRUD(session, app.state.security_challenges, sessions)
        devices = DeviceUnlockCRUD(session, app.state.security_challenges, sessions)
        if operation == "biometric_login_options":
            username = _text(fields.get("username"), maximum=64)
            assert username is not None
            return _response(await devices.native_login_options(username, factors))
        if operation == "biometric_material":
            username = _text(fields.get("username"), maximum=64)
            assert username is not None
            material = await devices.native_material(
                username, _id(fields.get("device_id"))
            )
            if material is None:
                raise NotFound("Touch ID is not enrolled for this account.")
            return _response(
                {"material": base64.urlsafe_b64encode(material).rstrip(b"=").decode()}
            )
        token = header.get("session")
        if not isinstance(token, str):
            raise SessionRequired("The vault is locked. Unlock it first.")
        context = await auth.context(token)
        if operation == "biometric_status":
            return _response(await devices.native_status(context.user.id))
        if operation == "biometric_enroll":
            name = _text(fields.get("name"), maximum=64)
            password = _text(fields.get("current_password"), maximum=4096)
            assert name is not None and password is not None
            result = await devices.native_enroll(
                context,
                name=name,
                current_password=password,
                material=_decode(fields.get("material"), minimum=66, maximum=2048),
                secret=_decode(fields.get("secret"), minimum=32, maximum=32),
                security_key_assertion=_assertion(fields.get("security_key_assertion")),
                factors=factors,
            )
            return _response(result)
        if operation == "biometric_remove":
            return _response(
                await devices.native_remove(context, _id(fields.get("id")))
            )
        raise InvalidRequest("Unknown Touch ID operation.")


async def _login(app, header, raw: bytes):
    fields = _body(raw)
    database = app.state.database
    sessions = app.state.vault_sessions
    async with database.transaction(write=True) as session:
        auth = AuthCRUD(session, sessions, database)
        factors = SecurityFactorCRUD(session, app.state.security_challenges, sessions)
        devices = DeviceUnlockCRUD(session, app.state.security_challenges, sessions)
        username = _text(fields.get("username"), maximum=64)
        password = _text(fields.get("password"), maximum=4096, optional=True)
        assert username is not None
        unlocked = await devices.native_login(
            username,
            _id(fields.get("device_id")),
            _decode(fields.get("secret"), minimum=32, maximum=32),
            password,
            _assertion(fields.get("security_key_assertion")),
            factors,
        )
        if unlocked is None:
            return _response({"valid": False})
        user_id, key, second_factor = unlocked
        response = await auth.login_with_device(user_id, key, second_factor)
        return _response(response.model_dump(mode="json"))


async def call(app, header, body):
    try:
        if header.get("native") == "biometric_login":
            return await _login(app, header, body)
        return await _call(app, header, body)
    except SessionRequired as error:
        return _response({"detail": str(error)}, 401)
    except Forbidden as error:
        return _response({"detail": str(error)}, 403)
    except NotFound as error:
        return _response({"detail": str(error)}, 404)
    except (InvalidRequest, VaultError) as error:
        return _response({"detail": str(error)}, 400)
