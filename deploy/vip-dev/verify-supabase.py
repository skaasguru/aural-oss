#!/usr/bin/env python3
"""Exercise real Auth -> profile/RLS -> Storage, then delete all disposable data.

Usage: python3 verify-supabase.py --env .env --base-url http://<gateway>:8000
Uses only the named configuration; credentials and tokens are never printed.
"""
import argparse
import json
from pathlib import Path
import secrets
import urllib.error
import urllib.parse
import urllib.request
import uuid


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env", type=Path, required=True)
    parser.add_argument("--base-url", required=True)
    args = parser.parse_args()
    env = dict(line.split("=", 1) for line in args.env.read_text().splitlines() if line and not line.startswith("#") and "=" in line)
    base = args.base_url.rstrip("/")
    anon, service = env["ANON_KEY"], env["SERVICE_ROLE_KEY"]

    def request(path, method="GET", data=None, token=None, binary=False):
        headers = {"apikey": anon, "Authorization": "Bearer " + (token or anon)}
        if data is not None:
            headers["Content-Type"] = "text/plain" if binary else "application/json"
            body = data if binary else json.dumps(data).encode()
        else:
            body = None
        try:
            with urllib.request.urlopen(urllib.request.Request(base + path, data=body, headers=headers, method=method), timeout=30) as response:
                raw = response.read()
                return json.loads(raw) if raw and "json" in response.headers.get("Content-Type", "") else raw
        except urllib.error.HTTPError as error:
            raise RuntimeError(f"{method} {path.split('?')[0]} returned HTTP {error.code}") from None

    uid = None
    name = None
    try:
        email = "aural-smoke-" + uuid.uuid4().hex + "@example.com"
        result = request("/auth/v1/signup", "POST", {"email": email, "password": secrets.token_urlsafe(32), "data": {"full_name": "Disposable Aural Smoke"}})
        uid, token = result["user"]["id"], result["access_token"]
        print("PASS: signup and authenticated session")
        profile = request("/rest/v1/profiles?id=eq." + uid + "&select=id,email", token=token)
        assert len(profile) == 1 and profile[0]["email"] == email
        assert request("/rest/v1/profiles?id=eq." + uid + "&select=id") == []
        print("PASS: profile trigger and anonymous RLS isolation")
        name = uid + "/smoke.txt"
        content = b"Aural disposable storage verification."
        request("/storage/v1/object/recordings/" + name, "POST", content, token, binary=True)
        actual = request("/storage/v1/object/authenticated/recordings/" + name, token=token)
        assert actual == content
        print("PASS: private recording bucket upload and authenticated download")
    finally:
        if name:
            request("/storage/v1/object/recordings", "DELETE", {"prefixes": [name]}, service)
        if uid:
            request("/rest/v1/organizations?ownerId=eq." + uid, "DELETE", token=service)
            request("/auth/v1/admin/users/" + uid, "DELETE", token=service)
            assert request("/rest/v1/profiles?id=eq." + uid + "&select=id", token=service) == []
            print("PASS: disposable user, organization, profile and object cleaned up")


if __name__ == "__main__":
    main()
