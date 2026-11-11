import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await Promise.race([
      getPool().query("SELECT 1"),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("DB query timeout (3s)")), 3000)
      ),
    ]);
    return NextResponse.json({ ok: true, db: "connected" });
  } catch (e) {
    console.error("[health] DB check failed:", e);
    return NextResponse.json({ ok: false, db: "unreachable" }, { status: 500 });
  }
}
