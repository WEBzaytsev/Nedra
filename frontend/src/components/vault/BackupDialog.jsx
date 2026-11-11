import { useEffect, useId, useRef, useState } from "react";
import { Alert, Flex, Text } from "@gravity-ui/uikit";
import Dialog from "../TaskSurface";
import { useTranslation } from "react-i18next";

import PasswordField from "../PasswordField";
import { IS_DESKTOP } from "../../platform";

const BackupDialog = ({ open, onClose, onBackup }) => {
  const { t } = useTranslation();
  const titleId = useId();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const controller = useRef(null);

  useEffect(() => {
    if (open) {
      setPassword("");
      setError("");
      setCancelled(false);
    }
  }, [open]);

  useEffect(() => () => controller.current?.abort(), []);

  const handleBackup = async () => {
    if (controller.current) return;
    if (!password.trim()) {
      setError(t("backup.passwordRequired"));
      return;
    }
    const request = new AbortController();
    controller.current = request;
    setLoading(true);
    setCancelled(false);
    try {
      await onBackup({ masterPassword: password, signal: request.signal });
      onClose();
    } catch (err) {
      if (!request.signal.aborted) setError(err.message);
    } finally {
      if (controller.current === request) {
        controller.current = null;
        setLoading(false);
      }
    }
  };

  const canCancel = loading && !IS_DESKTOP;
  const cancelBackup = () => {
    controller.current?.abort();
    setCancelled(true);
  };

  return (
    <Dialog
      dockActions
      aria-labelledby={titleId}

      contentOverflow="auto"
      disableEscapeKeyDown={loading}
      disableOutsideClick={loading}
      fullWidth
      hasCloseButton={false}
      maxWidth="s"
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !loading) onClose();
      }}
      open={open}
    >
      <Dialog.Header caption={t("backup.title")} id={titleId} />
      <Dialog.Body>
        <Flex direction="column" gap="spacing-5" minWidth="0">
          <Text as="div" color="secondary" wordBreak="break-word">
            {t("backup.descriptionFull")}
          </Text>
          <PasswordField
            autoComplete="current-password"
            autoFocus
            errorMessage={error || undefined}
            label={t("auth.masterPassword")}
            onChange={(event) => {
              setPassword(event.target.value);
              setError("");
              setCancelled(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") handleBackup();
            }}
            required
            validationState={error ? "invalid" : undefined}
            value={password}
          />
          <Alert
            theme="info"
            view="outlined"
            message={`${t("backup.restoreAdvice")} ${t(IS_DESKTOP ? "backup.desktopAdvice" : "backup.webAdvice")}`}
          />
          {cancelled && (
            <Alert theme="info" view="outlined" message={t("backup.cancelRequested")} />
          )}
        </Flex>
      </Dialog.Body>
      <Dialog.Footer
        loading={false}
        onClickButtonApply={handleBackup}
        onClickButtonCancel={canCancel ? cancelBackup : onClose}
        textButtonApply={t("backup.title")}
        textButtonCancel={t(canCancel ? "backup.cancel" : "common.actions.cancel")}
        propsButtonApply={{ disabled: loading, loading }}
        propsButtonCancel={{ disabled: (loading && !canCancel) || (loading && cancelled) }}
      />
    </Dialog>
  );
};

export default BackupDialog;
