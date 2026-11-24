import { useEffect, useId, useMemo, useState } from "react";
import { ArrowUturnCcwLeft, TrashBin } from "@gravity-ui/icons";
import { Text, Flex, Button, Checkbox, Icon, Tooltip, useLayoutContext } from "@gravity-ui/uikit";
import Dialog from "../TaskSurface";
import { Trans, useTranslation } from "react-i18next";

import ConfirmDialog from "../ConfirmDialog";
import {
  actionableEntries,
  canActOnEntry,
  reconcileSelection,
  selectedActionableEntries,
} from "../../lib/entrySelection";

const formatDeleted = (iso, language) => {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString(language);
};

const TrashDialog = ({ open, trash, onClose, onRestore, onPurge, onBulkRestore, onBulkPurge }) => {
  const { t, i18n } = useTranslation();
  const { isMediaActive } = useLayoutContext();
  const phone = !isMediaActive("s");
  const titleId = useId();
  const [purgeTargets, setPurgeTargets] = useState([]);
  const [purgeAll, setPurgeAll] = useState(false);
  const [purgeError, setPurgeError] = useState("");
  const [pendingId, setPendingId] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const restorable = useMemo(() => actionableEntries(trash), [trash]);
  const owned = useMemo(() => trash.filter((entry) => entry.access === "owner"), [trash]);
  const selectedEntries = useMemo(
    () => selectedActionableEntries(restorable, selectedIds),
    [restorable, selectedIds]
  );
  const allSelected = restorable.length > 0 && selectedEntries.length === restorable.length;
  const canPurgeSelection = selectedEntries.every((entry) => entry.access === "owner");
  const purgeTarget = purgeTargets[0];

  useEffect(() => {
    setSelectedIds((ids) => reconcileSelection(ids, restorable));
  }, [restorable]);

  useEffect(() => {
    if (!open) {
      setSelectedIds([]);
      setPurgeTargets([]);
      setPurgeAll(false);
      setPurgeError("");
    }
  }, [open]);

  const handleRestore = async (entry) => {
    setPendingId(entry.id);
    try {
      await onRestore({ passwordName: entry.password_name, entryId: entry.id });
    } catch {
    } finally {
      setPendingId(null);
    }
  };

  const handlePurge = async () => {
    setPurgeError("");
    setPendingId(!purgeAll && purgeTargets.length === 1 ? purgeTarget.id : "bulk-purge");
    try {
      if (!purgeAll && purgeTargets.length === 1) {
        await onPurge({ passwordName: purgeTarget.password_name, entryId: purgeTarget.id });
      } else {
        await onBulkPurge(purgeTargets);
      }
      setSelectedIds([]);
      setPurgeTargets([]);
      setPurgeAll(false);
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
    } finally {
      setPendingId(null);
    }
  };

  return (
    <>
      {purgeTargets.length === 0 && (
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
                {restorable.length > 0 && (
                  <Flex direction="column" gap="spacing-3" paddingBlockEnd="spacing-3" minWidth="0">
                    <Flex
                      direction={{ xs: "column", s: "row" }}
                      gap="spacing-3"
                      alignItems={{ s: "center" }}
                      justifyContent="space-between"
                      minWidth="0"
                    >
                      <Flex gap="spacing-3" alignItems="center" wrap="wrap" minWidth="0">
                        <Checkbox
                          checked={allSelected}
                          indeterminate={selectedEntries.length > 0 && !allSelected}
                          disabled={pendingId !== null}
                          onUpdate={(checked) =>
                            setSelectedIds(
                              checked ? restorable.map((entry) => String(entry.id)) : []
                            )
                          }
                          size="xl"
                        >
                          {t(
                            allSelected ? "vault.bulk.clearSelection" : "vault.bulk.selectAvailable"
                          )}
                        </Checkbox>
                        {selectedEntries.length > 0 && (
                          <Text role="status">
                            {t("vault.bulk.selected", { count: selectedEntries.length })}
                          </Text>
                        )}
                      </Flex>
                      {selectedEntries.length === 0 && owned.length > 0 && (
                        <Button
                          disabled={pendingId !== null}
                          onClick={() => {
                            setPurgeError("");
                            setPurgeAll(true);
                            setPurgeTargets(owned);
                          }}
                          size="xl"
                          type="button"
                          view="outlined-danger"
                          width={phone ? "max" : undefined}
                        >
                          <Icon data={TrashBin} />
                          {t("trashDialog.deleteAll")}
                        </Button>
                      )}
                    </Flex>
                    {selectedEntries.length > 0 && (
                      <Flex direction={{ xs: "column", s: "row" }} gap="spacing-2" minWidth="0">
                        <Button
                          disabled={pendingId !== null}
                          loading={pendingId === "bulk-restore"}
                          onClick={handleBulkRestore}
                          size="xl"
                          type="button"
                          view="outlined"
                          width={phone ? "max" : undefined}
                        >
                          <Icon data={ArrowUturnCcwLeft} />
                          {t("trashDialog.restoreSelected")}
                        </Button>
                        {canPurgeSelection && (
                          <Button
                            disabled={pendingId !== null}
                            onClick={() => {
                              setPurgeError("");
                              setPurgeAll(false);
                              setPurgeTargets(selectedEntries);
                            }}
                            size="xl"
                            type="button"
                            view="outlined-danger"
                            width={phone ? "max" : undefined}
                          >
                            <Icon data={TrashBin} />
                            {t("trashDialog.deleteSelected")}
                          </Button>
                        )}
                      </Flex>
                    )}
                    {selectedEntries.length > 0 && !canPurgeSelection && (
                      <Text color="secondary">{t("trashDialog.deleteOwnedOnly")}</Text>
                    )}
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
                    <Flex gap="spacing-3" alignItems="flex-start" minWidth="0" flexGrow={1}>
                      {canActOnEntry(entry) && (
                        <Checkbox
                          checked={selectedIds.includes(String(entry.id))}
                          controlProps={{
                            "aria-label": t("vault.bulk.selectEntry", {
                              name: entry.password_name,
                            }),
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
                      )}
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
                        {entry.access === "read" && (
                          <Text color="secondary">{t("sharing.readOnlyAccess")}</Text>
                        )}
                      </Flex>
                    </Flex>
                    {selectedEntries.length === 0 && canActOnEntry(entry) && (
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
                        {entry.access === "owner" && (
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
                        )}
                      </Flex>
                    )}
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
        </Dialog>
      )}
      {purgeTargets.length > 0 && (
        <ConfirmDialog
          confirmColor="error"
          confirmText={t(
            purgeError
              ? "common.actions.retry"
              : purgeAll
                ? "trashDialog.deleteAll"
                : purgeTargets.length === 1
                  ? "trashDialog.deleteForever"
                  : "trashDialog.deleteSelected"
          )}
          error={purgeError}
          onClose={() => {
            setPurgeError("");
            setPurgeTargets([]);
            setPurgeAll(false);
          }}
          onConfirm={handlePurge}
          open
          pending={pendingId !== null}
          title={t(
            purgeAll
              ? "trashDialog.deleteAllTitle"
              : purgeTargets.length === 1
                ? "trashDialog.deleteForeverTitle"
                : "trashDialog.deleteSelectedTitle"
          )}
        >
          {purgeAll ? (
            <Text>{t("trashDialog.deleteAllMessage", { count: purgeTargets.length })}</Text>
          ) : purgeTargets.length === 1 ? (
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
      )}
    </>
  );
};

export default TrashDialog;
