/**
 * THE REVIEW SCREEN (PRD screen 4, plan P4.4 + P4.5): where a documentation
 * executive inspects extracted data against the document itself, corrects
 * fields, completes missing data manually (D-1b), and reads the
 * deterministic cross-checks that gate approval; where the MANAGER approves
 * and generates the gated CSV export; and where the append-only audit trail
 * renders every event the services wrote.
 *
 * Everything is the EXISTING contract: row-6 detail aggregate (fields,
 * lineItems, checks, approval, latestExport all included), row-11 signed-file
 * chain for the preview, row-12 field PATCH, row-10 manual entry, row-13
 * resolve, row-14 approve, row-16 export, row-17 re-download, row-18 audit.
 * The client invents NO values, NO confidence, NO checks, NO eligibility.
 *
 * Interaction context comes from PURE permission helpers derived from the
 * state machine's own table — the UI cannot offer an action the machine would
 * 409/403 (DRAFT/PROCESSING corrections, EXPORTED anything, executive
 * approval, unapproved export).
 */
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { apiFetch } from "@/server/api-fetch";
import { getSessionUserRsc } from "@/server/session";
import { StatusChip } from "@/components/status-chip";
import { DocumentUpload, type ExistingDoc } from "@/components/document-upload";
import { DocumentPreview } from "@/components/document-preview";
import { ExtractButton } from "@/components/extract-button";
import { FieldsPanel } from "@/components/fields-panel";
import { ManualEntryForm } from "@/components/manual-entry-form";
import { ResolveCheckButton } from "@/components/resolve-check-button";
import { ApprovalPanel } from "@/components/approval-panel";
import { ExportPanel } from "@/components/export-panel";
import { ErrorBanner } from "@/components/states";
import { documentStatusLabel, documentTypeLabel, formatBytes } from "@/lib/format";
import {
  approvalReadiness,
  auditSummary,
  checkDetailRows,
  checkStatusLabel,
  checkTitle,
  extractAction,
  reviewPermissions,
  toReviewField,
  type ReviewField,
} from "@/lib/review";
import { REQUIRED_FIELD_KEYS } from "@/server/engines/crosschecks";
import type { DocType } from "@/lib/types";

export const instant = false;

interface DetailResponse {
  shipment: {
    id: string;
    ref: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    supplier: { id: string; name: string; country: string | null } | null;
    approval: { approvedById: string; approvedByName: string | null; approvedAt: string | null } | null;
  };
  documents: ExistingDoc[];
  fields: Array<Record<string, unknown>>;
  lineItems: Array<{
    id: string;
    seq: number;
    description: string;
    hsnCode: string | null;
    unit: string | null;
    quantity: string;
    unitPrice: string | null;
    lineTotal: string | null;
    documentType: string;
  }>;
  checks: CheckRow[];
  latestExport: { id: string; fileName: string; formatVersion: string; csvSha256: string; createdAt: string } | null;
  metrics: {
    documentsCount: number;
    fieldsTotal: number;
    fieldsCleared: number;
    unresolvedBlockingFails: number;
  };
}

interface CheckRow {
  id: string;
  ruleKey: string;
  result: string;
  severity: string;
  detailsJson: unknown;
  resolvedNote: string | null;
  resolvedAt: string | null;
}

interface AuditResponse {
  events: Array<{ id: string; action: string; actorName: string; payload: unknown; createdAt: string }>;
}

const DOC_TYPES: DocType[] = ["INVOICE", "PACKING_LIST", "BILL_OF_LADING"];

const AUDIT_LABELS: Record<string, string> = {
  SHIPMENT_CREATED: "Shipment created",
  DOCUMENT_UPLOADED: "Document uploaded",
  EXTRACTION_STARTED: "Extraction started",
  EXTRACTION_COMPLETED: "Extraction completed",
  EXTRACTION_FAILED: "Extraction failed",
  DOCS_REACHED_TERMINAL: "All documents processed",
  MANUAL_ENTRY: "Manual entry",
  FIELD_CONFIRMED: "Field confirmed",
  FIELD_CORRECTED: "Field corrected",
  CHECKS_RECOMPUTED: "Checks recomputed",
  DISCREPANCY_FLAGGED: "Discrepancy flagged",
  DISCREPANCY_RESOLVED: "Discrepancy resolved",
  APPROVAL_GRANTED: "Approval granted",
  APPROVAL_REVOKED: "Approval revoked",
  EXPORT_GENERATED: "Export generated",
  EXPORT_DOWNLOADED: "Export downloaded",
};

