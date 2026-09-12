import { ImportWizardHost } from "@/components/ImportWizardHost";

/**
 * Money → Import: the statement import wizard (upload, preview, mapping,
 * account, processing, summary). Processing is a durable job, so closing
 * the browser mid-run is safe — reopening resumes from stored progress.
 */
export default function ImportPage() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: 24 }}>
      <ImportWizardHost />
    </main>
  );
}
