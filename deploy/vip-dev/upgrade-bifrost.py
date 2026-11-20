#!/usr/bin/env python3
"""Upgrade the shared VIP-dev Bifrost to a pinned release with admin auth and per-app virtual keys.

Run ON the VM:  python3 upgrade-bifrost.py /path/to/bifrost-seed.json

Bifrost >= 2.4 serves relays (AssemblyAI Sync STT); >= 2.6 locks the management API until an admin
exists and, with enforce_auth_on_inference, refuses inference without a virtual key. So the image
swap, the seed, the generated credentials and the callers' keys change together, with a rollback.
Prints variable NAMES and statuses only, never secret values.
"""
import json, os, re, secrets, shutil, sqlite3, subprocess, sys, time, urllib.error, urllib.request

VERSION = "v2.6.0"
VIP = "/srv/dev/apps/vip"
AURAL = "/srv/dev/apps/aural"
AURAL_COMPOSE = ["docker", "compose", "-f", "compose.supabase.yaml", "-f", "compose.app.yaml"]


def sh(*args, cwd=None, check=True):
    r = subprocess.run(args, cwd=cwd, text=True, capture_output=True)
    if check and r.returncode:
        raise SystemExit(f"FAILED {' '.join(args[:4])}: {r.stderr.strip()[-400:]}")
    return r


def read_env(path):
    return dict(l.rstrip("\n").split("=", 1) for l in open(path) if "=" in l and not l.lstrip().startswith("#"))


def set_env(path, values):
    lines = open(path).read().splitlines()
    for key, value in values.items():
        row = f"{key}={value}"
        hit = [i for i, l in enumerate(lines) if l.startswith(key + "=")]
        if hit:
            lines[hit[0]] = row
        else:
            lines.append(row)
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write("\n".join(lines) + "\n")
    os.replace(tmp, path)


def bifrost_ip():
    c = json.loads(sh("docker", "inspect", "vip-bifrost-1").stdout)[0]
    return c["NetworkSettings"]["Networks"]["dev-ingress"]["IPAddress"], c


