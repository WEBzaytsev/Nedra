import { useState } from "react";
import { ArrowRotateLeft, Copy, Eye, EyeSlash } from "@gravity-ui/icons";
import { Button, Dialog, Flex, Icon, Text, Tooltip } from "@gravity-ui/uikit";
import { useTranslation } from "react-i18next";
import ConfirmDialog from "../ConfirmDialog";
import { HISTORY_LIMIT, historyDuration, historyTimeline } from "../../lib/passwordHistory";

const formatWhen = (date, language) =>
  date
    ? new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(date)
    : null;

const HistoryRow = ({ row, language, writable, onCopy, onUseAgain }) => {
  const { t } = useTranslation();
  const [revealed, setRevealed] = useState(false);
  const until = row.current ? new Date() : row.until;
  const duration = historyDuration(row.since, until);
  const changed = formatWhen(row.current ? row.since : row.until, language);
  const durationText = duration?.lessThanDay
    ? t("entry.history.lessThanDay")
    : duration
      ? t(`entry.history.duration.${duration.unit}`, { count: duration.count })
      : null;
  const canReuse = writable && !row.current && !row.sameAsCurrent;
  return (
    <Flex as="div" role="listitem" direction="column" gap="spacing-2" minWidth="0">
      <Flex gap="spacing-2" alignItems="center" minWidth="0">
        <Flex minWidth="0" flexGrow={1}>
          <Text as="code" variant="code-1" whiteSpace="break-spaces" wordBreak="break-all">
            {revealed ? row.value : "••••••••••••"}
          </Text>
        </Flex>
        <Flex gap="spacing-1" flexShrink={0}>
          <Tooltip content={t(revealed ? "passwordField.hide" : "passwordField.show")}>
            <Button
              type="button"
              size="xl"
              view="flat-secondary"
              aria-label={t(revealed ? "passwordField.hide" : "passwordField.show")}
              selected={revealed}
              onClick={() => setRevealed((value) => !value)}
            >
              <Icon data={revealed ? EyeSlash : Eye} />
            </Button>
          </Tooltip>
          <Tooltip content={t("vault.columns.copyPassword")}>
            <Button
              type="button"
              size="xl"
              view="flat-secondary"
              aria-label={t("vault.columns.copyPassword")}
              onClick={() => onCopy(row.value)}
            >
              <Icon data={Copy} />
            </Button>
          </Tooltip>
          {canReuse && (
            <Tooltip content={t("entry.history.useAgain")}>
              <Button
                type="button"
                size="xl"
                view="flat-secondary"
                aria-label={t("entry.history.useAgain")}
                onClick={() => onUseAgain(row)}
              >
                <Icon data={ArrowRotateLeft} />
              </Button>
            </Tooltip>
          )}
        </Flex>
      </Flex>
      <Flex direction="column" gap="spacing-1" minWidth="0">
        <Text variant="caption-2" color="secondary">
          {row.current
            ? changed
              ? t("entry.history.currentSince", { when: changed })
              : t("entry.history.current")
            : changed
              ? t("entry.history.replaced", { when: changed })
              : t("entry.history.previous")}
        </Text>
        {durationText && (
          <Text variant="caption-2" color="secondary">
            {t("entry.history.usedFor", { duration: durationText })}
          </Text>
        )}
        {row.sameAsCurrent && (
          <Text variant="caption-2" color="secondary">
            {t("entry.history.matchesCurrent")}
          </Text>
        )}
      </Flex>
    </Flex>
  );
};

const PasswordHistoryDialog = ({ entry, onClose, onCopy, onReuse }) => {
  const { t, i18n } = useTranslation();
  const [candidate, setCandidate] = useState(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const open = Boolean(entry);
  const history = entry?.password_history ?? [];
  const writable = entry?.access === "owner" || entry?.access === "write";
  const close = () => {
    if (pending) return;
    setCandidate(null);
    setError("");
    onClose();
  };
  const confirmReuse = async () => {
    if (!candidate) return;
    setPending(true);
    setError("");
    try {
      await onReuse(entry, candidate);
      onClose();
      setCandidate(null);
    } catch (requestError) {
      setError(requestError.message || t("errors.updatePassword"));
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <Dialog
        open={open}
        aria-label={t("entry.history.title")}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) close();
        }}
        fullWidth
        maxWidth="m"
        contentOverflow="auto"
      >
        <Dialog.Header caption={t("entry.history.title")} />
        <Dialog.Body>
          {entry && (
            <Flex direction="column" gap="spacing-4" minWidth="0">
              <Text variant="subheader-2" wordBreak="break-word">
                {entry.password_name}
              </Text>
              <Flex as="div" role="list" direction="column" gap="spacing-4">
                {historyTimeline(entry).map((row) => (
                  <HistoryRow
                    key={row.key}
                    row={row}
                    language={i18n.resolvedLanguage}
                    writable={writable}
                    onCopy={onCopy}
                    onUseAgain={setCandidate}
                  />
                ))}
              </Flex>
              <Text variant="caption-2" color="secondary" wordBreak="break-word">
                {t("entry.history.retention", { count: HISTORY_LIMIT })}
              </Text>
            </Flex>
          )}
        </Dialog.Body>
        <Dialog.Footer onClickButtonCancel={close} textButtonCancel={t("common.actions.close")} />
      </Dialog>
      <ConfirmDialog
        open={open && Boolean(candidate)}
        title={t("entry.history.confirmTitle")}
        confirmText={t("entry.history.useAgain")}
        onClose={() => {
          if (!pending) {
            setCandidate(null);
            setError("");
          }
        }}
        onConfirm={confirmReuse}
        pending={pending}
        error={error}
      >
        {t("entry.history.confirmMessage", { name: entry?.password_name })}
        {history.length >= HISTORY_LIMIT && (
          <Text as="p" marginBlock="spacing-3 0">
            {t("entry.history.evictWarning", { count: HISTORY_LIMIT })}
          </Text>
        )}
      </ConfirmDialog>
    </>
  );
};

export default PasswordHistoryDialog;
