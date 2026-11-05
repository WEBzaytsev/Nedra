import { useId, useState } from "react";
import { ArrowUturnCcwLeft, TrashBin } from "@gravity-ui/icons";
import { Text, Flex, Button, Icon, Tooltip } from "@gravity-ui/uikit";
import Dialog from "../TaskSurface";
import { Trans, useTranslation } from "react-i18next";

import ConfirmDialog from "../ConfirmDialog";

const formatDeleted = (iso, language) => {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString(language);
};

const TrashDialog = ({ open, trash, onClose, onRestore, onPurge }) => {
  const { t, i18n } = useTranslation();
  const titleId = useId();
  const [purgeTarget, setPurgeTarget] = useState(null);
  const [purgeError, setPurgeError] = useState("");
  const [pendingId, setPendingId] = useState(null);

  const handleRestore = async (entry) => {
    setPendingId(entry.id);
    try {
      await onRestore({ passwordName: entry.password_name, entryId: entry.id });
    } catch {
      // The parent reports the request error; keep this dialog open for retry.
    } finally {
      setPendingId(null);
    }
  };

  const handlePurge = async () => {
    setPurgeError("");
    setPendingId(purgeTarget.id);
    try {
      await onPurge({ passwordName: purgeTarget.password_name, entryId: purgeTarget.id });
      setPurgeTarget(null);
    } catch {
      setPurgeError(t("trashDialog.purgeFailed"));
    } finally {
      setPendingId(null);
    }
  };

  return (
    <Dialog
      aria-labelledby={titleId}

      contentOverflow="auto"
      fullWidth
      hasCloseButton={false}
      maxWidth="m"

      onOpenChange={(nextOpen) => {
        if (!nextOpen && pendingId === null) onClose();
      }}
      open={open}
    >
      <Dialog.Header caption={t("vault.trash")} id={titleId} />
      <Dialog.Body hasBorders>
        {trash.length === 0 ? (
          <Text as="div" color="secondary" wordBreak="break-word">
            {t("trashDialog.empty")}
          </Text>
        ) : (
          <Flex direction="column" gap="spacing-2" minWidth="0" aria-label={t("vault.trash")}>
            {trash.map((entry) => (
              <Flex
                direction={{ xs: "column", s: "row" }}
                gap="spacing-3"
                minWidth="0"
                paddingBlock="spacing-3"
                alignItems={{ s: "center" }}
                justifyContent="space-between"
                key={entry.id}
              >
                <Flex direction="column" gap="spacing-1" minWidth="0" flexGrow={1}>
                  <Text variant="subheader-2" wordBreak="break-word">
                    {entry.password_name}
                  </Text>
                  {entry.username && (
                    <Text color="secondary" wordBreak="break-word">
                      {entry.username}
                    </Text>
                  )}
                  <Text variant="caption-2" color="secondary" wordBreak="break-word">
                    {t("trashDialog.deleted")}:{" "}
                    {formatDeleted(entry.deleted, i18n.resolvedLanguage)}
                  </Text>
                </Flex>
                <Flex
                  direction="row"
                  gap="spacing-2"
                  minWidth="0"
                  flexShrink={0}
                  wrap="wrap"
                  alignItems="center"
                >
                  <Tooltip content={t("trashDialog.restore")} role="label">
                    <Button
                      aria-label={`${t("trashDialog.restore")}: ${entry.password_name}`}

                      disabled={pendingId !== null}
                      loading={pendingId === entry.id && !purgeTarget}
                      onClick={() => handleRestore(entry)}
                      size="xl"
                      type="button"
                      view="flat"
                    >
                      <Icon data={ArrowUturnCcwLeft} />
                      {t("trashDialog.restore")}
                    </Button>
                  </Tooltip>
                  <Tooltip content={t("trashDialog.deleteForever")} role="label">
                    <Button
                      aria-label={`${t("trashDialog.deleteForever")}: ${entry.password_name}`}

                      disabled={pendingId !== null}
                      onClick={() => {
                        setPurgeError("");
                        setPurgeTarget(entry);
                      }}
                      size="xl"
                      type="button"
                      view="flat-danger"
                    >
                      <Icon data={TrashBin} />
                    </Button>
                  </Tooltip>
                </Flex>
              </Flex>
            ))}
          </Flex>
        )}
      </Dialog.Body>
      <Dialog.Footer
        onClickButtonCancel={onClose}
        propsButtonCancel={{ disabled: pendingId !== null }}
        textButtonCancel={t("common.actions.close")}
      />
      <ConfirmDialog
        confirmColor="error"
        confirmText={t(purgeError ? "common.actions.retry" : "trashDialog.deleteForever")}
        error={purgeError}
        onClose={() => {
          setPurgeError("");
          setPurgeTarget(null);
        }}
        onConfirm={handlePurge}
        open={Boolean(purgeTarget)}
        pending={pendingId !== null}
        title={t("trashDialog.deleteForeverTitle")}
      >
        <Trans
          components={{ strong: <Text as="strong" /> }}
          i18nKey="trashDialog.deleteForeverMessage"
          values={{ name: purgeTarget?.password_name }}
        />
      </ConfirmDialog>
    </Dialog>
  );
};

export default TrashDialog;
