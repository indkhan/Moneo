import { phoneAccess, type PhoneAccess } from "@/lib/phone-access";
import { isDesktop } from "@/lib/desktop-bridge";
import { PhoneAccessCard } from "./phone-access-card";

// Setup steps only appear once the owner asks for phone access; until then this is one line and a button.
export async function PhoneAccessSection() {
  const status: PhoneAccess = await phoneAccess().catch(() => ({ state: "off" }));
  return <PhoneAccessCard desktop={isDesktop()} initial={status.state === "on" || (status.state === "disconnected" && status.forwarding) ? status : { state: "off" }} />;
}
