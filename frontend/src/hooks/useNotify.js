import { useCallback } from "react";
import { useLayoutContext, useToaster } from "@gravity-ui/uikit";

let notificationId = 0;
let mobileFeedbackTimer;

const MOBILE_FEEDBACK_NAME = "nedra-mobile-feedback";
const DEFAULT_AUTO_HIDING = 5000;

export const useNotify = () => {
  const { add, update, has, remove } = useToaster();
  const { isMediaActive } = useLayoutContext();
  const phone = !isMediaActive("s");

  const notify = useCallback(
    (content, { name: requestedName, autoHiding = DEFAULT_AUTO_HIDING, ...options } = {}) => {
      const mobileFeedback = phone && autoHiding !== false && requestedName === undefined;
      const name =
        requestedName ??
        (mobileFeedback ? MOBILE_FEEDBACK_NAME : `nedra-notification-${++notificationId}`);
      const notification = {
        ...options,
        name,
        content,
        autoHiding: mobileFeedback ? false : autoHiding,
      };

      if (has(name)) update(name, notification);
      else add(notification);

      if (mobileFeedback) {
        clearTimeout(mobileFeedbackTimer);
        mobileFeedbackTimer = setTimeout(() => remove(name), autoHiding);
      }

      return name;
    },
    [add, update, has, remove, phone]
  );

  return { notify, dismiss: remove };
};
