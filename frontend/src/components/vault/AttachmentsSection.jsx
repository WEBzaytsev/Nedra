import { useCallback, useEffect, useState } from "react";
import { FileArrowDown, Paperclip, TrashBin } from "@gravity-ui/icons";
import { Button, Flex, Icon, Text, Tooltip, useFileInput } from "@gravity-ui/uikit";
import { useStoreActions } from "easy-peasy";
import { useTranslation } from "react-i18next";

import { useNotify } from "../../hooks/useNotify";
import ConfirmDialog from "../ConfirmDialog";

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

const formatBytes = (bytes, language) => {
  const formatter = new Intl.NumberFormat(language, { maximumFractionDigits: 1 });
  if (bytes < 1024) return `${formatter.format(bytes)} B`;
  if (bytes < 1024 * 1024) return `${formatter.format(bytes / 1024)} KB`;
  return `${formatter.format(bytes / (1024 * 1024))} MB`;
};

const AttachmentsSection = ({ passwordName, onChanged, readOnly = false }) => {
  const { t, i18n } = useTranslation();
  const { notify } = useNotify();
  const fetchAttachments = useStoreActions((a) => a.ciphermothModels.passwords.fetchAttachments);
  const uploadAttachment = useStoreActions((a) => a.ciphermothModels.passwords.uploadAttachment);
  const downloadAttachment = useStoreActions(
    (a) => a.ciphermothModels.passwords.downloadAttachment
  );
  const deleteAttachment = useStoreActions((a) => a.ciphermothModels.passwords.deleteAttachment);

  const [attachments, setAttachments] = useState([]);
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const result = await fetchAttachments(passwordName);
      setAttachments(Array.isArray(result) ? result : []);
    } catch (error) {
      notify(error.message, { theme: "danger" });
    }
  }, [fetchAttachments, passwordName, notify]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleFiles = async (files) => {
    setBusy(true);
    try {
      for (const file of files) {
        if (file.size > MAX_ATTACHMENT_BYTES) {
          notify(t("attachments.tooLarge", { filename: file.name }), {
            theme: "warning",
          });
          continue;
        }
        await uploadAttachment({ passwordName, file });
        notify(t("attachments.attached", { filename: file.name }), {
          theme: "success",
        });
        onChanged?.();
      }
      await refresh();
    } catch (error) {
      notify(error.message, { theme: "danger" });
    } finally {
      setBusy(false);
    }
  };

  const { controlProps: fileInputProps, triggerProps: fileTriggerProps } = useFileInput({
    onUpdate: (files) => {
      if (files.length) handleFiles(files);
    },
  });

  const onDownload = async (attachment) => {
    try {
      await downloadAttachment({
        passwordName,
        attachmentId: attachment.id,
        filename: attachment.filename,
      });
    } catch (error) {
      notify(error.message, { theme: "danger" });
    }
  };

  const confirmDelete = async () => {
    const attachment = pendingDelete;
    try {
      await deleteAttachment({ passwordName, attachmentId: attachment.id });
      setPendingDelete(null);
      notify(t("attachments.removed", { filename: attachment.filename }), {
        theme: "success",
      });
      onChanged?.();
      await refresh();
    } catch (error) {
      notify(error.message, { theme: "danger" });
    }
  };

  return (
    <Flex direction="column" gap="spacing-3" minWidth="0">
      {attachments.length === 0 ? (
        <Text as="div" color="secondary" wordBreak="break-word">
          {t("attachments.empty")}
        </Text>
      ) : (
        <Flex direction="column" gap="spacing-2" minWidth="0">
          {attachments.map((attachment) => (
            <Flex
              direction="row"
              gap="spacing-2"
              minWidth="0"
              paddingBlock="spacing-2"
              alignItems="center"
              wrap="wrap"
              justifyContent="space-between"
              key={attachment.id}
            >
              <Icon data={Paperclip} size={16} />
              <Flex direction="column" gap="spacing-1" flexGrow={1} flexBasis="0" minWidth="0">
                <Text wordBreak="break-word">{attachment.filename}</Text>
                <Text variant="caption-2" color="secondary" wordBreak="break-word">
                  {formatBytes(attachment.size_bytes, i18n.resolvedLanguage)}
                </Text>
              </Flex>
              <Tooltip content={t("common.actions.download")}>
                <Button
                  type="button"
                  size="xl"
                  view="flat-secondary"
                  onClick={() => onDownload(attachment)}
                  aria-label={t("common.actions.download")}
                >
                  <Icon data={FileArrowDown} />
                </Button>
              </Tooltip>
              {!readOnly && (
                <Tooltip content={t("attachments.removeFile")}>
                  <Button
                    type="button"
                    size="xl"
                    view="flat-danger"
                    onClick={() => setPendingDelete(attachment)}
                    aria-label={t("attachments.removeFile")}
                  >
                    <Icon data={TrashBin} />
                  </Button>
                </Tooltip>
              )}
            </Flex>
          ))}
        </Flex>
      )}

      {!readOnly && (
        <Flex
          direction={{ xs: "column", m: "row" }}
          gap="spacing-3"
          minWidth="0"
          wrap="wrap"
          alignItems={{ m: "center" }}
        >
          <input {...fileInputProps} multiple />
          <Button {...fileTriggerProps} type="button" size="xl" view="outlined" loading={busy}>
            <Icon data={Paperclip} />
            {t("attachments.attachFile")}
          </Button>
          <Text color="secondary">{t("attachments.limits")}</Text>
        </Flex>
      )}

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title={t("attachments.removeTitle")}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
        confirmText={t("common.actions.remove")}
        confirmColor="error"
      >
        {t("attachments.removeMessage", { filename: pendingDelete?.filename })}
      </ConfirmDialog>
    </Flex>
  );
};

export default AttachmentsSection;
