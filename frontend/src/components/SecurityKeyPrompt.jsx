import { useEffect, useState } from "react";
import { Alert, Flex, Text } from "@gravity-ui/uikit";
import { useTranslation } from "react-i18next";

import { IS_DESKTOP } from "../platform";
import { cancelSecurityKey, onSecurityKeyPrompt } from "../lib/securityKey";
import PasswordField from "./PasswordField";
import Dialog from "./TaskSurface";

const SecurityKeyPrompt = () => {
  const { t } = useTranslation();
  const [state, setState] = useState(null);
  const [pin, setPin] = useState("");

  useEffect(() => onSecurityKeyPrompt(setState), []);
  useEffect(() => setPin(""), [state?.kind]);
  if (!IS_DESKTOP || !state) return null;
  const close = () => {
    if (state.kind === "pin") state.cancel();
    else cancelSecurityKey();
  };
  return (
    <Dialog
      contentOverflow="visible"
      disableEscapeKeyDown
      disableOutsideClick
      fullWidth
      hasCloseButton={false}
      maxWidth="xs"
      open
    >
      <Dialog.Header caption={t("auth.securityKey")} />
      <Dialog.Body>
        <Flex direction="column" gap="spacing-4">
          <Text>{t(state.kind === "pin" ? "auth.securityKeyPin" : "auth.securityKeyTouch")}</Text>
          {state.kind === "pin" && (
            <>
              {state.error && <Alert message={t("auth.securityKeyPinInvalid")} theme="danger" />}
              <PasswordField
                autoComplete="off"
                autoFocus
                label={t("auth.securityKeyPin")}
                onChange={(event) => setPin(event.target.value)}
                value={pin}
              />
              <Text color="secondary">{t("auth.securityKeyPinHint")}</Text>
            </>
          )}
        </Flex>
      </Dialog.Body>
      <Dialog.Footer
        onClickButtonApply={state.kind === "pin" ? () => state.submit(pin) : undefined}
        onClickButtonCancel={close}
        propsButtonApply={{ disabled: state.kind === "pin" && !pin }}
        textButtonApply={state.kind === "pin" ? t("common.actions.confirm") : undefined}
        textButtonCancel={t("common.actions.cancel")}
      />
    </Dialog>
  );
};

export default SecurityKeyPrompt;
