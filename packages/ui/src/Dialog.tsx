import * as RadixDialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";

export function Dialog({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
          }}
        />
        <RadixDialog.Content
          aria-describedby={undefined}
          style={{
            position: "fixed",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            minWidth: 320,
            maxWidth: "min(480px, 90vw)",
            background: "var(--moneo-surface, #171e28)",
            border: "1px solid var(--moneo-border, #2a3442)",
            borderRadius: 12,
            padding: 20,
            color: "var(--moneo-text, #e8edf3)",
          }}
        >
          <RadixDialog.Title style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
            {title}
          </RadixDialog.Title>
          <div style={{ marginTop: 12 }}>{children}</div>
          <RadixDialog.Close asChild>
            <button
              type="button"
              aria-label="Close dialog"
              style={{
                position: "absolute",
                top: 12,
                right: 12,
                background: "transparent",
                border: "none",
                color: "inherit",
                cursor: "pointer",
                fontSize: 16,
              }}
            >
              ✕
            </button>
          </RadixDialog.Close>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
