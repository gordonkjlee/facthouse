// Main UI flow screenshots for the ui-ux-review skill. Synthetic data only.
import { test, expect } from "@playwright/test";
import { renderInitWebHtml } from "../../dist/cli/web.js";
import { renderInspectHtml } from "../../dist/cli/inspect-html.js";

const OUT = "test-results/ui";
const widths = [390, 1440];
const schemes = ["light", "dark"] as const;

const pages: Record<string, () => string> = {
  "init-web": () =>
    renderInitWebHtml({ token: "t", dataDir: "/tmp/synthetic", processCwd: "/tmp/synthetic" }),
  "inspect-empty": () =>
    renderInspectHtml({
      nodes: [], edges: [], facts: [], links: [], info: [], events: [], sources: [], iToD: [],
      dByEntity: {}, eventCount: 0, eventShown: 0, dCap: 36, selectedId: null, cap: 50,
    }),
};

for (const [name, html] of Object.entries(pages)) {
  for (const width of widths) {
    for (const colorScheme of schemes) {
      test(`${name} ${width} ${colorScheme}`, async ({ browser }) => {
        // Known bug, found by this test on its first run: inspect overflows
        // ~36px sideways at a 390px phone width. Remove when fixed.
        test.fail(name === "inspect-empty" && width === 390, "inspect overflows at 390px");
        const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme });
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(String(e)));
        await page.setContent(html());
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        await page.screenshot({ path: `${OUT}/${name}-${width}-${colorScheme}.png`, fullPage: true });
        expect(errors, "no script errors").toEqual([]);
        expect(overflow, "no horizontal overflow").toBe(false);
      });
    }
  }
}
