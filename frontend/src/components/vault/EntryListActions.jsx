import {
  ArrowUpRightFromSquare,
  Copy,
  EllipsisVertical,
  Eye,
  EyeSlash,
  Pencil,
  Person,
  PersonPlus,
  Star,
  StarFill,
  TrashBin,
} from "@gravity-ui/icons";
import { Flex, Button, Icon, Menu, MenuDivider, MenuItem, Tooltip } from "@gravity-ui/uikit";
import { useTranslation } from "react-i18next";

import TotpCell from "./TotpCell";
import { IS_DESKTOP, openExternal } from "../../platform";

const QuickAction = ({ label, icon, onClick, selected = false }) => (
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

const EntryListActions = ({
  entry,
  onCopy,
  onEdit,
  onDelete,
  onShare,
  onToggleFavorite,
  onMenuOpenChange,
  revealed,
  onRevealChange,
}) => {
  const { t } = useTranslation();
  const isNote = entry.kind === "note";
  const writable = entry.access === "owner" || entry.access === "write";
  const valueLabel = t(isNote ? "entry.labels.note" : "common.fields.password");
  const revealLabel = isNote
    ? `${t(revealed ? "passwordField.hide" : "passwordField.show")}: ${valueLabel}`
    : t(revealed ? "vault.columns.hidePassword" : "vault.columns.revealPassword");
  const copyLabel = t(isNote ? "vault.browser.copyNote" : "vault.columns.copyPassword");

  const openWebsite = () => {
    const url = /^https?:\/\//i.test(entry.url) ? entry.url : `https://${entry.url}`;
    if (IS_DESKTOP) openExternal(url).catch(() => {});
    else window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <Flex
      direction={{ xs: "column", m: "row" }}
      gap="spacing-3"
      minWidth="0"
      wrap="wrap"
      alignItems={{ m: "center" }}
    >
      {!isNote && entry.username && (
        <QuickAction
          label={t("vault.columns.copyUsername")}
          icon={Person}
          onClick={() => onCopy(entry.username)}
        />
      )}
      <QuickAction
        label={revealLabel}
        icon={revealed ? EyeSlash : Eye}
        selected={revealed}
        onClick={() => onRevealChange(!revealed)}
      />
      <QuickAction label={copyLabel} icon={Copy} onClick={() => onCopy(entry.password_value)} />
      {!isNote && entry.totp_secret && <TotpCell secret={entry.totp_secret} onCopy={onCopy} />}
      <Menu
        placement="bottom-end"
        onOpenChange={onMenuOpenChange}
        trigger={
          <Button
            type="button"
            view="flat-secondary"
            size="xl"
            aria-label={`${t("navigation.more")}: ${entry.password_name}`}
          >
            <Icon data={EllipsisVertical} />
          </Button>
        }
      >
        {entry.url && (
          <MenuItem icon={<Icon data={ArrowUpRightFromSquare} />} onClick={openWebsite}>
            {t("vault.columns.openWebsite")}
          </MenuItem>
        )}
        {writable && (
          <MenuItem
            icon={<Icon data={entry.favorite ? StarFill : Star} />}
            onClick={() => onToggleFavorite(entry)}
          >
            {t(entry.favorite ? "vault.columns.removeFavorite" : "vault.columns.markFavorite")}
          </MenuItem>
        )}
        {writable && (
          <MenuItem icon={<Icon data={Pencil} />} onClick={() => onEdit(entry)}>
            {t("common.actions.edit")}
          </MenuItem>
        )}
        {entry.access === "owner" && (
          <MenuItem icon={<Icon data={PersonPlus} />} onClick={() => onShare(entry)}>
            {t("sharing.manage")}
          </MenuItem>
        )}
        {writable && <MenuDivider />}
        {writable && (
          <MenuItem
            theme="danger"
            icon={<Icon data={TrashBin} />}
            onClick={() => onDelete(entry.password_name)}
          >
            {t("common.actions.delete")}
          </MenuItem>
        )}
      </Menu>
    </Flex>
  );
};

export default EntryListActions;
