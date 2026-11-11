"""
Inspect a pipeline run — print items, items-by-type, or one item's raw metadata.

Use when a user reports "this output looks weird" and you need to decide
quickly whether it's a pipeline bug (content missing in DB) or a viewer bug
(content in DB but rendered wrong).

Usage:
    # Find runs for a video (by UUID, YouTube ID, or YouTube URL)
    python scripts/inspect_run.py --video 66b6e463-...

    # Summarize a run: counts by content_type + any empty items
    python scripts/inspect_run.py --run 31bca6d1-...

    # Dump all items of a type in a time window (seconds)
    python scripts/inspect_run.py --run <id> --type text --from 0 --to 600

    # Dump one item's full metadata
    python scripts/inspect_run.py --item db4242dd-...

    # Diff two runs on the same video (counts by type)
    python scripts/inspect_run.py --diff <run_a> <run_b>

DB URL resolution order:
    1. --db-url flag
    2. $RAILWAY_DB_URL env var
    3. $DATABASE_URL env var (from .env, local by default)

To query the production DB from your laptop:
    railway link --service Postgres
    eval "$(railway variables --kv | grep DATABASE_PUBLIC_URL | sed 's/^/export /')"
    python scripts/inspect_run.py --video <id> --db-url "$DATABASE_PUBLIC_URL"
"""
import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parents[2] / ".env")

import psycopg2
import psycopg2.extras


def fmt_ts(sec):
    if sec is None:
        return "?"
    sec = float(sec)
    return f"{int(sec//60)}:{int(sec%60):02d}"


def resolve_db_url(args):
    url = args.db_url or os.getenv("RAILWAY_DB_URL") or os.getenv("DATABASE_URL")
    if not url:
        sys.exit("❌ No DB URL. Pass --db-url or set RAILWAY_DB_URL / DATABASE_URL.")
    return url


def connect(url):
    return psycopg2.connect(url)


def resolve_video_id(cur, token):
    """Accept video UUID, YouTube ID, or YouTube URL."""
    # UUID
    if len(token) == 36 and token.count("-") == 4:
        cur.execute("SELECT id, youtube_url FROM videos WHERE id=%s", (token,))
        row = cur.fetchone()
        if row:
            return row["id"], row["youtube_url"]
    # YouTube URL / ID
    cur.execute(
        "SELECT id, youtube_url FROM videos WHERE youtube_url LIKE %s ORDER BY created_at DESC LIMIT 1",
        (f"%{token}%",),
    )
    row = cur.fetchone()
    if row:
        return row["id"], row["youtube_url"]
    sys.exit(f"❌ No video matches {token!r}")


def list_runs(cur, video_id):
    cur.execute(
        """
        SELECT id, created_at, status, run_type, progress,
               transcript_prompt_version, equations_prompt_version,
               visual_content_prompt_version,
               (SELECT COUNT(*) FROM transcript_segments s WHERE s.run_id = pr.id) AS segs,
               (SELECT COUNT(*) FROM equations e WHERE e.run_id = pr.id) AS items
        FROM pipeline_runs pr WHERE video_id=%s ORDER BY created_at
        """,
        (video_id,),
    )
    return cur.fetchall()


def cmd_video(cur, token):
    vid, url = resolve_video_id(cur, token)
    print(f"Video: {vid}")
    print(f"URL:   {url}")
    runs = list_runs(cur, vid)
    print(f"\nRuns ({len(runs)}):")
    for i, r in enumerate(runs, 1):
        scope = (r["progress"] or {}).get("scope") or r["run_type"] or "full"
        print(
            f"  Run {i}  {r['id']}  {r['created_at']:%Y-%m-%d %H:%M}  "
            f"{r['status']:<10} {scope:<20} "
            f"segs={r['segs']:<4} items={r['items']:<4} "
            f"tx={r['transcript_prompt_version']} eq={r['equations_prompt_version']} "
            f"vc={r['visual_content_prompt_version']}"
        )


