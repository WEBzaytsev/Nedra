import { useCallback, useEffect, useState } from "react";
import { Flex, Text, Alert, Button, Col, Dialog, Row, Select } from "@gravity-ui/uikit";
import { useStoreActions } from "easy-peasy";
import { useTranslation } from "react-i18next";

import { isInvalidExpiry, toUtcExpiry } from "../../lib/accessExpiry";
import ExpiryField from "../access/ExpiryField";

const ShareDialog = ({ entry, open, onClose }) => {
  const { t } = useTranslation();
  const { listShares, setShare, revokeShare } = useStoreActions(
    (actions) => actions.ciphermothModels.passwords
  );
  const shareTargets = useStoreActions((actions) => actions.ciphermothModels.users.shareTargets);
  const [shares, setShares] = useState([]);
  const [targets, setTargets] = useState([]);
  const [targetId, setTargetId] = useState("");
  const [permission, setPermission] = useState("read");
  const [expiresAt, setExpiresAt] = useState("");
  const [expiryRejected, setExpiryRejected] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const expiryInvalid = expiryRejected || isInvalidExpiry(expiresAt);

  const load = useCallback(async () => {
    if (!entry) return;
    const [nextShares, nextTargets] = await Promise.all([listShares(entry.id), shareTargets()]);
    setShares(nextShares);
    setTargets(nextTargets);
  }, [entry, listShares, shareTargets]);

  useEffect(() => {
    if (!open) return;
    setTargetId("");
    setPermission("read");
    setExpiresAt("");
    setExpiryRejected(false);
    setError("");
    load().catch((requestError) => setError(requestError.message));
  }, [open, load]);

  const run = async (operation) => {
    setBusy(true);
    setError("");
    try {
      await operation();
      await load();
      return true;
    } catch (requestError) {
      setError(requestError.message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (!targetId) return;
    if (isInvalidExpiry(expiresAt)) {
      setExpiryRejected(true);
      return;
    }
    if (
      await run(() =>
        setShare({
          entryId: entry.id,
          userId: Number(targetId),
          permission,
          expiresAt: toUtcExpiry(expiresAt),
        })
      )
    ) {
      setTargetId("");
      setExpiresAt("");
      setExpiryRejected(false);
    }
  };

  const available = targets.filter(
    (target) => !shares.some((share) => share.user_id === target.id)
  );
  const permissionOptions = [
    { value: "read", content: t("sharing.read") },
    { value: "write", content: t("sharing.readWrite") },
  ];

  return (
    <Dialog
      aria-label={t("sharing.manage")}

      contentOverflow="auto"
      fullWidth
      hasCloseButton={!busy}
      maxWidth="m"
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !busy) onClose();
      }}
    >
      <Dialog.Header caption={t("sharing.manage")} />
      <Dialog.Body>
        <Flex direction="column" gap="spacing-5" minWidth="0">
          <Text as="div" color="secondary" wordBreak="break-word">
            {entry?.password_name}
          </Text>
          {error && <Alert theme="danger" view="outlined" message={error} />}

          <Row gap="spacing-6">
            <Col size={{ xs: 12, m: 6 }} minWidth="0">
              <Flex direction="column" gap="spacing-3" minWidth="0" as="section">
                <Text as="div" role="heading" aria-level={3} variant="subheader-2">
                  {t("sharing.currentAccess")}
                </Text>
                {shares.length === 0 ? (
                  <Text as="div" color="secondary" wordBreak="break-word">
                    {t("sharing.ownerOnly")}
                  </Text>
                ) : (
                  <Flex direction="column" gap="spacing-2" minWidth="0">
                    {shares.map((share) => (
                      <Flex
                        direction="column"
                        gap="spacing-3"
                        minWidth="0"
                        paddingBlock="spacing-2"
                        justifyContent="space-between"
                        key={share.user_id}
                      >
                        <Flex direction="column" gap="spacing-1" minWidth="0">
                          <Text as="strong">{share.username}</Text>
                          <Text as="small" variant="caption-2" color="secondary">
                            {t(`users.roles.${share.role}`)}
                          </Text>
                        </Flex>
                        <Text>{t("sharing.permission")}</Text>
                        <Select
                          size="xl"
                          width="max"
                          aria-label={t("sharing.permission")}
                          value={[share.permission]}
                          disabled={busy}
                          options={permissionOptions}
                          onUpdate={([nextPermission = "read"]) =>
                            run(() =>
                              setShare({
                                entryId: entry.id,
                                userId: share.user_id,
                                permission: nextPermission,
                                expiresAt: share.expires_at ?? null,
                              })
                            )
                          }
                        />
                        <Flex>
                          <Button
                            type="button"
                            size="xl"
                            view="flat-danger"
                            disabled={busy}
                            onClick={() =>
                              run(() => revokeShare({ entryId: entry.id, userId: share.user_id }))
                            }
                          >
                            {t("sharing.revoke")}
                          </Button>
                        </Flex>
                      </Flex>
                    ))}
                  </Flex>
                )}
              </Flex>
            </Col>
            <Col size={{ xs: 12, m: 6 }} minWidth="0">
              <Flex direction="column" gap="spacing-3" minWidth="0" as="section">
                <Text as="div" role="heading" aria-level={3} variant="subheader-2">
                  {t("sharing.grantAccess")}
                </Text>
                <Flex direction="column" gap="spacing-3" minWidth="0">
                  <Text>{t("sharing.user")}</Text>
                  <Select
                    size="xl"
                    width="max"

                    aria-label={t("sharing.user")}
                    placeholder={t("sharing.selectTarget")}
                    value={targetId ? [targetId] : []}
                    disabled={busy || available.length === 0}
                    options={available.map((target) => ({
                      value: String(target.id),
                      content: `${target.username} · ${t(`users.roles.${target.role}`)}`,
                    }))}
                    onUpdate={([value = ""]) => setTargetId(value)}
                  />
                  <Text>{t("sharing.permission")}</Text>
                  <Select
                    size="xl"
                    width="max"
                    aria-label={t("sharing.permission")}
                    value={[permission]}
                    disabled={busy}
                    options={permissionOptions}
                    onUpdate={([value = "read"]) => setPermission(value)}
                  />
                  <ExpiryField
                    value={expiresAt}
                    disabled={busy}
                    onUpdate={(value) => {
                      setExpiresAt(value);
                      setExpiryRejected(false);
                    }}
                    invalid={expiryInvalid}
                  />
                  <Flex>
                    <Button
                      type="button"
                      size="xl"
                      view="action"
                      disabled={busy || !targetId || expiryInvalid}
                      loading={busy}
                      onClick={add}
                    >
                      {t("sharing.grant")}
                    </Button>
                  </Flex>
                </Flex>
              </Flex>
            </Col>
          </Row>
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

export default ShareDialog;
