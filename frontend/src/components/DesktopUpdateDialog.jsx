import { useEffect, useState } from "react";
import { Flex, Text, Alert, Button, Dialog, Loader, Progress } from "@gravity-ui/uikit";
import { useStoreActions, useStoreState } from "easy-peasy";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { openExternal } from "../platform";

export default function DesktopUpdateDialog({ open, onClose }) {
  const { t } = useTranslation();
  const {
    current,
    latest,
    notes,
    canInstall,
    releaseUrl,
    updateAvailable,
    checked,
    checking,
    error: checkError,
  } = useStoreState((state) => state.nedraModels.updates);
  const checkForUpdates = useStoreActions((actions) => actions.nedraModels.updates.checkForUpdates);
  const title = t(
    checkError
      ? "updateDialog.checkFailed"
      : checking || !checked
        ? "updateDialog.checking"
        : updateAvailable
          ? "updateDialog.title"
          : "updateDialog.upToDate"
  );
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let disposed = false;
    const listeners = Promise.all([
      listen("update-progress", ({ payload }) => {
        if (!disposed)
          setProgress(
            payload.total ? Math.min(100, (payload.downloaded / payload.total) * 100) : null
          );
      }),
      listen("update-installing", () => {
        if (!disposed) setInstalling(true);
      }),
    ]);
    return () => {
      disposed = true;
      listeners.then((stops) => stops.forEach((stop) => stop()));
    };
  }, []);

  const install = async () => {
    setBusy(true);
    setError(null);
    setProgress(null);
    try {
      await invoke("update_install");
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    try {
      await invoke("update_cancel");
    } catch (requestError) {
      setError(String(requestError));
    }
  };

  return (
    <Dialog
      aria-label={title}

      contentOverflow="auto"
      fullWidth
      hasCloseButton={!busy}
      maxWidth="s"
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !busy) onClose();
      }}
    >
      <Dialog.Header caption={title} />
      <Dialog.Body>
        <Flex direction="column" gap="spacing-3" minWidth="0">
          {checkError ? (
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
            <>
              <Text as="div" color="secondary" wordBreak="break-word">
                v{current} → v{latest}
              </Text>
              {notes && (
                <Text as="div" color="secondary" wordBreak="break-word">
                  {notes}
                </Text>
              )}
              <Text as="div" color="secondary" wordBreak="break-word">
                {canInstall
                  ? t("desktopUpdate.installDescription")
                  : t("desktopUpdate.debianDescription")}
              </Text>
              {releaseUrl && (
                <Button type="button" view="flat" onClick={() => openExternal(releaseUrl)}>
                  {t("desktopUpdate.releaseNotes")}
                </Button>
              )}
            </>
          ) : (
            <Text color="secondary">
              {t("updateDialog.installedVersion", { version: `v${current}` })}
            </Text>
          )}
          {busy && (
            <Flex direction="column" gap="spacing-3" minWidth="0" role="status">
              {progress === null ? <Loader size="m" /> : <Progress value={progress} />}
              <Text color="secondary">
                {t(installing ? "desktopUpdate.installing" : "desktopUpdate.downloading")}
              </Text>
            </Flex>
          )}
          {error && <Alert theme="info" view="outlined" message={error} />}
        </Flex>
      </Dialog.Body>
      <Dialog.Footer
        renderButtons={() => (
          <Flex gap="spacing-3" wrap="wrap">
            {busy ? (
              <Button type="button" view="outlined" onClick={cancel} disabled={installing}>
                {t("desktopUpdate.cancelDownload")}
              </Button>
            ) : (
              <Button type="button" view="flat" onClick={onClose}>
                {t("common.actions.later")}
              </Button>
            )}
            {updateAvailable && canInstall && !checkError && !checking && (
              <Button type="button" view="action" onClick={install} disabled={busy} loading={busy}>
                {t("desktopUpdate.downloadInstall")}
              </Button>
            )}
          </Flex>
        )}
      />
    </Dialog>
  );
}
