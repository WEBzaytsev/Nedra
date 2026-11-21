import ipaddress
import re
from dataclasses import dataclass
from functools import cache
from urllib.parse import urlsplit

import idna
from fido2 import rpid

_SCHEME = re.compile(r"^([A-Za-z][A-Za-z0-9+.\-]*):(.*)$", re.DOTALL)
_PORT_ONLY = re.compile(r"^\d+(?:[/?#]|$)")
_FORBIDDEN = re.compile(r"[\x00-\x20\x7f]")
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")
_ASCII_LABEL = re.compile(r"^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$")
_NUMERIC_LABEL = re.compile(r"^(?:0x[0-9a-f]*|[0-9]+)$")
_DEFAULT_PORTS = {"http": 80, "https": 443}
MAX_URL_LENGTH = 2048


@dataclass(frozen=True, slots=True)
class Origin:
    scheme: str
    host: str
    port: int | None

    @property
    def is_ip(self) -> bool:
        return self.host.startswith("[") or _is_ipv4(self.host)

    def __str__(self) -> str:
        port = "" if self.port is None else f":{self.port}"
        return f"{self.scheme}://{self.host}{port}"


def _is_ipv4(host: str) -> bool:
    try:
        ipaddress.IPv4Address(host)
    except ValueError:
        return False
    return True


def _host(raw: str) -> str | None:
    if raw.startswith("["):
        if not raw.endswith("]"):
            return None
        try:
            return f"[{ipaddress.IPv6Address(raw[1:-1]).compressed}]"
        except ValueError:
            return None
    host = raw.lower().rstrip(".")
    if not host or ".." in host:
        return None
    labels = host.split(".")
    if _NUMERIC_LABEL.fullmatch(labels[-1]):
        return str(ipaddress.IPv4Address(host)) if _is_ipv4(host) else None
    if host.isascii() and not any(label.startswith("xn--") for label in labels):
        if all(_ASCII_LABEL.fullmatch(label) for label in labels) and len(host) < 254:
            return host
        return None
    try:
        encoded = idna.encode(host, uts46=True, transitional=False).decode("ascii")
    except (idna.IDNAError, UnicodeError, ValueError):
        return None
    return encoded.rstrip(".") or None


def normalize(url: object) -> Origin | None:
    if not isinstance(url, str) or re.search(r"[\x1c-\x1f\x7f-\x9f]", url):
        return None
    value = url.strip()
    if not value or len(value) > MAX_URL_LENGTH:
        return None
    scheme_match = _SCHEME.match(value)
    if scheme_match and not _PORT_ONLY.match(scheme_match[2]):
        scheme = scheme_match[1].lower()
        if scheme not in _DEFAULT_PORTS or not scheme_match[2].startswith("//"):
            return None
        value = f"{scheme}:{scheme_match[2]}"
    else:
        scheme = "https"
        value = f"https://{value}"
    try:
        parts = urlsplit(value)
        port = parts.port
    except ValueError:
        return None

    if "\\" in value or _CONTROL.search(value) or _FORBIDDEN.search(parts.netloc):
        return None
    netloc = parts.netloc.rpartition("@")[2]
    if not netloc or "%" in netloc:
        return None
    raw_host = netloc
    if raw_host.startswith("["):
        raw_host = raw_host[: raw_host.find("]") + 1]
    elif ":" in raw_host:
        raw_host = raw_host.rsplit(":", 1)[0]
    host = _host(raw_host)
    if host is None:
        return None
    if port == _DEFAULT_PORTS[scheme]:
        port = None
    return Origin(scheme, host, port)


def _ascii_rule(rule: str) -> str | None:
    try:
        return idna.encode(rule, uts46=True, transitional=False).decode("ascii")
    except (idna.IDNAError, UnicodeError, ValueError):
        return None


@cache
def _suffix_rules() -> tuple[frozenset[str], frozenset[str], frozenset[str]]:
    plain: set[str] = set()
    wildcard: set[str] = set()
    exception: set[str] = set()
    with open(rpid.tld_fname, encoding="utf-8") as listing:
        for line in listing:
            rule = line.strip()
            if not rule or rule.startswith("//"):
                continue
            target = plain
            if rule.startswith("!"):
                rule, target = rule[1:], exception
            elif rule.startswith("*."):
                rule, target = rule[2:], wildcard
            ascii_rule = _ascii_rule(rule)
            if ascii_rule:
                target.add(ascii_rule)
    return frozenset(plain), frozenset(wildcard), frozenset(exception)


def public_suffix(host: str) -> str:
    plain, wildcard, exception = _suffix_rules()
    labels = host.split(".")
    for start in range(len(labels)):
        candidate = ".".join(labels[start:])
        if candidate in exception:
            return ".".join(labels[start + 1 :])
        if candidate in plain:
            return candidate
        parent = ".".join(labels[start + 1 :])
        if start + 1 < len(labels) and parent in wildcard:
            return candidate
    return labels[-1]


def registrable_domain(host: str) -> str | None:
    suffix = public_suffix(host)
    if host == suffix:
        return None
    rest = host[: -len(suffix) - 1]
    return f"{rest.rsplit('.', 1)[-1]}.{suffix}"


def origins_match(page: Origin, saved: Origin, *, subdomains: bool = False) -> bool:
    if page.scheme != saved.scheme or page.port != saved.port:
        return False
    if page.host == saved.host:
        return True
    if not subdomains or page.is_ip or saved.is_ip:
        return False
    if not page.host.endswith("." + saved.host):
        return False
    registrable = registrable_domain(saved.host)
    return registrable is not None and registrable == registrable_domain(page.host)


def candidate_filter(page: Origin, *, subdomains: bool) -> str | None:
    if page.is_ip:
        return None
    if subdomains:
        return registrable_domain(page.host) or page.host
    return page.host


def could_match(needle: str | None, saved_url: str) -> bool:
    if needle is None or not saved_url.isascii():
        return True
    return needle in saved_url.lower()


def matches(page_url: object, saved_url: object, *, subdomains: bool = False) -> bool:
    page = normalize(page_url)
    saved = normalize(saved_url)
    if page is None or saved is None:
        return False
    return origins_match(page, saved, subdomains=subdomains)
