import { redirect } from "next/navigation";

// Notifications and Activity are one feed; the bell opens what needs attention.
export default function NotificationsPage() {
  redirect("/ai/activity?filter=attention");
}
