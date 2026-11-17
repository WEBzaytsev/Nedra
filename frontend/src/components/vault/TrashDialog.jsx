import { useEffect, useId, useMemo, useState } from "react";
import { ArrowUturnCcwLeft, TrashBin } from "@gravity-ui/icons";
import { Text, Flex, Button, Checkbox, Icon, Tooltip } from "@gravity-ui/uikit";
import Dialog from "../TaskSurface";
import { Trans, useTranslation } from "react-i18next";

import ConfirmDialog from "../ConfirmDialog";

const formatDeleted = (iso, language) => {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString(language);
};

const TrashDialog = ({ open, trash, onClose, onRestore, onPurge, onBulkRestore, onBulkPurge }) => {
  const { t, i18n } = useTranslation();
  const titleId = useId();
  const [purgeTargets, setPurgeTargets] = useState([]);
  const [purgeError, setPurgeError] = useState("");
  const [pendingId, setPendingId] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const selectedEntries = useMemo(
    () => trash.filter((entry) => selectedIds.includes(String(entry.id))),
    [trash, selectedIds]
  );
  const purgeTarget = purgeTargets[0];

  useEffect(() => {
    setSelectedIds((ids) => ids.filter((id) => trash.some((entry) => String(entry.id) === id)));
  }, [trash]);

  useEffect(() => {
    if (!open) {
      setSelectedIds([]);
      setPurgeTargets([]);
      setPurgeError("");
    }
  }, [open]);

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
    setPendingId(purgeTargets.length === 1 ? purgeTarget.id : "bulk-purge");
    try {
      if (purgeTargets.length === 1) {
        await onPurge({ passwordName: purgeTarget.password_name, entryId: purgeTarget.id });
      } else {
        await onBulkPurge(purgeTargets);
      }
      setSelectedIds([]);
      setPurgeTargets([]);
    } catch {
      setPurgeError(t("trashDialog.purgeFailed"));
    } finally {
      setPendingId(null);
    }
  };

  const handleBulkRestore = async () => {
    setPendingId("bulk-restore");
    try {
      await onBulkRestore(selectedEntries);
      setSelectedIds([]);
    } catch {
      // The parent reports the error; retain the selection for retry.
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
            {selectedEntries.length > 0 && (
              <Flex
                direction={{ xs: "column", s: "row" }}
                gap="spacing-3"
                alignItems={{ s: "center" }}
                justifyContent="space-between"
                minWidth="0"
                qa="trash-bulk-actions"
              >
                <Text role="status">
                  {t("vault.bulk.selected", { count: selectedEntries.length })}
                </Text>
                <Flex gap="spacing-2" wrap="wrap">
                  <Button
                    disabled={pendingId !== null}
                    loading={pendingId === "bulk-restore"}
                    onClick={handleBulkRestore}
                    size="xl"
                    type="button"
                    view="outlined"
                  >
                    <Icon data={ArrowUturnCcwLeft} />
                    {t("trashDialog.restoreSelected")}
                  </Button>
                  <Button
                    disabled={pendingId !== null}
                    onClick={() => {
                      setPurgeError("");
                      setPurgeTargets(selectedEntries);
                    }}
                    size="xl"
                    type="button"
                    view="outlined-danger"
                  >
                    <Icon data={TrashBin} />
                    {t("trashDialog.deleteSelected")}
                  </Button>
                  <Button
                    disabled={pendingId !== null}
                    onClick={() => setSelectedIds([])}
                    size="xl"
                    type="button"
                    view="outlined"
                  >
                    {t("vault.bulk.clearSelection")}
                  </Button>
                </Flex>
              </Flex>
            )}
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
                <Checkbox
                  checked={selectedIds.includes(String(entry.id))}
                  controlProps={{
                    "aria-label": t("vault.bulk.selectEntry", { name: entry.password_name }),
                  }}
                  disabled={pendingId !== null}
                  onUpdate={(checked) => {
                    const id = String(entry.id);
                    setSelectedIds((ids) =>
                      checked ? [...ids, id] : ids.filter((selectedId) => selectedId !== id)
                    );
                  }}
                  size="xl"
                />
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
                        setPurgeTargets([entry]);
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
        confirmText={t(
          purgeError
            ? "common.actions.retry"
            : purgeTargets.length === 1
              ? "trashDialog.deleteForever"
              : "trashDialog.deleteSelected"
        )}
        error={purgeError}
        onClose={() => {
          setPurgeError("");
          setPurgeTargets([]);
        }}
        onConfirm={handlePurge}
        open={purgeTargets.length > 0}
        pending={pendingId !== null}
        title={t(
          purgeTargets.length === 1
            ? "trashDialog.deleteForeverTitle"
            : "trashDialog.deleteSelectedTitle"
        )}
      >
        {purgeTargets.length === 1 ? (
          <Trans
            components={{ strong: <Text as="strong" /> }}
            i18nKey="trashDialog.deleteForeverMessage"
            values={{ name: purgeTarget?.password_name }}
          />
        ) : (
          <Flex as="div" direction="column" gap="spacing-2" minWidth="0">
            <Text>{t("trashDialog.deleteSelectedMessage", { count: purgeTargets.length })}</Text>
            <Flex
              as="ul"
              direction="column"
              gap="spacing-1"
              margin="0"
              paddingInlineStart="spacing-5"
            >
              {purgeTargets.map((entry) => (
                <Text as="li" key={entry.id} wordBreak="break-word">
                  {entry.password_name}
                </Text>
              ))}
            </Flex>
          </Flex>
        )}
      </ConfirmDialog>
    </Dialog>
  );
};

export default TrashDialog;
