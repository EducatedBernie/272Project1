import { NextRequest, NextResponse } from "next/server";
import { createHmac } from "crypto";

const COOKIE_NAME = "chalkboard_auth";
const DEMO_PASSWORDS = ["demo 2026", "2026"];

function sign(password: string): string {
  const secret = process.env.AUTH_SECRET || "chalkboard-default-secret";
  return createHmac("sha256", secret).update(password).digest("hex");
}

/**
 * Constant-time string comparison.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function isAcceptedPassword(password: string, primaryPassword: string): boolean {
  return [primaryPassword, ...DEMO_PASSWORDS].some((accepted) =>
    timingSafeEqual(password, accepted)
  );
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || !("password" in body)) {
    return NextResponse.json({ error: "password field required" }, { status: 400 });
  }

  const { password } = body as { password: unknown };
  if (typeof password !== "string" || !password) {
    return NextResponse.json({ error: "password must be a non-empty string" }, { status: 400 });
  }

  const expected = process.env.DASHBOARD_PASSWORD;
  if (!expected) {
    return NextResponse.json({ error: "DASHBOARD_PASSWORD not configured" }, { status: 500 });
  }

  if (!isAcceptedPassword(password, expected)) {
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  // Store HMAC of the password in the cookie — never the password itself
  const token = sign(expected);
  const response = NextResponse.json({ ok: true });
  response.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 60 * 60 * 24 * 7, // 7 days
  });

  return response;
}