const fmt = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Asia/Kolkata",
});

const money = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyFmt = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 3 });

export default async function ReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ doc?: string }>;
}) {
  const [{ id }, { doc: docParam }, user] = await Promise.all([params, searchParams, getSessionUserRsc()]);
  const auditTab = docParam === "AUDIT"; // 4th tab: the full audit trail, full-width
  const selectedDoc: DocType = !auditTab && DOC_TYPES.includes(docParam as DocType) ? (docParam as DocType) : "INVOICE";

  const result = await apiFetch<DetailResponse>(`/api/shipments/${id}`);
  if (!result.ok) {
    if (result.status === 401) redirect("/login");
    if (result.status === 404) notFound();
    return (
      <div className="space-y-4">
        <ErrorBanner code={result.error.code} message={result.error.message} details={result.error.details} />
        <Link href="/" className="inline-block text-sm font-medium text-zinc-700 underline underline-offset-4">
          Back to shipments
        </Link>
      </div>
    );
  }

  const { shipment: s, metrics, documents, fields, lineItems, checks, latestExport } = result.data;
  const audit = await apiFetch<AuditResponse>(`/api/shipments/${id}/audit`);
  const events = audit.ok ? audit.data.events : null; // history is non-critical: degrade, never block

  const perms = reviewPermissions(s.status);
  const exported = s.status === "EXPORTED";
  // Viewer context for the manager-only approve button. The layout guarantees
  // a session; defaulting to EXECUTIVE is the conservative direction (the
  // button would hide, never wrongly appear).
  const role = user?.role ?? "EXECUTIVE";
  // Approval readiness summary — PURE helper over the aggregate + the engine's
  // own required-field seam. Display only; the server's gates are the law.
  const readiness = approvalReadiness({
    documents: documents.map((d) => ({ type: d.type })),
    fields: fields.map((f) => ({
      documentType: String(f.documentType),
      fieldKey: String(f.fieldKey),
      status: String(f.status),
    })),
    checks: checks.map((c) => ({ ruleKey: c.ruleKey, result: c.result, severity: c.severity, resolvedAt: c.resolvedAt })),
  });
  // Display currency for money checks: the invoice's own `currency` FIELD is
  // the declared unit; fall back to the totalValue row's currency column
  // (manual entry may not have set either — then values render un-currencied).
  const invoiceCurrency =
    ((fields.find((f) => f.fieldKey === "currency" && f.documentType === "INVOICE")?.valueText as string | null) ||
      (fields.find((f) => f.fieldKey === "totalValue" && f.documentType === "INVOICE")?.currency as string | null)) ??
    null;
  const fieldRows = (doc: DocType): ReviewField[] =>
    fields.filter((f) => f.documentType === doc).map((f) => toReviewField({ ...f, documentType: doc }));

  return (
    <div className="space-y-4">
      <Link href="/" className="inline-block text-sm text-zinc-500 hover:text-zinc-700">
        ← All shipments
      </Link>

      {/* ---------------- header ---------------- */}
      <div className="rounded-lg border border-zinc-200 bg-white p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h1 className="font-mono text-lg font-semibold tracking-tight text-zinc-900">{s.ref}</h1>
            <StatusChip status={s.status} />
          </div>
          <p className="text-sm text-zinc-500">
            {s.supplier ? `${s.supplier.name}${s.supplier.country ? ` (${s.supplier.country})` : ""}` : "No supplier"}
            <span className="text-zinc-300"> · </span>
            imported by <span className="font-medium text-zinc-700">Your Company Ltd</span>
          </p>
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-2 text-sm md:grid-cols-4">
          <div>
            <dt className="text-zinc-500">Documents</dt>
            <dd className="text-zinc-900">{metrics.documentsCount} of 3</dd>
          </div>
          <div>
            <dt className="text-zinc-500">Fields cleared</dt>
            <dd className="text-zinc-900">
              {metrics.fieldsCleared}/{metrics.fieldsTotal}
            </dd>
          </div>
          <div>
            <dt className="text-zinc-500">Blocking discrepancies</dt>
            <dd className={metrics.unresolvedBlockingFails > 0 ? "font-medium text-red-600" : "text-zinc-900"}>
              {metrics.unresolvedBlockingFails}
            </dd>
          </div>
          <div>
            <dt className="text-zinc-500">Approval</dt>
            <dd className="text-zinc-900">
              {s.approval?.approvedAt
                ? `Approved by ${s.approval.approvedByName ?? "manager"} · ${fmt.format(new Date(s.approval.approvedAt))} IST`
                : "Not approved"}
            </dd>
          </div>
        </dl>
        {exported ? (
          <p className="mt-3 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
            This shipment is <strong>exported</strong> — read-only. Documents, fields and checks can no longer change.
            {latestExport ? ` Export file: ${latestExport.fileName} (v${latestExport.formatVersion}).` : ""}
          </p>
        ) : null}
        {s.status === "PROCESSING" ? (
          <p className="mt-3 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-700">
            Extraction in progress — extract or manually enter the remaining documents; field corrections unlock once
            all documents are processed.
          </p>
        ) : null}
        {s.status === "DRAFT" ? (
          <p className="mt-3 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-700">
            Draft — extract each document with AI (or enter it manually); the first extraction starts processing.
          </p>
        ) : null}
      </div>

      {/* ---------------- blocking banner ---------------- */}
      {metrics.unresolvedBlockingFails > 0 ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
          <p className="text-sm font-medium text-red-800">
            {metrics.unresolvedBlockingFails} unresolved blocking {metrics.unresolvedBlockingFails === 1 ? "discrepancy" : "discrepancies"} —
            approval and export stay locked until each one is corrected or resolved with a note.
          </p>
        </div>
      ) : null}

      {/* ---------------- approval + export (P4.5) ---------------- */}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <ApprovalPanel
          shipmentId={s.id}
          status={s.status}
          role={role}
          approval={s.approval?.approvedAt ? { approvedByName: s.approval.approvedByName, approvedAt: s.approval.approvedAt } : null}
          readiness={readiness}
        />
        <ExportPanel shipmentId={s.id} status={s.status} latestExport={latestExport} />
      </div>

      {/* ---------------- document tabs ---------------- */}
      <div className="border-b border-zinc-200">
        <nav className="flex gap-1" aria-label="Documents">
          {[...DOC_TYPES, "AUDIT" as const].map((t) => {
            const d = t === "AUDIT" ? undefined : documents.find((x) => x.type === t);
            const active = t === "AUDIT" ? auditTab : !auditTab && t === selectedDoc;
            return (
              <Link
                key={t}
                href={`/shipments/${s.id}?doc=${t}`}
                aria-current={active ? "page" : undefined}
                className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-medium ${
                  active ? "border-zinc-900 text-zinc-900" : "border-transparent text-zinc-500 hover:border-zinc-300 hover:text-zinc-700"
                }`}
              >
                {t === "AUDIT" ? "Audit trail" : documentTypeLabel(t)}
                {t === "AUDIT" ? null : (
                  <span
                    className={`ml-2 inline-block h-1.5 w-1.5 rounded-full align-middle ${
                      !d ? "bg-zinc-300" : d.status === "PROCESSED" ? "bg-emerald-500" : d.status === "UPLOADED" ? "bg-amber-500" : "bg-red-500"
                    }`}
                    aria-hidden
                  />
                )}
              </Link>
            );
          })}
        </nav>
      </div>

      {auditTab ? (
        /* ---------------- audit trail (full-width, P4.5) ---------------- */
        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
          <div className="border-b border-zinc-200 px-4 py-3">
            <h2 className="text-sm font-semibold text-zinc-900">Append-only audit trail</h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              Every event the services wrote — verbatim payloads, newest first. This tab renders history; it never
              fabricates a description. POST to this endpoint is not a route (405): entries cannot be edited or added
              from outside a business transaction.
            </p>
          </div>
          {events === null ? (
            <p className="px-4 py-3 text-xs text-zinc-500">Audit trail is unavailable right now.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 text-xs font-medium text-zinc-500">
                    <th className="px-4 py-2.5">When (IST)</th>
                    <th className="px-4 py-2.5">Actor</th>
                    <th className="px-4 py-2.5">Event</th>
                    <th className="px-4 py-2.5">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((e) => (
                    <tr key={e.id} className="border-b border-zinc-100 last:border-0 align-top">
                      <td className="whitespace-nowrap px-4 py-2 font-mono text-[11px] text-zinc-400">
                        {fmt.format(new Date(e.createdAt))} IST
                      </td>
                      <td className="px-4 py-2 font-medium text-zinc-900">{e.actorName}</td>
                      <td className="px-4 py-2 text-zinc-700">{AUDIT_LABELS[e.action] ?? e.action}</td>
                      <td className="px-4 py-2 font-mono text-[11px] text-zinc-500">{auditSummary(e.action, e.payload) ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        (() => {
        const doc = documents.find((x) => x.type === selectedDoc);
        const rows = fieldRows(selectedDoc);
        const items = lineItems.filter((li) => li.documentType === selectedDoc);
        const extract = doc ? extractAction(s.status, doc.status) : null;
        return (
          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
            <div className="space-y-4">
              {doc ? (
                <DocumentPreview documentId={doc.id} fileName={doc.fileName} />
              ) : (
                <div className="flex min-h-[420px] flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-zinc-300 bg-white px-6 text-center">
                  <p className="text-sm font-medium text-zinc-900">{documentTypeLabel(selectedDoc)} not uploaded</p>
                  <p className="text-xs text-zinc-500">Upload it in the Documents section below, then review its fields here.</p>
                </div>
              )}
              {doc ? (
                <p className="text-xs text-zinc-500">
                  {documentTypeLabel(selectedDoc)} · {doc.fileName} · {formatBytes(Number(doc.sizeBytes))} ·{" "}
                  {documentStatusLabel(doc.status)}
                </p>
              ) : null}
            </div>

            <div className="space-y-4">
              {doc && extract ? <ExtractButton documentId={doc.id} action={extract} /> : null}
              {doc?.status === "FAILED" && doc.extractError ? (
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
                  <p className="text-sm font-medium text-red-800">The last extraction attempt failed</p>
                  <p className="mt-1 break-words font-mono text-[11px] text-red-700">{doc.extractError}</p>
                  <p className="mt-1 text-xs text-red-600">Retry above, or enter this document manually below.</p>
                </div>
              ) : null}
              <FieldsPanel shipmentId={s.id} fields={rows} requiredKeys={REQUIRED_FIELD_KEYS[selectedDoc]} canCorrect={perms.canCorrect} />

              {items.length > 0 ? (
                <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-zinc-200 text-xs font-medium text-zinc-500">
                        <th className="px-4 py-2.5">#</th>
                        <th className="px-4 py-2.5">Description</th>
                        <th className="px-4 py-2.5 text-right">Qty</th>
                        <th className="px-4 py-2.5 text-right">Unit price</th>
                        <th className="px-4 py-2.5 text-right">Line total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((li) => (
                        <tr key={li.id} className="border-b border-zinc-100 last:border-0">
                          <td className="px-4 py-2 text-zinc-500">{li.seq}</td>
                          <td className="px-4 py-2 text-zinc-900">
                            {li.description}
                            {li.hsnCode ? <span className="ml-2 text-[11px] text-zinc-400">HSN {li.hsnCode}</span> : null}
                          </td>
                          <td className="px-4 py-2 text-right font-mono text-[13px] text-zinc-900">{qtyFmt.format(Number(li.quantity))}</td>
                          <td className="px-4 py-2 text-right font-mono text-[13px] text-zinc-900">
                            {li.unitPrice ? money.format(Number(li.unitPrice)) : "—"}
                          </td>
                          <td className="px-4 py-2 text-right font-mono text-[13px] text-zinc-900">
                            {li.lineTotal ? money.format(Number(li.lineTotal)) : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}

              {doc ? (
                <ManualEntryForm
                  shipmentId={s.id}
                  documentId={doc.id}
                  docType={selectedDoc}
                  fields={rows}
                  enabled={perms.canManualEntry}
                />
              ) : null}
            </div>
          </div>
        );
        })()
      )}

      {/* ---------------- documents / upload ---------------- */}
      {perms.readOnly ? null : <DocumentUpload shipmentId={s.id} documents={documents} />}
      {perms.readOnly ? (
        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-xs font-medium text-zinc-500">
                <th className="px-4 py-2.5">Type</th>
                <th className="px-4 py-2.5">File</th>
                <th className="px-4 py-2.5">Size</th>
                <th className="px-4 py-2.5">Status</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((d) => (
                <tr key={d.id} className="border-b border-zinc-100 last:border-0">
                  <td className="px-4 py-3 font-medium text-zinc-900">{documentTypeLabel(d.type)}</td>
                  <td className="px-4 py-3 text-zinc-700">{d.fileName}</td>
                  <td className="px-4 py-3 text-zinc-500">{formatBytes(Number(d.sizeBytes))}</td>
                  <td className="px-4 py-3 text-zinc-700">{documentStatusLabel(d.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {/* ---------------- validation checks ---------------- */}
      <div className="rounded-lg border border-zinc-200 bg-white">
        <div className="border-b border-zinc-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-zinc-900">Deterministic checks</h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            Pure cross-checks over the typed data — the same engine every write re-runs. Nothing here is AI-generated.
          </p>
        </div>
        <ul className="divide-y divide-zinc-100">
          {checks.map((c) => {
            const blocking = c.severity === "BLOCKING";
            const failed = c.result === "FAIL";
            const unresolved = failed && c.resolvedAt === null;
            const detailRows = checkDetailRows(c.ruleKey, c.detailsJson, invoiceCurrency);
            return (
              <li
                key={c.id}
                className={`px-4 py-3 ${unresolved && blocking ? "border-l-2 border-l-red-500" : failed ? "border-l-2 border-l-amber-400" : "border-l-2 border-l-transparent"}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium text-zinc-900">{checkTitle(c.ruleKey)}</p>
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        c.result === "PASS"
                          ? "bg-emerald-50 text-emerald-700"
                          : failed
                            ? "bg-red-50 text-red-700"
                            : c.result === "WARNING"
                              ? "bg-amber-50 text-amber-700"
                              : "bg-zinc-100 text-zinc-500"
                      }`}
                    >
                      {checkStatusLabel(c.result)}
                    </span>
                    {blocking ? (
                      <span className="inline-flex items-center rounded-full bg-zinc-900 px-2 py-0.5 text-[11px] font-medium text-white">
                        Blocks approval
                      </span>
                    ) : null}
                    {c.resolvedAt ? (
                      <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200">
                        Accepted with note
                      </span>
                    ) : null}
                  </div>
                  {unresolved && blocking && perms.canResolve ? (
                    <ResolveCheckButton shipmentId={s.id} checkId={c.id} ruleKey={c.ruleKey} shipmentRef={s.ref} detailsText={detailRows.map((r) => `${r.label}: ${r.value}`).join("\n")} />
                  ) : null}
                </div>
                {detailRows.length > 0 ? (
                  <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-3">
                    {detailRows.map((r, i) => (
                      <div key={`${r.label}-${i}`} className="flex justify-between gap-2 border-b border-dashed border-zinc-100 py-0.5">
                        <dt className="text-zinc-500">{r.label}</dt>
                        <dd className={`font-mono ${r.value === "MISMATCH" ? "font-semibold text-red-600" : "text-zinc-900"}`}>{r.value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
                {c.resolvedNote ? <p className="mt-2 text-xs text-emerald-700">Resolution note: “{c.resolvedNote}”</p> : null}
              </li>
            );
          })}
        </ul>
      </div>

      {/* ---------------- (history moved into the AUDIT tab, P4.5) ---------------- */}
    </div>
  );
}
