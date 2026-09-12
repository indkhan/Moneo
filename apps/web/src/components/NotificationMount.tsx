"use client";

/** Global notification mount. Epoch 0: empty live region reserving the slot. */
export function NotificationMount() {
  return (
    <div id="notification-mount" aria-live="polite" style={{ display: "grid", gap: 8 }}>
      {/* Notifications render here from Epoch 17. */}
    </div>
  );
}
