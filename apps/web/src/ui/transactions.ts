// E03-S06 server-rendered transaction table + drawer (zero client JS).
// Consumes the shared transactions-query.ts reads and the S05 domain
// commands — never its own SQL for financial truth. Selection is per-page
// only (checkboxes reset across pages; stated on the page, never silently
// mixed). Conflicts re-render with the fresh version and preserved input.

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { isUuid } from "../ids.ts";
import { formatMinor } from "../money.ts";
import { listAccountViews } from "../commands/accounts.ts";
import {
  TxError,
  addTag as addTagCmd,
  bulkSetCategory as bulkSetCategoryCmd,
  correct as correctCmd,
  getTransaction,
  listCategories,
  listTags,
  setCategory as setCategoryCmd,
  undo as undoCmd,
  validateBulkSetCategoryInput,
} from "../commands/transactions.ts";
import { TenantDenied, TenantInvalid, sessionClaims, type SessionResolver } from "../tenancy.ts";
import { getTransactionEvidence, listTransactions, type TxListItem } from "../transactions-query.ts";
import { readLimitedBody } from "../http-controls.ts";
import { errorPage, escapeHtml, page } from "./shell.ts";

export type TxUiConfig = { appBaseUrl: string };

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  });
  res.end(body);
}

function readFormBody(req: IncomingMessage): Promise<URLSearchParams> {
  return readLimitedBody(req, 64 * 1024).then((body) => {
    try {
      return new URLSearchParams(body.toString("utf8"));
    } catch {
      throw new Error("body_invalid");
    }
  });
}

function sameOrigin(req: IncomingMessage, appBaseUrl: string): boolean {
  const allowed = new URL(appBaseUrl).origin;
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  if (req.headers["sec-fetch-site"] === "same-origin") return true;
  if (typeof origin === "string") return origin === allowed;
  if (typeof referer === "string") return referer === allowed || referer.startsWith(`${allowed}/`);
  return false;
}

function fmtAmount(item: { amountMinor: string; currency: string }): string {
  try {
    return `${formatMinor(BigInt(item.amountMinor), item.currency)} ${item.currency}`;
  } catch {
    return `${item.amountMinor} ${item.currency}`;
  }
}

function filterQuery(query: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["kind", "accountId", "categoryId", "uncategorized", "tagId", "direction", "dateFrom", "dateTo", "search", "sort", "limit"]) {
    const value = query.get(key);
    if (value !== null && value !== "") out[key] = value;
  }
  return out;
}

function withOffset(base: Record<string, string>, offset: number): string {
  const params = new URLSearchParams({ ...base, offset: String(offset) });
  return params.toString();
}

function rowLabel(item: TxListItem): string {
  return `${item.effectiveDate} ${item.description}`;
}

