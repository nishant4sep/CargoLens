"use client";

/**
 * Login form (client): posts to the REAL contract row 1 endpoint over HTTP,
 * parses the response through the one envelope parser, and on success lets
 * the server components take over (`router.replace` + `refresh` — the (app)
 * layout re-reads the session from the cookie the login just set). Errors
 * render inline from the envelope — including the deliberate
 * "Invalid email or password" (no user-enumeration oracle, 06 §1.1).
 */
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { parseEnvelope } from "@/lib/envelope";
import { ErrorBanner } from "@/components/states";

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const parsed = await parseEnvelope<{ user: { id: string; name: string; role: string } }>(res);
      if (!parsed.ok) {
        setError({ code: parsed.error.code, message: parsed.error.message });
        return;
      }
      router.replace("/");
      router.refresh();
    } catch {
      setError({ code: "NETWORK", message: "Could not reach the server. Try again." });
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
      {error ? <ErrorBanner code={error.code} message={error.message} /> : null}
      <div>
        <label htmlFor="email" className="block text-sm font-medium text-zinc-700">
          Email
        </label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-zinc-900 focus:outline-none focus:ring-1 focus:ring-zinc-900"
          placeholder="you@company.in"
        />
      </div>
      <div>
        <label htmlFor="password" className="block text-sm font-medium text-zinc-700">
          Password
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-zinc-900 focus:outline-none focus:ring-1 focus:ring-zinc-900"
          placeholder="••••••••"
        />
      </div>
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
