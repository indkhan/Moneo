import { app, Menu, nativeImage, Tray } from "electron";
import { iconPath } from "./app-window";
import { setStartAtLogin, startsAtLogin } from "./login-item";

export type TrayActions = {
  open(): void;
  openInBrowser(): void;
  backUp(): void;
  openBackups(): void;
  restore(): void;
  quit(): void;
};

let tray: Tray | undefined;

export function createTray(actions: TrayActions) {
  const size = process.platform === "darwin" ? 18 : 16;
  tray = new Tray(nativeImage.createFromPath(iconPath()).resize({ width: size, height: size }));
  tray.setToolTip(`Moneo ${app.getVersion()}`);
  const build = () => Menu.buildFromTemplate([
    { label: "Open Moneo", click: actions.open },
    { label: "Open in browser", click: actions.openInBrowser },
    { type: "separator" },
    { label: "Back up now", click: actions.backUp },
    { label: "Open backups folder", click: actions.openBackups },
    { label: "Restore from backup…", click: actions.restore },
    { type: "separator" },
    {
      label: "Start Moneo when I sign in", type: "checkbox", checked: startsAtLogin(),
      click: item => {
        setStartAtLogin(item.checked);
        tray?.setContextMenu(build());
      },
    },
    { type: "separator" },
    { label: "Quit Moneo", click: actions.quit },
  ]);
  tray.setContextMenu(build());
  if (process.platform !== "darwin") tray.on("click", actions.open);
  return tray;
}