export async function handleTransactionRoutes(
  pool: Pool,
  resolveSession: SessionResolver,
  config: TxUiConfig,
  event: (code: string) => void,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  query: URLSearchParams,
  requestId = "uncontrolled",
): Promise<boolean> {
  const tableMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/transactions$/);
  if (tableMatch && method === "GET") {
    const workspaceId = tableMatch[1];
    const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
    if (!resolved.session) {
      html(res, 401, errorPage({ status: 401, heading: "Sign in required", message: "Log in to view transactions.", back: "/", requestId, authed: false }));
      return true;
    }
    if (!resolved.claim) {
      event("ui_denied:transactions");
      html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace.", back: "/", requestId, authed: true }));
      return true;
    }
    const filters = filterQuery(query);
    // N1: strict offset parsing — garbage maps to a 400 like the API
    // validator, never silently to page one.
    const offsetRaw = query.get("offset");
    if (offsetRaw !== null && !/^\d+$/.test(offsetRaw)) {
      html(res, 400, errorPage({ status: 400, heading: "Invalid page", message: "The page offset is not valid. Return to the first page and retry.", back: `/w/${escapeHtml(workspaceId)}/transactions`, requestId, authed: true }));
      return true;
    }
    const offset = offsetRaw === null ? 0 : Math.min(1_000_000, Number(offsetRaw));
    try {
      const [result, accounts, categories] = await Promise.all([
        listTransactions(pool, resolved.claim, { workspaceId, ...filters, offset }),
        listAccountViews(pool, resolved.claim),
        listCategories(pool, resolved.claim),
      ]);
      const accountName = new Map(accounts.map((a) => [a.id, a.name]));
      const categoryName = new Map(categories.map((c) => [c.id, c.name]));
      const total = Number(result.totals.count);
      const from = total === 0 ? 0 : offset + 1;
      const to = Math.min(total, offset + result.items.length);
      const totalsLine =
        result.totals.byCurrency.length === 0
          ? `<p>No matching transactions.</p>`
          : `<p>${escapeHtml(String(total))} matching transaction${total === 1 ? "" : "s"}: ${result.totals.byCurrency
              .map((t) => `${escapeHtml(t.currency)} — in ${escapeHtml(formatMinor(BigInt(t.inflowMinor), t.currency))}, out ${escapeHtml(formatMinor(BigInt(t.outflowMinor), t.currency))}`)
              .join("; ")}.</p>`;
      const sortDir = filters.sort === "date_asc" ? "oldest first" : "newest first";
      const rows =
        result.items.length === 0
          ? `<p>No transactions on this page.</p>`
          : `<div style="overflow-x:auto"><table><caption>Transactions (${escapeHtml(sortDir)}; selection applies to this page only)</caption><thead><tr><th scope="col">Select</th><th scope="col">Date</th><th scope="col">Description</th><th scope="col">Account</th><th scope="col">Amount</th><th scope="col">Direction</th><th scope="col">Category</th><th scope="col">Detail</th></tr></thead><tbody>${result.items
              .map(
                (t) =>
                  `<tr><td><input type="checkbox" form="bulk-form" name="sel" value="${escapeHtml(t.kind)}:${escapeHtml(t.id)}:${escapeHtml(t.version)}" aria-label="Select ${escapeHtml(rowLabel(t))}"></td><td>${escapeHtml(t.effectiveDate)}</td><td>${escapeHtml(t.description)}</td><td>${escapeHtml(accountName.get(t.accountId) ?? t.accountId)}</td><td>${escapeHtml(fmtAmount(t))}</td><td>${escapeHtml(t.direction)}</td><td>${escapeHtml(t.categoryId ? (categoryName.get(t.categoryId) ?? t.categoryId) : "Uncategorized")}</td><td><a href="/w/${escapeHtml(workspaceId)}/transactions/${escapeHtml(t.id)}?kind=${escapeHtml(t.kind)}">Open</a></td></tr>`,
              )
              .join("")}</tbody></table></div>`;
      const pager = `<p>${total === 0 ? "" : `Showing ${from}–${to} of ${total}. `}
        ${offset > 0 ? `<a href="/w/${escapeHtml(workspaceId)}/transactions?${escapeHtml(withOffset(filters, Math.max(0, offset - result.limit)))}">Previous page</a>` : ""}
        ${offset + result.items.length < total ? ` <a href="/w/${escapeHtml(workspaceId)}/transactions?${escapeHtml(withOffset(filters, offset + result.limit))}">Next page</a>` : ""}</p>`;
      const option = (value: string, label: string, selected: string | undefined): string =>
        `<option value="${escapeHtml(value)}"${selected === value ? " selected" : ""}>${escapeHtml(label)}</option>`;
      const filterForm = `<form method="get" action="/w/${escapeHtml(workspaceId)}/transactions">
        <p><label>Kind <select name="kind">${option("all", "All", filters.kind ?? "all")}${option("imported", "Imported", filters.kind)}${option("manual", "Manual", filters.kind)}</select></label>
        <label>Account <select name="accountId"><option value="">All accounts</option>${accounts.map((a) => option(a.id, a.name, filters.accountId)).join("")}</select></label>
        <label>Category <select name="categoryId"><option value="">All categories</option>${categories.map((c) => option(c.id, c.name, filters.categoryId)).join("")}</select></label>
        <label><input type="checkbox" name="uncategorized" value="1"${filters.uncategorized ? " checked" : ""}> Uncategorized only</label></p>
        <p><label>Direction <select name="direction"><option value="">Both</option>${option("INFLOW", "Inflow", filters.direction)}${option("OUTFLOW", "Outflow", filters.direction)}</select></label>
        <label>From <input type="date" name="dateFrom" value="${escapeHtml(filters.dateFrom ?? "")}"></label>
        <label>To <input type="date" name="dateTo" value="${escapeHtml(filters.dateTo ?? "")}"></label>
        <label>Search <input name="search" maxlength="100" value="${escapeHtml(filters.search ?? "")}"></label>
        <label>Sort <select name="sort">${option("date_desc", "Newest first", filters.sort ?? "date_desc")}${option("date_asc", "Oldest first", filters.sort)}</select></label>
        <button type="submit">Apply</button></p></form>`;
      const bulkForm = `<form id="bulk-form" method="post" action="/w/${escapeHtml(workspaceId)}/transactions/bulk"><input type="hidden" name="idempotencyKey" value="${randomUUID()}"><p><label>Bulk category <select name="categoryId"><option value="">— choose —</option><option value="__clear__">Clear category</option>${categories.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join("")}</select></label> <button type="submit">Apply to selected</button> <small>One kind (imported or manual) per batch.</small></p></form>`;
      const notice =
        query.get("notice") === "bulk-applied"
          ? `<div class="notice" role="status"><p>Bulk category update applied.</p></div>`
          : query.get("notice") === "corrected"
            ? `<div class="notice" role="status"><p>Transaction updated.</p></div>`
            : query.get("notice") === "ai-confirmed" && isUuid(query.get("operationId") ?? "")
              ? `<div class="notice" role="status"><p>AI-proposed transaction confirmed. Operation ${escapeHtml(query.get("operationId")!)} is recorded in the audit history.</p><form method="post" action="/w/${escapeHtml(workspaceId)}/transactions/undo"><input type="hidden" name="operationId" value="${escapeHtml(query.get("operationId")!)}"><input type="hidden" name="idempotencyKey" value="${randomUUID()}"><button type="submit">Undo with compensating transaction</button></form></div>`
              : query.get("notice") === "undone"
                ? `<div class="notice" role="status"><p>Compensating transaction recorded.</p></div>`
            : "";
      html(
        res,
        200,
        page({ title: "Transactions", requestId, authed: true, content: `<h2>Transactions</h2>${notice}${filterForm}${totalsLine}${rows}${pager}${bulkForm}<p><a href="/w/${escapeHtml(workspaceId)}">Back to workspace</a></p>` }),
      );
      return true;
    } catch (err) {
      if (err instanceof TenantInvalid || err instanceof TenantDenied) {
        event("ui_denied:transactions");
        html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace.", back: "/", requestId, authed: true }));
        return true;
      }
      throw err;
    }
  }

  const undoMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/transactions\/undo$/);
  if (undoMatch && method === "POST") {
    const workspaceId = undoMatch[1];
    if (!sameOrigin(req, config.appBaseUrl)) return false;
    const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
    if (!resolved.claim) return false;
    const form = await readFormBody(req).catch(() => null);
    await undoCmd(pool, resolved.claim, resolved.claim.userId, { workspaceId, operationId: form?.get("operationId"), idempotencyKey: form?.get("idempotencyKey") });
    res.writeHead(303, { Location: `/w/${workspaceId}/transactions?notice=undone` });
    res.end();
    return true;
  }

  const drawerMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/transactions\/([A-Za-z0-9-]+)$/);
  if (drawerMatch && method === "GET") {
    const workspaceId = drawerMatch[1];
    const txId = drawerMatch[2];
    const kind = query.get("kind") === "manual" ? "manual" : "imported";
    const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
    if (!resolved.session) {
      html(res, 401, errorPage({ status: 401, heading: "Sign in required", message: "Log in to view this transaction.", back: "/", requestId, authed: false }));
      return true;
    }
    if (!resolved.claim) {
      event("ui_denied:transaction");
      html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace.", back: "/", requestId, authed: true }));
      return true;
    }
    return renderDrawer(pool, resolved.claim.userId, workspaceId, kind, txId, req, res, query, requestId, null, null);
  }

  const bulkMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/transactions\/bulk$/);
  if (bulkMatch && method === "POST") {
    const workspaceId = bulkMatch[1];
    if (!sameOrigin(req, config.appBaseUrl)) {
      event("ui_denied:origin");
      html(res, 403, errorPage({ status: 403, heading: "Forbidden", message: "Cross-origin form posts are rejected.", back: `/w/${workspaceId}/transactions`, requestId, authed: true }));
      return true;
    }
    const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
    if (!resolved.claim) {
      const authed = resolved.session !== null;
      html(res, authed ? 404 : 401, errorPage({ status: authed ? 404 : 401, heading: authed ? "Not found" : "Sign in required", message: "No such workspace.", back: "/", requestId, authed }));
      return true;
    }
    const form = await readFormBody(req).catch(() => null);
    const rawSel = form?.getAll("sel") ?? [];
    const categoryRaw = form?.get("categoryId") ?? "";
    const idempotencyKey = form?.get("idempotencyKey") ?? "";
    const parsed = rawSel.flatMap((s) => {
      const parts = s.split(":");
      if (parts.length !== 3 || (parts[0] !== "imported" && parts[0] !== "manual") || !isUuid(parts[1]) || !/^[0-9]+$/.test(parts[2])) return [];
      return [{ kind: parts[0] as "imported" | "manual", id: parts[1], version: parts[2] }];
    });
    if (parsed.length === 0 || categoryRaw === "" || !isUuid(idempotencyKey)) {
      event("ui_command_denied:bulk");
      html(res, 400, errorPage({ status: 400, heading: "Nothing to update", message: "Select at least one transaction on this page and choose a category.", back: `/w/${workspaceId}/transactions`, requestId, authed: true }));
      return true;
    }
    const categoryId = categoryRaw === "__clear__" ? null : categoryRaw;
    if (categoryId !== null && !isUuid(categoryId)) {
      html(res, 400, errorPage({ status: 400, heading: "Bulk update failed", message: "Unknown category.", back: `/w/${workspaceId}/transactions`, requestId, authed: true }));
      return true;
    }
    // B1: one UI batch covers exactly one kind. Mixed-kind selections are
    // rejected up front (400) rather than executed as sequential per-kind
    // transactions, which could half-apply and could not replay identically.
    const kinds = new Set(parsed.map((i) => i.kind));
    if (kinds.size > 1) {
      event("ui_command_denied:bulk-mixed-kind");
      html(res, 400, errorPage({ status: 400, heading: "One kind per batch", message: "Select imported or manual transactions in a single bulk update, not both. Split the selection and retry.", back: `/w/${workspaceId}/transactions`, requestId, authed: true }));
      return true;
    }
    try {
      const kind = parsed[0].kind;
      const input = {
        workspaceId,
        transactionKind: kind,
        categoryId,
        items: parsed.map((i) => ({ transactionId: i.id, expectedVersion: i.version })),
        idempotencyKey,
      };
      validateBulkSetCategoryInput(input);
      await bulkSetCategoryCmd(pool, resolved.claim, resolved.claim.userId, input);
      event("ui_command_ok:bulk");
      res.writeHead(303, { Location: `/w/${workspaceId}/transactions?notice=bulk-applied` });
      res.end();
      return true;
    } catch (err) {
      // N2: not_found maps to the same 409 conflict shell as stale versions —
      // the UI never distinguishes unknown categories/transactions from
      // moved-on ones (uniform, no existence oracle).
      if (err instanceof TxError && (err.code === "version_mismatch" || err.code === "idempotency_reuse" || err.code === "idempotency_expired" || err.code === "not_found")) {
        event("ui_command_conflict:bulk");
        const detail = (err.detail as { items?: { transactionId: string; reason: string; currentVersion?: string }[] } | undefined)?.items ?? [];
        html(
          res,
          409,
          page({
            title: "Bulk update conflict",
            requestId,
            authed: true,
            content: `<div class="alert" role="alert"><h2>Bulk update conflict</h2><p>One or more selected transactions changed before this update. Nothing was changed. Reopen the table for fresh versions and retry.</p>${detail.length > 0 ? `<ul>${detail.map((d) => `<li>${escapeHtml(d.transactionId)} — ${escapeHtml(d.reason)}${d.currentVersion ? ` (now v${escapeHtml(d.currentVersion)})` : ""}</li>`).join("")}</ul>` : ""}<p><a href="/w/${escapeHtml(workspaceId)}/transactions">Back to transactions</a></p></div>`,
          }),
        );
        return true;
      }
      if (err instanceof TxError || err instanceof TenantInvalid || err instanceof TenantDenied) {
        event("ui_command_denied:bulk");
        html(res, 400, errorPage({ status: 400, heading: "Bulk update failed", message: "Check the selection and retry.", back: `/w/${workspaceId}/transactions`, requestId, authed: true }));
        return true;
      }
      throw err;
    }
  }

  const drawerActionMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/transactions\/([A-Za-z0-9-]+)\/(set_category|correct|add_tag)$/);
  if (drawerActionMatch && method === "POST") {
    const workspaceId = drawerActionMatch[1];
    const txId = drawerActionMatch[2];
    const action = drawerActionMatch[3];
    if (!sameOrigin(req, config.appBaseUrl)) {
      event("ui_denied:origin");
      html(res, 403, errorPage({ status: 403, heading: "Forbidden", message: "Cross-origin form posts are rejected.", back: `/w/${workspaceId}/transactions`, requestId, authed: true }));
      return true;
    }
    const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
    if (!resolved.claim) {
      const authed = resolved.session !== null;
      html(res, authed ? 404 : 401, errorPage({ status: authed ? 404 : 401, heading: authed ? "Not found" : "Sign in required", message: "No such workspace.", back: "/", requestId, authed }));
      return true;
    }
    const form = await readFormBody(req).catch(() => null);
    const kind = form?.get("kind") === "manual" ? "manual" : "imported";
    const expectedVersion = form?.get("expectedVersion") ?? "";
    const idempotencyKey = form?.get("idempotencyKey") ?? "";
    try {
      if (action === "set_category") {
        const categoryRaw = form?.get("categoryId") ?? "";
        await setCategoryCmd(pool, resolved.claim, resolved.claim.userId, {
          workspaceId,
          transactionKind: kind,
          transactionId: txId,
          categoryId: categoryRaw === "__clear__" || categoryRaw === "" ? null : categoryRaw,
          expectedVersion,
          idempotencyKey,
        });
      } else if (action === "correct") {
        await correctCmd(pool, resolved.claim, resolved.claim.userId, {
          workspaceId,
          transactionKind: kind,
          transactionId: txId,
          expectedVersion,
          description: form?.get("description") ?? "",
          idempotencyKey,
        });
      } else {
        const tagId = form?.get("tagId") ?? "";
        await addTagCmd(pool, resolved.claim, resolved.claim.userId, {
          workspaceId,
          transactionKind: kind,
          transactionId: txId,
          tagId,
          expectedVersion,
          idempotencyKey,
        });
      }
      event(`ui_command_ok:drawer-${action}`);
      res.writeHead(303, { Location: `/w/${workspaceId}/transactions?notice=corrected` });
      res.end();
      return true;
    } catch (err) {
      if (err instanceof TxError && (err.code === "version_mismatch" || err.code === "idempotency_reuse" || err.code === "idempotency_expired")) {
        event(`ui_command_conflict:drawer-${action}`);
        return renderDrawer(pool, resolved.claim.userId, workspaceId, kind, txId, req, res, query, requestId, "This transaction changed before your update. Review the current values and retry with a fresh form.", {
          description: action === "correct" ? (form?.get("description") ?? null) : null,
        });
      }
      if (err instanceof TxError || err instanceof TenantInvalid || err instanceof TenantDenied) {
        event(`ui_command_denied:drawer-${action}`);
        return renderDrawer(pool, resolved.claim.userId, workspaceId, kind, txId, req, res, query, requestId, "The update was rejected. Check the values and retry.", {
          description: action === "correct" ? (form?.get("description") ?? null) : null,
        });
      }
      throw err;
    }
  }

  return false;

  async function renderDrawer(
    pool: Pool,
    _userId: string,
    workspaceId: string,
    kind: "imported" | "manual",
    txId: string,
    _req: IncomingMessage,
    res: ServerResponse,
    _query: URLSearchParams,
    requestId: string,
    alert: string | null,
    preserved: { description: string | null } | null,
  ): Promise<boolean> {
    const { claim } = await sessionClaims(pool, resolveSession, _req, workspaceId);
    if (!claim) {
      html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace.", back: "/", requestId, authed: true }));
      return true;
    }
    const [view, evidence, categories, tags, accounts] = await Promise.all([
      getTransaction(pool, claim, kind, txId),
      getTransactionEvidence(pool, claim, kind, txId),
      listCategories(pool, claim),
      listTags(pool, claim),
      listAccountViews(pool, claim),
    ]);
    if (!view || !evidence) {
      html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such transaction.", back: `/w/${escapeHtml(workspaceId)}/transactions`, requestId, authed: true }));
      return true;
    }
    const accountName = accounts.find((a) => a.id === view.accountId)?.name ?? view.accountId;
    const categoryName = view.categoryId ? (categories.find((c) => c.id === view.categoryId)?.name ?? view.categoryId) : "Uncategorized";
    const tagNames = view.tagIds.map((id) => tags.find((t) => t.id === id)?.name ?? id);
    const sourceSection =
      evidence.source.kind === "imported"
        ? `<h3>Source evidence</h3><dl><dt>File</dt><dd>${escapeHtml(evidence.source.fileName || "unknown file")}</dd><dt>Row</dt><dd>${escapeHtml(String(evidence.source.importRowNo))}</dd><dt>Observation</dt><dd>${escapeHtml(evidence.source.observationId)}</dd><dt>Link status</dt><dd>${escapeHtml(evidence.source.linkStatus)}${evidence.source.matchReason ? ` (${escapeHtml(evidence.source.matchReason)})` : ""}</dd></dl>`
        : `<h3>Source evidence</h3><dl><dt>Entry</dt><dd>Manual</dd><dt>Reference</dt><dd>${escapeHtml(evidence.source.reference ?? "none")}</dd></dl>`;
    const auditSection =
      evidence.audit.length === 0
        ? `<h3>History</h3><p>No corrections yet.</p>`
        : `<h3>History</h3><ul>${evidence.audit.map((a) => `<li>${escapeHtml(a.action)} — ${escapeHtml(a.createdAt)}${a.compensatingOperationId ? " (undo)" : ""}</li>`).join("")}</ul>`;
    const alertBox = alert ? `<div class="alert" role="alert"><h2>Update conflict</h2><p>${escapeHtml(alert)}</p></div>` : "";
    const key = randomUUID();
    const forms = `<h3>Correct</h3>
      <form method="post" action="/w/${escapeHtml(workspaceId)}/transactions/${escapeHtml(txId)}/set_category"><input type="hidden" name="kind" value="${escapeHtml(kind)}"><input type="hidden" name="expectedVersion" value="${escapeHtml(view.version)}"><input type="hidden" name="idempotencyKey" value="${key}"><p><label>Category <select name="categoryId"><option value="__clear__">Uncategorized</option>${categories.map((c) => `<option value="${escapeHtml(c.id)}"${c.id === view.categoryId ? " selected" : ""}>${escapeHtml(c.name)}</option>`).join("")}</select></label> <button type="submit">Save category</button></p></form>
      <form method="post" action="/w/${escapeHtml(workspaceId)}/transactions/${escapeHtml(txId)}/correct"><input type="hidden" name="kind" value="${escapeHtml(kind)}"><input type="hidden" name="expectedVersion" value="${escapeHtml(view.version)}"><input type="hidden" name="idempotencyKey" value="${randomUUID()}"><p><label>Description <input name="description" required maxlength="500" value="${escapeHtml(preserved?.description ?? view.description)}"></label> <button type="submit">Save description</button></p></form>
      ${
        kind === "imported"
          ? `<form method="post" action="/w/${escapeHtml(workspaceId)}/transactions/${escapeHtml(txId)}/add_tag"><input type="hidden" name="kind" value="${escapeHtml(kind)}"><input type="hidden" name="expectedVersion" value="${escapeHtml(view.version)}"><input type="hidden" name="idempotencyKey" value="${randomUUID()}"><p><label>Tag <select name="tagId">${tags.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`).join("")}</select></label> <button type="submit">Add tag</button></p></form>`
          : `<p>Tags attach to imported transactions only.</p>`
      }`;
    html(
      res,
      alert ? 409 : 200,
      page({
        title: "Transaction",
        requestId,
        authed: true,
        content: `<h2>Transaction</h2>${alertBox}<dl><dt>Date</dt><dd>${escapeHtml(view.effectiveDate)}</dd><dt>Description</dt><dd>${escapeHtml(view.description)}</dd><dt>Account</dt><dd>${escapeHtml(accountName)}</dd><dt>Amount</dt><dd>${escapeHtml(fmtAmount(view))}</dd><dt>Direction</dt><dd>${escapeHtml(view.direction)}</dd><dt>Category</dt><dd>${escapeHtml(categoryName)}</dd><dt>Tags</dt><dd>${tagNames.length > 0 ? tagNames.map((t) => escapeHtml(t)).join(", ") : "none"}</dd><dt>Version</dt><dd>${escapeHtml(view.version)}</dd></dl>${sourceSection}${auditSection}${forms}<p><a href="/w/${escapeHtml(workspaceId)}/transactions">Back to transactions</a></p>`,
      }),
    );
    return true;
  }
}
