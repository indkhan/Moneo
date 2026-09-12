import type { ReactNode } from "react";

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div
      role="status"
      style={{
        border: "1px dashed var(--moneo-border, #2a3442)",
        borderRadius: 12,
        padding: 32,
        textAlign: "center",
        color: "var(--moneo-muted, #9aa7b8)",
      }}
    >
      <p style={{ margin: 0, fontWeight: 700, color: "var(--moneo-text, #e8edf3)" }}>{title}</p>
      {description ? <p style={{ margin: "8px 0 0" }}>{description}</p> : null}
      {action ? <div style={{ marginTop: 16 }}>{action}</div> : null}
    </div>
  );
}
