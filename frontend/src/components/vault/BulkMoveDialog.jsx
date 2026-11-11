import { useEffect, useMemo, useState } from "react";
import { Flex, Select, Text } from "@gravity-ui/uikit";
import { useTranslation } from "react-i18next";

import Dialog from "../TaskSurface";

const NO_FOLDER = "none";

const BulkMoveDialog = ({ open, entries, folders, onClose, onMove, pending }) => {
  const { t } = useTranslation();
  const [selected, setSelected] = useState(NO_FOLDER);
  const owners = useMemo(() => new Set(entries.map((entry) => entry.owner_id)), [entries]);
  const options = useMemo(
    () => [
      { value: NO_FOLDER, content: t("vault.bulk.noFolder") },
      ...folders
        .filter((folder) => owners.has(folder.owner_id))
        .map((folder) => ({
          value: String(folder.id),
          content: `${folder.name} · ${folder.owner_username ?? folder.owner_id}`,
        })),
    ],
    [folders, owners, t]
  );

  useEffect(() => {
    if (open) setSelected(NO_FOLDER);
  }, [open]);

  const folderId = selected === NO_FOLDER ? null : Number(selected);
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !pending) onClose();
      }}
      aria-label={t("vault.bulk.moveTitle")}
      contentOverflow="auto"
      fullWidth
      hasCloseButton={false}
      maxWidth="s"
    >
      <Dialog.Header caption={t("vault.bulk.moveTitle")} />
      <Dialog.Body>
        <Flex direction="column" gap="spacing-4" minWidth="0">
          <Text>{t("vault.bulk.moveDescription", { count: entries.length })}</Text>
          <Flex direction="column" gap="spacing-2" minWidth="0">
            <Text>{t("vault.bulk.destination")}</Text>
            <Select
              size="xl"
              width="max"
              value={[selected]}
              options={options}
              filterable={options.length > 8}
              disabled={pending}
              aria-label={t("vault.bulk.destination")}
              onUpdate={([value = NO_FOLDER]) => setSelected(value)}
            />
          </Flex>
        </Flex>
      </Dialog.Body>
      <Dialog.Footer
        loading={pending}
        onClickButtonApply={() => onMove(folderId)}
        onClickButtonCancel={onClose}
        textButtonApply={t("vault.bulk.move")}
        textButtonCancel={t("common.actions.cancel")}
        propsButtonCancel={{ disabled: pending }}
      />
    </Dialog>
  );
};

export default BulkMoveDialog;
