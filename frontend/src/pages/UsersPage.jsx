import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, EllipsisVertical, Persons, Plus } from "@gravity-ui/icons";
import {
  Flex,
  Box,
  Text,
  Alert,
  Button,
  Card,
  Dialog,
  Icon,
  Menu,
  MenuDivider,
  MenuItem,
  Select,
  Switch,
  TextInput,
  Row,
  Col,
  useLayoutContext,
} from "@gravity-ui/uikit";
import { useStoreActions, useStoreState } from "easy-peasy";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

import GroupManagementDialog from "../components/access/GroupManagementDialog";
import UserFolderAccessDialog from "../components/access/UserFolderAccessDialog";
import ConfirmDialog from "../components/ConfirmDialog";
import PasswordField from "../components/PasswordField";
import useClipboard from "../hooks/useClipboard";
import { useNotify } from "../hooks/useNotify";
import { getCurrentUser } from "../utils";
import TaskSurface from "../components/TaskSurface";
import useTaskRoute from "../hooks/useTaskRoute";

const EMPTY_FORM = {
  username: "",
  temporary_password: "",
  current_password: "",
  role: "member",
};
const SERVICE_OPERATIONS = ["list", "get", "create", "update", "delete", "relinquish"];

const UsersPage = () => {
  const { t } = useTranslation();
  const { isMediaActive } = useLayoutContext();
  const mobile = !isMediaActive("s");
  const { params, openTask, closeTask } = useTaskRoute();
  const view = params.get("view");
  const { notify } = useNotify();
  const copy = useClipboard();
  const users = useStoreState((state) => state.ciphermothModels.users.users);
  const {
    get,
    create,
    update,
    revokeSessions,
    resetPassword,
    rotateServiceToken,
    updateServiceOperations,
    remove,
  } = useStoreActions((actions) => actions.ciphermothModels.users);
  const currentUserId = getCurrentUser()?.id;
  const [form, setForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [serviceToken, setServiceToken] = useState("");
  const [resetTarget, setResetTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [serviceConfigTarget, setServiceConfigTarget] = useState(null);
  const [serviceOperations, setServiceOperations] = useState([]);
  const [servicePassword, setServicePassword] = useState("");
  const [desktopFolderTarget, setFolderAccessTarget] = useState(null);
  const [desktopGroupsOpen, setGroupsOpen] = useState(false);
  const folderAccessTarget =
    view === "access"
      ? users.find((user) => String(user.id) === params.get("user"))
      : desktopFolderTarget;
  const groupsOpen = view === "groups" || desktopGroupsOpen;
  const taskOpen = mobile && ["create", "groups", "access"].includes(view);
  const CreateSurface = mobile ? TaskSurface : Box;
  const [temporaryPassword, setTemporaryPassword] = useState("");
  const [temporaryPasswordError, setTemporaryPasswordError] = useState(false);
  const temporaryPasswordRef = useRef(null);
  const servicePasswordRef = useRef(null);
  const createFormId = useId();

  const closeUserAction = (setter, target) => {
    if (view === "access") {
      closeTask();
      return;
    }
    const userId = target?.id;
    setter(null);
    if (userId) {
      window.requestAnimationFrame(() =>
        document.querySelector(`[data-user-menu="${userId}"]`)?.focus()
      );
    }
  };

  const loadUsers = useCallback(async () => {
    setListLoading(true);
    setListError("");
    try {
      await get();
    } catch (error) {
      setListError(error.message);
    } finally {
      setListLoading(false);
    }
  }, [get]);
  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  const run = async (operation, message = "") => {
    setBusy(true);
    try {
      const result = await operation();
      if (message) notify(message, { theme: "success" });
      return result ?? true;
    } catch (error) {
      notify(error.message, { theme: "danger" });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async (event) => {
    event.preventDefault();
    if (form.role !== "service" && !form.temporary_password) {
      setTemporaryPasswordError(true);
      temporaryPasswordRef.current?.focus();
      return;
    }
    if (form.role === "service" && !form.current_password) {
      servicePasswordRef.current?.focus();
      return;
    }
    const payload =
      form.role === "service"
        ? { username: form.username, role: form.role, current_password: form.current_password }
        : {
            username: form.username,
            role: form.role,
            temporary_password: form.temporary_password,
          };
    const created = await run(() => create(payload), t("users.messages.created"));
    if (!created) return;
    setServiceToken(created.service_token || "");
    setForm(EMPTY_FORM);
    setTemporaryPasswordError(false);
  };

  const saveReset = async () => {
    const ok = await run(
      () => resetPassword({ userId: resetTarget.id, temporaryPassword }),
      t("users.messages.passwordReset")
    );
    if (!ok) return;
    closeUserAction(setResetTarget, resetTarget);
    setTemporaryPassword("");
  };

  const saveServiceOperations = async () => {
    const saved = await run(
      () =>
        updateServiceOperations({
          userId: serviceConfigTarget.id,
          operations: serviceOperations,
          currentPassword: servicePassword,
        }),
      t("users.messages.serviceOperationsUpdated")
    );
    if (!saved) return;
    setServicePassword("");
    setServiceConfigTarget(null);
  };

  const rotateToken = async () => {
    const token = await run(
      () =>
        rotateServiceToken({
          userId: serviceConfigTarget.id,
          currentPassword: servicePassword,
        }),
      t("users.messages.tokenRotated")
    );
    if (token) setServiceToken(token);
    setServicePassword("");
  };

  const openServiceConfig = (user) => {
    setServiceConfigTarget(user);
    setServiceOperations(user.service_operations || []);
    setServicePassword("");
  };

  const deleteUser = async () => {
    const removed = await run(() => remove(deleteTarget.id), t("users.messages.deleted"));
    if (removed) setDeleteTarget(null);
  };

  return (
    <Flex direction="column" gap="spacing-5" minWidth="0" as="section">
      {!taskOpen && (
        <Flex
          direction={{ xs: "column", m: "row" }}
          gap="spacing-5"
          minWidth="0"
          wrap="wrap"
          alignItems={{ m: "center" }}
          as="header"
          justifyContent="space-between"
        >
          <Flex direction="column" gap="spacing-3" minWidth="0">
            <Text as="div" role="heading" aria-level={1} variant="header-1">
              {t("users.title")}
            </Text>
            {!mobile && (
              <Text as="div" color="secondary" wordBreak="break-word">
                {t("users.subtitle")}
              </Text>
            )}
          </Flex>
          <Flex
            direction="row"
            gap="spacing-3"
            minWidth="0"
            wrap="wrap"
            alignItems={{ m: "center" }}
            justifyContent="space-between"
          >
            {mobile && (
              <Button size="xl" view="action" onClick={() => openTask({ view: "create" })}>
                <Icon data={Plus} />
                {t("common.actions.add")}
              </Button>
            )}
            <Button
              size={mobile ? "xl" : undefined}
              type="button"
              view="outlined"
              onClick={() => (mobile ? openTask({ view: "groups" }) : setGroupsOpen(true))}
            >
              <Icon data={Persons} />
              {t("groups.title")}
            </Button>
            {!mobile && (
              <Button component={Link} to="/passwords" view="flat-secondary">
                <Icon data={ArrowLeft} />
                {t("users.backToVault")}
              </Button>
            )}
          </Flex>
        </Flex>
      )}
      {serviceToken && (
        <Alert
          theme="warning"
          view="outlined"
          title={t("users.serviceTokenOnce")}
          message={
            <Flex direction="column" gap="spacing-3" minWidth="0">
              <Flex as="label" direction="column" gap="spacing-2" minWidth="0">
                <Text>{t("users.serviceToken")}</Text>
                <TextInput
                  value={serviceToken}
                  size="xl"
                  controlProps={{ readOnly: true, "aria-label": t("users.serviceToken") }}
                />
              </Flex>
              <Flex direction="column" gap="spacing-3" minWidth="0">
                <Button type="button" view="outlined" onClick={() => copy(serviceToken)}>
                  {t("users.copyToken")}
                </Button>
                <Button type="button" view="flat" onClick={() => setServiceToken("")}>
                  {t("common.actions.dismiss")}
                </Button>
              </Flex>
            </Flex>
          }
        />
      )}

      <Row gap="spacing-6">
        <Col size={{ xs: 12, xl: 7 }} hidden={taskOpen}>
          <Flex direction="column" gap="spacing-3" minWidth="0">
            {listLoading && <Text role="status">{t("common.labels.loading")}</Text>}
            {listError && (
              <Alert
                theme="danger"
                message={listError}
                actions={
                  <Button size="xl" onClick={loadUsers}>
                    {t("common.actions.retry")}
                  </Button>
                }
              />
            )}
            {!listLoading && !listError && users.length === 0 && (
              <Text color="secondary">{t("users.empty")}</Text>
            )}
            {users.map((user) => {
              const isCurrent = user.id === currentUserId;
              return (
                <Card type="container" view="outlined" size="l" qa="user-card" key={user.id}>
                  <Flex
                    direction="column"
                    gap="spacing-4"
                    minWidth="0"
                    padding="spacing-4"
                    as="article"
                    data-user-id={user.id}
                  >
                    <Flex direction="column" gap="spacing-1" minWidth="0" flexGrow={1}>
                      <Text as="strong" wordBreak="break-word">
                        {user.username}
                      </Text>
                      <Text as="small" variant="caption-2" color="secondary" wordBreak="break-word">
                        {user.must_change_password && user.role !== "service"
                          ? t("users.passwordChangeRequested")
                          : user.role === "service"
                            ? t("users.serviceAccount")
                            : t("users.interactiveAccount")}
                      </Text>
                      {user.role === "service" && (
                        <Text
                          as="small"
                          variant="caption-2"
                          color="secondary"
                          wordBreak="break-word"
                        >
                          {(user.service_operations || []).length
                            ? t("users.serviceOperationsSummary", {
                                operations: user.service_operations.join(", "),
                              })
                            : t("users.serviceDisabled")}
                        </Text>
                      )}
                    </Flex>
                    <Flex
                      direction={{ xs: "column", m: "row" }}
                      gap="spacing-3"
                      alignItems={{ m: "center" }}
                      width="100%"
                      minWidth="0"
                      qa="user-controls"
                    >
                      <Flex width={{ xs: "100%", m: "220px" }} minWidth="0" qa="user-role-control">
                        <Select
                          width="max"
                          size="xl"
                          aria-label={t("users.role")}
                          value={[user.role]}
                          disabled={busy || isCurrent || user.role === "service"}
                          options={(user.role === "service"
                            ? ["service"]
                            : ["admin", "member"]
                          ).map((role) => ({
                            value: role,
                            content: t(
                              role === "service"
                                ? "users.roles.serviceShort"
                                : `users.roles.${role}`
                            ),
                          }))}
                          onUpdate={([role = user.role]) =>
                            run(
                              () => update({ userId: user.id, role }),
                              t("users.messages.roleUpdated")
                            )
                          }
                        />
                      </Flex>
                      <Flex
                        width={{ xs: "100%", m: "auto" }}
                        flexGrow={1}
                        gap="spacing-4"
                        minWidth="0"
                        alignItems="center"
                        justifyContent={{ xs: "space-between", m: "flex-end" }}
                        qa="user-actions"
                      >
                        <Flex flexShrink={0}>
                          <Switch
                            size="m"
                            checked={user.active}
                            disabled={busy || isCurrent}
                            onUpdate={(active) =>
                              run(
                                () => update({ userId: user.id, active }),
                                t("users.messages.statusUpdated")
                              )
                            }
                          >
                            {t(user.active ? "users.active" : "users.inactive")}
                          </Switch>
                        </Flex>
                        <Flex flexShrink={0}>
                          <Menu
                            placement="bottom-end"
                            trigger={
                              <Button
                                type="button"
                                size="xl"
                                view="flat-secondary"
                                aria-label={`${t("navigation.more")}: ${user.username}`}
                                data-user-menu={user.id}
                              >
                                <Icon data={EllipsisVertical} />
                                {t("navigation.more")}
                              </Button>
                            }
                          >
                            <MenuItem
                              disabled={busy}
                              onClick={() =>
                                mobile
                                  ? openTask({ view: "access", user: user.id })
                                  : setFolderAccessTarget(user)
                              }
                            >
                              {t("folderAccess.manage")}
                            </MenuItem>
                            {user.role === "service" ? (
                              <MenuItem disabled={busy} onClick={() => openServiceConfig(user)}>
                                {t("users.configureService")}
                              </MenuItem>
                            ) : (
                              <MenuItem
                                disabled={busy || isCurrent}
                                onClick={() => setResetTarget(user)}
                              >
                                {t("users.resetPassword")}
                              </MenuItem>
                            )}
                            <MenuItem
                              disabled={busy}
                              onClick={() =>
                                run(
                                  () => revokeSessions(user.id),
                                  t("users.messages.sessionsRevoked")
                                )
                              }
                            >
                              {t("users.revokeSessions")}
                            </MenuItem>
                            <MenuDivider />
                            <MenuItem
                              theme="danger"
                              disabled={busy || isCurrent}
                              onClick={() => setDeleteTarget(user)}
                            >
                              {t("common.actions.delete")}
                            </MenuItem>
                          </Menu>
                        </Flex>
                      </Flex>
                    </Flex>
                  </Flex>
                </Card>
              );
            })}
          </Flex>
        </Col>
        <Col size={{ xs: 12, xl: 5 }}>
          <Box hidden={mobile && view !== "create"}>
            <CreateSurface
              {...(mobile
                ? {
                    open: view === "create",
                    "aria-label": t("users.createAccount"),
                    onOpenChange: (open) => {
                      if (!open && !busy) closeTask();
                    },
                    disableEscapeKeyDown: busy,
                  }
                : {})}
            >
              <Flex direction="column" gap="spacing-4" minWidth="0" as="section">
                {mobile ? (
                  <TaskSurface.Header caption={t("users.createAccount")} />
                ) : (
                  <Text as="div" role="heading" aria-level={2} variant="subheader-3">
                    {t("users.createAccount")}
                  </Text>
                )}
                <Flex
                  direction="column"
                  gap="spacing-3"
                  minWidth="0"
                  as="form"
                  id={createFormId}
                  noValidate
                  onSubmit={add}
                >
                  <Flex as="label" direction="column" gap="spacing-2">
                    <Text>{t("auth.username")}</Text>
                    <TextInput
                      size="xl"
                      placeholder={t("auth.username")}
                      required
                      value={form.username}
                      onUpdate={(username) => setForm((current) => ({ ...current, username }))}
                      autoComplete="off"
                      note={t("auth.usernameRules")}
                      controlProps={{
                        "aria-label": t("auth.username"),
                        autoCapitalize: "none",
                        spellCheck: false,
                      }}
                    />
                  </Flex>
                  {form.role === "service" ? (
                    <Flex direction="column" gap="spacing-3" minWidth="0">
                      <Text color="secondary" wordBreak="break-word">
                        {t("users.servicePasswordConfirmation")}
                      </Text>
                      <PasswordField
                        label={t("auth.currentPassword")}
                        size="xl"
                        controlRef={servicePasswordRef}
                        value={form.current_password}
                        disabled={busy}
                        onChange={(event) =>
                          setForm((current) => ({
                            ...current,
                            current_password: event.target.value,
                          }))
                        }
                        autoComplete="current-password"
                      />
                    </Flex>
                  ) : (
                    <PasswordField
                      label={t("users.temporaryPassword")}
                      size="xl"
                      controlRef={temporaryPasswordRef}
                      validationState={temporaryPasswordError ? "invalid" : undefined}
                      errorMessage={
                        temporaryPasswordError ? t("users.temporaryPasswordRequired") : undefined
                      }
                      value={form.temporary_password}
                      onGenerate={(temporary_password) => {
                        setForm((current) => ({ ...current, temporary_password }));
                        setTemporaryPasswordError(false);
                      }}
                      disabled={busy}
                      onChange={(event) => {
                        setForm((current) => ({
                          ...current,
                          temporary_password: event.target.value,
                        }));
                        setTemporaryPasswordError(false);
                      }}
                      autoComplete="new-password"
                    />
                  )}
                  <Select
                    size="xl"
                    aria-label={t("users.role")}
                    value={[form.role]}
                    options={["admin", "member", "service"].map((role) => ({
                      value: role,
                      content: t(`users.roles.${role}`),
                    }))}
                    onUpdate={([role = "member"]) => {
                      setForm((current) => ({
                        ...current,
                        role,
                        temporary_password: role === "service" ? "" : current.temporary_password,
                        current_password: role === "service" ? current.current_password : "",
                      }));
                      setTemporaryPasswordError(false);
                    }}
                  />
                  {!mobile && (
                    <Button
                      type="submit"
                      view="action"
                      size="xl"
                      disabled={busy || !form.username.trim()}
                      loading={busy}
                    >
                      {t("common.actions.create")}
                    </Button>
                  )}
                </Flex>
                {mobile && (
                  <TaskSurface.Footer
                    textButtonApply={t("common.actions.create")}
                    propsButtonApply={{
                      type: "submit",
                      form: createFormId,
                      disabled: busy || !form.username.trim(),
                      loading: busy,
                    }}
                    textButtonCancel={t("navigation.back")}
                    onClickButtonCancel={closeTask}
                    propsButtonCancel={{ disabled: busy, qa: "task-back" }}
                  />
                )}
              </Flex>
            </CreateSurface>
          </Box>
        </Col>
      </Row>

      {taskOpen && view === "access" && !folderAccessTarget && (
        <TaskSurface
          open
          aria-label={t("folderAccess.manage")}
          onOpenChange={(open) => {
            if (!open) closeTask();
          }}
        >
          <TaskSurface.Header caption={t("folderAccess.manage")} />
          <TaskSurface.Body>
            {listLoading ? (
              <Text role="status">{t("common.labels.loading")}</Text>
            ) : listError ? (
              <Alert
                theme="danger"
                message={listError}
                actions={
                  <Button size="xl" onClick={loadUsers}>
                    {t("common.actions.retry")}
                  </Button>
                }
              />
            ) : (
              <Alert theme="warning" message={t("users.unavailable")} />
            )}
          </TaskSurface.Body>
          <TaskSurface.Footer
            onClickButtonCancel={closeTask}
            textButtonCancel={t("navigation.back")}
            propsButtonCancel={{ qa: "task-back" }}
          />
        </TaskSurface>
      )}

      <Dialog
        aria-label={t("users.configureServiceFor", { username: serviceConfigTarget?.username })}
        fullWidth
        maxWidth="s"
        open={Boolean(serviceConfigTarget)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !busy) {
            setServiceConfigTarget(null);
            setServicePassword("");
          }
        }}
      >
        <Dialog.Header
          caption={t("users.configureServiceFor", { username: serviceConfigTarget?.username })}
        />
        <Dialog.Body>
          <Flex direction="column" gap="spacing-5" minWidth="0">
            <Text as="div" color="secondary" wordBreak="break-word">
              {t("users.serviceOperationsDescription")}
            </Text>
            <Flex direction="column" gap="spacing-3" minWidth="0">
              {SERVICE_OPERATIONS.map((operation) => (
                <Switch
                  key={operation}
                  size="m"
                  checked={serviceOperations.includes(operation)}
                  disabled={busy}
                  onUpdate={(enabled) =>
                    setServiceOperations((current) =>
                      enabled
                        ? [...current, operation]
                        : current.filter((candidate) => candidate !== operation)
                    )
                  }
                >
                  {t(`users.serviceOperations.${operation}`)}
                </Switch>
              ))}
            </Flex>
            <PasswordField
              label={t("auth.currentPassword")}
              value={servicePassword}
              disabled={busy}
              onChange={(event) => setServicePassword(event.target.value)}
              autoComplete="current-password"
            />
            <Button
              type="button"
              view="outlined"
              disabled={busy || !servicePassword}
              loading={busy}
              onClick={rotateToken}
            >
              {t("users.rotateToken")}
            </Button>
          </Flex>
        </Dialog.Body>
        <Dialog.Footer
          onClickButtonApply={saveServiceOperations}
          onClickButtonCancel={() => {
            setServiceConfigTarget(null);
            setServicePassword("");
          }}
          textButtonApply={t("common.actions.save")}
          textButtonCancel={t("common.actions.cancel")}
          propsButtonApply={{ disabled: busy || !servicePassword, loading: busy, view: "action" }}
          propsButtonCancel={{ disabled: busy }}
        />
      </Dialog>

      <Dialog
        aria-label={t("users.resetPasswordFor", { username: resetTarget?.username })}

        fullWidth
        maxWidth="s"
        open={Boolean(resetTarget)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !busy) closeUserAction(setResetTarget, resetTarget);
        }}
      >
        <Dialog.Header caption={t("users.resetPasswordFor", { username: resetTarget?.username })} />
        <Dialog.Body>
          <Flex direction="column" gap="spacing-5" minWidth="0">
            <Text as="div" color="secondary" wordBreak="break-word">
              {t("users.resetPasswordDescription")}
            </Text>
            <PasswordField
              label={t("users.temporaryPassword")}
              value={temporaryPassword}
              onGenerate={setTemporaryPassword}
              disabled={busy}
              onChange={(event) => setTemporaryPassword(event.target.value)}
              autoComplete="new-password"
              autoFocus
            />
          </Flex>
        </Dialog.Body>
        <Dialog.Footer
          onClickButtonApply={saveReset}
          onClickButtonCancel={() => closeUserAction(setResetTarget, resetTarget)}
          textButtonApply={t("users.resetPassword")}
          textButtonCancel={t("common.actions.cancel")}
          propsButtonApply={{ disabled: busy || !temporaryPassword, loading: busy, view: "action" }}
          propsButtonCancel={{ disabled: busy }}
        />
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={t("common.actions.delete")}
        confirmText={t("common.actions.delete")}
        confirmColor="error"
        onClose={() => closeUserAction(setDeleteTarget, deleteTarget)}
        onConfirm={deleteUser}
      >
        {t("users.deleteConfirm", { username: deleteTarget?.username })}
      </ConfirmDialog>

      <UserFolderAccessDialog
        open={Boolean(folderAccessTarget)}
        user={folderAccessTarget}
        onClose={() => closeUserAction(setFolderAccessTarget, folderAccessTarget)}
      />
      <GroupManagementDialog
        open={groupsOpen}
        onClose={() => (view === "groups" ? closeTask() : setGroupsOpen(false))}
      />
    </Flex>
  );
};

export default UsersPage;
