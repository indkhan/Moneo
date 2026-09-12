import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Slot } from "@radix-ui/react-slot";
import { clsx } from "clsx";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  asChild?: boolean;
}

const base: Record<string, string> = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "8px",
  fontWeight: "600",
  borderRadius: "10px",
  border: "1px solid transparent",
  cursor: "pointer",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", asChild = false, className, style, ...rest },
  ref,
) {
  const Comp = asChild ? Slot : "button";
  const palette =
    variant === "primary"
      ? { background: "var(--moneo-accent, #4f8cff)", color: "#fff" }
      : variant === "danger"
        ? { background: "#b3261e", color: "#fff" }
        : variant === "secondary"
          ? {
              background: "var(--moneo-surface, #171e28)",
              color: "var(--moneo-text, #e8edf3)",
              border: "1px solid var(--moneo-border, #2a3442)",
            }
          : { background: "transparent", color: "var(--moneo-text, #e8edf3)" };
  const padding = size === "sm" ? "6px 12px" : size === "lg" ? "12px 20px" : "8px 16px";
  return (
    <Comp
      ref={ref}
      className={clsx("moneo-button", className)}
      style={{ ...base, ...palette, padding, ...style }}
      {...rest}
    />
  );
});
