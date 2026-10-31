import { expect, type Page } from "playwright/test";

export async function openLayoutPage(page: Page, path: string, fontSize: number) {
  await page.goto(path);
  // Le bridge est installé dans un useEffect : le HTML racine est alors hydraté.
  await page.waitForFunction(() => Boolean(window.__SIRIUS_E2E__));
  await page.addStyleTag({ content: `html { font-size: ${fontSize}px; }` });
  await expect(page.locator("html")).toHaveCSS("font-size", `${fontSize}px`);
}
