export const sample = {
  html: `<section><h1>Monthly spending</h1><div data-slot="chart"></div><label>Scenario <input data-action="scenario" type="range" min="0" max="100" value="25"></label><output data-slot="value"></output></section>`,
  css: `section{font:16px system-ui;padding:1rem;color:#172033} h1{font-size:1.2rem} input{width:100%} .bars{display:flex;align-items:end;gap:.5rem;height:9rem}.bar{background:#5768ee;min-width:3rem}`,
  js: `
    const rows = artifact.finance.spendingByCategory();
    function draw(value) {
      artifact.ui.render({ type: "chart", rows });
      artifact.ui.patch({ action: "scenario", value: String(value) });
      artifact.ui.patch({ slot: "value", text: "Illustrative buffer: €" + value });
    }
    globalThis.onEvent = event => { if (event.action === "scenario") { artifact.state.set({ slider: Number(event.value) }); draw(event.value); } };
    draw(artifact.state.get().slider);
  `,
};
