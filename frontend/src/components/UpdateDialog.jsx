import { ArrowRight } from "@gravity-ui/icons";
import { Flex, Icon, Link, Text } from "@gravity-ui/uikit";
import Dialog from "./TaskSurface";
import { useStoreState } from "easy-peasy";
import { useTranslation } from "react-i18next";

import { MANUAL_UPDATE_COMMAND } from "../lib/updateCommands";
import { IS_DESKTOP } from "../platform";
import DesktopUpdateDialog from "./DesktopUpdateDialog";

const stripV = (value) => String(value ?? "").replace(/^v/, "");

const UpdateDialog = ({ open, onClose }) => {
  const { t } = useTranslation();
  const { current, latest, releaseUrl } = useStoreState((state) => state.ciphermothModels.updates);

  return (
    <Dialog
      aria-label={t("updateDialog.title")}

      contentOverflow="auto"
      fullWidth
      maxWidth="s"
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <Dialog.Header caption={t("updateDialog.title")} />
      <Dialog.Body>
        <Flex direction="column" gap="spacing-3" minWidth="0">
          <Flex
            direction="row"
            gap="spacing-3"
            alignItems="center"
            minWidth="0"
            aria-label={t("updateDialog.title")}
          >
            <Text color="secondary">{current ? `v${stripV(current)}` : "—"}</Text>
            <Icon data={ArrowRight} size={16} />
            <Text>{latest ?? "-"}</Text>
          </Flex>

          {releaseUrl && (
            <Link href={releaseUrl} target="_blank" rel="noopener noreferrer">
              {t("updateDialog.releaseNotes")}
            </Link>
          )}

          <Flex direction="column" gap="spacing-3" minWidth="0">
            <Text as="div" color="secondary" wordBreak="break-word">
              {t("updateDialog.manualBackupDescription")}
            </Text>
            <Text as="div" variant="code-1" whiteSpace="break-spaces" wordBreak="break-all">
              {MANUAL_UPDATE_COMMAND}
            </Text>
          </Flex>
        </Flex>
      </Dialog.Body>
      <Dialog.Footer
        onClickButtonApply={onClose}
        textButtonApply={t("common.actions.close")}
        propsButtonApply={{ view: "normal" }}
      />
    </Dialog>
  );
};

export default IS_DESKTOP ? DesktopUpdateDialog : UpdateDialog;
