// Preload for the local setup/status window only (the app window has none). It exposes progress
// updates and four buttons, nothing else; the main process checks every call's sender.
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("moneoSetup", {
  state: () => ipcRenderer.invoke("setup:state"),
  onState: (callback: (state: unknown) => void) => { ipcRenderer.on("setup:state", (_event, state) => callback(state)); },
  retry: () => ipcRenderer.invoke("setup:retry"),
  openLogs: () => ipcRenderer.invoke("setup:open-logs"),
  restoreBackup: () => ipcRenderer.invoke("setup:restore"),
  quit: () => ipcRenderer.invoke("setup:quit"),
});
