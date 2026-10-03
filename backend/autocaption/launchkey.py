"""Launch check: the engine only starts when the AutoCaption AE panel starts it.

The panel passes AUTOCAPTION_LAUNCH="<nonce>.<signature>" where the signature is
an HMAC of a fresh random nonce. This stops the engine being started by
double-clicking it or from scripts; it is a deterrent, not a security boundary
(the panel's code ships to every user's machine).
"""
from __future__ import annotations

import hashlib
import hmac
import os
import re

_KEY = bytes.fromhex("6163652d656e67696e652d33663961") + b"\x07cyriqvfx\x11autocaption"
MESSAGE = "This engine runs from the AutoCaption AE panel in After Effects."


def sign(nonce: str) -> str:
    return hmac.new(_KEY, f"{nonce}:autocaption-engine".encode(), hashlib.sha256).hexdigest()


def valid(token: str | None) -> bool:
    if not token or not re.fullmatch(r"[0-9a-f]{32}\.[0-9a-f]{64}", token):
        return False
    nonce, sig = token.split(".")
    return hmac.compare_digest(sig, sign(nonce))


def check() -> bool:
    return valid(os.environ.get("AUTOCAPTION_LAUNCH"))


def token() -> str:
    nonce = os.urandom(16).hex()
    return f"{nonce}.{sign(nonce)}"
