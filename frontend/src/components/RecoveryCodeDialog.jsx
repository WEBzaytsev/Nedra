import { useEffect, useId, useState } from "react";
import { Alert, Button, Flex, Text } from "@gravity-ui/uikit";
import { useTranslation } from "react-i18next";

import apiClient from "../api/client";
import { errorDetail } from "../lib/http";
import { securityKeyStepUp } from "../lib/securityStepUp";
import PasswordField from "./PasswordField";
import Dialog from "./TaskSurface";

const RecoveryCodeDialog = ({ open, onClose }) => {
  const { t } = useTranslation();
  const titleId = useId();
  const [currentPassword, setCurrentPassword] = useState("");
  const [configured, setConfigured] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCurrentPassword("");
    setCode("");
    setError("");
    apiClient
      .get("/auth/recovery")
      .then(({ data }) => setConfigured(data.configured))
      .catch(async (err) => setError(await errorDetail(err, t("errors.load"))));
  }, [open, t]);

  const issue = async () => {
    setBusy(true);
    setError("");
    try {
      const securityKeyAssertion = await securityKeyStepUp("recovery-create", {
        current_password: currentPassword,
      });
      const { data } = await apiClient.post("/auth/recovery", {
        current_password: currentPassword,
        security_key_assertion: securityKeyAssertion,
      });
      setConfigured(true);
      setCode(data.recovery_code);
      setCurrentPassword("");
    } catch (err) {
      setError(await errorDetail(err, t("errors.save")));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    setBusy(true);
    setError("");
    try {
      const securityKeyAssertion = await securityKeyStepUp("recovery-revoke", {
        current_password: currentPassword,
      });
      await apiClient.request({
        method: "DELETE",
        url: "/auth/recovery",
        data: { current_password: currentPassword, security_key_assertion: securityKeyAssertion },
      });
      setConfigured(false);
      setCode("");
      setCurrentPassword("");
    } catch (err) {
      setError(await errorDetail(err, t("errors.save")));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      aria-labelledby={titleId}
      contentOverflow="auto"
      fullWidth
      hasCloseButton={false}
      maxWidth="s"
      onOpenChange={(nextOpen) => !nextOpen && !busy && onClose()}
      open={open}
    >
      <Dialog.Header caption={t("auth.recoveryTitle")} id={titleId} />
      <Dialog.Body>
        <Flex direction="column" gap="spacing-4">
          <Text color="secondary">{t("auth.recoveryDescription")}</Text>
          {error && <Alert message={error} theme="danger" />}
          {code && <Alert message={`${t("auth.recoverySaveCode")} ${code}`} theme="warning" />}
          {!code && (
            <PasswordField
              autoComplete="current-password"
              disabled={busy}
              label={t("auth.currentPassword")}
              onChange={(event) => setCurrentPassword(event.target.value)}
              value={currentPassword}
            />
          )}
        </Flex>
      </Dialog.Body>
      <Dialog.Footer
        loading={busy}
        onClickButtonApply={code ? onClose : issue}
        onClickButtonCancel={code ? undefined : onClose}
        propsButtonApply={{ disabled: !code && !currentPassword }}
        textButtonApply={t(
          code
            ? "common.actions.close"
            : configured
              ? "auth.recoveryReplace"
              : "auth.recoveryCreate"
        )}
        textButtonCancel={code ? undefined : t("common.actions.close")}
      />
      {configured && !code && (
        <Flex justifyContent="flex-end" padding={{ bottom: "spacing-4", right: "spacing-4" }}>
          <Button disabled={busy || !currentPassword} onClick={revoke} view="flat-danger">
            {t("auth.recoveryRevoke")}
          </Button>
        </Flex>
      )}
    </Dialog>
  );
};

export default RecoveryCodeDialog;
