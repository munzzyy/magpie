// Translation, gettext style: the English source string is the key. English
// stays the always-complete baseline (an untranslated string degrades to
// English, never to a blank), tests keep asserting real copy, and extraction
// is mechanical. Catalogs are plain modules shipped like everything else.

import { es } from "./strings-es.js";

const CATALOGS = { es };

const DIR = { ar: "rtl", fa: "rtl", he: "rtl", ur: "rtl" };

export const LOCALE_CHOICES = [
  { id: "auto", label: "Auto" },
  { id: "en", label: "English" },
  { id: "es", label: "Español" },
];

let active = null;
let activeCode = "en";

export const norm = (s) => String(s).replace(/\s+/g, " ").trim();

export function resolveLocale(pref) {
  if (pref && pref !== "auto") return pref === "en" || CATALOGS[pref] ? pref : "en";
  for (const tag of navigator.languages || [navigator.language || "en"]) {
    const code = String(tag).slice(0, 2).toLowerCase();
    if (code === "en") return "en";
    if (CATALOGS[code]) return code;
  }
  return "en";
}

export function setLocale(code) {
  activeCode = code === "en" || CATALOGS[code] ? code : "en";
  active = activeCode === "en" ? null : CATALOGS[activeCode];
  if (globalThis.document) {
    document.documentElement.lang = activeCode;
    document.documentElement.dir = DIR[activeCode] || "ltr";
  }
}

export const currentLocale = () => activeCode;

export function t(text, vars) {
  let out = text;
  if (active) {
    if (active[text] !== undefined) {
      out = active[text];
    } else {
      const hit = active[norm(text)];
      if (hit !== undefined) out = text.match(/^\s*/)[0] + hit + text.match(/\s*$/)[0];
    }
  }
  if (vars) {
    // One pass over the template, never over substituted output, so a value
    // that happens to contain {name} cannot pull in another variable.
    out = out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  }
  return out;
}

export function translateDom(root) {
  const scope = root || globalThis.document;
  if (!scope?.querySelectorAll) return;
  for (const node of scope.querySelectorAll("[data-i18n]")) {
    if (!node.dataset.i18nSrc) node.dataset.i18nSrc = norm(node.textContent);
    node.textContent = t(node.dataset.i18nSrc);
  }
  for (const node of scope.querySelectorAll("[data-i18n-attr]")) {
    for (const attr of node.dataset.i18nAttr.split(",")) {
      const stash = `data-i18n-src-${attr}`;
      if (!node.hasAttribute(stash)) node.setAttribute(stash, norm(node.getAttribute(attr) || ""));
      node.setAttribute(attr, t(node.getAttribute(stash)));
    }
  }
}