def http(ip, path, body=None, key=None, timeout=40):
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = "Bearer " + key
    req = urllib.request.Request(f"http://{ip}:8080{path}", data=json.dumps(body).encode() if body else None, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:  # noqa: BLE001
        return None, str(e).encode()


def wait_health():
    for _ in range(90):
        time.sleep(2)
        try:
            ip, c = bifrost_ip()
            if c["State"]["Running"] and http(ip, "/health", timeout=3)[0] == 200:
                return ip
        except Exception:  # noqa: BLE001
            pass
    return None


def main():
    seed = sys.argv[1]
    json.load(open(seed))
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    backup = f"{VIP}/backups/bifrost-pre-{VERSION}-{stamp}"
    os.makedirs(backup, mode=0o700)
    for db in ("config.db", "logs.db"):
        src = sqlite3.connect(f"file:{VIP}/data/bifrost/{db}?mode=ro", uri=True)
        dst = sqlite3.connect(f"{backup}/{db}")
        src.backup(dst); dst.close(); src.close()
    for path in (f"{VIP}/data/bifrost/config.json", f"{VIP}/compose.yaml", f"{VIP}/bifrost-seed.json", f"{VIP}/.env"):
        shutil.copy2(path, backup)
    shutil.copy2(f"{AURAL}/.env", f"{backup}/aural.env")
    for f in os.listdir(backup):
        os.chmod(f"{backup}/{f}", 0o600)
    _, live = bifrost_ip()
    old_image = live["Image"]
    sh("docker", "tag", old_image, "maximhq/bifrost:rollback-pre-" + VERSION)
    print("backup:", backup, "| rollback image tagged")

    env = read_env(f"{VIP}/.env")
    new = {}
    if not env.get("BIFROST_ADMIN_USERNAME"): new["BIFROST_ADMIN_USERNAME"] = "admin"
    if not env.get("BIFROST_ADMIN_PASSWORD"): new["BIFROST_ADMIN_PASSWORD"] = "Bf-" + secrets.token_urlsafe(24) + "-9a!"
    for name in ("AURAL_BIFROST_VK", "VIP_BIFROST_VK"):
        if not env.get(name): new[name] = "sk-bf-" + secrets.token_urlsafe(32)
    for name in ("ANTHROPIC_API_KEY", "ASSEMBLYAI_API_KEY"):
        if name not in env: new[name] = ""
    if new: set_env(f"{VIP}/.env", new)
    env = read_env(f"{VIP}/.env")
    os.makedirs("/srv/dev/secrets", mode=0o700, exist_ok=True)
    fd = os.open("/srv/dev/secrets/bifrost-admin.txt", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(f"Bifrost dashboard login (after the Caddy basic-auth prompt)\nusername: {env['BIFROST_ADMIN_USERNAME']}\npassword: {env['BIFROST_ADMIN_PASSWORD']}\n")
    print("env names added:", sorted(new))

    compose = open(f"{VIP}/compose.yaml").read()
    original = compose
    compose, n = re.subn(r"(?m)^(\s+image: maximhq/bifrost)(:\S+)?\s*$", rf"\1:{VERSION}", compose)
    assert n == 2, f"expected 2 bifrost image lines, found {n}"
    if "BIFROST_ADMIN_PASSWORD" not in compose:
        compose, n = re.subn(r"(?m)^(\s+)BIFROST_API_KEY: .*$", lambda m: "\n".join(m.group(1) + row for row in (
            "ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}",
            "ASSEMBLYAI_API_KEY: ${ASSEMBLYAI_API_KEY:-}",
            "BIFROST_ADMIN_USERNAME: ${BIFROST_ADMIN_USERNAME:?Set BIFROST_ADMIN_USERNAME in .env}",
            "BIFROST_ADMIN_PASSWORD: ${BIFROST_ADMIN_PASSWORD:?Set BIFROST_ADMIN_PASSWORD in .env}",
            "AURAL_BIFROST_VK: ${AURAL_BIFROST_VK:?Set AURAL_BIFROST_VK in .env}",
            "VIP_BIFROST_VK: ${VIP_BIFROST_VK:?Set VIP_BIFROST_VK in .env}")), compose)
        assert n == 1, f"expected 1 BIFROST_API_KEY line, found {n}"
    compose, n = re.subn(r"(?m)^(\s+LLM_GATEWAY_API_KEY: ).*$", r"\1${VIP_BIFROST_VK:?Set VIP_BIFROST_VK in .env}", compose)
    assert n == 2, f"expected 2 LLM_GATEWAY_API_KEY lines, found {n}"
    open(f"{VIP}/compose.yaml", "w").write(compose)
    shutil.copy2(seed, f"{VIP}/bifrost-seed.json")
    sh("docker", "compose", "config", "--quiet", cwd=VIP)

    def rollback(reason):
        print("ROLLBACK:", reason)
        sh("docker", "compose", "stop", "bifrost", cwd=VIP, check=False)
        open(f"{VIP}/compose.yaml", "w").write(original.replace("image: maximhq/bifrost\n", "image: maximhq/bifrost:rollback-pre-" + VERSION + "\n"))
        shutil.copy2(f"{backup}/bifrost-seed.json", f"{VIP}/bifrost-seed.json")
        for db in ("config.db", "logs.db"):
            for suffix in ("", "-shm", "-wal"):
                try: os.remove(f"{VIP}/data/bifrost/{db}{suffix}")
                except FileNotFoundError: pass
            shutil.copy2(f"{backup}/{db}", f"{VIP}/data/bifrost/{db}")
        shutil.copy2(f"{backup}/aural.env", f"{AURAL}/.env")
        sh("docker", "compose", "up", "-d", "bifrost", cwd=VIP, check=False)
        print("rolled back; bifrost health:", bool(wait_health()))
        sh(*AURAL_COMPOSE, "up", "-d", "--no-deps", "--wait", "--wait-timeout", "180", "web", "relay", cwd=AURAL, check=False)
        raise SystemExit(1)

    sh("docker", "pull", "-q", f"maximhq/bifrost:{VERSION}")
    r = sh("docker", "compose", "up", "-d", "bifrost", cwd=VIP, check=False)
    if r.returncode: rollback("compose up failed: " + r.stderr.strip()[-300:])
    ip = wait_health()
    if not ip: rollback("bifrost did not become healthy")
    status, body = http(ip, "/api/version")
    print("bifrost healthy; unauthenticated /api/version ->", status)
    chat = {"model": "groq/openai/gpt-oss-120b", "messages": [{"role": "user", "content": "Reply with the single word: pong"}], "max_tokens": 40}
    for name in ("AURAL_BIFROST_VK", "VIP_BIFROST_VK"):
        status, body = http(ip, "/v1/chat/completions", chat, env[name])
        print(f"groq chat with {name}:", status)
        if status != 200: rollback(f"{name} could not complete a chat: {body[:200]!r}")
    print("no key ->", http(ip, "/v1/chat/completions", chat)[0], "(expect 401)")

    set_env(f"{AURAL}/.env", {"BIFROST_API_KEY": env["AURAL_BIFROST_VK"]})
    r = sh(*AURAL_COMPOSE, "up", "-d", "--no-deps", "--wait", "--wait-timeout", "180", "web", "relay", cwd=AURAL, check=False)
    print("aural web+relay recreated:", r.returncode == 0, r.stderr.strip()[-200:] if r.returncode else "")
    print(sh("docker", "ps", "--format", "{{.Names}}\t{{.Image}}\t{{.Status}}", "--filter", "name=bifrost", "--filter", "name=aural-web", "--filter", "name=aural-relay").stdout)


if __name__ == "__main__":
    main()
