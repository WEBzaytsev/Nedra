from urllib.parse import parse_qs, urlparse

_MIN_MASTER_PASSWORD_LENGTH = 12
_MIN_CHARACTER_CLASSES = 2

_BASE32_ALPHABET = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")


def _character_classes(password: str) -> int:
    return sum(
        (
            any(c.islower() for c in password),
            any(c.isupper() for c in password),
            any(c.isdigit() for c in password),
            any(not c.isalnum() for c in password),
        )
    )


def validate_master_password_strength(password: str) -> str:
    if len(password) < _MIN_MASTER_PASSWORD_LENGTH:
        raise ValueError(
            f"Master password must be at least {_MIN_MASTER_PASSWORD_LENGTH} "
            "characters long."
        )

    if _character_classes(password) < _MIN_CHARACTER_CLASSES:
        raise ValueError(
            "Master password must mix at least two of: lowercase, uppercase, "
            "numbers, symbols."
        )

    return password


def require_unicode_text(value: object) -> object:
    for text in value if isinstance(value, list) else (value,):
        if isinstance(text, str):
            try:
                text.encode("utf-8")
            except UnicodeEncodeError:
                raise ValueError(
                    "must be valid Unicode text (no unpaired surrogates)"
                ) from None
    return value


def reject_nul(value: str | None) -> str | None:
    if value is not None and "\x00" in value:
        raise ValueError("must not contain NUL characters")
    return value


def addressable_name(value: str | None) -> str | None:
    if value in (".", ".."):
        raise ValueError("cannot be '.' or '..'")
    if value == "trash":
        raise ValueError("'trash' is reserved, choose another name")
    return value


def normalize_totp_secret_leniently(raw: str | None) -> str | None:
    try:
        return normalize_totp_secret(raw)
    except ValueError:
        return raw


def normalize_totp_secret(raw: str | None) -> str | None:
    if not raw:
        return None

    value = raw.strip()
    if value.lower().startswith("otpauth://"):
        secret = parse_qs(urlparse(value).query).get("secret", [""])[0]
        value = secret

    value = value.replace(" ", "").upper().rstrip("=")
    if not value:
        return None

    if any(c not in _BASE32_ALPHABET for c in value):
        raise ValueError("TOTP secret must be valid base32 or an otpauth:// URI.")

    return value
