// Setup/status window. State comes from the main process (desktop/src/setup-window.ts).
const api = window.moneoSetup;
const $ = id => document.getElementById(id);

const INTRO = {
  firstRun: "Moneo is creating a private database on this computer. Your finances stay here; nothing is uploaded. This takes a minute the first time.",
  starting: "Moneo is starting its private database on this computer.",
  stopping: "Moneo is closing its database safely. This usually takes a few seconds.",
  restoring: "Moneo is restoring your data from a backup.",
};
const TITLE = { starting: "Starting Moneo", failed: "Moneo could not start", stopping: "Shutting down…", restoring: "Restoring from backup…" };

function render(state) {
  $("title").textContent = TITLE[state.phase] ?? TITLE.starting;
  $("intro").textContent = state.phase === "starting" && state.firstRun ? INTRO.firstRun : INTRO[state.phase] ?? "";
  $("intro").hidden = state.phase === "failed";
  const list = $("steps");
  list.replaceChildren(...state.steps.map(step => {
    const item = document.createElement("li");
    item.className = step.state;
    const label = document.createElement("span");
    label.textContent = step.label;
    item.append(label);
    if (step.detail) {
      const detail = document.createElement("span");
      detail.className = "detail";
      detail.textContent = step.detail;
      item.append(detail);
    }
    return item;
  }));
  $("failure").hidden = state.phase !== "failed";
  if (state.error) {
    $("error-summary").textContent = state.error.summary;
    $("error-detail").textContent = state.error.detail ?? "";
  }
}

for (const [id, action] of [["retry", api.retry], ["logs", api.openLogs], ["restore", api.restoreBackup], ["quit", api.quit]]) {
  const button = $(id);
  button.addEventListener("click", async () => {
    button.disabled = true;
    try { await action(); } finally { button.disabled = false; }
  });
}

api.onState(render);
api.state().then(render);
