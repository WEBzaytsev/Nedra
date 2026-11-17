import { useEffect, useMemo, useState } from "react";
import { Button, Flex, Select, Text, TextInput } from "@gravity-ui/uikit";
import { useTranslation } from "react-i18next";

import Dialog from "../TaskSurface";

const NO_FOLDER = "none";

const BulkMoveDialog = ({
  open,
  entries,
  folders,
  onClose,
  onMove,
  onCreateFolder,
  canCreateFolder,
  pending,
}) => {
  const { t } = useTranslation();
  const [selected, setSelected] = useState(NO_FOLDER);
  const [newFolder, setNewFolder] = useState("");
  const [creating, setCreating] = useState(false);
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
    if (open) {
      setSelected(NO_FOLDER);
      setNewFolder("");
    }
  }, [open]);

  const folderId = selected === NO_FOLDER ? null : Number(selected);
  const createFolder = async () => {
    const name = newFolder.trim();
    if (!name || creating || !onCreateFolder) return;
    setCreating(true);
    try {
      const id = await onCreateFolder(name);
      if (id != null) {
        setSelected(String(id));
        setNewFolder("");
      }
    } finally {
      setCreating(false);
    }
  };
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
            {canCreateFolder && (
              <Flex gap="spacing-2" wrap="wrap">
                <TextInput
                  size="xl"
                  value={newFolder}
                  placeholder={t("folderAccess.createFolder")}
                  aria-label={t("folderAccess.createFolder")}
                  disabled={pending || creating}
                  onUpdate={setNewFolder}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      createFolder();
                    }
                  }}
                />
                <Button
                  size="xl"
                  view="outlined"
                  disabled={!newFolder.trim() || pending || creating}
                  loading={creating}
                  onClick={createFolder}
                >
                  {t("folderAccess.createFolder")}
                </Button>
              </Flex>
            )}
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
