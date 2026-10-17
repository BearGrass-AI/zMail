// Renders scripts/dmg/background.html at 640x470 and 1280x940 and joins the two into background.tiff,
// which create-dmg uses so the picture is sharp on Retina screens.
// Usage: CHROME_PATH=<a Chromium binary, optional> node scripts/dmg/render-background.cjs [path to playwright-core]
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require(process.argv[2] || "playwright-core");

(async () => {
  const dir = __dirname;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zmail-dmg-"));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
  for (const [scale, name] of [[1, "background.png"], [2, "background@2x.png"]]) {
    const page = await browser.newPage({ viewport: { width: 640, height: 470 }, deviceScaleFactor: scale });
    await page.goto("file://" + path.join(dir, "background.html"));
    await page.screenshot({ path: path.join(tmp, name) });
    await page.close();
  }
  await browser.close();
  execFileSync("tiffutil", ["-cathidpicheck", path.join(tmp, "background.png"), path.join(tmp, "background@2x.png"), "-out", path.join(dir, "background.tiff")]);
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
