// Phone access goes through Tailscale, which keeps the *.ts.net address the device asked for.
export function fromRemoteDevice(headers: Headers) {
  return (headers.get("x-forwarded-host") ?? headers.get("host") ?? "").split(":")[0].toLowerCase().endsWith(".ts.net");
}

/** The address this device reached Moneo on; behind Tailscale `request.url` names this computer instead. */
export function requestOrigin(request: Request) {
  return fromRemoteDevice(request.headers) ? `https://${request.headers.get("x-forwarded-host") ?? request.headers.get("host")}` : new URL(request.url).origin;
}

/** These logins return to this computer's own address, so they cannot finish on another device. */
export const connectOnComputer = (service: string) => `${service} can only return to the computer running Moneo. Open ${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"} in a browser on that computer to connect; everything else keeps working here.`;
