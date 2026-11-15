import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

it("keeps the previous installers available while a newer release has no assets", async () => {
  const names = ["Moneo-Setup-0.1.4-x64.exe", "Moneo-0.1.4-arm64.dmg", "Moneo-0.1.4-x64.dmg", "Moneo-0.1.4.AppImage", "moneo-desktop_0.1.4_amd64.deb"];
  const releases = [
    { tag_name: "v0.1.5", draft: false, prerelease: false, assets: [] },
    { tag_name: "v0.1.4", draft: false, prerelease: false, assets: names.map(name => ({ name })) },
  ];
  const context = {
    fetch: vi.fn().mockResolvedValue({ ok: true, json: async () => releases }),
    navigator: { userAgent: "Windows" },
    document: { querySelector: () => ({}), querySelectorAll: () => [] },
  };
  runInNewContext(readFileSync(new URL("./site.js", import.meta.url), "utf8"), context);
  expect(await runInNewContext("latestRelease()", context)).toMatchObject({ tag_name: "v0.1.4" });
});
