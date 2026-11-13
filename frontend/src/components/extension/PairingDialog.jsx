import { useEffect, useState } from "react";
import { Box, Flex, Text } from "@gravity-ui/uikit";
import { useTranslation } from "react-i18next";

import Dialog from "../TaskSurface";
import { answerPairing, formatPairingCode, onPairingRequest } from "../../platform/extension";

export default function PairingDialog() {
  const { t } = useTranslation();
  const [request, setRequest] = useState(null);
  useEffect(() => {
    let stop;
    let disposed = false;
    onPairingRequest(
      (next) => setRequest(next),
      (id) => setRequest((current) => (current?.id === id ? null : current))
    ).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);
  const code = formatPairingCode(request?.code);
  const answer = (allow) => {
    if (request) answerPairing(request.id, allow);
    setRequest(null);
  };
  return (
    <Dialog
      disableEscapeKeyDown={false}
      disableOutsideClick={false}
      fullWidth
      maxWidth="xs"
      onOpenChange={(open) => !open && answer(false)}
      open={Boolean(request && code)}
    >
      <Dialog.Header
        caption={t("desktopExtension.pairTitle", {
          browser: request?.browser ?? t("desktopExtension.browser"),
        })}
      />
      <Dialog.Body>
        <Flex direction="column" gap="spacing-4">
          <Text color="secondary">
            {t("desktopExtension.pairDescription", {
              browser: request?.browser ?? t("desktopExtension.browser"),
            })}
          </Text>
          <Box
            aria-label={t("desktopExtension.code", { code })}
            padding="spacing-4"
            style={{ letterSpacing: "0.2em", textAlign: "center" }}
          >
            <Text variant="display-2">{code}</Text>
          </Box>
        </Flex>
      </Dialog.Body>
      <Dialog.Footer
        onClickButtonApply={() => answer(true)}
        onClickButtonCancel={() => answer(false)}
        textButtonApply={t("desktopExtension.allowPairing")}
        textButtonCancel={t("desktopExtension.denyPairing")}
      />
    </Dialog>
  );
}
