/**
 * Screen 1 (PRD §8): minimal centered card, demo-account hint box.
 * Server component: an ALREADY-AUTHENTICATED visitor is redirected to the
 * app — /login is only for signed-out users (plan P4.1 item 7).
 *
 * cacheComponents note (Next 16): blocking route (`instant = false`) — the
 * session redirect is request-time truth; a prerendered shell would flash
 * the form to signed-in users before bouncing them.
 */
import { redirect } from "next/navigation";
import { getSessionUserRsc } from "@/server/session";
import { LoginForm } from "./login-form";

export const instant = false;

export default async function LoginPage() {
  const user = await getSessionUserRsc();
  if (user) redirect("/");

  const demoPassword = process.env.SEED_DEMO_PASSWORD || "cargolens-demo-password-123";

  return (
    <div className="flex min-h-screen flex-1 items-center justify-center bg-zinc-50 px-4">
      <div className="w-full max-w-sm">
        <div className="rounded-lg border border-zinc-200 bg-white p-8 shadow-sm">
          <h1 className="text-xl font-semibold tracking-tight text-zinc-900">CargoLens</h1>
          <p className="mt-1 text-sm text-zinc-500">Sign in to verify import documents.</p>
          <LoginForm />
        </div>
        <div className="mt-4 rounded-lg border border-zinc-200 bg-white p-4">
          <p className="text-xs font-semibold text-zinc-700">Demo accounts</p>
          <ul className="mt-2 space-y-1 text-xs text-zinc-500">
            <li>
              <span className="font-mono text-zinc-700">exec@demo.cargolens.in</span> — Executive
            </li>
            <li>
              <span className="font-mono text-zinc-700">manager@demo.cargolens.in</span> — Manager
            </li>
            <li>
              password: <span className="font-mono text-zinc-700">{demoPassword}</span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
