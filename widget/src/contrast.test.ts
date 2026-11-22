import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contrast } from "./test/contrast";

const css = readFileSync(join(__dirname, "widget.css"), "utf8");

// [description, foreground, background] -- must stay in sync with widget.css (checked below)
const TEXT: [string, string, string][] = [
  ["body text on panel", "#1c2430", "#ffffff"],
  ["header / own bubble / send button text", "#ffffff", "#2563eb"],
  ["system hint on message area", "#566070", "#f5f7fb"],
  ["typing indicator on message area", "#566070", "#f5f7fb"],
  ["notice on message area", "#5b6575", "#f5f7fb"],
  ["error on message area", "#b42318", "#f5f7fb"],
  ["confirm text on confirm bar", "#1c2430", "#fff7ed"],
  ["secondary button text", "#1c2430", "#e3e8f0"],
];
const NON_TEXT: [string, string, string][] = [
  ["input border on footer", "#7a8496", "#ffffff"],
  ["focus ring on panel", "#1d4ed8", "#ffffff"],
  ["launcher on host page", "#2563eb", "#ffffff"],
];

describe("widget.css colour contrast (WCAG 1.4.3 / 1.4.11)", () => {
  it.each(TEXT)("%s >= 4.5:1", (_n, fg, bg) => expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5));
  it.each(NON_TEXT)("%s >= 3:1", (_n, fg, bg) => expect(contrast(fg, bg)).toBeGreaterThanOrEqual(3));
  it("every checked colour is really used in widget.css", () => {
    for (const hex of new Set([...TEXT, ...NON_TEXT].flatMap(([, a, b]) => [a, b]))) {
      if (hex === "#ffffff" || hex === "#fff") continue;
      expect(css.toLowerCase()).toContain(hex);
    }
  });
  it("respects prefers-reduced-motion", () => expect(css).toMatch(/prefers-reduced-motion:\s*reduce/));
});
