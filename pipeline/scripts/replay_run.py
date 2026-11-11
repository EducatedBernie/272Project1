"""
Replay a failed pipeline run locally.

Reads params from the pipeline_runs table and prints a ready-to-run command.
Does NOT execute — you decide what to run.

Usage:
    python scripts/replay_run.py <run_id>
    python scripts/replay_run.py <run_id> --db-url $RAILWAY_DB_URL

Note: replaying locally writes to YOUR local DB under the production video_id.
      Use --db to write to DB, or omit for demo JSON output only.
"""
import argparse
import json
import os
import shlex
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parents[2] / ".env")


def main():
    parser = argparse.ArgumentParser(description="Replay a pipeline run locally")
    parser.add_argument("run_id", help="Pipeline run UUID")
    parser.add_argument("--db-url", default=os.getenv("DATABASE_URL"),
                        help="Database URL (default: local from .env)")
    args = parser.parse_args()

    if not args.db_url:
        print("❌ No database URL. Set DATABASE_URL or pass --db-url.")
        sys.exit(1)

    import psycopg2
    conn = psycopg2.connect(args.db_url)
    cur = conn.cursor()
    cur.execute(
        "SELECT run_type, params, status, error, video_id FROM pipeline_runs WHERE id = %s",
        (args.run_id,)
    )
    row = cur.fetchone()
    conn.close()

    if not row:
        print(f"❌ Run {args.run_id} not found")
        sys.exit(1)

    run_type, params, status, error, video_id = row
    params = params or {}

    print(f"\n📋 Run {args.run_id}")
    print(f"   Type:     {run_type}")
    print(f"   Status:   {status}")
    print(f"   Video ID: {video_id}")
    if error:
        print(f"   Error:    {error[:200]}...")
    print(f"\n   Params:")
    print(f"   {json.dumps(params, indent=2)}")

    # Build a replay command
    source = params.get("source", "")
    title = params.get("title", "")

    print(f"\n🔁 Replay command:")
    if run_type in ("process", "reprocess"):
        cmd = f'python scripts/process_video_v2.py {shlex.quote(source)}'
        if title:
            cmd += f' --title {shlex.quote(title)}'
        # Omit --db by default — safer for local replay
        print(f"   {cmd}")
        print(f"\n   Add --db to write to local database")
        print(f"   Add --run-id {args.run_id} --db to resume the exact run")
        if source.startswith("uploads/"):
            print("\n   ⚠️  Source is an R2 key, not a local file.")
            dl = (f"from src.storage.r2 import download_file; "
                  f"download_file('{source}', '{os.path.basename(source)}')")
            print(f'   Download first:  python -c "{dl}"')
    elif run_type == "reprocess_section":
        print("   python3 <<'PY'")
        print("from scripts.process_video_v2 import reprocess_section")
        print("reprocess_section(")
        for k, v in params.items():
            print(f"    {k}={repr(v)},")
        print(")")
        print("PY")
    elif run_type == "reprocess_visual":
        print("   python3 <<'PY'")
        print("from scripts.process_video_v2 import reprocess_visual_content")
        print("reprocess_visual_content(")
        for k, v in params.items():
            print(f"    {k}={repr(v)},")
        print(")")
        print("PY")
    else:
        print(f"   Unknown run_type: {run_type}")

    print()


if __name__ == "__main__":
    main()
