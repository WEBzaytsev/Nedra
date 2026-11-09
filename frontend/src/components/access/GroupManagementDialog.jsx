import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Flex, Text, Button, Col, Divider, Row, Select, TextInput } from "@gravity-ui/uikit";
import { useStoreActions, useStoreState } from "easy-peasy";
import { useTranslation } from "react-i18next";
import Dialog from "../TaskSurface";

import { useNotify } from "../../hooks/useNotify";
import ConfirmDialog from "../ConfirmDialog";
import ManagementSection from "./ManagementSection";

const GroupManagementDialog = ({ open, onClose }) => {
  const { t, i18n } = useTranslation();
  const { notify } = useNotify();
  const groups = useStoreState((state) => state.ciphermothModels.access.groups);
  const users = useStoreState((state) => state.ciphermothModels.users.users);
  const {
    getGroups,
    createGroup,
    renameGroup,
    deleteGroup,
    groupMembers,
    addGroupMember,
    removeGroupMember,
    groupAudit,
  } = useStoreActions((actions) => actions.ciphermothModels.access);
  const [groupId, setGroupId] = useState("");
  const [newName, setNewName] = useState("");
  const [renameName, setRenameName] = useState("");
  const [members, setMembers] = useState([]);
  const [audit, setAudit] = useState([]);
  const [userId, setUserId] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null);
  const selected = groups.find((group) => group.id === Number(groupId)) ?? null;

  const loadGroups = useCallback(async () => {
    setLoadError("");
    const next = await getGroups();
    setGroupId((current) =>
      next.some((group) => group.id === Number(current)) ? current : String(next[0]?.id ?? "")
    );
  }, [getGroups]);

  const loadDetails = useCallback(async () => {
    if (!selected) {
      setMembers([]);
      setAudit([]);
      return;
    }
    const [nextMembers, nextAudit] = await Promise.all([
      groupMembers(selected.id),
      groupAudit(selected.id),
    ]);
    setMembers(nextMembers);
    setAudit(nextAudit);
  }, [selected, groupMembers, groupAudit]);

  useEffect(() => {
    if (!open) return;
    loadGroups().catch((error) => setLoadError(error.message));
  }, [open, loadGroups, notify]);

  useEffect(() => {
    if (!open || !selected) return;
    setRenameName(selected.name);
    loadDetails().catch((error) => setLoadError(error.message));
  }, [open, selected, loadDetails, notify]);

  const run = async (operation, message, refreshGroups = false) => {
    setBusy(true);
    try {
      await operation();
      if (refreshGroups) await loadGroups();
      else await loadDetails();
      notify(message, { theme: "success" });
      return true;
    } catch (error) {
      notify(error.message, { theme: "danger" });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const availableUsers = useMemo(
    () =>
      users.filter((user) => user.active && !members.some((member) => member.user_id === user.id)),
    [users, members]
  );

  const addGroup = async () => {
    const name = newName.trim();
    if (!name) return;
    const created = await run(() => createGroup(name), t("groups.created"), true);
    if (created) setNewName("");
  };

  const addMember = async () => {
    if (!selected || !userId) return;
    const added = await run(
      () => addGroupMember({ groupId: selected.id, userId: Number(userId) }),
      t("groups.memberAdded")
    );
    if (added) setUserId("");
  };

  const removeSelectedGroup = async () => {
    const removed = await run(() => deleteGroup(deleteTarget.id), t("groups.deleted"), true);
    if (removed) setDeleteTarget(null);
  };

  const eventDate = (value) => {
    const iso = /[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`;
    return new Date(iso).toLocaleString(i18n.resolvedLanguage);
  };

  return (
    <>
      <Dialog
        aria-label={t("groups.title")}

        contentOverflow="auto"
        fullWidth
        hasCloseButton={!busy}
        maxWidth="l"
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !busy) onClose();
        }}
      >
        <Dialog.Header caption={t("groups.title")} />
        <Dialog.Body>
          <Flex direction="column" gap="spacing-5" minWidth="0">
            {loadError && (
              <Alert
                theme="danger"
                message={loadError}
                actions={
                  <Button
                    size="xl"
                    onClick={() => {
                      setLoadError("");
                      Promise.all([loadGroups(), loadDetails()]).catch((error) =>
                        setLoadError(error.message)
                      );
                    }}
                  >
                    {t("common.actions.retry")}
                  </Button>
                }
              />
            )}
            <ManagementSection title={t("groups.create")}>
              <Flex
                direction={{ xs: "column", s: "row" }}
                gap="spacing-3"
                minWidth="0"
                alignItems={{ s: "center" }}
              >
                <TextInput
                  size="xl"
                  placeholder={t("groups.name")}
                  controlProps={{ "aria-label": t("groups.name") }}
                  value={newName}
                  onUpdate={setNewName}
                />
                <Button
                  type="button"
                  size="xl"
                  view="action"
                  disabled={busy || !newName.trim()}
                  onClick={addGroup}
                >
                  {t("common.actions.create")}
                </Button>
              </Flex>
            </ManagementSection>

            {groups.length === 0 ? (
              !loadError && (
                <Text as="div" color="secondary" wordBreak="break-word">
                  {t("groups.empty")}
                </Text>
              )
            ) : (
              <Row gap="spacing-6">
                <Col size={{ xs: 12, m: 5 }} minWidth="0">
                  <Flex direction="column" gap="spacing-4">
                    <Text>{t("groups.group")}</Text>
                    <Select
                      size="xl"
                      width="max"
                      aria-label={t("groups.group")}
                      value={groupId ? [groupId] : []}
                      options={groups.map((group) => ({
                        value: String(group.id),
                        content: group.name,
                      }))}
                      onUpdate={([value = ""]) => setGroupId(value)}
                    />

                    <Flex
                      direction="column"
                      gap="spacing-3"
                      minWidth="0"
                      as="section"
                      paddingBlock="spacing-3"
                    >
                      <Flex direction="column" gap="spacing-2" minWidth="0">
                        <Text as="label" htmlFor="cm-group-rename">
                          {t("groups.rename")}
                        </Text>
                        <TextInput
                          id="cm-group-rename"
                          size="xl"
                          placeholder={t("groups.rename")}
                          controlProps={{ "aria-label": t("groups.rename") }}
                          value={renameName}
                          onUpdate={setRenameName}
                        />
                        <Flex gap="spacing-2" wrap="wrap">
                          <Button
                            type="button"
                            size="xl"
                            view="outlined"
                            disabled={
                              busy || !renameName.trim() || renameName.trim() === selected?.name
                            }
                            onClick={() =>
                              run(
                                () =>
                                  renameGroup({ groupId: selected.id, name: renameName.trim() }),
                                t("groups.renamed"),
                                true
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
                    </Flex>
                  </Flex>
                </Col>
                <Col size={{ xs: 12, m: 7 }} minWidth="0">
                  <Flex direction="column" gap="spacing-5">
                    <Flex direction="column" gap="spacing-3" minWidth="0" as="section">
                      <Text as="div" role="heading" aria-level={3} variant="subheader-2">
                        {t("groups.members")}
                      </Text>
                      {members.length === 0 ? (
                        <Text as="div" color="secondary" wordBreak="break-word">
                          {t("groups.noMembers")}
                        </Text>
                      ) : (
                        <Flex direction="column" gap="spacing-2" minWidth="0">
                          {members.map((member) => (
                            <Flex
                              direction="row"
                              gap="spacing-2"
                              alignItems="center"
                              minWidth="0"
                              paddingBlock="spacing-2"
                              justifyContent="space-between"
                              key={member.user_id}
                            >
                              <Flex
                                direction="column"
                                gap="spacing-1"
                                minWidth="0"
                                flexGrow={1}
                                flexBasis={0}
                              >
                                <Text as="strong" wordBreak="break-word">
                                  {member.username}
                                </Text>
                                <Text as="small" variant="caption-2" color="secondary">
                                  {t(`users.roles.${member.role}`)}
                                </Text>
                              </Flex>
                              <Button
                                type="button"
                                size="xl"
                                view="flat-danger"
                                disabled={busy}
                                onClick={() =>
                                  run(
                                    () =>
                                      removeGroupMember({
                                        groupId: selected.id,
                                        userId: member.user_id,
                                      }),
                                    t("groups.memberRemoved")
                                  )
                                }
                              >
                                {t("common.actions.remove")}
                              </Button>
                            </Flex>
                          ))}
                        </Flex>
                      )}
                      <Flex
                        direction={{ xs: "column", s: "row" }}
                        gap="spacing-3"
                        minWidth="0"
                        alignItems={{ s: "center" }}
                      >
                        <Select
                          size="xl"
                          aria-label={t("groups.addMember")}
                          placeholder={t("groups.addMember")}
                          value={userId ? [userId] : []}
                          disabled={busy || availableUsers.length === 0}
                          options={availableUsers.map((user) => ({
                            value: String(user.id),
                            content: `${user.username} · ${t(`users.roles.${user.role}`)}`,
                          }))}
                          onUpdate={([value = ""]) => setUserId(value)}
                        />
                        <Button
                          type="button"
                          size="xl"
                          view="action"
                          disabled={busy || !userId}
                          onClick={addMember}
                        >
                          {t("common.actions.add")}
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
                                  target: event.target_username || "",
                                })}
                              </Text>
                              <Text
                                as="time"
                                variant="caption-2"
                                color="secondary"
                                dateTime={event.created}
                              >
                                {eventDate(event.created)}
                              </Text>
                            </Flex>
                          ))}
                        </Flex>
                      )}
                    </Flex>
                  </Flex>
                </Col>
              </Row>
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
        onConfirm={removeSelectedGroup}
      >
        {t("groups.deleteConfirm", { name: deleteTarget?.name })}
      </ConfirmDialog>
    </>
  );
};

export default GroupManagementDialog;
