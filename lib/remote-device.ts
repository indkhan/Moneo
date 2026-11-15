import { appUrl } from "@/lib/env";

export function fromRemoteDevice(headers: Headers) {
  return (headers.get("x-forwarded-host") ?? headers.get("host") ?? "").split(":")[0].toLowerCase().endsWith(".ts.net");
}

export function requestOrigin(request: Request) {
  return fromRemoteDevice(request.headers) ? `https://${request.headers.get("x-forwarded-host") ?? request.headers.get("host")}` : new URL(request.url).origin;
}

export const connectOnComputer = (service: string) => `${service} can only return to the computer running Moneo. Open ${appUrl()} in a browser on that computer to connect; everything else keeps working here.`;
