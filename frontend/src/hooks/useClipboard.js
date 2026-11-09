import { useCallback, useEffect, useRef } from "react";
import { useNotify } from "./useNotify";
import { useStoreState } from "easy-peasy";
import { useTranslation } from "react-i18next";

import { IS_DESKTOP, copySecret } from "../platform";

const wipe = () => navigator.clipboard.writeText("").catch(() => {});

const formatDuration = (ms, t) => {
  const seconds = Math.round(ms / 1000);
  if (seconds >= 60 && seconds % 60 === 0)
    return t("common.duration.minutes", { count: seconds / 60 });
  return t("common.duration.seconds", { count: seconds });
};

const useClipboard = () => {
  const { t } = useTranslation();
  const { notify } = useNotify();
  const clearMs = useStoreState((s) => s.ciphermothModels.settings.settings.clipboard_clear_ms);
  const clearAtRef = useRef(null);

  useEffect(() => {
    const onFocus = () => {
      const clearAt = clearAtRef.current;
      if (clearAt && Date.now() >= clearAt - 5_000) {
        clearAtRef.current = null;
        wipe();
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  return useCallback(
    (value) => {
      (IS_DESKTOP ? copySecret(value, clearMs) : navigator.clipboard.writeText(value)).then(() => {
        notify(t("clipboard.copied", { duration: formatDuration(clearMs, t) }), {
          theme: "success",
        });
        if (IS_DESKTOP) return;
        const clearAt = Date.now() + clearMs;
        clearAtRef.current = clearAt;
        setTimeout(() => {
          if (clearAtRef.current === clearAt && document.hasFocus()) {
            clearAtRef.current = null;
            wipe();
          }
        }, clearMs);
      });
    },
    [notify, clearMs, t]
  );
};

export default useClipboard;
