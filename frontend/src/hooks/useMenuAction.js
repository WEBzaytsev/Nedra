import { useEffect, useRef } from "react";

import { IS_DESKTOP } from "../platform";
import { onMenuAction } from "../platform/menu";

const useMenuAction = (id, handler) => {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    if (!IS_DESKTOP) return undefined;
    return onMenuAction(id, () => latest.current());
  }, [id]);
};

export default useMenuAction;
