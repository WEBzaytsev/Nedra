import { useCallback } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";

// Navigation state contains only a return URL, never form values or secrets.
export default function useTaskRoute() {
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const openTask = useCallback(
    (values) => {
      const next = new URLSearchParams(location.search);
      for (const key of ["tool", "entry", "view", "user"]) next.delete(key);
      for (const [key, value] of Object.entries(values)) next.set(key, String(value));
      navigate(`${location.pathname}?${next}`, {
        state: { taskReturn: location.pathname + location.search, taskScroll: window.scrollY },
      });
    },
    [location.pathname, location.search, navigate]
  );
  const closeTask = useCallback(() => {
    if (location.state?.taskReturn) {
      navigate(-1);
      return;
    }
    const next = new URLSearchParams(location.search);
    for (const key of ["tool", "entry", "view", "user"]) next.delete(key);
    navigate({ pathname: location.pathname, search: next.toString() }, { replace: true });
  }, [location, navigate]);
  return { params, openTask, closeTask };
}
