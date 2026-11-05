import { useEffect, useId, useState } from "react";
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

  useEffect(() => {
    if (open) {
      setPassword("");
      setError("");
    }
  }, [open]);

  const handleBackup = async () => {
    if (!password.trim()) {
      setError(t("backup.passwordRequired"));
      return;
    }
    setLoading(true);
    try {
      await onBackup(password);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog
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
            helperText={error}
            label={t("auth.masterPassword")}
            onChange={(event) => {
              setPassword(event.target.value);
              setError("");
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
        </Flex>
      </Dialog.Body>
      <Dialog.Footer
        loading={loading}
        onClickButtonApply={handleBackup}
        onClickButtonCancel={onClose}
        textButtonApply={t("backup.title")}
        textButtonCancel={t("common.actions.cancel")}
      />
    </Dialog>
  );
};

export default BackupDialog;
