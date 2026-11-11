import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Plus } from "@gravity-ui/icons";
import {
  Box,
  Flex,
  Row,
  Col,
  Text,
  Alert,
  Button,
  Icon,
  Loader,
  Select,
  TextInput,
  useLayoutContext,
} from "@gravity-ui/uikit";
import { useStoreActions, useStoreState } from "easy-peasy";

import { Trans, useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";

import BackupDialog from "../components/vault/BackupDialog";
import BulkMoveDialog from "../components/vault/BulkMoveDialog";
import ConfirmDialog from "../components/ConfirmDialog";
import EmptyVault from "../components/vault/EmptyVault";
import HealthDialog from "../components/vault/HealthDialog";
import ImportDialog from "../components/vault/ImportDialog";
import PasswordFormDialog from "../components/vault/PasswordFormDialog";
import PasswordHistoryDialog from "../components/vault/PasswordHistoryDialog";
import FolderAccessDialog from "../components/access/FolderAccessDialog";
import ShareDialog from "../components/vault/ShareDialog";
import TrashDialog from "../components/vault/TrashDialog";
import EntryBrowser from "../components/vault/EntryBrowser";
import EntryFilterMenu from "../components/vault/EntryFilterMenu";
import useClipboard from "../hooks/useClipboard";
import { applyEntryFilters, entryFilterCounts } from "../lib/entryFilters";
import { duplicateEntryName } from "../lib/entryActions";
import { useNotify } from "../hooks/useNotify";
import { getPageScrollTarget, getPageScrollTop } from "../lib/pageScroll";
import { reusePayload } from "../lib/passwordHistory";
import { generateTotp } from "../lib/totp";
import apiClient from "../api/client";
import { createEntryDraftStore } from "../lib/entryDraft";
import { getCurrentUser } from "../utils";
import useTaskRoute from "../hooks/useTaskRoute";
import { VaultViewContext } from "../hooks/VaultViewContext";
import TaskSurface from "../components/TaskSurface";
import useMenuAction from "../hooks/useMenuAction";

const buildSubtitle = (loading, passwords, t) => {
  if (loading) return t("common.labels.loading");
  const count = passwords.length;
  if (count === 0) return t("vault.subtitle.empty");
  return t("vault.subtitle.secretCount", { count });
};

const PasswordsPage = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { openTask, closeTask } = useTaskRoute();
  const vaultView = useContext(VaultViewContext);
  const { isMediaActive } = useLayoutContext();
  const mobile = !isMediaActive("s");
  const desktopShell = isMediaActive("l");
  const { notify, dismiss } = useNotify();
  const copy = useClipboard();

  const {
    get,
    create,
    update,
    reuseHistory,
    remove,
    backup,
    importPasswords,
    importCsv,
    toggleFavorite,
    bulkTrash,
    undoBulkTrash,
    bulkRestore,
    bulkPurge,
    bulkMove,
    undoBulkMove,
    getTrash,
    restore,
    purge,
    getDamaged,
    removeDamaged,
  } = useStoreActions((actions) => actions.ciphermothModels.passwords);
  const getFolders = useStoreActions((actions) => actions.ciphermothModels.access.getFolders);
  const { error, loading, passwords, trash, damaged, damageCheckError } = useStoreState(
    (state) => state.ciphermothModels.passwords
  );
  const folders = useStoreState((state) => state.ciphermothModels.access.folders);

  const [sortOrder, setSortOrder] = useState(vaultView.current.sortOrder ?? "created-desc");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [desktopEditTarget, setEditTarget] = useState(null);
  const [historyTarget, setHistoryTarget] = useState(null);
  const [shareTarget, setShareTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [removeDamagedOpen, setRemoveDamagedOpen] = useState(false);
  const [search, setSearch] = useState(vaultView.current.search ?? "");
  const [folderFilter, setFolderFilter] = useState(vaultView.current.folderFilter ?? "");
  const [entryFilters, setEntryFilters] = useState(
    () => new Set(vaultView.current.entryFilters ?? [])
  );
  const [draftStore, setDraftStore] = useState(null);
  const [initialDraft, setInitialDraft] = useState(null);
  const [draftError, setDraftError] = useState(false);
  const [draftReady, setDraftReady] = useState(false);
  const [draftAttempt, setDraftAttempt] = useState(0);
  const [requestedEntryId, setRequestedEntryId] = useState(null);
  const searchInput = useRef(null);
  const [selectedEntryIds, setSelectedEntryIds] = useState([]);
  const [bulkTrashPending, setBulkTrashPending] = useState(false);
  const [bulkMoveTargets, setBulkMoveTargets] = useState(null);
  const [bulkMovePending, setBulkMovePending] = useState(false);
  const bulkTrashInFlight = useRef(false);
  const bulkMoveInFlight = useRef(false);
  const view = searchParams.get("view");
  const routeEntry = passwords.find((entry) => String(entry.id) === searchParams.get("entry"));
  const editTarget = view === "edit" ? routeEntry : desktopEditTarget;
  const entryTask = mobile && routeEntry && ["details", "edit", "share"].includes(view);
  const entryUnavailable =
    mobile &&
    !loading &&
    !error &&
    ["details", "edit", "share"].includes(view) &&
    (!routeEntry ||
      (view === "edit" && routeEntry.access === "read") ||
      (view === "share" && routeEntry.access !== "owner"));
  const toolTask =
    mobile && ["folders", "backup", "import", "health", "trash"].includes(searchParams.get("tool"));

  const clearToolRoute = useCallback(() => {
    if (mobile) {
      closeTask();
      return;
    }
    if (!searchParams.has("tool")) return;
    const next = new URLSearchParams(searchParams);
    next.delete("tool");
    setSearchParams(next, { replace: true });
  }, [mobile, closeTask, searchParams, setSearchParams]);
  const activeTool = searchParams.get("tool");

  useEffect(() => {
    Object.assign(vaultView.current, {
      sortOrder,
      search,
      folderFilter,
      entryFilters: [...entryFilters],
    });
  }, [vaultView, sortOrder, search, folderFilter, entryFilters]);

  useEffect(() => {
    const target = getPageScrollTarget();
    const scroll = vaultView.current.scroll ?? 0;
    const frame = requestAnimationFrame(() => target.scrollTo(0, scroll));
    const rememberScroll = () => {
      vaultView.current.scroll = getPageScrollTop();
    };
    target.addEventListener("scroll", rememberScroll);
    return () => {
      cancelAnimationFrame(frame);
      target.removeEventListener("scroll", rememberScroll);
    };
  }, [vaultView, mobile]);

  useEffect(() => {
    let active = true;
    setDraftError(false);
    setDraftStore(null);
    const restoreDraft = async () => {
      try {
        const { data } = await apiClient.get("/auth/entry-draft-key");
        if (!active) return;
        if (data.user_id !== getCurrentUser()?.id) throw new Error("Draft owner changed");
        const store = createEntryDraftStore(data);
        setDraftStore(store);
        const draft = store.read();
        setDraftReady(true);
        if (draft) {
          if (mobile) {
            setInitialDraft(draft);
            return;
          }
          setInitialDraft(draft);
          setEditTarget(null);
          setDialogOpen(true);
        }
      } catch {
        if (active) setDraftError(true);
      }
    };
    restoreDraft();
    return () => {
      active = false;
    };
  }, [draftAttempt, mobile, navigate]);

  const saveDraft = useCallback(
    (form) => {
      if (!draftStore) return;
      try {
        if (form) draftStore.write(form);
        else draftStore.clear();
        setDraftError(false);
      } catch {
        setDraftError(true);
      }
    },
    [draftStore]
  );

  const closeEntryForm = () => {
    if (view === "edit") {
      closeTask();
      return;
    }
    if (!editTarget) {
      draftStore?.clear();
      setInitialDraft(null);
      setDraftError(false);
    }
    setDialogOpen(false);
  };

  useEffect(() => {
    get();
    getTrash();
    getDamaged();
    getFolders().catch((requestError) => notify(requestError.message, { theme: "danger" }));
  }, [get, getTrash, getDamaged, getFolders, notify]);

  useEffect(() => {
    setSelectedEntryIds((ids) =>
      ids.filter((id) => passwords.some((entry) => String(entry.id) === id))
    );
  }, [passwords]);

  const damagedCount = damaged.entries.length + damaged.attachments.length;

  const folderOptions = useMemo(
    () => folders.filter((folder) => ["owner", "write", "read"].includes(folder.access)),
    [folders]
  );
  const writableFolderOptions = useMemo(
    () => folders.filter((folder) => ["owner", "write"].includes(folder.access)),
    [folders]
  );
  const formFolderOptions = useMemo(
    () =>
      editTarget
        ? writableFolderOptions.filter((folder) => folder.owner_id === editTarget.owner_id)
        : writableFolderOptions,
    [editTarget, writableFolderOptions]
  );
  const activeFolder = folderOptions.some((folder) => folder.id === Number(folderFilter))
    ? folderFilter
    : "";

  const openAdd = (entryType = "password") => {
    const folder = writableFolderOptions.find((item) => item.id === Number(folderFilter));
    if (mobile) {
      navigate("/entries/new", {
        state: {
          folderId: folder?.id ?? null,
          entryType,
          taskReturn: "/passwords" + window.location.search,
        },
      });
      return;
    }
    if (!draftReady) {
      notify(t("entry.draft.unavailable"), { theme: "danger" });
      return;
    }
    setEditTarget(null);
    const draft = folder ? { folder: folder.name, folder_id: folder.id } : null;
    setInitialDraft(entryType === "note" ? { ...(draft ?? {}), kind: "note" } : draft);
    setDialogOpen(true);
  };

  const openTool = useCallback(
    (tool) => {
      if (mobile) {
        openTask({ tool });
        return;
      }
      const next = new URLSearchParams(searchParams);
      next.delete("entry");
      next.delete("view");
      next.set("tool", tool);
      setSearchParams(next);
    },
    [mobile, openTask, searchParams, setSearchParams]
  );

  const openEdit = useCallback(
    (row) => {
      if (row.access === "read") return;
      if (mobile || searchParams.has("entry")) {
        openTask({ entry: row.id, view: "edit" });
        return;
      }
      setEditTarget(row);
      setDialogOpen(true);
    },
    [mobile, openTask, searchParams]
  );

  const openShare = (row) => {
    if (mobile || searchParams.has("entry")) openTask({ entry: row.id, view: "share" });
    else setShareTarget(row);
  };

  const openDuplicate = (row) => {
    if (row.access === "read") return;
    setEditTarget(null);
    setInitialDraft({
      ...row,
      password_name: duplicateEntryName(
        row.password_name,
        passwords.map((entry) => entry.password_name),
        t("vault.context.copySuffix")
      ),
      favorite: false,
      attachment_count: 0,
      password_history: [],
    });
    setDialogOpen(true);
  };

  const handleCopyTotp = async (row) => {
    try {
      copy(await generateTotp(row.totp_secret));
    } catch {
      notify(t("totp.invalid"), { theme: "danger" });
    }
  };

  const handleToggleFavorite = useCallback(
    async (row) => {
      try {
        await toggleFavorite({ passwordName: row.password_name, favorite: !row.favorite });
      } catch (requestError) {
        notify(requestError.message, { theme: "danger" });
      }
    },
    [toggleFavorite, notify]
  );

  const handleSubmit = async (entry) => {
    if (editTarget) {
      await update({
        password: {
          password_name: editTarget.password_name,
          username: editTarget.username ?? null,
          password_value: editTarget.password_value,
          description: editTarget.description ?? null,
        },
        new_password: entry,
      });
      notify(
        t(entry.kind === "note" ? "vault.messages.noteUpdated" : "vault.messages.passwordUpdated"),
        { theme: "success" }
      );
    } else {
      await create(entry);
      notify(
        t(entry.kind === "note" ? "vault.messages.noteCreated" : "vault.messages.passwordCreated"),
        { theme: "success" }
      );
    }
    closeEntryForm();
    await getFolders().catch((requestError) => notify(requestError.message, { theme: "danger" }));
  };

  const handleReusePassword = async (entry, historyRow) => {
    await reuseHistory(reusePayload(entry, historyRow));
    notify(t("vault.messages.passwordUpdated"), { theme: "success" });
  };

  const handleDelete = async () => {
    try {
      await remove(deleteTarget);
      setDeleteTarget(null);
      notify(t("vault.messages.movedToTrash", { count: 1 }), { theme: "success" });
    } catch (requestError) {
      notify(requestError.message, { theme: "danger" });
    }
  };

  const selectedEntries = useMemo(
    () => passwords.filter((entry) => selectedEntryIds.includes(String(entry.id))),
    [passwords, selectedEntryIds]
  );

  const handleUndoBulkTrash = useCallback(
    async (receipt) => {
      if (bulkTrashInFlight.current) return;
      bulkTrashInFlight.current = true;
      setBulkTrashPending(true);
      try {
        await undoBulkTrash(receipt);
        dismiss("bulk-trash-undo");
        notify(t("vault.messages.trashUndone", { count: receipt.length }), { theme: "success" });
      } catch (requestError) {
        notify(requestError.message, { theme: "danger" });
      } finally {
        bulkTrashInFlight.current = false;
        setBulkTrashPending(false);
      }
    },
    [dismiss, notify, t, undoBulkTrash]
  );

  const handleBulkTrash = useCallback(async () => {
    if (selectedEntries.length === 0 || bulkTrashInFlight.current) return;
    bulkTrashInFlight.current = true;
    setBulkTrashPending(true);
    try {
      const result = await bulkTrash(selectedEntries);
      setSelectedEntryIds([]);
      const receipt = result.entries;
      notify(
        <Flex alignItems="center" gap="spacing-3" wrap="wrap">
          <Text>{t("vault.messages.movedToTrash", { count: receipt.length })}</Text>
          <Button size="xl" view="flat-secondary" onClick={() => handleUndoBulkTrash(receipt)}>
            {t("vault.bulk.undo")}
          </Button>
        </Flex>,
        { theme: "success", autoHiding: false, name: "bulk-trash-undo" }
      );
    } catch (requestError) {
      notify(requestError.message, { theme: "danger" });
    } finally {
      bulkTrashInFlight.current = false;
      setBulkTrashPending(false);
    }
  }, [bulkTrash, selectedEntries, handleUndoBulkTrash, notify, t]);

  const handleUndoBulkMove = useCallback(
    async (receipt) => {
      if (bulkMoveInFlight.current) return;
      bulkMoveInFlight.current = true;
      setBulkMovePending(true);
      try {
        await undoBulkMove(receipt);
        dismiss("bulk-move-undo");
        notify(t("vault.messages.moveUndone", { count: receipt.length }), { theme: "success" });
      } catch (requestError) {
        notify(requestError.message, { theme: "danger" });
      } finally {
        bulkMoveInFlight.current = false;
        setBulkMovePending(false);
      }
    },
    [dismiss, notify, t, undoBulkMove]
  );

  const handleBulkMove = useCallback(
    async (folderId) => {
      const entries = bulkMoveTargets ?? [];
      if (entries.length === 0 || bulkMoveInFlight.current) return;
      bulkMoveInFlight.current = true;
      setBulkMovePending(true);
      try {
        await bulkMove({ entries, folderId });
        setBulkMoveTargets(null);
        setSelectedEntryIds([]);
        const receipt = entries
          .filter((entry) => entry.folder_id !== folderId)
          .map((entry) => ({
            entry_id: entry.id,
            folder_id: entry.folder_id,
            moved_to_folder_id: folderId,
          }));
        notify(
          <Flex alignItems="center" gap="spacing-3" wrap="wrap">
            <Text>{t("vault.messages.moved", { count: receipt.length })}</Text>
            {receipt.length > 0 && (
              <Button size="xl" view="flat-secondary" onClick={() => handleUndoBulkMove(receipt)}>
                {t("vault.bulk.undo")}
              </Button>
            )}
          </Flex>,
          { theme: "success", autoHiding: false, name: "bulk-move-undo" }
        );
      } catch (requestError) {
        notify(requestError.message, { theme: "danger" });
      } finally {
        bulkMoveInFlight.current = false;
        setBulkMovePending(false);
      }
    },
    [bulkMove, bulkMoveTargets, handleUndoBulkMove, notify, t]
  );

  const handleRestore = async (name) => {
    try {
      await restore(name);
      notify(t("vault.messages.restored", { count: 1 }), { theme: "success" });
    } catch (requestError) {
      notify(requestError.message, { theme: "danger" });
      throw requestError;
    }
  };

  const handleBulkRestore = async (entries) => {
    try {
      await bulkRestore(entries);
      notify(t("vault.messages.restored", { count: entries.length }), { theme: "success" });
    } catch (requestError) {
      notify(requestError.message, { theme: "danger" });
      throw requestError;
    }
  };

  const handleRemoveDamaged = async () => {
    try {
      await removeDamaged(damaged);
      setRemoveDamagedOpen(false);
      notify(t("vault.damage.removed"), { theme: "success" });
    } catch (requestError) {
      notify(requestError.message, { theme: "danger" });
    }
  };

  const handlePurge = async (name) => {
    // TrashDialog keeps a failed purge inline, alongside Retry and Cancel.
    await purge(name);
    notify(t("vault.messages.permanentlyDeleted", { count: 1 }), { theme: "success" });
  };

  const handleBulkPurge = async (entries) => {
    try {
      await bulkPurge(entries);
      notify(t("vault.messages.permanentlyDeleted", { count: entries.length }), {
        theme: "success",
      });
    } catch (requestError) {
      notify(requestError.message, { theme: "danger" });
      throw requestError;
    }
  };

  const handleBackup = async (request) => {
    await backup(request);
    notify(t("vault.messages.backupRequested"), { theme: "info" });
  };

  useMenuAction("new-login", openAdd);
  useMenuAction("new-note", () => openAdd("note"));
  useMenuAction("import", () => openTool("import"));
  useMenuAction("backup", () => openTool("backup"));
  useMenuAction("trash", () => openTool("trash"));
  useMenuAction("health", () => openTool("health"));
  useMenuAction("find", () => {
    searchInput.current?.focus();
    searchInput.current?.select();
  });

  const searchedPasswords = useMemo(() => {
    const query = search.trim().toLowerCase();
    const byFolder = activeFolder
      ? passwords.filter((password) => password.folder_id === Number(activeFolder))
      : passwords;
    const matches = !query
      ? byFolder
      : byFolder.filter(
          (password) =>
            password.password_name.toLowerCase().includes(query) ||
            password.username?.toLowerCase().includes(query) ||
            password.description?.toLowerCase().includes(query) ||
            password.url?.toLowerCase().includes(query) ||
            password.folder?.toLowerCase().includes(query) ||
            password.tags?.some((tag) => tag.toLowerCase().includes(query)) ||
            password.custom_fields?.some(
              (field) =>
                field.label.toLowerCase().includes(query) ||
                (!field.hidden && field.value.toLowerCase().includes(query))
            )
        );

    return matches;
  }, [passwords, search, activeFolder]);
  const filterCounts = useMemo(() => entryFilterCounts(searchedPasswords), [searchedPasswords]);
  const filteredPasswords = useMemo(
    () =>
      [...applyEntryFilters(searchedPasswords, entryFilters)].sort(
        (first, second) =>
          (sortOrder === "created-desc"
            ? Date.parse(second.created) - Date.parse(first.created)
            : 0) ||
          (sortOrder === "favorites" ? Number(second.favorite) - Number(first.favorite) : 0) ||
          first.password_name.localeCompare(second.password_name) *
            (sortOrder === "name-desc" ? -1 : 1)
      ),
    [searchedPasswords, entryFilters, sortOrder]
  );

  const subtitle = useMemo(
    () => (error || passwords.length === 0 ? "" : buildSubtitle(loading, passwords, t)),
    [error, loading, passwords, t]
  );
  const isEmpty = !loading && !error && passwords.length === 0;

  return (
    <Flex
      direction="column"
      gap="spacing-5"
      minWidth="0"
      minHeight="0"
      height={desktopShell ? "calc(100dvh - var(--g-spacing-6) - var(--g-spacing-6))" : undefined}
      overflow={desktopShell ? "hidden" : undefined}
      as="section"
      qa="vault-page"
    >
      <Box
        hidden={
          (mobile && Boolean(bulkMoveTargets)) ||
          toolTask ||
          entryUnavailable ||
          (entryTask && view !== "details")
        }
        minWidth="0"
        minHeight="0"
        flexGrow={desktopShell ? 1 : undefined}
      >
        <Flex
          direction="column"
          gap="spacing-5"
          minWidth="0"
          minHeight="0"
          height={desktopShell ? "100%" : undefined}
          overflow={desktopShell ? "hidden" : undefined}
        >
          {!entryTask && (
            <>
              <Flex
                direction={{ xs: "row", s: "column", xl: "row" }}
                gap="spacing-3"
                minWidth="0"
                as="header"
                wrap="wrap"
                alignItems={{ xs: "center", s: "stretch", xl: "center" }}
                justifyContent="space-between"
              >
                <Flex
                  direction={{ xs: "column", s: "row" }}
                  alignItems={{ s: "baseline" }}
                  gap={{ xs: "spacing-1", s: "spacing-3" }}
                  wrap="wrap"
                  minWidth="0"
                >
                  <Box as="h1" margin="0">
                    <Text variant="header-1">{t("vault.title")}</Text>
                  </Box>
                  <Text color="secondary" wordBreak="break-word" role="status">
                    {subtitle}
                  </Text>
                </Flex>
                {!isEmpty && (
                  <Flex>
                    <Button
                      type="button"
                      view="action"
                      size="xl"
                      disabled={!draftReady}
                      onClick={() => openAdd()}
                    >
                      <Icon data={Plus} />
                      {t("common.actions.add")}
                    </Button>
                  </Flex>
                )}
              </Flex>

              {mobile && initialDraft && (
                <Alert
                  theme="info"
                  message={t("entry.draft.available")}
                  actions={
                    <Button
                      size="xl"
                      onClick={() =>
                        navigate("/entries/new", { state: { taskReturn: "/passwords" } })
                      }
                    >
                      {t("entry.draft.resume")}
                    </Button>
                  }
                />
              )}
              {(error || (draftError && !draftReady) || damageCheckError || damagedCount > 0) && (
                <Flex direction="column" gap="spacing-3" minWidth="0">
                  {error && (
                    <Alert
                      theme="danger"
                      view="outlined"
                      message={error}
                      actions={
                        <Button
                          type="button"
                          size="xl"
                          view="outlined"
                          onClick={() => get()}
                          disabled={loading}
                        >
                          {t("common.actions.retry")}
                        </Button>
                      }
                    />
                  )}
                  {draftError && !draftReady && (
                    <Alert
                      theme="danger"
                      view="outlined"
                      message={t("entry.draft.unavailable")}
                      actions={
                        <>
                          <Button
                            type="button"
                            view="flat-danger"
                            onClick={() => setDraftAttempt((n) => n + 1)}
                          >
                            {t("common.actions.retry")}
                          </Button>
                          {draftStore && (
                            <Button
                              type="button"
                              view="flat-danger"
                              onClick={() => {
                                draftStore.clear();
                                setDraftError(false);
                                setDraftReady(true);
                              }}
                            >
                              {t("entry.draft.discard")}
                            </Button>
                          )}
                        </>
                      }
                      actionsLayout="horizontal"
                    />
                  )}
                  {damageCheckError && (
                    <Alert
                      theme="warning"
                      view="outlined"
                      message={damageCheckError}
                      actions={
                        <Button type="button" view="flat-warning" onClick={() => getDamaged()}>
                          {t("common.actions.retry")}
                        </Button>
                      }
                    />
                  )}
                  {damagedCount > 0 && (
                    <Alert
                      theme="warning"
                      view="outlined"
                      message={t("vault.damage.message", { count: damagedCount })}
                      actions={
                        <Button
                          type="button"
                          view="flat-warning"
                          onClick={() => setRemoveDamagedOpen(true)}
                        >
                          {t("common.actions.remove")}
                        </Button>
                      }
                    />
                  )}
                </Flex>
              )}

              {passwords.length > 0 && (
                <Row gap="spacing-3">
                  <Col
                    size={{
                      xs: 12,
                      m: folderOptions.length ? 12 : 6,
                      xl: folderOptions.length ? 4 : 6,
                    }}
                  >
                    <TextInput
                      controlRef={searchInput}
                      size="xl"
                      type="search"
                      placeholder={t("vault.searchPlaceholder")}
                      value={search}
                      onUpdate={setSearch}
                      hasClear
                      qa="vault-search"
                      controlProps={{ "aria-label": t("vault.searchPlaceholder") }}
                    />
                  </Col>
                  {folderOptions.length > 0 && (
                    <Col size={{ xs: 6, m: 6, xl: 3 }} minWidth="0">
                      <Select
                        size="xl"
                        width="max"
                        aria-label={t("common.fields.folder")}
                        value={[activeFolder]}
                        onUpdate={([value = ""]) => setFolderFilter(value)}
                        options={[
                          { value: "", content: t("vault.allFolders") },
                          ...folderOptions.map((folder) => ({
                            value: String(folder.id),
                            content: `${folder.name} · ${folder.owner_username ?? folder.owner_id}`,
                          })),
                        ]}
                      />
                    </Col>
                  )}
                  <Col
                    size={{
                      xs: folderOptions.length ? 6 : 12,
                      m: folderOptions.length ? 6 : 4,
                      xl: folderOptions.length ? 3 : 4,
                    }}
                    minWidth="0"
                  >
                    <Select
                      size="xl"
                      width="max"
                      aria-label={t("vault.browser.sort")}
                      value={[sortOrder]}
                      onUpdate={([value = "created-desc"]) => setSortOrder(value)}
                      options={[
                        { value: "favorites", content: t("vault.browser.favoritesFirst") },
                        { value: "name", content: t("vault.browser.nameAscending") },
                        { value: "name-desc", content: t("vault.browser.nameDescending") },
                        { value: "created-desc", content: t("vault.browser.dateAdded") },
                      ]}
                    />
                  </Col>
                  <Col size={{ xs: 12, m: 2, xl: 2 }} minWidth="0">
                    <EntryFilterMenu
                      active={entryFilters}
                      counts={filterCounts}
                      onChange={setEntryFilters}
                    />
                  </Col>
                </Row>
              )}

              {loading && (
                <Flex
                  direction="column"
                  gap="spacing-3"
                  minWidth="0"
                  alignItems="center"
                  justifyContent="center"
                  paddingBlock="spacing-10"
                >
                  <Loader size="l" />
                </Flex>
              )}

              {isEmpty && <EmptyVault onAdd={() => openAdd()} disabled={!draftReady} />}
            </>
          )}

          {passwords.length > 0 && (
            <EntryBrowser
              entries={filteredPasswords}
              totalCount={passwords.length}
              emptyMessage={t(
                entryFilters.size
                  ? "vault.noQuickFilterResults"
                  : search.trim()
                    ? "vault.noSearchResults"
                    : "vault.noFolderResults",
                { search: search.trim() }
              )}
              onResetFilters={() => {
                setSearch("");
                setFolderFilter("");
                setEntryFilters(new Set());
              }}
              requestedEntryId={requestedEntryId}
              onRequestedEntryOpen={() => setRequestedEntryId(null)}
              onCopy={copy}
              onEdit={openEdit}
              onHistory={setHistoryTarget}
              onDelete={setDeleteTarget}
              onShare={openShare}
              mobileEntry={view === "details" ? routeEntry : null}
              taskActive={view === "details" && !entryUnavailable && !toolTask}
              onOpenEntry={(entry) => openTask({ entry: entry.id, view: "details" })}
              onCloseEntry={closeTask}
              onToggleFavorite={handleToggleFavorite}
              onCopyTotp={handleCopyTotp}
              onDuplicate={openDuplicate}
              onMove={(entry) => setBulkMoveTargets([entry])}
              selectedEntryIds={selectedEntryIds}
              onSelectedEntryIdsChange={setSelectedEntryIds}
              onBulkTrash={handleBulkTrash}
              bulkTrashPending={bulkTrashPending}
              onBulkMove={() => setBulkMoveTargets(selectedEntries)}
              bulkMovePending={bulkMovePending}
            />
          )}
        </Flex>
      </Box>
      {entryUnavailable && (
        <TaskSurface
          open
          aria-label={t("entry.unavailable")}
          onOpenChange={(open) => {
            if (!open) closeTask();
          }}
        >
          <TaskSurface.Header caption={t("vault.browser.details")} />
          <TaskSurface.Body>
            <Alert theme="warning" message={t("entry.unavailable")} />
          </TaskSurface.Body>
          <TaskSurface.Footer
            onClickButtonCancel={closeTask}
            textButtonCancel={t("navigation.back")}
            propsButtonCancel={{ qa: "task-back" }}
          />
        </TaskSurface>
      )}
      {(dialogOpen || (view === "edit" && routeEntry?.access !== "read" && routeEntry)) && (
        <PasswordFormDialog
          key={editTarget?.id ?? "new"}
          open
          page={mobile}
          editTarget={editTarget}
          initialDraft={initialDraft}
          onDraftChange={saveDraft}
          draftError={draftError}
          folderOptions={formFolderOptions}
          onClose={closeEntryForm}
          onSubmit={handleSubmit}
          onCopy={copy}
        />
      )}
      <PasswordHistoryDialog
        entry={historyTarget}
        onClose={() => setHistoryTarget(null)}
        onCopy={copy}
        onReuse={handleReusePassword}
      />
      <ShareDialog
        open={Boolean((view === "share" && routeEntry?.access === "owner") || shareTarget)}
        entry={view === "share" ? routeEntry : shareTarget}
        onClose={() => (view === "share" ? closeTask() : setShareTarget(null))}
      />
      <FolderAccessDialog open={activeTool === "folders"} onClose={clearToolRoute} />
      <BackupDialog
        open={activeTool === "backup"}
        onClose={clearToolRoute}
        onBackup={handleBackup}
      />
      <ImportDialog
        open={activeTool === "import"}
        onClose={clearToolRoute}
        onImport={importPasswords}
        onImportCsv={importCsv}
      />
      <HealthDialog
        open={activeTool === "health"}
        passwords={passwords}
        onClose={clearToolRoute}
        onSelect={(row) => {
          if (mobile) {
            openTask({ entry: row.id, view: row.access === "read" ? "details" : "edit" });
            return;
          }
          clearToolRoute();
          if (row.access === "read") {
            setFolderFilter("");
            setSearch(row.password_name);
            setRequestedEntryId(row.id);
          } else {
            openEdit(row);
          }
        }}
      />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={t("vault.moveToTrash.title")}
        confirmText={t("vault.moveToTrash.action")}
        confirmColor="error"
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
      >
        <Trans
          i18nKey="vault.moveToTrash.message"
          values={{ name: deleteTarget }}
          components={{ strong: <Text as="strong" /> }}
        />
      </ConfirmDialog>
      <ConfirmDialog
        open={removeDamagedOpen}
        title={t("vault.damage.removeTitle")}
        confirmText={t("common.actions.remove")}
        confirmColor="error"
        onClose={() => setRemoveDamagedOpen(false)}
        onConfirm={handleRemoveDamaged}
      >
        {t("vault.damage.removeMessage", { count: damagedCount })}
      </ConfirmDialog>
      <BulkMoveDialog
        open={Boolean(bulkMoveTargets)}
        entries={bulkMoveTargets ?? []}
        folders={writableFolderOptions}
        onClose={() => setBulkMoveTargets(null)}
        onMove={handleBulkMove}
        pending={bulkMovePending}
      />
      <TrashDialog
        open={activeTool === "trash"}
        trash={trash}
        onClose={clearToolRoute}
        onRestore={handleRestore}
        onPurge={handlePurge}
        onBulkRestore={handleBulkRestore}
        onBulkPurge={handleBulkPurge}
      />
    </Flex>
  );
};

export default PasswordsPage;
