import { useEffect, useMemo, useState } from "react";
import { Flex, Alert, Button, Loader, Text, useLayoutContext } from "@gravity-ui/uikit";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { useNotify } from "../hooks/useNotify";
import { useStoreActions, useStoreState } from "easy-peasy";

import apiClient from "../api/client";
import PasswordFormDialog from "../components/vault/PasswordFormDialog";
import TaskSurface from "../components/TaskSurface";
import { createEntryDraftStore } from "../lib/entryDraft";
import { getCurrentUser } from "../utils";

const EntryCreatePage = () => {
  const { t } = useTranslation();
  const { isMediaActive } = useLayoutContext();
  const mobile = !isMediaActive("s");
  const { notify } = useNotify();
  const navigate = useNavigate();
  const location = useLocation();
  const create = useStoreActions((actions) => actions.ciphermothModels.passwords.create);
  const getFolders = useStoreActions((actions) => actions.ciphermothModels.access.getFolders);
  const folders = useStoreState((state) => state.ciphermothModels.access.folders);
  const [initialDraft, setInitialDraft] = useState(undefined);
  const [draftStore, setDraftStore] = useState(null);
  const [draftError, setDraftError] = useState(false);
  const [draftAttempt, setDraftAttempt] = useState(0);
  const entryType = location.state?.entryType === "note" ? "note" : "password";

  useEffect(() => {
    let active = true;
    setInitialDraft(undefined);
    setDraftStore(null);
    setDraftError(false);
    const initialize = async () => {
      let availableFolders = [];
      try {
        availableFolders = await getFolders();
      } catch (err) {
        notify(err.message, { theme: "danger" });
      }

      const initialFolder = availableFolders.find(
        (item) =>
          item.id === Number(location.state?.folderId) && ["owner", "write"].includes(item.access)
      );

      try {
        const { data } = await apiClient.get("/auth/entry-draft-key");
        if (!active) return;
        if (data.user_id !== getCurrentUser()?.id) throw new Error("Draft owner changed");
        const store = createEntryDraftStore(data);
        setDraftStore(store);
        setInitialDraft(
          store.read() ??
            (initialFolder ? { folder: initialFolder.name, folder_id: initialFolder.id } : null)
        );
      } catch {
        if (!active) return;
        setDraftError(true);
        setInitialDraft(null);
      }
    };
    initialize();
    return () => {
      active = false;
    };
  }, [draftAttempt, notify, getFolders, location.state?.folderId]);

  const folderOptions = useMemo(
    () => folders.filter((folder) => ["owner", "write"].includes(folder.access)),
    [folders]
  );

  const saveDraft = (value) => {
    if (!draftStore) {
      setDraftError(true);
      return;
    }
    try {
      if (value) draftStore.write(value);
      else draftStore.clear();
      setDraftError(false);
    } catch {
      setDraftError(true);
    }
  };

  const close = () => {
    if (location.state?.taskReturn) navigate(-1);
    else navigate("/passwords", { replace: true });
  };
  const cancel = () => {
    draftStore?.clear();
    close();
  };

  const submit = async (payload) => {
    await create(payload);
    draftStore?.clear();
    notify(
      t(payload.kind === "note" ? "vault.messages.noteCreated" : "vault.messages.passwordCreated"),
      { theme: "success" }
    );
    close();
  };

  if (initialDraft === undefined) {
    if (mobile)
      return (
        <TaskSurface
          open
          aria-label={t("entry.title.addPassword")}
          onOpenChange={(open) => !open && close()}
        >
          <TaskSurface.Header caption={t("entry.title.addPassword")} />
          <TaskSurface.Body>
            <Flex gap="spacing-3" justifyContent="center" paddingBlock="spacing-10" role="status">
              <Loader size="l" />
              <Text>{t("common.labels.loading")}</Text>
            </Flex>
          </TaskSurface.Body>
          <TaskSurface.Footer
            onClickButtonCancel={close}
            textButtonCancel={t("navigation.back")}
            propsButtonCancel={{ qa: "task-back" }}
          />
        </TaskSurface>
      );
    return (
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
    );
  }

  if (draftError) {
    if (mobile)
      return (
        <TaskSurface
          open
          aria-label={t("entry.title.addPassword")}
          onOpenChange={(open) => !open && close()}
        >
          <TaskSurface.Header caption={t("entry.title.addPassword")} />
          <TaskSurface.Body>
            <Alert
              theme="danger"
              view="outlined"
              message={t("entry.draft.unavailable")}
              actions={
                draftStore && (
                  <Button
                    size="xl"
                    view="flat-danger"
                    onClick={() => {
                      try {
                        draftStore.clear();
                        setDraftAttempt((n) => n + 1);
                      } catch {
                        notify(t("entry.draft.unavailable"), { theme: "danger" });
                      }
                    }}
                  >
                    {t("entry.draft.discard")}
                  </Button>
                )
              }
            />
          </TaskSurface.Body>
          <TaskSurface.Footer
            onClickButtonApply={() => setDraftAttempt((n) => n + 1)}
            textButtonApply={t("common.actions.retry")}
            onClickButtonCancel={close}
            textButtonCancel={t("navigation.back")}
            propsButtonCancel={{ qa: "task-back" }}
          />
        </TaskSurface>
      );
    return (
      <Flex
        direction="column"
        gap="spacing-3"
        minWidth="0"
        alignItems="center"
        justifyContent="center"
        paddingBlock="spacing-10"
      >
        <Flex direction="column" gap="spacing-3" minWidth="0" role="alert">
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
                      try {
                        draftStore.clear();
                        setDraftAttempt((n) => n + 1);
                      } catch {
                        notify(t("entry.draft.unavailable"), { theme: "danger" });
                      }
                    }}
                  >
                    {t("entry.draft.discard")}
                  </Button>
                )}
                <Button type="button" view="flat-secondary" onClick={close}>
                  {t("common.actions.cancel")}
                </Button>
              </>
            }
            actionsLayout="horizontal"
          />
        </Flex>
      </Flex>
    );
  }

  return (
    <PasswordFormDialog
      page
      open
      entryType={entryType}
      initialDraft={initialDraft}
      onDraftChange={saveDraft}
      draftError={draftError}
      folderOptions={folderOptions}
      onClose={cancel}
      onBack={close}
      onSubmit={submit}
    />
  );
};

export default EntryCreatePage;
