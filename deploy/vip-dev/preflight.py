#!/usr/bin/env python3
"""Read-only safety gate; run BEFORE pulling images on the shared VIP dev host.

Exit nonzero if available disk is below 8 GiB, available RAM below 1 GiB,
or the host is not the expected amd64 Docker host. Does not prune or resize anything.
"""
import json
import os
import platform
from pathlib import Path
import subprocess
import sys


def main() -> int:
    disk = os.statvfs("/srv/dev" if Path("/srv/dev").exists() else "/")
    free = disk.f_bavail * disk.f_frsize
    mem = dict((line.split(":", 1)[0], int(line.split()[1]) * 1024) for line in Path("/proc/meminfo").read_text().splitlines())
    available = mem["MemAvailable"]
    print(f"Available disk: {free / 1024**3:.2f} GiB; RAM: {available / 1024**3:.2f} GiB; architecture: {platform.machine()}")
    problems = []
    if free < 8 * 1024**3:
        problems.append("At least 8 GiB FREE disk is required before pulling app + Supabase images. Expand capacity or use external Supabase; never prune VIP rollback images automatically.")
    if available < 1024**3:
        problems.append("At least 1 GiB available RAM is required.")
    if platform.machine() not in ("x86_64", "amd64"):
        problems.append("VIP dev deployment expects amd64 images and host.")
    subprocess.run(["docker", "version", "--format", "{{.Server.Version}}"], check=True)
    network = json.loads(subprocess.check_output(["docker", "network", "inspect", "dev-ingress"]))
    if not network:
        problems.append("Shared dev-ingress network is missing.")
    for problem in problems:
        print("BLOCKED:", problem, file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
