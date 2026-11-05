"use client";

/**
 * Sign out (contract row 2): POST /api/auth/logout destroys the session row
 * server-side and clears the cookie; we then navigate to /login. Even if the
 * request fails, navigating is safe — /login and the (app) guard re-check
 * the session server-side on every render.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  return (
    <button
      type="button"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        try {
          await fetch("/api/auth/logout", { method: "POST" });
        } finally {
          router.replace("/login");
          router.refresh();
        }
      }}
      className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
