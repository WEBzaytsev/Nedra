import { useId } from "react";
import { Box, Flex, Alert, Dialog } from "@gravity-ui/uikit";
import { useTranslation } from "react-i18next";

const ConfirmDialog = ({
  open,
  title,
  onClose,
  onConfirm,
  confirmText,
  confirmColor = "primary",
  error = "",
  pending = false,
  children,
}) => {
  const { t } = useTranslation();
  const titleId = useId();
  const destructive = confirmColor === "error";

  return (
    <Dialog
      aria-labelledby={titleId}

      contentOverflow="auto"
      disableEscapeKeyDown={pending}
      disableOutsideClick={pending}
      fullWidth
      hasCloseButton={false}
      maxWidth="s"
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !pending) onClose();
      }}
      open={open}
    >
      <Dialog.Header caption={title} id={titleId} />
      <Dialog.Body>
        <Box minWidth="0" style={{ overflowWrap: "anywhere" }}>
          {children}
        </Box>
        {error && (
          <Flex direction="column" marginBlockStart="spacing-3" minWidth="0" role="alert">
            <Alert message={error} theme="danger" view="outlined" />
          </Flex>
        )}
      </Dialog.Body>
      <Dialog.Footer
        loading={pending}
        onClickButtonApply={onConfirm}
        onClickButtonCancel={onClose}
        preset={destructive ? "danger" : "default"}
        propsButtonApply={{ disabled: pending, view: destructive ? "outlined-danger" : "action" }}
        propsButtonCancel={{ disabled: pending }}
        textButtonApply={confirmText ?? t("common.actions.confirm")}
        textButtonCancel={t("common.actions.cancel")}
      />
    </Dialog>
  );
};

export default ConfirmDialog;
