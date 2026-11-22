import { useRef, useState } from "react";
import { Alert, Box, Button, Card, Container, Flex, Text } from "@gravity-ui/uikit";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";

import apiClient from "../api/client";
import BrandMark from "../components/BrandMark";

const REQUEST = /^[A-Za-z0-9_-]{43}$/;

export default function DesktopConnectPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const request = params.get("request") ?? "";
  const valid = REQUEST.test(request);
  const [state, setState] = useState(valid ? "ready" : "unavailable");
  const [connectionId, setConnectionId] = useState("");
  const started = useRef(false);

  const answer = async (allow) => {
    if (started.current || !valid) return;
    started.current = true;
    setState("working");
    try {
      const { data } = await apiClient.post("/desktop/connections/answer", { request, allow });
      setConnectionId(data.id ?? "");
      setState(allow ? "approved" : "denied");
    } catch {
      setState("unavailable");
    }
  };

  const revoke = async () => {
    if (!connectionId) return;
    try {
      await apiClient.delete(`/desktop/connections/${connectionId}`);
      setState("revoked");
    } catch {
      setState("unavailable");
    }
  };

  return (
    <Container maxWidth="480px" gutters="spacing-3" paddingBlock="spacing-10">
      <Card view="outlined">
        <Flex direction="column" gap="spacing-5" padding="spacing-6">
          <Flex alignItems="center" gap="spacing-2">
            <BrandMark />
            <Text variant="subheader-3">Nedra</Text>
          </Flex>
          <Box as="h1" margin="0">
            <Text variant="header-1">{t("desktopConnect.title")}</Text>
          </Box>
          <Text>{t("desktopConnect.description")}</Text>
          {state === "unavailable" && (
            <Alert theme="danger" message={t("desktopConnect.unavailable")} />
          )}
          {state === "approved" && <Alert theme="success" message={t("desktopConnect.approved")} />}
          {state === "denied" && <Alert theme="info" message={t("desktopConnect.denied")} />}
          {state === "revoked" && <Alert theme="info" message={t("desktopConnect.revoked")} />}
          {state === "ready" && (
            <Flex direction="column" gap="spacing-3">
              <Button view="action" size="xl" onClick={() => answer(true)}>
                {t("desktopConnect.allow")}
              </Button>
              <Button size="xl" onClick={() => answer(false)}>
                {t("desktopConnect.deny")}
              </Button>
            </Flex>
          )}
          {state === "working" && <Text role="status">{t("desktopConnect.working")}</Text>}
          {state === "approved" && connectionId && (
            <Button size="xl" onClick={revoke}>
              {t("desktopConnect.revoke")}
            </Button>
          )}
        </Flex>
      </Card>
    </Container>
  );
}
