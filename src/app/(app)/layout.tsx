/**
 * The guarded shell (P4.1, plan §8): every page inside the `(app)` group
 * requires a session — the layout resolves it server-side via the RSC helper
 * and redirects to /login otherwise. No page renders before this check.
 * Client components never gate access; they only render what the server
 * already proved.
 *
 * cacheComponents note (Next 16): this segment is a BLOCKING route
 * (`instant = false`) on purpose. Every byte of it depends on the session
 * cookie, so there is no meaningful "instant shell" to prerender — and the
 * prerender/prefetch pass trips over the guard's redirect(). Verified in dev
 * (2026-11-05): with a Suspense-wrapped guard, the Prefetch validation hits
 * NEXT_REDIRECT and authed navigations stay stuck on the fallback; declaring
 * the route blocking renders it per-request, which is what an auth gate is.
 */
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getSessionUserRsc } from "@/server/session";
import { SignOutButton } from "@/components/sign-out-button";

export const instant = false;

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await getSessionUserRsc();
  if (!user) redirect("/login");

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-6">
          <span className="text-sm font-semibold tracking-tight text-zinc-900">CargoLens</span>
          <div className="flex items-center gap-3">
            <span className="text-sm text-zinc-600">{user.name}</span>
            <span className="rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-xs font-medium text-zinc-600">
              {user.role}
            </span>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</main>
    </div>
  );
}
