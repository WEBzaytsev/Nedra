import { createContext, useContext, useLayoutEffect, useMemo, useState } from "react";
import { LayoutProvider, Provider as GravityProvider, useLayoutContext } from "@gravity-ui/uikit";
import { useTranslation } from "react-i18next";

const STORAGE_KEY = "nedra-theme";

const ModeContext = createContext(null);

const initialMode = () => {
  const saved = window.localStorage.getItem(STORAGE_KEY);
  return saved === "light" || saved === "dark" ? saved : "dark";
};

const ResponsiveGravity = ({ children, ...props }) => {
  const { isMediaActive } = useLayoutContext();
  return (
    <GravityProvider {...props} mobile={!isMediaActive("m")} rootClassName="nedra-theme">
      {children}
    </GravityProvider>
  );
};

export const ColorModeProvider = ({ children }) => {
  const { i18n } = useTranslation();
  const [mode, setMode] = useState(initialMode);

  const language = (i18n.resolvedLanguage ?? i18n.language)?.startsWith("ru") ? "ru" : "en";

  useLayoutEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, mode);
    document.documentElement.dataset.theme = mode;
    document.documentElement.style.colorScheme = mode;
  }, [mode]);

  const value = useMemo(
    () => ({
      mode,
      setMode,
      toggle: () => {
        setMode((current) => (current === "dark" ? "light" : "dark"));
      },
    }),
    [mode]
  );

  return (
    <ModeContext.Provider value={value}>
      <LayoutProvider>
        <ResponsiveGravity
          theme={mode}
          lang={language}

          defaultProps={{
            TooltipDelayGroup: { skipDelay: 300 },
            // Layout gaps own the rhythm, including semantic headings and paragraphs.
            Text: { style: { margin: 0 } },
            Button: { size: "xl" },
          }}
        >
          {children}
        </ResponsiveGravity>
      </LayoutProvider>
    </ModeContext.Provider>
  );
};

export const useColorMode = () => {
  const context = useContext(ModeContext);
  if (!context) throw new Error("useColorMode must be used inside ColorModeProvider");
  return context;
};
