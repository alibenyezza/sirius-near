import { expect, test, type Page } from "playwright/test";
import { openLayoutPage } from "./helpers/layout";

async function expectReadableDiagrams(page: Page) {
  const issues = await page.locator("main").evaluate(async (main) => {
    await document.fonts.ready;
    const issues: string[] = [];
    const markerIds = new Set<string>();
    const root = document.documentElement;
    if (root.scrollWidth > root.clientWidth + 1) issues.push("Débordement horizontal de la page");

    for (const figure of main.querySelectorAll("figure")) {
      const bounds = figure.getBoundingClientRect();
      if (bounds.left < 0 || bounds.right > root.clientWidth + 1) issues.push("Schéma hors de la page");
    }

    for (const svg of main.querySelectorAll<SVGSVGElement>("svg[role=img]")) {
      const view = svg.viewBox.baseVal;
      const label = svg.querySelector("title")?.textContent;
      if (!label || !svg.querySelector("desc")?.textContent) issues.push("Schéma sans alternative textuelle");
      if (svg.getAttribute("aria-hidden") === "true") issues.push(`${label} masqué aux lecteurs d’écran`);

      const texts = [...svg.querySelectorAll("text")];
      for (const text of texts) {
        const box = text.getBBox();
        if (box.x < 0 || box.y < 0 || box.x + box.width > view.width || box.y + box.height > view.height) {
          issues.push(`${label} : texte hors du schéma (${text.textContent})`);
        }
      }
      for (let i = 0; i < texts.length; i++) {
        const left = texts[i].getBBox();
        for (const other of texts.slice(i + 1)) {
          const right = other.getBBox();
          if (Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x) > 1 &&
              Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y) > 1) {
            issues.push(`${label} : textes superposés (${texts[i].textContent} / ${other.textContent})`);
          }
        }
      }

      const nodes = [...svg.querySelectorAll("[data-diagram-node]")];
      const boxes = nodes.map((node) => node.querySelector("rect")!.getBBox());
      for (const [index, node] of nodes.entries()) {
        const bounds = boxes[index];
        for (const text of node.querySelectorAll("text")) {
          const box = text.getBBox();
          if (box.x < bounds.x + 6 || box.x + box.width > bounds.x + bounds.width - 6 ||
              box.y < bounds.y + 3 || box.y + box.height > bounds.y + bounds.height - 3) {
            issues.push(`${label} : libellé hors de son bloc (${text.textContent})`);
          }
        }
      }

      for (const group of svg.querySelectorAll("g[marker-end]")) {
        const markerId = group.getAttribute("marker-end")?.match(/^url\(#(.+)\)$/)?.[1];
        if (!markerId || ![...svg.querySelectorAll("marker")].some((marker) => marker.id === markerId)) {
          issues.push(`${label} : pointe de flèche extérieure au SVG`);
        }
        for (const path of group.querySelectorAll("path")) {
          const length = path.getTotalLength();
          for (let distance = 0; distance <= length; distance += 2) {
            const point = path.getPointAtLength(distance);
            if (boxes.some((box) => point.x > box.x + 1 && point.x < box.x + box.width - 1 &&
                point.y > box.y + 1 && point.y < box.y + box.height - 1)) {
              issues.push(`${label} : une flèche traverse un bloc`);
              break;
            }
          }
        }
      }
      for (const marker of svg.querySelectorAll("marker")) {
        if (markerIds.has(marker.id)) issues.push("Identifiant de flèche dupliqué");
        markerIds.add(marker.id);
      }
    }
    return issues;
  });
  expect(issues).toEqual([]);
}

for (const screen of [
  { width: 320, fontSize: 16 },
  { width: 390, fontSize: 20 },
  { width: 1024, fontSize: 16 },
  { width: 1440, fontSize: 16 },
]) {
  test.describe(`documentation : ${screen.width}px / police ${screen.fontSize}px`, () => {
    test.use({ viewport: { width: screen.width, height: 900 } });

    test("profils, limites du stub et schémas lisibles", async ({ page }) => {
      const hydrationWarnings: string[] = [];
      page.on("console", (message) => {
        if (/hydrat/i.test(message.text())) hydrationWarnings.push(message.text());
      });
      await page.route("**/api/**", (route) => route.abort());
      await openLayoutPage(page, "/docs", screen.fontSize);
      await expect(page.getByRole("heading", { name: "Demo and confidentiality" })).toBeVisible();
      await expect(page.locator("main [role=note]")).toContainText("there is no hardware enclave");
      await expect(page.getByRole("heading", { name: "Dataset training profile" })).toBeVisible();
      await expect(page.locator("#profils")).toContainText("linear_regression · v1.0.0");
      await expect(page.locator("#profils")).toContainText("logistic_regression · v1.0.0");
      await expect(page.locator("main figure svg")).toHaveCount(3);
      await expectReadableDiagrams(page);

      if (screen.width === 320) {
        const diagram = page.getByRole("region", { name: "Dataset and settlement flow" });
        await diagram.focus();
        await page.keyboard.press("ArrowRight");
        await expect.poll(() => diagram.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
      }
      expect(hydrationWarnings, "Aucun avertissement d’hydratation").toEqual([]);
    });
  });
}

test("la page MCP donne l’adresse du serveur et la connexion par client", async ({ page }) => {
  await page.route("**/api/**", (route) => route.abort());
  await openLayoutPage(page, "/docs/mcp", 16);
  await expect(page.getByRole("heading", { name: "Use Sirius from your AI agent" })).toBeVisible();
  await expect(page.locator("main")).toContainText("https://sirius-data.tech/api/mcp");
  await expect(page.locator("#outils")).toContainText("verify_certificate");
  await page.getByRole("tab", { name: "Cursor" }).click();
  await expect(page.getByRole("tabpanel")).toContainText("mcpServers");
  await page.getByRole("tab", { name: "Claude Code" }).click();
  await expect(page.getByRole("tabpanel")).toContainText("claude mcp add --transport http sirius");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
});
