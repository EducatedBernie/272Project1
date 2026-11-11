"""
Post-deploy smoke test for Chalkboard.

Quick mode (default): check env, versions, connectivity, enqueue a test video,
verify worker claims it. ~30 seconds.

Full mode (--full): wait for completion, assert segment/equation counts. ~5 min.

Usage:
    python scripts/smoke_test.py
    python scripts/smoke_test.py --base-url https://app.chalkboard.video --password $PASS
    python scripts/smoke_test.py --full

Notes:
    - Version/tool checks (Python, ffmpeg, yt-dlp) reflect the machine running
      the script, not the target. Run inside the container for meaningful checks.
    - Each run enqueues a real pipeline job. No auto-cleanup — rows accumulate
      in videos/pipeline_runs over time (deduped by URL for videos).
"""
import argparse
import http.cookiejar
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
import urllib.error

# Known-good test video: 76-second silent board work demo
DEFAULT_TEST_VIDEO_URL = "https://www.youtube.com/watch?v=NRbdymYpL9s"
DEFAULT_TEST_VIDEO_TITLE = "Smoke Test — Silent Board Work"
EXPECTED_MIN_SEGMENTS = 10
EXPECTED_MIN_EQUATIONS = 5

# Cloudflare blocks Python's default user agent. Identify as a real browser-ish UA.
USER_AGENT = "Mozilla/5.0 (compatible; chalkboard-smoke-test)"

_results = []


def check(name, condition, detail=""):
    status = "\u2705" if condition else "\u274c"
    msg = f"  {status} {name}"
    if detail:
        msg += f" \u2014 {detail}"
    print(msg)
    _results.append(condition)
    return condition


def http_post(url, data, cookies=None):
    """Simple HTTP POST returning (status_code, response_dict)."""
    req = urllib.request.Request(
        url,
        data=json.dumps(data).encode(),
        headers={"Content-Type": "application/json", "User-Agent": USER_AGENT},
    )
    if cookies:
        req.add_header("Cookie", cookies)
    try:
        resp = urllib.request.urlopen(req, timeout=10)
        return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = {}
        try:
            body = json.loads(e.read())
        except Exception:
            pass
        return e.code, body
    except urllib.error.URLError:
        return 0, {}


