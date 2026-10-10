import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** Minimal .env reader for host-side scripts (strips inline comments, no variable expansion). */
export async function loadEnv(): Promise<Record<string, string>> {
  const file = fileURLToPath(new URL("../.env", import.meta.url));
  const out: Record<string, string> = {};
  for (const line of (await readFile(file, "utf8")).split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/\s+#.*$/, "").trim().replace(/^"(.*)"$/, "$1");
  }
  return { ...out, ...(process.env as Record<string, string>) };
}
