import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Flex,
  Text,
  Button,
  Dialog,
  Divider,
  Grid,
  Label,
  Select,
  TextInput,
} from "@gravity-ui/uikit";
import { useStoreActions, useStoreState } from "easy-peasy";
import { useTranslation } from "react-i18next";

import { useSnackbar } from "../../hooks/useNotify";
import {
  isInvalidExpiry,
  toLocalExpiry,
  toPersistedExpiry,
  toUtcExpiry,
} from "../../lib/accessExpiry";
import { getCurrentUser } from "../../utils";
import ConfirmDialog from "../ConfirmDialog";
import ExpiryField from "./ExpiryField";

const eventDate = (value, language) => {
  const iso = /[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`;
  return new Date(iso).toLocaleString(language);
};

const permissionOptions = (t) => [
  { value: "read", content: t("sharing.read") },
  { value: "write", content: t("sharing.readWrite") },
];

const GrantRow = ({ grant, busy, onSave, onRevoke }) => {
  const { t } = useTranslation();
  const [permission, setPermission] = useState(grant.permission);
  const [expiresAt, setExpiresAt] = useState(toLocalExpiry(grant.expires_at));
  const [expiryRejected, setExpiryRejected] = useState(false);
  const expiryInvalid = expiryRejected || isInvalidExpiry(expiresAt);

  useEffect(() => {
    setPermission(grant.permission);
    setExpiresAt(toLocalExpiry(grant.expires_at));
    setExpiryRejected(false);
  }, [grant.expires_at, grant.permission]);

  const save = () => {
    if (isInvalidExpiry(expiresAt)) {
      setExpiryRejected(true);
      return;
    }
    onSave(permission, toPersistedExpiry(expiresAt, grant.expires_at));
  };

  return (
    <Flex direction="column" gap="spacing-4" minWidth="0" as="article" paddingBlock="spacing-3">
      <Flex gap="spacing-2" alignItems="center" wrap="wrap" minWidth="0">
        <Text as="strong" wordBreak="break-word">
          {grant.target_name}
        </Text>
        <Flex gap="spacing-2" wrap="wrap">
          <Text color="secondary">{t(`folderAccess.targetTypes.${grant.target_type}`)}</Text>
          {grant.expired && (
            <Label size="s" theme="warning">
              {t("folderAccess.expired")}
            </Label>
          )}
        </Flex>
      </Flex>
      <Grid columns={{ xs: "minmax(0, 1fr)", l: "repeat(2, minmax(0, 1fr))" }} gap="spacing-4">
        <Flex direction="column" gap="spacing-2" minWidth="0">
          <Text>{t("sharing.permission")}</Text>
          <Select
            size="xl"
            width="max"
            aria-label={t("sharing.permission")}
            value={[permission]}
            disabled={busy}
            options={permissionOptions(t)}
            onUpdate={([value = "read"]) => setPermission(value)}
          />
        </Flex>
        <ExpiryField
          value={expiresAt}
          onUpdate={(value) => {
            setExpiresAt(value);
            setExpiryRejected(false);
          }}
          disabled={busy}
          invalid={expiryInvalid}
        />
      </Grid>
      <Flex gap="spacing-2" wrap="wrap">
        <Button
          type="button"
          size="xl"
          view="outlined"
          disabled={busy || expiryInvalid}
          onClick={save}
        >
          {t("common.actions.save")}
        </Button>
        <Button type="button" size="xl" view="flat-danger" disabled={busy} onClick={onRevoke}>
          {t("sharing.revoke")}
        </Button>
      </Flex>
    </Flex>
  );
};

const FolderAccessDialog = ({ open, onClose }) => {
  const { t, i18n } = useTranslation();
  const { enqueueSnackbar } = useSnackbar();
  const folders = useStoreState((state) => state.ciphermothModels.access.folders);
  const groups = useStoreState((state) => state.ciphermothModels.access.groups);
  const {
    getFolders,
    createFolder,
    renameFolder,
    deleteFolder,
    folderGrants,
    setFolderGrant,
    revokeFolderGrant,
    folderAudit,
    getGroups,
  } = useStoreActions((actions) => actions.ciphermothModels.access);
  const shareTargets = useStoreActions((actions) => actions.ciphermothModels.users.shareTargets);

  const [folderId, setFolderId] = useState("");
  const [newFolderName, setNewFolderName] = useState("");
  const [renameName, setRenameName] = useState("");
  const [grants, setGrants] = useState([]);
  const [audit, setAudit] = useState([]);
  const [targets, setTargets] = useState([]);
  const [targetType, setTargetType] = useState("user");
  const [targetId, setTargetId] = useState("");
  const [permission, setPermission] = useState("read");
  const [expiresAt, setExpiresAt] = useState("");
  const [expiryRejected, setExpiryRejected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const expiryInvalid = expiryRejected || isInvalidExpiry(expiresAt);
  const currentUserId = getCurrentUser()?.id;
  const selected = folders.find((folder) => folder.id === Number(folderId)) ?? null;
  const ownsSelected = selected?.owner_id === currentUserId;

  const loadBase = useCallback(async () => {
    const [nextFolders, nextGroups, nextTargets] = await Promise.all([
      getFolders(),
      getGroups(),
      shareTargets(),
    ]);
    setTargets(nextTargets);
    setFolderId((current) => {
      if (nextFolders.some((folder) => folder.id === Number(current))) return current;
      return String(nextFolders[0]?.id ?? "");
    });
    return { nextFolders, nextGroups };
  }, [getFolders, getGroups, shareTargets]);

  const loadDetails = useCallback(async () => {
    if (!selected?.can_manage) {
      setGrants([]);
      setAudit([]);
      return;
    }
    const [nextGrants, nextAudit] = await Promise.all([
      folderGrants(selected.id),
      folderAudit(selected.id),
    ]);
    setGrants(nextGrants);
    setAudit(nextAudit);
  }, [selected?.can_manage, selected?.id, folderGrants, folderAudit]);

  useEffect(() => {
    if (!open) return;
    loadBase().catch((error) => enqueueSnackbar(error.message, { variant: "error" }));
  }, [open, loadBase, enqueueSnackbar]);

  useEffect(() => {
    if (!open || !selected) return;
    setRenameName(selected.name);
    loadDetails().catch((error) => enqueueSnackbar(error.message, { variant: "error" }));
  }, [open, selected, loadDetails, enqueueSnackbar]);

  const run = async (operation, message, { refreshBase = false } = {}) => {
    setBusy(true);
    try {
      await operation();
      if (refreshBase) await loadBase();
      else await loadDetails();
      enqueueSnackbar(message, { variant: "success" });
      return true;
    } catch (error) {
      enqueueSnackbar(error.message, { variant: "error" });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const grantTargets = useMemo(() => {
    const source = targetType === "user" ? targets : groups;
    return source.filter(
      (target) =>
        !(targetType === "user" && target.id === selected?.owner_id) &&
        !grants.some((grant) => grant.target_type === targetType && grant.target_id === target.id)
    );
  }, [targetType, targets, groups, grants, selected?.owner_id]);

  const saveGrant = (grant, nextPermission, nextExpiry) =>
    run(
      () =>
        setFolderGrant({
          folderId: selected.id,
          targetType: grant.target_type,
          targetId: grant.target_id,
          permission: nextPermission,
          expiresAt: nextExpiry,
        }),
      t("folderAccess.saved")
    );

  const addGrant = async () => {
    if (!targetId) return;
    if (isInvalidExpiry(expiresAt)) {
      setExpiryRejected(true);
      return;
    }
    const saved = await run(
      () =>
        setFolderGrant({
          folderId: selected.id,
          targetType,
          targetId: Number(targetId),
          permission,
          expiresAt: toUtcExpiry(expiresAt),
        }),
      t("folderAccess.saved")
    );
    if (saved) {
      setTargetId("");
      setExpiresAt("");
      setExpiryRejected(false);
    }
  };

  const addFolder = async () => {
    const trimmed = newFolderName.trim();
    if (!trimmed) return;
    const created = await run(() => createFolder(trimmed), t("folderAccess.folderCreated"), {
      refreshBase: true,
    });
    if (created) setNewFolderName("");
  };

  const removeSelectedFolder = async () => {
    const removed = await run(
      () => deleteFolder(deleteTarget.id),
      t("folderAccess.folderDeleted"),
      { refreshBase: true }
    );
    if (removed) setDeleteTarget(null);
  };

  return (
    <>
      <Dialog
        aria-label={t("folderAccess.title")}

        contentOverflow="auto"
        fullWidth
        hasCloseButton={!busy}
        maxWidth="l"
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !busy) onClose();
        }}
      >
        <Dialog.Header caption={t("folderAccess.title")} />
        <Dialog.Body>
          <Flex direction="column" gap="spacing-5" minWidth="0">
            <Flex direction="column" gap="spacing-3" minWidth="0" as="section">
              <Text as="div" role="heading" aria-level={3} variant="subheader-2">
                {t("folderAccess.createFolder")}
              </Text>
              <Flex
                direction={{ xs: "column", s: "row" }}
                gap="spacing-3"
                minWidth="0"
                alignItems={{ s: "center" }}
              >
                <TextInput
                  size="xl"
                  placeholder={t("common.fields.name")}
                  controlProps={{ "aria-label": t("common.fields.name") }}
                  value={newFolderName}
                  onUpdate={setNewFolderName}
                />
                <Button
                  type="button"
                  size="xl"
                  view="action"
                  disabled={busy || !newFolderName.trim()}
                  onClick={addFolder}
                >
                  {t("common.actions.create")}
                </Button>
              </Flex>
            </Flex>

            <Divider />
            {folders.length === 0 ? (
              <Text as="div" color="secondary" wordBreak="break-word">
                {t("folderAccess.empty")}
              </Text>
            ) : (
              <Flex direction="column" gap="spacing-6" minWidth="0">
                <Flex direction="column" gap="spacing-4" minWidth="0">
                  <Flex direction="column" gap="spacing-4">
                    <Text as="div" role="heading" aria-level={3} variant="subheader-2">
                      {t("common.fields.folder")}
                    </Text>
                    <Select
                      size="xl"
                      width="max"
                      aria-label={t("common.fields.folder")}
                      value={folderId ? [folderId] : []}
                      options={folders.map((folder) => ({
                        value: String(folder.id),
                        content: `${folder.name} · ${folder.owner_username}`,
                      }))}
                      onUpdate={([value = ""]) => setFolderId(value)}
                    />

                    <Flex
                      direction="column"
                      gap="spacing-3"
                      minWidth="0"
                      as="section"
                      paddingBlock="spacing-3"
                    >
                      <Flex
                        direction={{ xs: "column", m: "row" }}
                        gap="spacing-3"
                        minWidth="0"
                        wrap="wrap"
                        alignItems={{ m: "center" }}
                        as="header"
                      >
                        <Flex direction="column" gap="spacing-3" minWidth="0">
                          <Text
                            as="div"
                            role="heading"
                            aria-level={3}
                            variant="subheader-2"
                            wordBreak="break-word"
                          >
                            {selected?.name}
                          </Text>
                          <Text as="div" color="secondary" wordBreak="break-word">
                            {t("folderAccess.ownerLabel", { owner: selected?.owner_username })}
                          </Text>
                        </Flex>
                        {!ownsSelected && (
                          <Text color="secondary" wordBreak="break-word">
                            {t(
                              selected?.access
                                ? `folderAccess.permissions.${selected.access}`
                                : "folderAccess.managementOnly"
                            )}
                          </Text>
                        )}
                      </Flex>
                      {ownsSelected && (
                        <Flex direction="column" gap="spacing-2" minWidth="0">
                          <Text>{t("folderAccess.rename")}</Text>
                          <Flex
                            direction={{ xs: "column", s: "row" }}
                            gap="spacing-2"
                            minWidth="0"
                            alignItems={{ s: "center" }}
                          >
                            <TextInput
                              size="xl"
                              width="max"
                              placeholder={t("folderAccess.rename")}
                              controlProps={{ "aria-label": t("folderAccess.rename") }}
                              value={renameName}
                              onUpdate={setRenameName}
                            />
                            <Button
                              type="button"
                              size="xl"
                              view="outlined"
                              disabled={
                                busy || !renameName.trim() || renameName.trim() === selected.name
                              }
                              onClick={() =>
                                run(
                                  () =>
                                    renameFolder({
                                      folderId: selected.id,
                                      name: renameName.trim(),
                                    }),
                                  t("folderAccess.folderRenamed"),
                                  { refreshBase: true }
                                )
                              }
                            >
                              {t("common.actions.save")}
                            </Button>
                            <Button
                              type="button"
                              size="xl"
                              view="outlined-danger"
                              disabled={busy}
                              onClick={() => setDeleteTarget(selected)}
                            >
                              {t("common.actions.delete")}
                            </Button>
                          </Flex>
                        </Flex>
                      )}
                    </Flex>
                  </Flex>
                </Flex>
                <Divider />
                <Flex direction="column" minWidth="0">
                  <Flex direction="column" gap="spacing-5">
                    {selected?.can_manage && (
                      <>
                        <Flex direction="column" gap="spacing-3" minWidth="0" as="section">
                          <Text as="div" role="heading" aria-level={3} variant="subheader-2">
                            {t("folderAccess.grants")}
                          </Text>
                          {grants.length === 0 ? (
                            <Text as="div" color="secondary" wordBreak="break-word">
                              {t("folderAccess.noGrants")}
                            </Text>
                          ) : (
                            <Flex direction="column" gap="spacing-3" minWidth="0">
                              {grants.map((grant) => (
                                <GrantRow
                                  key={`${grant.target_type}-${grant.target_id}`}
                                  grant={grant}
                                  busy={busy}
                                  onSave={(nextPermission, nextExpiry) =>
                                    saveGrant(grant, nextPermission, nextExpiry)
                                  }
                                  onRevoke={() =>
                                    run(
                                      () =>
                                        revokeFolderGrant({
                                          folderId: selected.id,
                                          targetType: grant.target_type,
                                          targetId: grant.target_id,
                                        }),
                                      t("folderAccess.revoked")
                                    )
                                  }
                                />
                              ))}
                            </Flex>
                          )}
                        </Flex>

                        <Flex
                          direction="column"
                          gap="spacing-3"
                          minWidth="0"
                          as="section"
                          paddingBlock="spacing-3"
                        >
                          <Text as="div" role="heading" aria-level={3} variant="subheader-2">
                            {t("sharing.grantAccess")}
                          </Text>
                          <Grid
                            columns={{ xs: "minmax(0, 1fr)", l: "repeat(2, minmax(0, 1fr))" }}
                            gap="spacing-4"
                          >
                            <Flex direction="column" gap="spacing-2" minWidth="0">
                              <Text>{t("folderAccess.targetType")}</Text>
                              <Select
                                size="xl"
                                aria-label={t("folderAccess.targetType")}
                                width="max"
                                value={[targetType]}
                                disabled={busy}
                                options={[
                                  { value: "user", content: t("folderAccess.targetTypes.user") },
                                  { value: "group", content: t("folderAccess.targetTypes.group") },
                                ]}
                                onUpdate={([value = "user"]) => {
                                  setTargetType(value);
                                  setTargetId("");
                                }}
                              />
                            </Flex>
                            <Flex direction="column" gap="spacing-2" minWidth="0">
                              <Text>{t("folderAccess.target")}</Text>
                              <Select
                                size="xl"
                                aria-label={t("folderAccess.target")}
                                width="max"
                                value={targetId ? [targetId] : []}
                                disabled={busy || grantTargets.length === 0}
                                options={grantTargets.map((target) => ({
                                  value: String(target.id),
                                  content: target.name ?? target.username,
                                }))}
                                onUpdate={([value = ""]) => setTargetId(value)}
                              />
                            </Flex>
                            <Flex direction="column" gap="spacing-2" minWidth="0">
                              <Text>{t("sharing.permission")}</Text>
                              <Select
                                size="xl"
                                aria-label={t("sharing.permission")}
                                width="max"
                                value={[permission]}
                                disabled={busy}
                                options={permissionOptions(t)}
                                onUpdate={([value = "read"]) => setPermission(value)}
                              />
                            </Flex>
                            <ExpiryField
                              value={expiresAt}
                              onUpdate={(value) => {
                                setExpiresAt(value);
                                setExpiryRejected(false);
                              }}
                              disabled={busy}
                              invalid={expiryInvalid}
                            />
                          </Grid>
                          <Flex>
                            <Button
                              type="button"
                              size="xl"
                              view="action"
                              disabled={busy || !targetId || expiryInvalid}
                              onClick={addGrant}
                            >
                              {t("sharing.grant")}
                            </Button>
                          </Flex>
                        </Flex>

                        <Divider />
                        <Flex direction="column" gap="spacing-3" minWidth="0" as="section">
                          <Text as="div" role="heading" aria-level={3} variant="subheader-2">
                            {t("folderAccess.audit")}
                          </Text>
                          {audit.length === 0 ? (
                            <Text as="div" color="secondary" wordBreak="break-word">
                              {t("folderAccess.noAudit")}
                            </Text>
                          ) : (
                            <Flex direction="column" gap="spacing-2" minWidth="0">
                              {audit.slice(0, 20).map((event) => (
                                <Flex
                                  direction={{ xs: "column", m: "row" }}
                                  gap="spacing-2"
                                  minWidth="0"
                                  paddingBlock="spacing-2"
                                  justifyContent="space-between"
                                  key={event.id}
                                >
                                  <Text wordBreak="break-word">
                                    {t(`folderAccess.actions.${event.action}`, {
                                      defaultValue: event.action,
                                      actor: event.actor_username || t("folderAccess.systemActor"),
                                      target:
                                        event.target_username || event.target_group_name || "",
                                    })}
                                  </Text>
                                  <Text
                                    as="time"
                                    variant="caption-2"
                                    color="secondary"
                                    dateTime={event.created}
                                  >
                                    {eventDate(event.created, i18n.resolvedLanguage)}
                                  </Text>
                                </Flex>
                              ))}
                            </Flex>
                          )}
                        </Flex>
                      </>
                    )}
                  </Flex>
                </Flex>
              </Flex>
            )}
          </Flex>
        </Dialog.Body>
        <Dialog.Footer
          onClickButtonApply={onClose}
          textButtonApply={t("common.actions.close")}
          propsButtonApply={{ disabled: busy, view: "normal" }}
        />
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={t("common.actions.delete")}
        confirmText={t("common.actions.delete")}
        confirmColor="error"
        onClose={() => setDeleteTarget(null)}
        onConfirm={removeSelectedFolder}
      >
        {t("folderAccess.deleteConfirm", { name: deleteTarget?.name })}
      </ConfirmDialog>
    </>
  );
};

export default FolderAccessDialog;
