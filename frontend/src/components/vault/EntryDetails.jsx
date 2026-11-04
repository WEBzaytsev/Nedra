import { useState } from "react";
import {
  ArrowUpRightFromSquare,
  Copy,
  Eye,
  EyeSlash,
  Pencil,
  PersonPlus,
  Star,
  StarFill,
  TrashBin,
} from "@gravity-ui/icons";
import {
  Button,
  DefinitionList,
  Disclosure,
  Divider,
  Flex,
  Icon,
  Text,
  Tooltip,
} from "@gravity-ui/uikit";
import { useTranslation } from "react-i18next";
import AttachmentsSection from "./AttachmentsSection";
import StrengthBar from "./StrengthBar";
import TotpCell from "./TotpCell";
import { IS_DESKTOP, openExternal } from "../../platform";

const IconAction = ({ label, icon, onClick, selected = false }) => (
  <Tooltip content={label} role="label">
    <Button
      type="button"
      view="flat-secondary"
      size="xl"
      aria-label={label}
      onClick={onClick}
      selected={selected}
    >
      <Icon data={icon} />
    </Button>
  </Tooltip>
);

const EntryValue = ({
  label,
  value,
  hidden = false,
  mono = false,
  onCopy,
  copyLabel,
  revealLabel,
  hideLabel,
  children,
}) => {
  const { t } = useTranslation();
  const [revealed, setRevealed] = useState(false);
  const visibilityLabel = revealed
    ? hideLabel || `${t("passwordField.hide")}: ${label}`
    : revealLabel || `${t("passwordField.show")}: ${label}`;
  return (
    <Flex direction="column" gap="spacing-2" minWidth="0">
      <DefinitionList direction="vertical" responsive>
        <DefinitionList.Item name={label}>
          <Flex gap="spacing-2" alignItems="flex-start" minWidth="0" justifyContent="space-between">
            <Flex flexGrow={1} flexBasis="0" minWidth="0" paddingBlock="spacing-2">
              <Text
                variant={mono ? "code-1" : "body-1"}
                wordBreak="break-all"
                whiteSpace="break-spaces"
              >
                {hidden && !revealed ? "••••••••••••" : value}
              </Text>
            </Flex>
            <Flex gap="spacing-1" flexShrink={0}>
              {hidden && (
                <IconAction
                  label={visibilityLabel}
                  icon={revealed ? EyeSlash : Eye}
                  selected={revealed}
                  onClick={() => setRevealed((current) => !current)}
                />
              )}
              <IconAction
                label={copyLabel || t("vault.browser.copyValue", { label })}
                icon={Copy}
                onClick={() => onCopy(value)}
              />
            </Flex>
          </Flex>
        </DefinitionList.Item>
      </DefinitionList>
      {children}
    </Flex>
  );
};

