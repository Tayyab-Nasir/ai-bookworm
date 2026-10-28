"""Private service identity proof only; not database or operational readiness."""
import asyncio
import base64
import hashlib
import hmac
import re

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from customer_protocol import strict_json

DOMAIN = "bookworm-customer-service-identity-v1"


def customer_identity_router(*, service_token: str, signing_keys: dict[str, bytes]) -> APIRouter:
    keys = dict(signing_keys)
    router = APIRouter()

    @router.post("/v1/internal/customer-text/identity", include_in_schema=False)
    async def identity(request: Request):
        token = request.headers.get("x-service-token", "")
        if not token.isascii() or not hmac.compare_digest(token, service_token):
            raise HTTPException(401, "Invalid service authentication.")
        if (request.url.query or request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json"
                or request.headers.get("content-encoding", "identity") != "identity"):
            raise HTTPException(400, "Invalid service identity challenge.")
        length = request.headers.get("content-length")
        if length is not None and (not length.isascii() or not length.isdecimal() or len(length) > 5 or int(length) > 2048):
            raise HTTPException(413, "Service identity challenge exceeds its limit.")
        data = bytearray()
        try:
            async with asyncio.timeout(5):
                async for chunk in request.stream():
                    if len(data) + len(chunk) > 2048:
                        raise HTTPException(413, "Service identity challenge exceeds its limit.")
                    data.extend(chunk)
            value = strict_json(bytes(data))
            if type(value) is not dict or set(value) != {"keyId", "nonce"}:
                raise ValueError()
            kid, nonce = value["keyId"], value["nonce"]
            if (type(kid) is not str or re.fullmatch(r"[A-Za-z0-9_-]{1,64}", kid) is None or kid not in keys
                    or type(nonce) is not str or re.fullmatch(r"[A-Za-z0-9_-]{43}", nonce) is None):
                raise ValueError()
            decoded = base64.b64decode(nonce + "=", altchars=b"-_", validate=True)
            if len(decoded) != 32 or base64.urlsafe_b64encode(decoded).decode().rstrip("=") != nonce:
                raise ValueError()
            proof = hmac.new(keys[kid], f"{DOMAIN}\n{kid}\n{nonce}".encode("ascii"), hashlib.sha256).hexdigest()
            return JSONResponse({"keyId": kid, "nonce": nonce, "proof": proof}, headers={"cache-control": "no-store"})
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(422, "Invalid service identity challenge.") from None
        finally:
            data[:] = b"\0" * len(data)

    return router
