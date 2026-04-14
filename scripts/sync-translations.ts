#!/usr/bin/env bun
/**
 * Sync non-English locale files against the English reference.
 *
 * - Missing keys: inserted with the English value as a fallback. Translators
 *   replace these later. i18next already uses English as the runtime
 *   fallbackLng, so fallbacks render correctly.
 * - Extra keys (present in locale but removed from English): dropped.
 * - Key ordering: matches the English reference so diffs stay readable.
 *
 * Run manually when English adds/removes keys:
 *   bun scripts/sync-translations.ts
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.join(__dirname, "..", "src", "i18n", "locales");
const REFERENCE_LANG = "en";

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
type JsonObject = { [k: string]: Json };

function isObject(v: Json): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Merge `target` onto the shape of `reference`. Keeps translated values where
 * the target already has them, copies English as fallback where it doesn't,
 * and drops keys that no longer exist in the reference.
 */
function syncObject(reference: JsonObject, target: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const key of Object.keys(reference)) {
    const refVal = reference[key];
    const curVal = target[key];
    if (isObject(refVal)) {
      const childTarget = isObject(curVal) ? curVal : {};
      out[key] = syncObject(refVal, childTarget);
    } else if (curVal !== undefined && typeof curVal === typeof refVal) {
      // Keep the existing translation (including arrays of same type).
      out[key] = curVal;
    } else {
      // Missing or wrong-shape — fall back to the English value.
      out[key] = refVal;
    }
  }
  return out;
}

function loadLocale(lang: string): JsonObject {
  const p = path.join(LOCALES_DIR, lang, "translation.json");
  return JSON.parse(fs.readFileSync(p, "utf8")) as JsonObject;
}

function writeLocale(lang: string, data: JsonObject): void {
  const p = path.join(LOCALES_DIR, lang, "translation.json");
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function main(): void {
  const reference = loadLocale(REFERENCE_LANG);
  const entries = fs.readdirSync(LOCALES_DIR, { withFileTypes: true });
  const locales = entries
    .filter((e) => e.isDirectory() && e.name !== REFERENCE_LANG)
    .map((e) => e.name)
    .sort();

  let touched = 0;
  for (const lang of locales) {
    const before = loadLocale(lang);
    const after = syncObject(reference, before);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      writeLocale(lang, after);
      touched++;
      console.log(`synced: ${lang}`);
    } else {
      console.log(`ok:     ${lang}`);
    }
  }
  console.log(`\n${touched}/${locales.length} locale(s) updated`);
}

main();
