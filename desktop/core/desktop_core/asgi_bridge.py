import asyncio
from collections.abc import Awaitable, Callable
from urllib.parse import unquote

ASGIApp = Callable[..., Awaitable[None]]


class ResponseTooLarge(Exception):
    pass


class NoResponse(Exception):
    pass


async def call(
    app: ASGIApp,
    method: str,
    raw_path: str,
    query: str,
    headers: list[tuple[str, str]],
    body: bytes,
    max_response: int,
    *,
    output=None,
    input_chunks=None,
    input_size=None,
) -> tuple[int, list[tuple[str, str]], bytes]:
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.4"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": unquote(raw_path),
        "raw_path": raw_path.encode("ascii"),
        "query_string": query.encode("ascii"),
        "root_path": "",
        "headers": [
            (name.lower().encode("latin-1"), value.encode("latin-1"))
            for name, value in [
                *headers,
                (
                    "content-length",
                    str(len(body) if input_size is None else input_size),
                ),
            ]
        ],
        "client": ("desktop-ipc", 0),
        "server": ("nedra-desktop", 0),
        "state": {},
    }
    request_sent = False
    finished = asyncio.Event()
    status: int | None = None
    response_headers: list[tuple[str, str]] = []
    chunks: list[bytes] = []
    size = 0

    async def receive() -> dict:
        nonlocal request_sent
        if input_chunks is not None and not request_sent:
            try:
                chunk = next(input_chunks)
                return {"type": "http.request", "body": chunk, "more_body": True}
            except StopIteration:
                request_sent = True
                return {"type": "http.request", "body": b"", "more_body": False}
        if not request_sent:
            request_sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        await finished.wait()
        return {"type": "http.disconnect"}

    async def send(message: dict) -> None:
        nonlocal status, response_headers, size
        if message["type"] == "http.response.start":
            status = message["status"]
            response_headers = [
                (name.decode("latin-1"), value.decode("latin-1"))
                for name, value in message.get("headers", [])
            ]
        elif message["type"] == "http.response.body":
            chunk = message.get("body", b"")
            size += len(chunk)
            if size > max_response:
                raise ResponseTooLarge
            if output is not None and status == 200:
                output.write(chunk)
            else:
                if size > 24 * 1024 * 1024:
                    raise ResponseTooLarge
                chunks.append(chunk)
            if not message.get("more_body", False):
                finished.set()

    try:
        await app(scope, receive, send)
    finally:
        finished.set()
    if status is None:
        raise NoResponse
    return status, response_headers, b"".join(chunks)
