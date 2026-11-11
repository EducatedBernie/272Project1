"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError("");

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Login failed");
      }

      // Redirect to the page they were trying to access, or dashboard
      // Validate it's a same-origin relative path to prevent open redirect
      const raw = searchParams.get("from") || "/dashboard";
      const from = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/dashboard";
      router.push(from);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: "var(--background)" }}>
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4">
        <h1 className="text-xl font-semibold" style={{ color: "var(--foreground)" }}>
          Chalkboard Dashboard
        </h1>
        <p className="text-sm" style={{ color: "var(--muted-foreground, #888)" }}>
          Enter the dashboard password to continue.
        </p>

        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          autoFocus
          disabled={submitting}
          className="w-full rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
          style={{
            background: "var(--muted, #222)",
            color: "var(--foreground)",
            border: "1px solid var(--border, #333)",
          }}
        />

        <button
          type="submit"
          disabled={submitting || !password}
          className="w-full rounded-lg px-4 py-3 text-sm font-medium disabled:opacity-50 transition-colors"
          style={{
            background: "var(--foreground)",
            color: "var(--background)",
          }}
        >
          {submitting ? "Logging in..." : "Log in"}
        </button>

        {error && (
          <p className="text-sm text-red-500">{error}</p>
        )}
      </form>
    </div>
  );
}
