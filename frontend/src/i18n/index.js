import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";

import en from "./en.js";
import ru from "./ru.js";

export const LANGUAGE_STORAGE_KEY = "nedra-language";
const LEGACY_LANGUAGE_STORAGE_KEY = "ciphermoth-language";
export const SUPPORTED_LANGUAGES = ["en", "ru"];
export const translationResources = {
  en: { translation: en },
  ru: { translation: ru },
};

const normalizeLanguage = (language) => {
  const base = String(language ?? "")
    .split("-")[0]
    .toLowerCase();
  return SUPPORTED_LANGUAGES.includes(base) ? base : "en";
};

if (typeof localStorage !== "undefined" && !localStorage.getItem(LANGUAGE_STORAGE_KEY)) {
  const legacy = localStorage.getItem(LEGACY_LANGUAGE_STORAGE_KEY);
  if (legacy) {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, legacy);
    localStorage.removeItem(LEGACY_LANGUAGE_STORAGE_KEY);
  }
}

const applyLanguage = (language) => {
  const normalized = normalizeLanguage(language);

  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("lang", normalized);
  }
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, normalized);
    } catch {
      // Language still applies for this tab when storage is unavailable.
    }
  }
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: translationResources,
    supportedLngs: SUPPORTED_LANGUAGES,
    fallbackLng: "en",
    load: "languageOnly",
    nonExplicitSupportedLngs: true,
    detection: {
      order: ["localStorage", "navigator"],
      lookupLocalStorage: LANGUAGE_STORAGE_KEY,
      caches: [],
    },
    interpolation: {
      escapeValue: false,
    },
    initImmediate: false,
  });

applyLanguage(i18n.resolvedLanguage ?? i18n.language);
i18n.on("languageChanged", (language) => applyLanguage(i18n.resolvedLanguage ?? language));

export default i18n;
