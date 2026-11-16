import { requireWorkspace } from "@/lib/auth";
import { desktopChooseFolder, isDesktop } from "@/lib/desktop-bridge";
import { fromRemoteDevice } from "@/lib/remote-device";

export async function POST(request: Request) {
  try { await requireWorkspace(); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  if (!isDesktop()) return Response.json({ error: "Type the folder's path instead." }, { status: 404 });
  if (fromRemoteDevice(request.headers)) return Response.json({ error: "The folder picker opens on the computer running Moneo. Choose the folder there, or type its path." }, { status: 403 });
  try {
    return Response.json({ folder: await desktopChooseFolder() }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "The folder picker could not open. Try again." }, { status: 503 });
  }
}
