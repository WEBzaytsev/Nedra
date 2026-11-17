import { createContext, useContext, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft } from "@gravity-ui/icons";
import { MobileTaskActionsContext } from "../hooks/MobileTaskActionsContext";
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
const TaskSurface = ({
  open,
  children,
  onOpenChange,
  page: inline = false,
  dockActions = true,
  ...props
}) => {
  const { isMediaActive } = useLayoutContext();
  const location = useLocation();
  const actionsTarget = useContext(MobileTaskActionsContext);
  const footerTarget = dockActions && !isMediaActive("s") ? actionsTarget : null;

  const page = inline || !isMediaActive("s");
  const heading = useRef(null);
  const root = useRef(null);
  const previousView = useRef(null);
  const dismiss = () => onOpenChange?.(false);
  const canDismiss = !props.disableEscapeKeyDown;

  useEffect(() => {
    if (!open || !page) return undefined;
    const target = getPageScrollTarget();
    const scroll = location.state?.taskScroll ?? getPageScrollTop();
    const trigger = document.activeElement;
    const section = root.current;
    const controls = () =>
      section?.querySelectorAll("button, input, textarea, select, a[href], [tabindex='0']");
    const saved = previousView.current?.key === location.key ? previousView.current : null;
    const view = { key: location.key, scroll: saved?.scroll ?? 0, focusIndex: saved?.focusIndex };
    const rememberScroll = () => {
      view.scroll = getPageScrollTop();
    };
    const rememberFocus = (event) => {
      view.focusIndex = Array.from(controls() ?? []).indexOf(event.target);
      rememberScroll();
    };
    target.scrollTo(0, view.scroll);
    (controls()?.[view.focusIndex] ?? heading.current)?.focus({ preventScroll: true });
    target.addEventListener("scroll", rememberScroll);
    section?.addEventListener("focusin", rememberFocus);
    return () => {
      // A parent task remains mounted while its child owns the route. Keep its
      // own position/focus separately from the position to restore on dismissal.
      previousView.current = view;
      target.removeEventListener("scroll", rememberScroll);
      section?.removeEventListener("focusin", rememberFocus);
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
    <PageContext.Provider value={{ heading, dismiss, canDismiss, footerTarget }}>
      <Flex
        as="section"
        ref={root}
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
      {page.canDismiss && !page.footerTarget && (
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
    <Box minWidth="0" qa="task-body">
      {children}
    </Box>
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
  onClickButtonBack,
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
  const footer = (
    <Flex
      as="footer"
      direction="column"
      gap="spacing-3"
      minWidth="0"
      paddingInline={page.footerTarget ? "spacing-3" : undefined}
      paddingBlockStart={page.footerTarget ? "spacing-3" : undefined}
      paddingBlockEnd={
        page.footerTarget ? "max(var(--g-spacing-3), env(safe-area-inset-bottom))" : "spacing-6"
      }
      qa="task-actions"
    >
      <Divider />
      {textButtonApply && (
        <Button
          size="xl"
          view="action"
          width="max"
          loading={loading}
          onClick={onClickButtonApply}
          {...propsButtonApply}
          disabled={loading || propsButtonApply?.disabled}
        >
          {textButtonApply}
        </Button>
      )}
      <SecondaryActions
        {...{ page, loading, textButtonCancel, onClickButtonCancel, propsButtonCancel }}
        onBack={page.footerTarget ? onClickButtonBack : undefined}
      />
    </Flex>
  );
  return page.footerTarget ? createPortal(footer, page.footerTarget) : footer;
};

const SecondaryActions = ({
  page,
  loading,
  textButtonCancel,
  onClickButtonCancel,
  propsButtonCancel,
  onBack,
}) => {
  const { t } = useTranslation();
  if (!textButtonCancel && !onBack) return null;
  return (
    <Flex gap="spacing-3" minWidth="0">
      {onBack && (
        <Button
          size="xl"
          view="flat-secondary"
          width="max"
          disabled={loading || !page.canDismiss}
          onClick={onBack}
          qa="task-back"
        >
          <Icon data={ArrowLeft} />
          {t("navigation.back")}
        </Button>
      )}
      {textButtonCancel && (
        <Button
          size="xl"
          view="flat-secondary"
          width="max"
          onClick={onClickButtonCancel}
          {...propsButtonCancel}
          disabled={loading || propsButtonCancel?.disabled}
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
