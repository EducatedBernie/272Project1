import { NextRequest, NextResponse } from "next/server";

const COOKIE_NAME = "chalkboard_auth";

/**
 * Compute a SHA-256 HMAC of a message using Web Crypto API (Edge-compatible).
 * Used to derive the cookie token from the password without storing the password itself.
 */
async function hmacSha256(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Constant-time string comparison to avoid timing attacks.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Compare against dummy to avoid leaking length via early return timing
    const dummy = "x".repeat(a.length);
    let mismatch = 1;
    for (let i = 0; i < dummy.length; i++) {
      mismatch |= dummy.charCodeAt(i) ^ a.charCodeAt(i);
    }
    return mismatch === 0;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Verify the auth cookie contains a valid HMAC token.
 *
 * Fail-closed: if DASHBOARD_PASSWORD is not set, auth FAILS (returns false).
 * To disable auth for local dev, set DASHBOARD_AUTH_DISABLED=true explicitly.
 */
async function verifyAuth(cookieValue: string | undefined): Promise<boolean> {
  if (process.env.DASHBOARD_AUTH_DISABLED === "true") return true;

  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return false; // Fail closed — missing password blocks access

  if (!cookieValue) return false;

  const authSecret = process.env.AUTH_SECRET || "chalkboard-default-secret";
  const expected = await hmacSha256(authSecret, password);
  return timingSafeEqual(cookieValue, expected);
}

/**
 * Protected routes require auth. Public routes pass through.
 *
 * Protected:
 *   /dashboard, /video/<id>/debug, /api/process, /api/upload,
 *   /api/reprocess, /api/reprocess-section, raw Gemini call-log APIs
 *
 * Public:
 *   /, /video/<id>, /api/videos, /api/thumbnail, /api/video-file, /login,
 *   GET /api/runs/<id> only (single-id status reads, used by /video/<id> polling).
 *   Anything deeper under /api/runs (e.g. /api/runs/<id>/cancel) and any
 *   non-GET method on /api/runs/* requires auth.
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Host-based redirects: keep marketing on chalkboard.video and app on app.chalkboard.video.
  // See ADR-018. Normalize host (lowercase + strip port) defensively.
  const host = (request.headers.get("host") || "").toLowerCase().split(":")[0];
  const isMarketingHost = host === "chalkboard.video" || host === "www.chalkboard.video";
  const isAppHost = host === "app.chalkboard.video";

  const isAppRoute =
    pathname === "/dashboard" ||
    pathname.startsWith("/dashboard/") ||
    pathname.startsWith("/video/") ||
    pathname === "/login" ||
    pathname.startsWith("/api/");
  const isDebugRoute = /^\/video\/[^/]+\/debug(?:\/.*)?$/.test(pathname);

  // Marketing host + app route → app subdomain.
  // Note on hostname + port = "" pattern: per WHATWG URL spec, the .host setter
  // does NOT clear an existing port if the new value omits one. Railway's
  // request.url includes its internal port (8080), so we must explicitly clear
  // it via .port = "" alongside .hostname assignment.
  if (isMarketingHost && isAppRoute) {
    const redirectUrl = new URL(request.url);
    redirectUrl.protocol = "https:";
    redirectUrl.hostname = "app.chalkboard.video";
    redirectUrl.port = "";
    return NextResponse.redirect(redirectUrl);
  }

  // App subdomain root → marketing (app is for app routes only)
  if (isAppHost && pathname === "/") {
    const redirectUrl = new URL(request.url);
    redirectUrl.protocol = "https:";
    redirectUrl.hostname = "chalkboard.video";
    redirectUrl.port = "";
    return NextResponse.redirect(redirectUrl);
  }

  // Public routes — no auth needed
  if (
    pathname === "/" ||
    pathname === "/login" ||
    (pathname.startsWith("/video/") && !isDebugRoute) ||
    pathname === "/api/videos" ||
    // GET /api/runs/<id> stays public (used by /video/<id> client polling).
    // Sub-paths like /api/runs/<id>/cancel and /api/runs (the list endpoint)
    // fall through to the auth gate.
    (/^\/api\/runs\/[^/]+$/.test(pathname) && request.method === "GET") ||
    (/^\/api\/notes\/[^/]+$/.test(pathname) && request.method === "GET") ||
    pathname === "/api/health" ||
    pathname === "/api/thumbnail" ||
    pathname === "/api/video-file" ||
    pathname.startsWith("/api/auth/") ||
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/demo/") ||
    // Static files — match known extensions rather than any dot in the path
    /\.(ico|png|jpg|jpeg|svg|gif|webp|css|js|woff2?|ttf|map|json|mp4)$/.test(pathname)
  ) {
    return NextResponse.next();
  }

  // Check auth cookie
  const cookie = request.cookies.get(COOKIE_NAME)?.value;
  if (await verifyAuth(cookie)) {
    return NextResponse.next();
  }

  // Unauthorized — redirect pages, 401 for API
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("from", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
