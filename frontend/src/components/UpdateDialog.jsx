import { useEffect } from "react";
import { ArrowRight } from "@gravity-ui/icons";
import { Button, Flex, Icon, Loader, Text } from "@gravity-ui/uikit";
import Dialog from "./TaskSurface";
import { useStoreActions, useStoreState } from "easy-peasy";
import { useTranslation } from "react-i18next";

import { IS_DESKTOP } from "../platform";
import DesktopUpdateDialog from "./DesktopUpdateDialog";

const stripV = (value) => String(value ?? "").replace(/^v/i, "");

const WebUpdateDialog = ({ open, onClose, checkForUpdates }) => {
  const { t } = useTranslation();
  const { current, latest, releaseUrl, updateAvailable, checked, checking, error } = useStoreState(
    (state) => state.nedraModels.updates
  );
  const title = t(
    error
      ? "updateDialog.checkFailed"
      : checking || !checked
        ? "updateDialog.checking"
        : updateAvailable
          ? "updateDialog.title"
          : "updateDialog.upToDate"
  );

  return (
    <Dialog
      aria-label={title}
      contentOverflow="auto"
      fullWidth
      maxWidth="s"
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <Dialog.Header caption={title} />
      <Dialog.Body>
        {error ? (
          <Button
            type="button"
            view="normal"
            size="xl"
            onClick={() => checkForUpdates({ manual: true })}
          >
            {t("updateDialog.retry")}
          </Button>
        ) : checking || !checked ? (
          <Flex alignItems="center" gap="spacing-3" role="status">
            <Loader size="m" />
            <Text>{t("updateDialog.checking")}</Text>
          </Flex>
        ) : updateAvailable ? (
          <Flex direction="column" gap="spacing-3" minWidth="0">
            <Flex alignItems="center" gap="spacing-3" minWidth="0">
              <Text color="secondary">v{stripV(current)}</Text>
              <Icon data={ArrowRight} size={16} />
              <Text>v{stripV(latest)}</Text>
            </Flex>
            <Text color="secondary">{t("updateDialog.adminUpdates")}</Text>
            {releaseUrl && (
              <Button
                component="a"
                href={releaseUrl}
                target="_blank"
                rel="noopener noreferrer"
                view="flat"
                size="xl"
              >
                {t("updateDialog.releaseNotes")}
              </Button>
            )}
          </Flex>
        ) : (
          <Text color="secondary">
            {t("updateDialog.installedVersion", { version: `v${stripV(current)}` })}
          </Text>
        )}
      </Dialog.Body>
      <Dialog.Footer
        onClickButtonApply={onClose}
        textButtonApply={t("common.actions.close")}
        propsButtonApply={{ view: "normal" }}
      />
    </Dialog>
  );
};

export default function UpdateDialog({ open, onClose }) {
  const checkForUpdates = useStoreActions((actions) => actions.nedraModels.updates.checkForUpdates);
  useEffect(() => {
    if (open) checkForUpdates({ manual: true });
  }, [open, checkForUpdates]);
  return IS_DESKTOP ? (
    <DesktopUpdateDialog open={open} onClose={onClose} />
  ) : (
    <WebUpdateDialog open={open} onClose={onClose} checkForUpdates={checkForUpdates} />
  );
}
