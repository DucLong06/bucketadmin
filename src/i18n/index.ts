// The app speaks English and Vietnamese. Every string on screen comes from ./strings through
// `t(key)`; the language is one module-level value, so helpers outside React can use it too.
import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { en, vi } from "./strings";

export type Lang = "en" | "vi";
export type Key = keyof typeof en;
const TABLES: Record<Lang, Record<Key, string>> = { en, vi };

/** The system's choice: Vietnamese when the locale says so, else English. */
export const systemLang = (locale: string = globalThis.navigator?.language ?? ""): Lang => (locale.toLowerCase().startsWith("vi") ? "vi" : "en");

let lang: Lang = systemLang();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export const getLang = () => lang;

/** Switches the language of everything on screen, at once (nothing is saved). */
export function applyLang(next: Lang) {
  lang = next;
  if (typeof document !== "undefined") document.documentElement.lang = next;
  listeners.forEach((listener) => listener());
}

/** The user's choice: shown at once and written to settings.json. */
export function setLang(next: Lang) {
  applyLang(next);
  return invoke("set_lang", { lang: next }).catch(() => {});
}

/** At startup: a saved choice wins over the system's language ("" = none saved). */
export const loadLang = () =>
  invoke<string>("get_lang").then(
    (saved) => applyLang(saved === "en" || saved === "vi" ? saved : lang),
    () => applyLang(lang),
  );

/** The current language; the component re-renders when it changes. */
export const useLang = (): Lang => useSyncExternalStore(subscribe, getLang, getLang);

/**
 * The string for `key` in the current language. `{name}` becomes `vars.name`;
 * `{n:row|rows}` picks the first form when `vars.n` is 1, else the second.
 */
export function t(key: Key, vars: Record<string, string | number> = {}): string {
  return TABLES[lang][key].replace(/\{(\w+)(?::([^|}]*)\|([^}]*))?\}/g, (whole, name: string, one?: string, other?: string) => {
    if (!(name in vars)) return whole;
    return other === undefined ? String(vars[name]) : vars[name] === 1 ? (one ?? "") : other;
  });
}
