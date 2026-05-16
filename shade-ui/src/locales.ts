import de from "../locales/de.json";
import en from "../locales/en.json";
import kr from "../locales/kr.json";

export const AVAILABLE_LANGS = ["en", "de", "kr"] as const;
export const DEFAULT_LANGUAGE = "en";

export type LocaleKey = keyof typeof en;

const bundles: Record<string, Record<string, string>> = { en, de, kr };

function interpolate(template: string, args: Array<number | string | undefined>): string {
  return template.replace(/\{\{(\d+)\}\}/g, (match, idx) => {
    const value = args[Number(idx)];
    return value === undefined ? match : String(value);
  });
}

function lookup(lang: string, key: string): string | undefined {
  return bundles[lang]?.[key] ?? bundles[DEFAULT_LANGUAGE]?.[key];
}

export function t(
  id: LocaleKey | LocaleKey[],
  args: Array<number | string | undefined> = [],
  lang?: string,
): string | undefined {
  const language = lang ?? DEFAULT_LANGUAGE;
  const keys = Array.isArray(id) ? id : [id];
  for (const key of keys) {
    const hit = lookup(language, key);
    if (hit !== undefined) return interpolate(hit, args);
  }
  return undefined;
}
