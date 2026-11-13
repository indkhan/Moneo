// Moneo landing page: finds the newest published release on GitHub, points every download at its
// installer, and suggests the one for this computer. Without a release (or without the API), the
// links fall back to the releases page.
const REPO = "indkhan/Moneo";
const RELEASES = `https://github.com/${REPO}/releases`;

// Installer names from desktop/electron-builder.config.cjs.
const ASSETS = {
  win: name => /^Moneo-Setup-.*-x64\.exe$/i.test(name),
  "mac-arm": name => /-arm64\.dmg$/i.test(name),
  "mac-intel": name => /-x64\.dmg$/i.test(name),
  appimage: name => /\.AppImage$/i.test(name),
  deb: name => /\.deb$/i.test(name),
};
const LABELS = { win: "Download for Windows", "mac-arm": "Download for Mac", "mac-intel": "Download for Mac (Intel)", appimage: "Download for Linux", deb: "Download for Linux" };

async function platform() {
  const ua = navigator.userAgent;
  const hint = navigator.userAgentData?.platform ?? "";
  if (/Android|iPhone|iPad|iPod/i.test(ua)) return null;
  if (/Win/i.test(hint) || /Windows/i.test(ua)) return "win";
  if (/mac/i.test(hint) || /Macintosh/i.test(ua)) {
    // Chromium can tell Intel from Apple silicon; Safari reports Intel on both, and most Macs today are Apple silicon.
    try {
      const { architecture } = await navigator.userAgentData.getHighEntropyValues(["architecture"]);
      if (architecture === "x86") return "mac-intel";
    } catch { /* not available */ }
    return "mac-arm";
  }
  if (/Linux|X11/i.test(hint + ua)) return "appimage";
  return null;
}

const size = bytes => `${(bytes / 1048576).toFixed(0)} MB`;

async function latestRelease() {
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: "application/vnd.github+json" } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  return response.json();
}

async function setUpDownloads() {
  const status = document.querySelector("[data-release-status]");
  const meta = document.querySelector("[data-release-meta]");
  const mine = await platform();
  const cards = [...document.querySelectorAll("[data-asset]")];
  const primary = [...document.querySelectorAll("[data-download-primary]")];
  const label = document.querySelector("[data-download-label]");
  let release = null;
  try { release = await latestRelease(); }
  catch {
    status.innerHTML = `Couldn't reach GitHub just now. All installers are on the <a href="${RELEASES}">releases page</a>.`;
    return;
  }
  if (!release) {
    status.innerHTML = `The first release is on its way. Until then, <a href="#run">run Moneo from source</a> or watch the <a href="${RELEASES}">releases page</a>.`;
    for (const card of cards) { card.href = RELEASES; card.setAttribute("aria-disabled", "true"); }
    return;
  }
  const published = new Date(release.published_at).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  status.textContent = `Moneo ${release.tag_name}, released ${published}. Free, and your data stays on your computer.`;
  meta.textContent = `${release.tag_name} · Windows · macOS · Linux · MIT licensed`;
  for (const card of cards) {
    const asset = release.assets.find(item => ASSETS[card.dataset.asset](item.name));
    if (!asset) { card.href = release.html_url; continue; }
    card.href = asset.browser_download_url;
    card.querySelector("[data-size]").textContent = `${asset.name} · ${size(asset.size)}`;
    if (card.dataset.asset === mine) {
      card.classList.add("recommended");
      for (const link of primary) link.href = asset.browser_download_url;
      if (label) label.textContent = `${LABELS[mine]} · ${release.tag_name}`;
    }
  }
}

async function showStars() {
  const badge = document.querySelector("[data-stars]");
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}`);
    if (!response.ok) return;
    const { stargazers_count: stars } = await response.json();
    if (stars > 0) { badge.textContent = stars >= 1000 ? `${(stars / 1000).toFixed(1)}K` : String(stars); badge.hidden = false; }
  } catch { /* optional */ }
}

function setUpCopy() {
  for (const button of document.querySelectorAll("[data-copy]")) {
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(button.dataset.copy);
        button.textContent = "Copied";
      } catch { button.textContent = "Select and copy"; }
      setTimeout(() => { button.textContent = "Copy"; }, 2000);
    });
  }
}

setUpCopy();
setUpDownloads();
showStars();
