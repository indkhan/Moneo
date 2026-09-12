import * as RadixMenu from "@radix-ui/react-dropdown-menu";
import type { ReactNode } from "react";

export function Menu({
  trigger,
  children,
  label,
}: {
  trigger: ReactNode;
  children: ReactNode;
  label?: string;
}) {
  return (
    <RadixMenu.Root>
      <RadixMenu.Trigger asChild>{trigger}</RadixMenu.Trigger>
      <RadixMenu.Portal>
        <RadixMenu.Content
          aria-label={label}
          sideOffset={6}
          style={{
            minWidth: 180,
            background: "var(--moneo-surface, #171e28)",
            border: "1px solid var(--moneo-border, #2a3442)",
            borderRadius: 10,
            padding: 6,
            color: "var(--moneo-text, #e8edf3)",
            zIndex: 50,
          }}
        >
          {children}
        </RadixMenu.Content>
      </RadixMenu.Portal>
    </RadixMenu.Root>
  );
}

export function MenuItem({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) {
  return (
    <RadixMenu.Item
      onSelect={onSelect}
      style={{
        padding: "8px 10px",
        borderRadius: 6,
        cursor: "pointer",
        fontSize: 14,
      }}
    >
      {children}
    </RadixMenu.Item>
  );
}
