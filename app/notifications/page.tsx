import { redirect } from "next/navigation";

export default function NotificationsPage() {
  redirect("/ai/activity?filter=attention");
}
