import { useCallback } from "react";
import { useLayoutContext, useToaster } from "@gravity-ui/uikit";

let notificationId = 0;
let mobileFeedbackTimer;

const themes = {
  default: "normal",
  error: "danger",
  info: "info",
  success: "success",
  warning: "warning",
};

export const useSnackbar = () => {
  const { add, update, has, remove } = useToaster();
  const { isMediaActive } = useLayoutContext();
  const phone = !isMediaActive("s");

  const enqueueSnackbar = useCallback(
    (message, options = {}) => {
      const mobileFeedback = phone && !options.persist && options.key === undefined;
      const name = String(
        options.key ??
          (mobileFeedback ? "cm-mobile-feedback" : `cm-notification-${++notificationId}`)
      );
      const notification = {
        name,
        content: message,
        theme: themes[options.variant] ?? "normal",
        autoHiding: options.persist || mobileFeedback ? false : (options.autoHideDuration ?? 5000),
        isClosable: true,
      };
      // Updating the visible mobile feedback avoids stacking even during the
      // native toaster's exit animation. Explicit/persistent messages stay separate.
      if (mobileFeedback && has(name)) update(name, notification);
      else add(notification);
      if (mobileFeedback) {
        // UIKit update preserves the mounted toast. Restart its feedback window
        // from the latest result without mounting another animated toast.
        clearTimeout(mobileFeedbackTimer);
        mobileFeedbackTimer = setTimeout(() => remove(name), options.autoHideDuration ?? 5000);
      }
      return name;
    },
    [add, update, has, remove, phone]
  );

  const closeSnackbar = useCallback((name) => remove(String(name)), [remove]);

  return { enqueueSnackbar, closeSnackbar };
};
