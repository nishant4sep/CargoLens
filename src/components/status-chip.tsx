/** Status chip — one restrained visual for the six machine states. */
import { statusLabel, statusToneClasses } from "@/lib/dashboard";

export function StatusChip({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${statusToneClasses(status)}`}
    >
      {statusLabel(status)}
    </span>
  );
}