const EntryDetails = ({
  entry,
  onCopy,
  onEdit,
  onDelete,
  onShare,
  onToggleFavorite,
  showTitle = false,
}) => {
  const { t, i18n } = useTranslation();
  const isNote = entry.kind === "note";
  const writable = entry.access === "owner" || entry.access === "write";
  const history = entry.password_history ?? [];
  const openWebsite = () => {
    const url = /^https?:\/\//i.test(entry.url) ? entry.url : `https://${entry.url}`;
    if (IS_DESKTOP) openExternal(url).catch(() => {});
    else window.open(url, "_blank", "noopener,noreferrer");
  };
  return (
    <Flex direction="column" gap="spacing-5" minWidth="0">
      <Flex direction="column" gap="spacing-3" minWidth="0" as="header" qa="entry-details-header">
        {showTitle && (
          <Text as="div" role="heading" aria-level={2} variant="header-1" wordBreak="break-word">
            {entry.password_name}
          </Text>
        )}
        <Flex gap="spacing-2" wrap="wrap" alignItems="center">
          <Text color="secondary">{t(isNote ? "entry.kind.note" : "entry.kind.login")}</Text>
          {entry.folder && <Text wordBreak="break-word">{entry.folder}</Text>}
          {entry.access !== "owner" && (
            <Text color="secondary" wordBreak="break-word">
              {t(entry.access === "read" ? "sharing.readOnlyAccess" : "sharing.readWrite")}
            </Text>
          )}
        </Flex>
        <Flex gap="spacing-2" wrap="wrap" alignItems="center">
          {writable && (
            <>
              <IconAction
                label={t(
                  entry.favorite ? "vault.columns.removeFavorite" : "vault.columns.markFavorite"
                )}
                icon={entry.favorite ? StarFill : Star}
                selected={entry.favorite}
                onClick={() => onToggleFavorite(entry)}
              />
              <Button size="xl" view="outlined" onClick={() => onEdit(entry)}>
                <Icon data={Pencil} />
                {t("common.actions.edit")}
              </Button>
            </>
          )}
          {entry.access === "owner" && (
            <Button size="xl" view="outlined" onClick={() => onShare(entry)}>
              <Icon data={PersonPlus} />
              {t("sharing.manage")}
            </Button>
          )}
        </Flex>
      </Flex>
      <Divider />
      {!isNote && entry.username && (
        <EntryValue
          label={t("common.fields.usernameEmail")}
          value={entry.username}
          copyLabel={t("vault.columns.copyUsername")}
          onCopy={onCopy}
        />
      )}
      <EntryValue
        label={t(isNote ? "entry.labels.note" : "common.fields.password")}
        value={entry.password_value}
        hidden
        mono={!isNote}
        revealLabel={!isNote ? t("vault.columns.revealPassword") : undefined}
        hideLabel={!isNote ? t("vault.columns.hidePassword") : undefined}
        copyLabel={t(isNote ? "vault.browser.copyNote" : "vault.columns.copyPassword")}
        onCopy={onCopy}
      >
        {!isNote && <StrengthBar password={entry.password_value} />}
      </EntryValue>
      {!isNote && entry.totp_secret && (
        <DefinitionList direction="vertical">
          <DefinitionList.Item name={t("entry.labels.twoFactor")}>
            <TotpCell secret={entry.totp_secret} onCopy={onCopy} />
          </DefinitionList.Item>
        </DefinitionList>
      )}
      {entry.url && (
        <DefinitionList direction="vertical">
          <DefinitionList.Item name={t("entry.labels.websiteOptional")}>
            <Flex gap="spacing-2" alignItems="center" minWidth="0">
              <Text variant="code-1" wordBreak="break-all" style={{ minWidth: 0, flex: 1 }}>
                {entry.url}
              </Text>
              <IconAction
                label={t("vault.columns.openWebsite")}
                icon={ArrowUpRightFromSquare}
                onClick={openWebsite}
              />
            </Flex>
          </DefinitionList.Item>
        </DefinitionList>
      )}
      {entry.custom_fields?.map((field, index) => (
        <EntryValue
          key={`${field.label}-${index}`}
          label={field.label}
          value={field.value}
          hidden={field.hidden}
          mono
          onCopy={onCopy}
        />
      ))}
      {entry.description && (
        <DefinitionList direction="vertical">
          <DefinitionList.Item name={t("entry.labels.notes")}>
            <Text whiteSpace="break-spaces" wordBreak="break-word">
              {entry.description}
            </Text>
          </DefinitionList.Item>
        </DefinitionList>
      )}
      {entry.tags?.length > 0 && (
        <Flex gap="spacing-2" wrap="wrap">
          {entry.tags.map((tag) => (
            <Text key={tag} color="secondary" wordBreak="break-all">
              {tag}
            </Text>
          ))}
        </Flex>
      )}
      {entry.attachment_count > 0 && (
        <Disclosure summary={`${t("entry.labels.attachments")} (${entry.attachment_count})`}>
          <AttachmentsSection passwordName={entry.password_name} readOnly />
        </Disclosure>
      )}
      {!isNote && history.length > 0 && (
        <Disclosure summary={`${t("entry.labels.passwordHistory")} (${history.length})`}>
          <Flex direction="column" gap="spacing-4">
            {history.map((item, index) => (
              <EntryValue
                key={`${item.changed_at}-${index}`}
                label={new Date(item.changed_at).toLocaleString(i18n.resolvedLanguage)}
                value={item.value}
                hidden
                mono
                onCopy={onCopy}
              />
            ))}
          </Flex>
        </Disclosure>
      )}
      {writable && (
        <Flex paddingBlockStart="spacing-3">
          <Button size="xl" view="flat-danger" onClick={() => onDelete(entry.password_name)}>
            <Icon data={TrashBin} />
            {t("common.actions.delete")}
          </Button>
        </Flex>
      )}
    </Flex>
  );
};
export default EntryDetails;
