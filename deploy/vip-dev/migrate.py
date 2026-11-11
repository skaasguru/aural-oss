#!/usr/bin/env python3
"""Apply Aural migrations transactionally to its own Supabase container.

Usage: python3 migrate.py --container aural-db-1 --source /srv/dev/apps/aural/source
Never point this at the VIP database. Repeated runs verify hashes and skip applied files.
"""
import argparse
import hashlib
from pathlib import Path
import subprocess


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--container", default="aural-db-1")
    p.add_argument("--source", type=Path, required=True)
    args = p.parse_args()
    if not args.container.startswith("aural-"):
        p.error("Only an explicitly named aural-* container is permitted")
    cmd = ["docker", "exec", "-i", args.container, "psql", "-X", "-U", "supabase_admin", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At"]

    def sql(text: str) -> str:
        return subprocess.run(cmd, input=text, text=True, capture_output=True, check=True).stdout.strip()

    sql("CREATE SCHEMA IF NOT EXISTS aural_migrations; CREATE TABLE IF NOT EXISTS aural_migrations.applied (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());")
    for f in sorted((args.source / "supabase/migrations").glob("*.sql")):
        if not f.name.replace("_", "").replace("-", "").replace(".", "").isalnum():
            raise ValueError("Invalid migration filename")
        digest = hashlib.sha256(f.read_bytes()).hexdigest()
        old = sql(f"SELECT sha256 FROM aural_migrations.applied WHERE name='{f.name}';")
        if old:
            if old != digest:
                raise ValueError(f"Applied migration changed: {f.name}")
            print("Already applied:", f.name)
            continue
        sql("BEGIN;\n" + f.read_text() + f"\nINSERT INTO aural_migrations.applied(name,sha256) VALUES ('{f.name}','{digest}');\nCOMMIT;")
        print("Applied:", f.name)
    sql("NOTIFY pgrst, 'reload schema';")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        raise SystemExit("Migration failed: " + error.stderr[-2000:]) from None
