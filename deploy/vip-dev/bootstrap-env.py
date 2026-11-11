#!/usr/bin/env python3
"""Generate NEW self-hosted Supabase credentials without displaying them.

Run on the deployment host: python3 bootstrap-env.py /srv/dev/apps/aural/.env
Existing files are never overwritten. Runtime speech settings are added separately.
"""
import argparse
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import time


def jwt(secret: str, role: str) -> str:
    def enc(value: bytes) -> str:
        return base64.urlsafe_b64encode(value).rstrip(b"=").decode()
    issued = int(time.time())
    header = enc(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    body = enc(json.dumps({"role": role, "iss": "supabase", "iat": issued, "exp": issued + 31536000}, separators=(",", ":")).encode())
    payload = header + "." + body
    return payload + "." + enc(hmac.new(secret.encode(), payload.encode(), hashlib.sha256).digest())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path)
    parser.add_argument("--app-url", default="https://aural.dev.skaaslabs.com")
    parser.add_argument("--supabase-url", default="https://aural-api.dev.skaaslabs.com")
    args = parser.parse_args()
    secret = secrets.token_urlsafe(48)
    values = {
        "POSTGRES_PASSWORD": secrets.token_hex(24),
        "JWT_SECRET": secret,
        "ANON_KEY": jwt(secret, "anon"),
        "SERVICE_ROLE_KEY": jwt(secret, "service_role"),
        "PUBLIC_APP_URL": args.app_url,
        "PUBLIC_SUPABASE_URL": args.supabase_url,
    }
    args.path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(args.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w") as out:
        for key, value in values.items():
            if any(c in value for c in "\n\r"):
                raise ValueError("Environment values cannot contain line breaks")
            out.write(f"{key}={value}\n")
    print("Created protected configuration:", args.path)
    print("Variable names:", ", ".join(values))


if __name__ == "__main__":
    main()
