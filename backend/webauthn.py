"""WebAuthn verification for personal FIDO2 factors.

A WebAuthn signature proves the authenticator is present for one fresh challenge.
The PRF output is a separate secret used only to unwrap that user's factor key.
It is supplied by the client and is not authenticated by the assertion, so this
protocol makes no anti-exfiltration or hardware-derived-secret claim for a
compromised browser client.
"""

import hashlib
import logging
import os
import time
from collections import OrderedDict
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, cast
from urllib.parse import urlparse

from fido2 import cbor
from fido2.cose import CoseKey
from fido2.server import Fido2Server
from fido2.utils import websafe_encode
from fido2.webauthn import (
    Aaguid,
    AttestationConveyancePreference,
    AttestedCredentialData,
    AuthenticatorData,
    CollectedClientData,
    PublicKeyCredentialRpEntity,
    UserVerificationRequirement,
)

logging.getLogger("fido2").setLevel(logging.WARNING)

CHALLENGE_BYTES = 32
CHALLENGE_TTL_SECONDS = 300
MAX_PENDING_CHALLENGES = 64
TIMEOUT_MS = 120_000
RP_NAME = "Nedra"
ALGORITHMS = (-7, -8, -257)
USER_VERIFICATION = UserVerificationRequirement.REQUIRED


class VerificationFailed(Exception):
    """A WebAuthn response that is safe to report to the client."""


@dataclass(frozen=True, slots=True)
class _Pending:
    purpose: str
    binding: bytes | None
    data: bytes
    expires: float


class Challenges:
    """Bounded in-memory, one-use challenges. Server restart invalidates them."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._pending: OrderedDict[bytes, _Pending] = OrderedDict()

    def issue(
        self, purpose: str, binding: bytes | None = None, data: bytes = b""
    ) -> bytes:
        now = self._clock()
        for challenge, pending in list(self._pending.items()):
            if pending.expires <= now:
                del self._pending[challenge]
        while len(self._pending) >= MAX_PENDING_CHALLENGES:
            self._pending.popitem(last=False)
        challenge = os.urandom(CHALLENGE_BYTES)
        self._pending[challenge] = _Pending(
            purpose, binding, data, now + CHALLENGE_TTL_SECONDS
        )
        return challenge

    def consume(
        self, challenge: bytes, purpose: str, binding: bytes | None = None
    ) -> bytes:
        pending = self._pending.pop(challenge, None)
        if (
            pending is None
            or pending.purpose != purpose
            or pending.binding != binding
            or pending.expires <= self._clock()
        ):
            raise VerificationFailed(
                "That security-key request expired or was already used. Try again."
            )
        return pending.data


def session_binding(token: str) -> bytes:
    return hashlib.sha256(
        b"ciphermoth/security-key-challenge\x00" + token.encode()
    ).digest()


@dataclass(frozen=True, slots=True)
class Credential:
    credential_id: bytes
    public_key: bytes
    rp_id: str


def client_challenge(client_data_json: bytes) -> bytes:
    try:
        return CollectedClientData(client_data_json).challenge
    except (ValueError, KeyError, TypeError) as error:
        raise VerificationFailed("The security-key response is malformed.") from error


def registration_rp_id(client_data_json: bytes, expected_rp_id: str) -> str:
    try:
        origin = CollectedClientData(client_data_json).origin
    except (ValueError, KeyError, TypeError) as error:
        raise VerificationFailed("The security-key response is malformed.") from error
    parsed = urlparse(origin)
    if parsed.scheme != "https" and parsed.hostname not in {"localhost", "127.0.0.1"}:
        raise VerificationFailed("Security keys require HTTPS or localhost.")
    if not parsed.hostname:
        raise VerificationFailed("The security-key response has no origin.")
    if parsed.hostname != expected_rp_id:
        raise VerificationFailed(
            "The security-key registration used a different relying party."
        )
    return expected_rp_id


def _server(rp_id: str) -> Fido2Server:
    return Fido2Server(
        PublicKeyCredentialRpEntity(name=RP_NAME, id=rp_id),
        attestation=AttestationConveyancePreference.NONE,
    )


def _state(challenge: bytes) -> dict[str, object]:
    return {
        "challenge": websafe_encode(challenge),
        "user_verification": USER_VERIFICATION,
    }


def verify_registration(
    rp_id: str, challenge: bytes, client_data_json: bytes, attestation_object: bytes
) -> Credential:
    try:
        auth_data = _server(rp_id).register_complete(
            _state(challenge),
            {
                "id": "",
                "rawId": "",
                "type": "public-key",
                "response": {
                    "clientDataJSON": websafe_encode(client_data_json),
                    "attestationObject": websafe_encode(attestation_object),
                },
                "clientExtensionResults": {},
            },
        )
    except (ValueError, KeyError, TypeError) as error:
        raise VerificationFailed(
            "The security-key registration did not verify."
        ) from error
    credential = auth_data.credential_data
    if credential is None or credential.public_key.ALGORITHM not in ALGORITHMS:
        raise VerificationFailed("This security key uses an unsupported algorithm.")
    return Credential(
        credential_id=bytes(credential.credential_id),
        public_key=cbor.encode(dict(credential.public_key)),
        rp_id=rp_id,
    )


def verify_assertion(
    credential: Credential,
    challenge: bytes,
    client_data_json: bytes,
    authenticator_data: bytes,
    signature: bytes,
) -> int:
    try:
        decoded = cbor.decode(credential.public_key)
        if not isinstance(decoded, Mapping):
            raise ValueError("not a COSE key")
        public_key = CoseKey.parse(cast(Mapping[int, Any], decoded))
        attested = AttestedCredentialData.create(
            bytes(Aaguid.NONE), credential.credential_id, public_key
        )
        encoded_id = websafe_encode(credential.credential_id)
        _server(credential.rp_id).authenticate_complete(
            _state(challenge),
            [attested],
            {
                "id": encoded_id,
                "rawId": encoded_id,
                "type": "public-key",
                "response": {
                    "clientDataJSON": websafe_encode(client_data_json),
                    "authenticatorData": websafe_encode(authenticator_data),
                    "signature": websafe_encode(signature),
                },
                "clientExtensionResults": {},
            },
        )
        return AuthenticatorData(authenticator_data).counter
    except (ValueError, KeyError, TypeError) as error:
        raise VerificationFailed("The security-key response did not verify.") from error


def counter_advanced(stored: int, received: int) -> bool:
    return (stored == 0 and received == 0) or received > stored
