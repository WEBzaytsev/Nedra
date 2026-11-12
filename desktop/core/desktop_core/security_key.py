"""One security key operation for the desktop shell, over this process's stdin
and stdout. The app's web view has no WebAuthn, so the shell runs the core in
this mode to talk to the key over USB (``security_key_client``, shared with the
CLI). The shell kills the process to cancel. The PIN arrives on stdin, never in
the command line, and is never logged or echoed."""

import json
import sys

_MAX_REQUEST = 64 * 1024


def _reply(payload: dict) -> int:
    sys.stdout.write(json.dumps(payload))
    sys.stdout.flush()
    return 0


def run() -> int:
    from security_key_client import (
        DESKTOP_RP_ID,
        SecurityKeyCancelled,
        SecurityKeyError,
        SecurityKeyPinInvalid,
        answer,
        register,
    )
    from settings import get_api_settings

    raw = sys.stdin.read(_MAX_REQUEST + 1)
    if len(raw) > _MAX_REQUEST:
        return _reply({"error": "failed", "message": "Request too large."})
    try:
        request = json.loads(raw)
        op = request["op"]
        pin = request.get("pin") or None
        if pin is not None and (not isinstance(pin, str) or len(pin) > 255):
            raise ValueError
    except (ValueError, KeyError, TypeError):
        return _reply({"error": "failed", "message": "Invalid request."})

    def get_pin() -> str | None:
        return pin

    try:
        if op == "register":
            rp_id = request["options"].get("rp_id", DESKTOP_RP_ID)
            trusted_rp_ids = get_api_settings().webauthn_rp_ids
            if not isinstance(rp_id, str) or rp_id not in trusted_rp_ids:
                raise SecurityKeyError(
                    "This desktop is not configured for the security key's "
                    "relying party. Set WEBAUTHN_RP_IDS to the exact trusted "
                    "host and restart it."
                )
            result = register(request["options"], rp_id, get_pin=get_pin)
            result["rp_id"] = rp_id
        elif op == "answer":
            result = answer(request["challenge"], get_pin=get_pin)
        else:
            return _reply({"error": "failed", "message": "Unknown operation."})
    except SecurityKeyCancelled:
        return _reply({"error": "cancelled", "message": "Cancelled."})
    except SecurityKeyPinInvalid as error:
        return _reply({"error": "pin-invalid", "message": str(error)})
    except SecurityKeyError as error:
        return _reply({"error": "failed", "message": str(error)})
    except (KeyError, TypeError, ValueError):
        return _reply({"error": "failed", "message": "Invalid request."})
    return _reply({"ok": result})
