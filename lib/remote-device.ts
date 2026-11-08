// Phone access goes through Tailscale, which keeps the *.ts.net address the device asked for.
export function fromRemoteDevice(headers: Headers) {
  return (headers.get("x-forwarded-host") ?? headers.get("host") ?? "").split(":")[0].toLowerCase().endsWith(".ts.net");
}

/** These logins return to this computer's own address, so they cannot finish on another device. */
export const connectOnComputer = (service: string) => `${service} can only return to the computer running Moneo. Open Moneo there to connect; everything else keeps working here.`;
