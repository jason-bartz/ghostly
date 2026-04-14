/**
 * One-shot stub script. Copies the `achievements` translation block and the
 * `sidebar.achievements` key from the English locale into every other locale
 * that does not already carry them. Non-destructive: existing translated
 * values are never overwritten, so this is safe to re-run.
 *
 * Run with: bun scripts/stub-achievements-translations.ts
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.join(__dirname, "..", "src", "i18n", "locales");
const REFERENCE_LANG = "en";

type Json = Record<string, unknown>;

function loadJson(filePath: string): Json {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Json;
}

function writeJson(filePath: string, data: Json): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function ensureBlock(target: Json, source: Json, key: string): boolean {
  if (!(key in target)) {
    target[key] = source[key];
    return true;
  }
  return false;
}

function ensureNested(
  target: Json,
  source: Json,
  parent: string,
  leaf: string,
): boolean {
  const targetParent = target[parent];
  const sourceParent = source[parent];
  if (typeof sourceParent !== "object" || sourceParent === null) return false;
  if (typeof targetParent !== "object" || targetParent === null) {
    target[parent] = { ...(sourceParent as Json) };
    return true;
  }
  const p = targetParent as Json;
  const s = sourceParent as Json;
  if (!(leaf in p) && leaf in s) {
    p[leaf] = s[leaf];
    return true;
  }
  return false;
}

const reference = loadJson(
  path.join(LOCALES_DIR, REFERENCE_LANG, "translation.json"),
);

const languages = fs
  .readdirSync(LOCALES_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name !== REFERENCE_LANG)
  .map((e) => e.name)
  .sort();

let changedCount = 0;
for (const lang of languages) {
  const filePath = path.join(LOCALES_DIR, lang, "translation.json");
  if (!fs.existsSync(filePath)) continue;
  const data = loadJson(filePath);

  let changed = false;
  changed = ensureBlock(data, reference, "achievements") || changed;
  changed = ensureNested(data, reference, "sidebar", "achievements") || changed;

  if (changed) {
    writeJson(filePath, data);
    console.log(`stubbed: ${lang}`);
    changedCount += 1;
  }
}

console.log(`Done. ${changedCount} locale file(s) updated.`);
