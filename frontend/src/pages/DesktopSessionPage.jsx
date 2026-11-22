import { useEffect, useState } from "react";
import { Alert, Container } from "@gravity-ui/uikit";
import { useTranslation } from "react-i18next";

import apiClient from "../api/client";
import LoadingScreen from "../components/LoadingScreen";
import { DESKTOP_SERVER_SESSION, clearSession, setCurrentUser, setSessionToken } from "../utils";

export default function DesktopSessionPage() {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get("session") ?? "";
    window.history.replaceState(null, "", "/desktop-session");
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      setFailed(true);
      return;
    }
    setSessionToken(token);
    apiClient
      .get("/auth/me")
      .then(({ data }) => {
        setCurrentUser(data);
        sessionStorage.setItem(DESKTOP_SERVER_SESSION, "1");
        window.location.replace("/passwords");
      })
      .catch(() => {
        clearSession();
        setFailed(true);
      });
  }, []);

  if (!failed) return <LoadingScreen label={t("desktopConnect.opening")} />;
  return (
    <Container maxWidth="480px" paddingBlock="spacing-10">
      <Alert theme="danger" message={t("desktopConnect.sessionFailed")} />
    </Container>
  );
}
