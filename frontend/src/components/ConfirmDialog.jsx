import { ConfirmDialog as GravityConfirmDialog } from "@gravity-ui/components";
import { Alert, Box, Flex } from "@gravity-ui/uikit";
import { useEffect, useRef } from "react";
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
  const destructive = confirmColor === "error";
  const cancelRef = useRef(null);
  const returnFocusRef = useRef(null);
  const wasOpenRef = useRef(false);

  if (open && !wasOpenRef.current) returnFocusRef.current = document.activeElement;
  wasOpenRef.current = open;

  useEffect(() => {
    if (!open) return undefined;
    const frame = window.requestAnimationFrame(() => cancelRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  return (
    <GravityConfirmDialog
      open={open}
      title={title}
      aria-label={title}
      message={
        <Box minWidth="0" style={{ overflowWrap: "anywhere" }}>
          {children}
          {error && (
            <Flex direction="column" marginBlockStart="spacing-3" minWidth="0" role="alert">
              <Alert message={error} theme="danger" view="outlined" />
            </Flex>
          )}
        </Box>
      }
      initialFocus="cancel"
      returnFocus={returnFocusRef}
      contentOverflow="auto"
      disableEscapeKeyDown={pending}
      disableOutsideClick={pending}
      fullWidth
      hasCloseButton={false}
      maxWidth="s"
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !pending) onClose();
      }}
      onClickButtonApply={onConfirm}
      onClickButtonCancel={onClose}
      propsButtonApply={{
        disabled: pending,
        loading: pending,
        view: destructive ? "outlined-danger" : "action",
      }}
      propsButtonCancel={{ disabled: pending, ref: cancelRef }}
      textButtonApply={confirmText ?? t("common.actions.confirm")}
      textButtonCancel={t("common.actions.cancel")}
    />
  );
};

export default ConfirmDialog;
