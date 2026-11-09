import { useCallback, useEffect, useRef, useState } from "react";
import { useStoreState } from "easy-peasy";
import { useNotify } from "./useNotify";
import { useTranslation } from "react-i18next";

import { endSession, readSession, touchSession } from "../api/session";
import {
  deadlineFromStatus,
  earlierDeadline,
  hiddenTooLong,
  shouldReport,
  warningLead,
} from "../lib/sessionClock";
import { isAuth } from "../utils";

const CountdownMessage = ({ seconds }) => {
  const { t } = useTranslation();
  const [remaining, setRemaining] = useState(seconds);
  useEffect(() => {
    if (remaining <= 0) return;
    const timer = setTimeout(() => setRemaining((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [remaining]);
  return t("autoLogout.countdown", { seconds: Math.max(0, remaining) });
};

const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown", "touchstart", "scroll"];
const CLOCK_CHECK_MS = 5_000;
const SYNC_EVERY_CHECKS = 3;

const useAutoLogout = () => {
  const { notify, dismiss } = useNotify();

  const settings = useStoreState((s) => s.ciphermothModels.settings.settings);
  const warnBeforeMs = settings.warn_before_ms;
  const hiddenMs = settings.hidden_ms;
  const debounceMs = settings.debounce_ms;

  const inactivityRef = useRef(settings.inactivity_ms);
  const deadlineRef = useRef(Date.now() + settings.inactivity_ms);
  const inactivityTimerRef = useRef(null);
  const warnTimerRef = useRef(null);
  const hiddenTimerRef = useRef(null);
  const hiddenAtRef = useRef(null);
  const warnKeyRef = useRef(null);
  const lastActivityRef = useRef(0);
  const lastReportedRef = useRef(0);
  const reportingRef = useRef(false);
  const synchronizedRef = useRef(false);

  const clearWarning = useCallback(() => {
    if (warnKeyRef.current) dismiss(warnKeyRef.current);
    warnKeyRef.current = null;
  }, [dismiss]);

  const logout = useCallback(() => {
    clearTimeout(inactivityTimerRef.current);
    clearTimeout(warnTimerRef.current);
    clearTimeout(hiddenTimerRef.current);
    clearWarning();
    endSession("autoLogout.loggedOut");
  }, [clearWarning]);

  const schedule = useCallback(() => {
    clearTimeout(inactivityTimerRef.current);
    clearTimeout(warnTimerRef.current);
    const remaining = deadlineRef.current - Date.now();
    if (remaining <= 0) {
      logout();
      return;
    }
    const lead = warningLead(warnBeforeMs, inactivityRef.current);
    warnTimerRef.current = setTimeout(
      () => {
        if (warnKeyRef.current) return;
        const seconds = Math.round((deadlineRef.current - Date.now()) / 1000);
        warnKeyRef.current = notify(<CountdownMessage seconds={seconds} />, {
          theme: "warning",
          autoHiding: false,
        });
      },
      Math.max(0, remaining - lead)
    );
    inactivityTimerRef.current = setTimeout(logout, remaining);
  }, [warnBeforeMs, notify, logout]);

  const adopt = useCallback(
    (status, deadline) => {
      synchronizedRef.current = true;
      inactivityRef.current = status.idle_timeout_ms;
      deadlineRef.current = deadline;
      schedule();
    },
    [schedule]
  );

  const report = useCallback(async () => {
    reportingRef.current = true;
    const sentAt = Date.now();
    lastReportedRef.current = sentAt;
    const status = await touchSession();
    reportingRef.current = false;
    if (!status || !isAuth()) return;
    clearWarning();
    adopt(status, deadlineFromStatus(sentAt, status));
  }, [adopt, clearWarning]);

  const sync = useCallback(async () => {
    const sentAt = Date.now();
    const status = await readSession();
    if (!status || !isAuth()) return;
    adopt(
      status,
      synchronizedRef.current
        ? earlierDeadline(deadlineRef.current, sentAt, status)
        : deadlineFromStatus(sentAt, status)
    );
  }, [adopt]);

  const onActivity = useCallback(() => {
    if (!isAuth() || document.hidden) return;
    const now = Date.now();
    if (now >= deadlineRef.current) {
      logout();
      return;
    }
    const warning = warnKeyRef.current !== null;
    if (!warning && now - lastActivityRef.current < debounceMs) return;
    lastActivityRef.current = now;
    if (reportingRef.current) return;
    if (
      shouldReport({
        now,
        lastReportedMs: lastReportedRef.current,
        inactivityMs: inactivityRef.current,
        warning,
      })
    ) {
      report();
    }
  }, [debounceMs, logout, report]);

  useEffect(() => {
    if (!isAuth()) return;
    sync();
    ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
    let checks = 0;
    const clock = setInterval(() => {
      if (Date.now() >= deadlineRef.current) {
        logout();
        return;
      }
      checks += 1;
      if (!document.hidden && checks % SYNC_EVERY_CHECKS === 0) sync();
    }, CLOCK_CHECK_MS);
    return () => {
      ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, onActivity));
      clearInterval(clock);
      clearTimeout(inactivityTimerRef.current);
      clearTimeout(warnTimerRef.current);
      clearWarning();
    };
  }, [sync, onActivity, logout, clearWarning]);

  useEffect(() => {
    if (!isAuth()) return;

    const handleVisibilityChange = () => {
      const now = Date.now();
      if (document.hidden) {
        hiddenAtRef.current = now;
        hiddenTimerRef.current = setTimeout(logout, hiddenMs);
        return;
      }
      clearTimeout(hiddenTimerRef.current);
      const tooLong = hiddenTooLong({ hiddenAt: hiddenAtRef.current, now, hiddenMs });
      hiddenAtRef.current = null;
      if (!isAuth() || tooLong || now >= deadlineRef.current) {
        logout();
        return;
      }
      sync();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      clearTimeout(hiddenTimerRef.current);
    };
  }, [logout, hiddenMs, sync]);
};

export default useAutoLogout;
