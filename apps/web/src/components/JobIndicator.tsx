"use client";

/**
 * Global background-job indicator mount. Epoch 0: idle placeholder that
 * reserves the layout slot so later epochs can stream durable-job state
 * without moving the page.
 */
export function JobIndicator() {
  return (
    <div
      id="job-indicator-mount"
      role="status"
      aria-label="Background jobs: idle"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontSize: 13,
        color: "var(--moneo-muted, #9aa7b8)",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: "#3fb950",
          display: "inline-block",
        }}
      />
      Jobs idle
    </div>
  );
}
