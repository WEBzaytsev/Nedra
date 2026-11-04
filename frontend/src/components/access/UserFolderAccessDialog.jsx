import { useCallback, useEffect, useState } from "react";
import { Flex, Text, Button, Col, Dialog, Row, Select } from "@gravity-ui/uikit";
import { useStoreActions } from "easy-peasy";
import { useTranslation } from "react-i18next";

import { useSnackbar } from "../../hooks/useNotify";
import { isInvalidExpiry, toLocalExpiry, toPersistedExpiry } from "../../lib/accessExpiry";
import ExpiryField from "./ExpiryField";

const AccessRow = ({ item, busy, onSave, onRevoke }) => {
  const { t } = useTranslation();
  const [permission, setPermission] = useState(item.direct_permission ?? "read");
  const [expiresAt, setExpiresAt] = useState(toLocalExpiry(item.direct_expires_at));
  const [expiryRejected, setExpiryRejected] = useState(false);
  const owned = item.folder.owner_id === item.userId;
  const expiryInvalid = expiryRejected || isInvalidExpiry(expiresAt);

  useEffect(() => {
    setPermission(item.direct_permission ?? "read");
    setExpiresAt(toLocalExpiry(item.direct_expires_at));
    setExpiryRejected(false);
  }, [item.direct_expires_at, item.direct_permission]);

  const save = () => {
    if (isInvalidExpiry(expiresAt)) {
      setExpiryRejected(true);
      return;
    }
    onSave(item.folder.id, permission, toPersistedExpiry(expiresAt, item.direct_expires_at));
  };

  return (
    <Flex direction="column" gap="spacing-3" minWidth="0" as="article" paddingBlock="spacing-3">
      <Flex
        direction="row"
        gap="spacing-3"
        minWidth="0"
        wrap="wrap"
        alignItems="center"
        as="header"
      >
        <Flex direction="column" gap="spacing-1" minWidth="0" flexGrow={1}>
          <Text as="div" role="heading" aria-level={3} variant="subheader-2" wordBreak="break-word">
            {item.folder.name}
          </Text>
          <Text as="div" color="secondary" wordBreak="break-word">
            {t("folderAccess.ownerLabel", { owner: item.folder.owner_username })}
          </Text>
        </Flex>
        <Text wordBreak="break-word" color="secondary">
          {t(
            item.effective_permission
              ? `folderAccess.permissions.${item.effective_permission}`
              : "folderAccess.permissions.none"
          )}
        </Text>
      </Flex>

      <Flex gap="spacing-2" wrap="wrap" minWidth="0">
        {item.sources.map((source, index) => (
          <Text
            key={`${source.source}-${source.source_id}-${index}`}
            color="secondary"
            wordBreak="break-word"
          >
            {t("folderAccess.source", {
              source: t(`folderAccess.sources.${source.source}`),
              name: source.name || "",
              permission: t(`folderAccess.permissions.${source.permission}`),
            })}
            {source.expired && ` · ${t("folderAccess.expired")}`}
          </Text>
        ))}
      </Flex>

      {owned ? (
        <Text as="div" color="secondary" wordBreak="break-word">
          {t("folderAccess.ownerCannotChange")}
        </Text>
      ) : (
        <Row gap="spacing-4">
          <Col size={{ xs: 12, s: 5 }} minWidth="0">
            <Flex direction="column" gap="spacing-2">
              <Text>{t("sharing.permission")}</Text>
              <Select
                size="xl"
                width="max"

                aria-label={t("sharing.permission")}
                value={[permission]}
                disabled={busy}
                options={[
                  { value: "read", content: t("sharing.read") },
                  { value: "write", content: t("sharing.readWrite") },
                ]}
                onUpdate={([value = "read"]) => setPermission(value)}
              />
            </Flex>
          </Col>
          <Col size={{ xs: 12, s: 7 }} minWidth="0">
            <ExpiryField
              value={expiresAt}
              onUpdate={(value) => {
                setExpiresAt(value);
                setExpiryRejected(false);
              }}
              disabled={busy}
              invalid={expiryInvalid}
            />
          </Col>
          <Col size={12}>
            <Flex gap="spacing-2" wrap="wrap">
              <Button
                type="button"
                size="xl"
                view="action"
                disabled={busy || expiryInvalid}
                onClick={save}
              >
                {t("common.actions.save")}
              </Button>
              <Button
                type="button"
                size="xl"
                view="flat-danger"
                disabled={busy || !item.direct_permission}
                onClick={() => onRevoke(item.folder.id)}
              >
                {t("sharing.revoke")}
              </Button>
            </Flex>
          </Col>
        </Row>
      )}
    </Flex>
  );
};

const UserFolderAccessDialog = ({ open, user, onClose }) => {
  const { t } = useTranslation();
  const { enqueueSnackbar } = useSnackbar();
  const { userFolderAccess, setFolderGrant, revokeFolderGrant } = useStoreActions(
    (actions) => actions.ciphermothModels.access
  );
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    setItems(await userFolderAccess(user.id));
  }, [user, userFolderAccess]);

  useEffect(() => {
    if (!open) return;
    load().catch((error) => enqueueSnackbar(error.message, { variant: "error" }));
  }, [open, load, enqueueSnackbar]);

  const run = async (operation, message) => {
    setBusy(true);
    try {
      await operation();
      await load();
      enqueueSnackbar(message, { variant: "success" });
    } catch (error) {
      enqueueSnackbar(error.message, { variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      aria-label={t("folderAccess.userTitle", { username: user?.username })}

      contentOverflow="auto"
      fullWidth
      hasCloseButton={!busy}
      maxWidth="m"
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !busy) onClose();
      }}
    >
      <Dialog.Header caption={t("folderAccess.userTitle", { username: user?.username })} />
      <Dialog.Body>
        <Flex direction="column" gap="spacing-5" minWidth="0">
          <Text as="div" color="secondary" wordBreak="break-word">
            {t("folderAccess.userDescription")}
          </Text>
          {items.length === 0 ? (
            <Text as="div" color="secondary" wordBreak="break-word">
              {t("folderAccess.empty")}
            </Text>
          ) : (
            items.map((item) => (
              <AccessRow
                key={item.folder.id}
                item={{ ...item, userId: user?.id }}
                busy={busy}
                onSave={(folderId, permission, expiresAt) =>
                  run(
                    () =>
                      setFolderGrant({
                        folderId,
                        targetType: "user",
                        targetId: user.id,
                        permission,
                        expiresAt,
                      }),
                    t("folderAccess.saved")
                  )
                }
                onRevoke={(folderId) =>
                  run(
                    () =>
                      revokeFolderGrant({
                        folderId,
                        targetType: "user",
                        targetId: user.id,
                      }),
                    t("folderAccess.revoked")
                  )
                }
              />
            ))
          )}
        </Flex>
      </Dialog.Body>
      <Dialog.Footer
        onClickButtonApply={onClose}
        textButtonApply={t("common.actions.close")}
        propsButtonApply={{ disabled: busy, view: "normal" }}
      />
    </Dialog>
  );
};

export default UserFolderAccessDialog;
