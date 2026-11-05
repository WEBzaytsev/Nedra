import { createContext, useContext, useEffect, useRef } from "react";
import { ArrowLeft } from "@gravity-ui/icons";
import {
  Box,
  Button,
  Dialog,
  Divider,
  Flex,
  Icon,
  Text,
  useLayoutContext,
} from "@gravity-ui/uikit";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import { getPageScrollTarget, getPageScrollTop } from "../lib/pageScroll";

const PageContext = createContext(null);

// Reuse task bodies and handlers. Only routed phone tasks use document flow;
// short contextual menus and destructive confirmations still use UIKit Dialog.
const TaskSurface = ({ open, children, onOpenChange, page: inline = false, ...props }) => {
  const { isMediaActive } = useLayoutContext();
  const location = useLocation();

  const page = inline || !isMediaActive("s");
  const heading = useRef(null);
  const dismiss = () => onOpenChange?.(false);
  const canDismiss = !props.disableEscapeKeyDown;

  useEffect(() => {
    if (!open || !page) return undefined;
    const target = getPageScrollTarget();
    const scroll = location.state?.taskScroll ?? getPageScrollTop();
    const trigger = document.activeElement;
    target.scrollTo(0, 0);
    heading.current?.focus({ preventScroll: true });
    return () => {
      target.scrollTo(0, scroll);
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [open, page, location.key, location.state?.taskScroll]);

  if (!page)
    return (
      <Dialog open={open} onOpenChange={onOpenChange} {...props}>
        {children}
      </Dialog>
    );
  if (!open) return null;
  return (
    <PageContext.Provider value={{ heading, dismiss, canDismiss }}>
      <Flex
        as="section"
        direction="column"
        gap="spacing-5"
        minWidth="0"
        aria-label={props["aria-label"]}
        aria-labelledby={props["aria-labelledby"]}
        qa="task-page"
      >
        {children}
      </Flex>
    </PageContext.Provider>
  );
};

const Header = ({ caption, id, insertAfter }) => {
  const page = useContext(PageContext);
  const { t } = useTranslation();
  if (!page) return <Dialog.Header caption={caption} id={id} insertAfter={insertAfter} />;
  return (
    <Flex as="header" direction="column" gap="spacing-3" minWidth="0">
      {page.canDismiss && (
        <Flex>
          <Button size="xl" view="flat-secondary" onClick={page.dismiss} qa="task-back">
            <Icon data={ArrowLeft} />
            {t("navigation.back")}
          </Button>
        </Flex>
      )}
      <Flex alignItems="flex-start" justifyContent="space-between" gap="spacing-3" minWidth="0">
        <Box minWidth="0" flexGrow={1}>
          <Box as="h1" margin="0" id={id} ref={page.heading} tabIndex={-1}>
            <Text variant="header-1" wordBreak="break-word">
              {caption}
            </Text>
          </Box>
        </Box>
        {insertAfter}
      </Flex>
    </Flex>
  );
};

const Body = ({ children, ...props }) => {
  const page = useContext(PageContext);
  return page ? (
    <Box minWidth="0">{children}</Box>
  ) : (
    <Dialog.Body {...props}>{children}</Dialog.Body>
  );
};

const Footer = ({
  loading,
  onClickButtonApply,
  onClickButtonCancel,
  textButtonApply,
  textButtonCancel,
  propsButtonApply,
  propsButtonCancel,
  ...props
}) => {
  const page = useContext(PageContext);
  if (!page)
    return (
      <Dialog.Footer
        {...{
          loading,
          onClickButtonApply,
          onClickButtonCancel,
          textButtonApply,
          textButtonCancel,
          propsButtonApply,
          propsButtonCancel,
          ...props,
        }}
      />
    );
  return (
    <Flex
      as="footer"
      direction="column"
      gap="spacing-3"
      minWidth="0"
      paddingBlockEnd="spacing-6"
      qa="task-actions"
    >
      <Divider />
      {textButtonApply && (
        <Button
          size="xl"
          view="action"
          width="max"
          loading={loading}
          disabled={loading}
          onClick={onClickButtonApply}
          {...propsButtonApply}
        >
          {textButtonApply}
        </Button>
      )}
      {textButtonCancel && (
        <Button
          size="xl"
          view="flat-secondary"
          width="max"
          disabled={loading}
          onClick={onClickButtonCancel}
          {...propsButtonCancel}
        >
          {textButtonCancel}
        </Button>
      )}
    </Flex>
  );
};

TaskSurface.Header = Header;
TaskSurface.Body = Body;
TaskSurface.Footer = Footer;
export default TaskSurface;