def cmd_run(cur, run_id):
    # repair_status values written by the deterministic healer:
    #   'fixed'   — healer rule matched and rewrote the item
    #   'skipped' — healer saw a validator error but no rule matched
    #               (perception failure — content genuinely missing)
    #   NULL      — item was clean off the line (most items)
    # Old LLM-repair runs may also have 'failed' rows lingering; we don't
    # surface those here because that path is gone (commit 0f21885).
    cur.execute(
        """
        SELECT content_type, COUNT(*) AS n,
               SUM(CASE WHEN description IS NULL OR description = '' THEN 1 ELSE 0 END) AS empty_desc,
               SUM(CASE WHEN content_metadata->>'repair_status' = 'fixed'   THEN 1 ELSE 0 END) AS healed,
               SUM(CASE WHEN content_metadata->>'repair_status' = 'skipped' THEN 1 ELSE 0 END) AS unhealable
        FROM equations WHERE run_id=%s GROUP BY content_type ORDER BY n DESC
        """,
        (run_id,),
    )
    print(f"Run {run_id} — counts by content_type:")
    for r in cur.fetchall():
        print(
            f"  {r['content_type']:<24} n={r['n']:<4} empty_desc={r['empty_desc']:<3} "
            f"healed={r['healed']:<3} unhealable={r['unhealable']}"
        )

    # Spotlight empty items (likely UI-visible "blank" entries)
    cur.execute(
        """
        SELECT id, content_type, timestamp_start, timestamp_end, confidence,
               description, latex_string, content_metadata
        FROM equations
        WHERE run_id=%s
          AND (description IS NULL OR description = '')
          AND (latex_string IS NULL OR latex_string = '')
        ORDER BY timestamp_start
        """,
        (run_id,),
    )
    empty = cur.fetchall()
    if empty:
        print(f"\n{len(empty)} items with empty description AND empty latex_string:")
        for r in empty[:30]:
            md = r["content_metadata"] or {}
            md_keys = sorted(k for k, v in md.items() if v)
            print(
                f"  {r['id']}  {r['content_type']:<12} "
                f"{fmt_ts(r['timestamp_start'])}-{fmt_ts(r['timestamp_end']):<7} "
                f"conf={r['confidence']}  metadata_keys={md_keys}"
            )
        print(
            "\n  ⚠️  These have empty top-level strings. Check content_metadata_keys — "
            "if populated (e.g. textBlocks, code, rows), the pipeline extracted the "
            "content but the viewer may not render it. That's a VIEWER bug, not a pipeline bug."
        )


def cmd_items(cur, run_id, ctype, start, end):
    cur.execute(
        """
        SELECT id, content_type, timestamp_start, timestamp_end, confidence,
               description, latex_string, content_metadata
        FROM equations
        WHERE run_id=%s AND content_type=%s
          AND timestamp_start >= %s AND timestamp_start < %s
        ORDER BY timestamp_start
        """,
        (run_id, ctype, start, end),
    )
    rows = cur.fetchall()
    print(f"{len(rows)} {ctype} items in [{fmt_ts(start)}, {fmt_ts(end)})\n")
    for r in rows:
        md = r["content_metadata"] or {}
        md_str = json.dumps(md, default=str)
        md_preview = md_str if len(md_str) <= 400 else f"{md_str[:400]}... [truncated, {len(md_str)} chars total — use --item for full row]"
        print(
            f"{r['id']} {fmt_ts(r['timestamp_start'])}-{fmt_ts(r['timestamp_end'])}  "
            f"conf={r['confidence']}\n  latex: {(r['latex_string'] or '')!r}\n  "
            f"desc:  {(r['description'] or '')!r}\n  meta:  {md_preview}\n"
        )


def cmd_item(cur, item_id):
    cur.execute(
        """
        SELECT e.*, pr.run_type, pr.progress
        FROM equations e LEFT JOIN pipeline_runs pr ON pr.id = e.run_id
        WHERE e.id=%s
        """,
        (item_id,),
    )
    r = cur.fetchone()
    if not r:
        sys.exit(f"❌ No item {item_id}")
    d = dict(r)
    # Make JSON-serializable
    for k, v in list(d.items()):
        if hasattr(v, "isoformat"):
            d[k] = v.isoformat()
        elif hasattr(v, "hex"):
            d[k] = str(v)
    print(json.dumps(d, indent=2, default=str))


def cmd_diff(cur, run_a, run_b):
    def counts(rid):
        cur.execute(
            "SELECT content_type, COUNT(*) AS n FROM equations WHERE run_id=%s GROUP BY content_type",
            (rid,),
        )
        return {r["content_type"]: r["n"] for r in cur.fetchall()}

    a = counts(run_a)
    b = counts(run_b)
    types = sorted(set(a) | set(b))
    print(f"{'type':<26} {'A':>6} {'B':>6} {'Δ':>6}")
    for t in types:
        na, nb = a.get(t, 0), b.get(t, 0)
        print(f"{t:<26} {na:>6} {nb:>6} {nb-na:>+6}")


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--db-url", default=None)
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--video", help="Video UUID, YouTube ID, or YouTube URL — lists runs")
    g.add_argument("--run", help="Run UUID — summarize")
    g.add_argument("--item", help="Item (equation row) UUID — dump raw row as JSON")
    g.add_argument("--diff", nargs=2, metavar=("RUN_A", "RUN_B"), help="Diff two runs by type")
    p.add_argument("--type", help="With --run: filter items by content_type")
    p.add_argument("--from", dest="t_from", type=float, default=0.0, help="Start time (seconds)")
    p.add_argument("--to", dest="t_to", type=float, default=1e9, help="End time (seconds)")
    args = p.parse_args()

    with connect(resolve_db_url(args)) as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            if args.video:
                cmd_video(cur, args.video)
            elif args.run and args.type:
                cmd_items(cur, args.run, args.type, args.t_from, args.t_to)
            elif args.run:
                cmd_run(cur, args.run)
            elif args.item:
                cmd_item(cur, args.item)
            elif args.diff:
                cmd_diff(cur, args.diff[0], args.diff[1])


if __name__ == "__main__":
    main()
