import { forwardRef, type InputHTMLAttributes } from "react";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, error, id, style, ...rest },
  ref,
) {
  const inputId = id ?? (label ? `input-${label.replace(/\s+/g, "-").toLowerCase()}` : "input");
  return (
    <label style={{ display: "grid", gap: 6, fontSize: 13 }}>
      {label ? <span style={{ fontWeight: 600 }}>{label}</span> : null}
      <input
        ref={ref}
        id={inputId}
        {...rest}
        style={{
          padding: "8px 12px",
          borderRadius: 8,
          border: "1px solid var(--moneo-border, #2a3442)",
          background: "var(--moneo-bg, #0f141b)",
          color: "var(--moneo-text, #e8edf3)",
          ...style,
        }}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${inputId}-error` : undefined}
      />
      {error ? (
        <span id={`${inputId}-error`} role="alert" style={{ color: "#ff8a80", fontSize: 12 }}>
          {error}
        </span>
      ) : null}
    </label>
  );
});