def http_get(url, cookies=None, parse_json=True):
    """Simple HTTP GET returning (status_code, response_dict_or_empty)."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    if cookies:
        req.add_header("Cookie", cookies)
    try:
        resp = urllib.request.urlopen(req, timeout=10)
        if parse_json:
            return resp.status, json.loads(resp.read())
        return resp.status, {}
    except urllib.error.HTTPError as e:
        body = {}
        if parse_json:
            try:
                body = json.loads(e.read())
            except Exception:
                pass
        return e.code, body
    except urllib.error.URLError:
        return 0, {}


def main():
    parser = argparse.ArgumentParser(description="Chalkboard post-deploy smoke test")
    parser.add_argument("--base-url", default="http://localhost:3000")
    parser.add_argument("--password", default=os.getenv("DASHBOARD_PASSWORD", ""))
    parser.add_argument("--video-url", default=DEFAULT_TEST_VIDEO_URL,
                        help="YouTube URL to test with (default: short silent board work)")
    parser.add_argument("--full", action="store_true", help="Wait for completion and assert counts")
    parser.add_argument("--timeout", type=int, default=300, help="Timeout in seconds for --full mode")
    args = parser.parse_args()

    base = args.base_url.rstrip("/")
    print(f"\n\U0001f50d Chalkboard Smoke Test \u2014 {base}\n")

    # ─── Preflight: versions ───
    print("Preflight:")
    python_ver = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
    check("Python", sys.version_info >= (3, 12), python_ver)

    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        ver = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True).stdout.split("\n")[0]
        check("ffmpeg", True, ver.strip())
    else:
        check("ffmpeg", False, "not found")

    ytdlp = shutil.which("yt-dlp")
    if ytdlp:
        ver = subprocess.run(["yt-dlp", "--version"], capture_output=True, text=True).stdout.strip()
        check("yt-dlp", True, ver)
    else:
        check("yt-dlp", False, "not found")

    # ─── Connectivity ───
    print("\nConnectivity:")
    status, body = http_get(f"{base}/api/health")
    check("Health endpoint", status == 200 and body.get("ok"), body.get("db", "?"))

    status, _ = http_get(f"{base}/", parse_json=False)
    check("Landing page", status == 200)

    # ─── Auth ───
    print("\nAuth:")
    cookies = None
    if args.password:
        cj = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
        req = urllib.request.Request(
            f"{base}/api/auth/login",
            data=json.dumps({"password": args.password}).encode(),
            headers={"Content-Type": "application/json", "User-Agent": USER_AGENT},
        )
        try:
            resp = opener.open(req, timeout=10)
            body = json.loads(resp.read())
            login_ok = resp.status == 200 and body.get("ok")
        except (urllib.error.HTTPError, urllib.error.URLError):
            login_ok = False
        check("Login", login_ok)
        if login_ok:
            cookies = "; ".join(f"{c.name}={c.value}" for c in cj)
    else:
        print("  \u26a0\ufe0f  No password provided \u2014 skipping auth (use --password)")

    # ─── Enqueue test video ───
    print("\nPipeline:")
    if not cookies and args.password:
        print("  \u274c Can't test pipeline \u2014 login failed")
        sys.exit(1)

    status, body = http_post(
        f"{base}/api/process",
        {"youtube_url": args.video_url, "title": DEFAULT_TEST_VIDEO_TITLE},
        cookies=cookies,
    )
    if status == 401:
        check("Enqueue", False, "unauthorized \u2014 need --password")
        sys.exit(1)

    check("Enqueue", status == 200 and body.get("run_id"), f"run_id={body.get('run_id')}")
    run_id = body.get("run_id")

    if not run_id:
        print("\n\u274c FAIL \u2014 could not enqueue test video")
        sys.exit(1)

    # Poll until worker claims it (status leaves 'queued')
    print(f"\n  Waiting for worker to claim run {run_id[:8]}...")
    claimed = False
    for _ in range(30):  # 30 * 2s = 60s max
        time.sleep(2)
        status, run = http_get(f"{base}/api/runs/{run_id}", cookies=cookies)
        if status == 200 and run.get("status") != "queued":
            pipeline_status = run["status"]
            check("Worker claimed", pipeline_status != "failed", f"status={pipeline_status}")
            claimed = True
            break

    if not claimed:
        check("Worker claimed", False, "still queued after 60s \u2014 worker may be dead")
        print("\n\u274c FAIL")
        sys.exit(1)

    # ─── Full mode: wait for completion ───
    if args.full:
        print(f"\n  Waiting for completion (timeout={args.timeout}s)...")
        start = time.time()
        final_status = None
        while time.time() - start < args.timeout:
            time.sleep(5)
            status, run = http_get(f"{base}/api/runs/{run_id}", cookies=cookies)
            if status == 200:
                final_status = run.get("status")
                elapsed = int(time.time() - start)
                print(f"    {elapsed}s \u2014 {final_status}")
                if final_status in ("complete", "failed"):
                    break

        check("Completed", final_status == "complete", f"status={final_status}")

        if final_status == "complete":
            seg = run.get("segment_count", 0)
            eq = run.get("equation_count", 0)
            check("Segments", seg >= EXPECTED_MIN_SEGMENTS, f"{seg} (min {EXPECTED_MIN_SEGMENTS})")
            check("Equations", eq >= EXPECTED_MIN_EQUATIONS, f"{eq} (min {EXPECTED_MIN_EQUATIONS})")
        elif final_status == "failed":
            print(f"    Error: {run.get('error', 'unknown')[:200]}")
    else:
        print("\n  (Use --full to wait for completion and verify output)")

    # ─── Summary ───
    all_pass = all(_results)
    print(f"\n{'\u2705 PASS' if all_pass else '\u274c FAIL'}\n")
    sys.exit(0 if all_pass else 1)


if __name__ == "__main__":
    main()
