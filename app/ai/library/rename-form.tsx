export function RenameArtifactForm({ artifactId, activeVersionId, name, action }: {
  artifactId: string;
  activeVersionId: string;
  name: string;
  action: (form: FormData) => Promise<void>;
}) {
  return <form key={activeVersionId} action={action} className="mt-4 flex flex-wrap gap-2 text-sm">
    <input type="hidden" name="artifactId" value={artifactId} />
    <input type="hidden" name="expectedActiveVersionId" value={activeVersionId} />
    <input name="name" defaultValue={name} required maxLength={120} aria-label="Artifact name" className="rounded-lg border border-border bg-card px-3 py-2" />
    <button className="rounded-lg border border-border bg-card px-3 text-sm font-medium hover:bg-muted">Save new version</button>
    <p className="w-full text-muted-foreground">When the active version changes, this field resets to the saved name. Re-enter unsaved names before saving.</p>
  </form>;
}

