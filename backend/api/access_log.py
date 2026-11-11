import logging
import re

_ENTRIES_PREFIX = re.compile(r"^(?P<prefix>.*?/passwords/)(?P<rest>.+)$")
_LITERAL_ROUTES = {
    ("GET", "trash"),
    ("POST", "create"),
    ("POST", "history/reuse"),
    ("PATCH", "update"),
    ("POST", "import"),
    ("POST", "import/csv"),
    ("POST", "backup"),
}
_ENTRY_ROUTE = re.compile(
    r"^[^/]+(?P<suffix>|/favorite|/restore|/purge|/attachments(?:/\d+)?)$"
)


def redact_path(method: str, path_with_query: str) -> str:
    """
    Replace entry names in a request path with ``{password_name}`` and drop the
    query string. Unrecognised paths under ``/passwords/`` are redacted entirely,
    since a name can itself contain a slash.
    """
    path, has_query, _ = path_with_query.partition("?")
    match = _ENTRIES_PREFIX.match(path)
    if match and (method, match["rest"]) not in _LITERAL_ROUTES:
        entry = _ENTRY_ROUTE.match(match["rest"])
        tail = f"{{password_name}}{entry['suffix']}" if entry else "{redacted}"
        path = match["prefix"] + tail
    return path + ("?{redacted}" if has_query else "")


class RedactEntryNames(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if isinstance(args, tuple) and len(args) == 5:
            client, method, path, version, status = args
            record.args = (
                client,
                method,
                redact_path(str(method), str(path)),
                version,
                status,
            )
        return True


def install_access_log_redaction() -> None:
    access = logging.getLogger("uvicorn.access")
    if not any(isinstance(f, RedactEntryNames) for f in access.filters):
        access.addFilter(RedactEntryNames())
