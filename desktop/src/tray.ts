import { app, Menu, nativeImage, Tray } from "electron";
import { iconPath } from "./app-window";

export type TrayActions = {
  open(): void;
  openInBrowser(): void;
  backUp(): void;
  openBackups(): void;
  restore(): void;
  quit(): void;
};

let tray: Tray | undefined;

// Login start is per user. Windows and Linux pass --hidden; macOS reports wasOpenedAtLogin instead.
export const startsAtLogin = () => app.getLoginItemSettings({ args: ["--hidden"] }).openAtLogin;
export const openedAtLogin = () => process.argv.includes("--hidden") || app.getLoginItemSettings().wasOpenedAtLogin === true;

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
        app.setLoginItemSettings({ openAtLogin: item.checked, args: ["--hidden"] });
        tray?.setContextMenu(build());
      },
    },
    { type: "separator" },
    { label: "Quit Moneo", click: actions.quit },
  ]);
  tray.setContextMenu(build());
  // Windows and Linux: a click on the icon opens the window; the menu is on right-click.
  if (process.platform !== "darwin") tray.on("click", actions.open);
  return tray;
}
