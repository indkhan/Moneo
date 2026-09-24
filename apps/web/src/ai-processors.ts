// E08-S03-L processor/subprocessor inventory (architecture §465) with
// honest Settings disclosure. Development reality is recorded as observed;
// production processors stay pending-qualification with every required term
// named and none asserted. No value here is a signed agreement; S03-D
// replaces pending entries with observed config + contract evidence. Never
// describe a provider in broader/safer terms than its configured policy.

export type ProcessorStatus = "development-only" | "local-test-only" | "pending-qualification" | "qualified";

export type ProcessorEntry = {
  name: string;
  purpose: string;
  dataCategories: string;
  region: string;
  training: string;
  dpa: string;
  retention: string;
  status: ProcessorStatus;
};

export const PROCESSOR_INVENTORY: ProcessorEntry[] = [
  {
    name: "OpenRouter (development route)",
    purpose: "Development AI inference for mapping, chat, analysis and artifact assistance (synthetic data only).",
    dataCategories: "Synthetic prompts and model responses; account exclusions enforced before dispatch.",
    region: "International processing (founder permits; EU-only inference not required). Actual edge/region per call is unqualified.",
    training: "Training-permitted on free-variant routes (e.g. :free models). Never used for customer data.",
    dpa: "No signed DPA; development synthetic traffic only.",
    retention: "Provider-default retention on development traffic (unqualified; assume retained).",
    status: "development-only",
  },
  {
    name: "Underlying model providers (via OpenRouter)",
    purpose: "Subprocessing of development inference requests routed by OpenRouter.",
    dataCategories: "Same synthetic payloads as above.",
    region: "Undisclosed per call; unqualified.",
    training: "Subject to each provider's terms via OpenRouter; unqualified for customer data.",
    dpa: "None signed.",
    retention: "Unqualified.",
    status: "development-only",
  },
  {
    name: "Production inference route",
    purpose: "Customer-data AI inference (not yet enabled).",
    dataCategories: "Would carry eligible workspace data only, after policy gates.",
    region: "To be recorded from the qualified route's observed config.",
    training: "Required: no training on customer data (data_collection deny). Unproven until S03-D.",
    dpa: "Required: signed DPA + subprocessor list before customer traffic. Not signed.",
    retention: "Required: qualified retention + ZDR evidence. Not qualified.",
    status: "pending-qualification",
  },
  {
    name: "Local disposable services (PostgreSQL, Redis, MinIO, ClamAV, Keycloak containers)",
    purpose: "Synthetic test runtime only.",
    dataCategories: "Synthetic fixtures; no customer data.",
    region: "Loopback / disposable containers on the operator machine.",
    training: "Not applicable (no model training).",
    dpa: "Not applicable (no personal data).",
    retention: "Disposable per-suite databases and buckets; see the retention catalog.",
    status: "local-test-only",
  },
];

/** Production disclosure readiness: every required term qualified, nothing pending. */
export function productionDisclosureReady(): boolean {
  return PROCESSOR_INVENTORY.filter((p) => p.name.startsWith("Production")).every((p) => p.status === "qualified");
}

function escapeCell(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** Settings disclosure table: observed development reality plus pending production terms, never asserted. */
export function renderProcessorDisclosureHtml(): string {
  const rows = PROCESSOR_INVENTORY.map(
    (p) =>
      `<tr><td>${escapeCell(p.name)}</td><td>${escapeCell(p.purpose)}</td><td>${escapeCell(p.dataCategories)}</td><td>${escapeCell(p.region)}</td><td>${escapeCell(p.training)}</td><td>${escapeCell(p.dpa)}</td><td>${escapeCell(p.retention)}</td><td>${escapeCell(p.status)}</td></tr>`,
  ).join("");
  return `<table><thead><tr><th scope="col">Processor</th><th scope="col">Purpose</th><th scope="col">Data</th><th scope="col">Region</th><th scope="col">Training</th><th scope="col">Agreement</th><th scope="col">Retention</th><th scope="col">Status</th></tr></thead><tbody>${rows}</tbody></table><p><small>No customer data flows to any model provider: the only qualified routes are development (synthetic) and local test services. Production customer-data inference stays disabled until S03-D qualifies it.</small></p>`;
}
