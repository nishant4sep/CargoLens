/**
 * Landing placeholder inside the guard (P4.1). The shipment dashboard
 * (P4.2) will replace this — it exists so the guard, login, and logout
 * have a real end-to-end path to verify against.
 */
export default function HomePage() {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-6">
      <h1 className="text-lg font-semibold tracking-tight text-zinc-900">Signed in</h1>
      <p className="mt-1 text-sm text-zinc-600">
        The shipment dashboard arrives in the next step. Authentication, the
        layout guard, and the shared state kit are live.
      </p>
    </div>
  );
}
