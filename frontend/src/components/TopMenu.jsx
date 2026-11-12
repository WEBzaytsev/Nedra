import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  ArrowRightFromSquare,
  ArrowRotateRight,
  ArrowDownToLine,
  ArrowUpFromLine,
  Bars,
  ChevronDown,
  FolderOpen,
  Gear,
  Globe,
  HeartPulse,
  Key,
  Lock,
  Moon,
  Persons,
  Sun,
  TrashBin,
  Xmark,
} from "@gravity-ui/icons";
import {
  Avatar,
  Box,
  Button,
  Divider,
  Drawer,
  Flex,
  Icon,
  List,
  Menu,
  MenuItem,
  Text,
  useLayoutContext,
} from "@gravity-ui/uikit";
import { useStoreActions, useStoreState } from "easy-peasy";
import { useTranslation } from "react-i18next";

import { endSession } from "../api/session";
import { useColorMode } from "../hooks/useColorMode";
import useMenuAction from "../hooks/useMenuAction";
import { IS_DESKTOP } from "../platform";
import { getCurrentUser } from "../utils";

import BrandMark from "./BrandMark";
import PasswordChangeDialog from "./PasswordChangeDialog";
import RecoveryCodeDialog from "./RecoveryCodeDialog";
import SecurityKeyDialog from "./SecurityKeyDialog";
import SettingsModal from "./SettingsModal";
import UpdateDialog from "./UpdateDialog";

const Brand = ({ version, onClick }) => {
  const { i18n } = useTranslation();
  const name = i18n.resolvedLanguage?.startsWith("ru") ? "Недра" : "Nedra";
  return (
    <Button component={Link} to="/passwords" onClick={onClick} view="flat" size="xl">
      <Button.Icon>
        {({ size }) => <BrandMark width={size} height={size} data-qa="brand-mark" />}
      </Button.Icon>
      <Text variant="subheader-2" qa="brand-title">
        {name}
      </Text>
      {version && (
        <Box as="span" marginInlineStart="spacing-2">
          <Text color="secondary" variant="caption-2">
            v{String(version).replace(/^v/, "")}
          </Text>
        </Box>
      )}
    </Button>
  );
};

const TopMenu = () => {
  const { t, i18n } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const { mode, setMode } = useColorMode();

  const { isMediaActive } = useLayoutContext();
  const desktop = isMediaActive("l");
  const phone = !isMediaActive("s");
  const currentUser = getCurrentUser();
  const admin = currentUser?.role === "admin";
  const language = (i18n.resolvedLanguage ?? i18n.language)?.startsWith("ru") ? "ru" : "en";
  const languageLabel = t(language === "ru" ? "language.russian" : "language.english");
  const themeLabel = t(`theme.${mode}`);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [securityKeyOpen, setSecurityKeyOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const mobileMenuButton = useRef(null);
  const utilityReturnTarget = useRef(null);

  const updateCheckEnabled = useStoreState(
    (state) => state.ciphermothModels.settings.settings.update_check_enabled
  );
  const settingsLoaded = useStoreState((state) => state.ciphermothModels.settings.loaded);
  const updateAvailable = useStoreState((state) => state.ciphermothModels.updates.updateAvailable);
  const version = useStoreState((state) => state.ciphermothModels.updates.current);
  const checkForUpdates = useStoreActions(
    (actions) => actions.ciphermothModels.updates.checkForUpdates
  );
  const fetchVersion = useStoreActions((actions) => actions.ciphermothModels.updates.fetchVersion);

  useEffect(() => {
    fetchVersion();
  }, [fetchVersion]);

  useEffect(() => {
    if (settingsLoaded && updateCheckEnabled) checkForUpdates();
  }, [settingsLoaded, updateCheckEnabled, checkForUpdates]);

  const closeMobileNav = () => setMobileNavOpen(false);
  const rememberUtilityTrigger = (event) => {
    utilityReturnTarget.current = mobileNavOpen ? mobileMenuButton.current : event?.currentTarget;
  };
  const closeUtility = (setter) => {
    setter(false);
    window.requestAnimationFrame(() => utilityReturnTarget.current?.focus());
  };
  const openSettings = (event) => {
    if (!admin) return;
    rememberUtilityTrigger(event);
    closeMobileNav();
    if (phone) {
      navigate("/settings", { state: { taskReturn: location.pathname + location.search } });
      return;
    }
    setSettingsOpen(true);
  };
  const openPassword = (event) => {
    rememberUtilityTrigger(event);
    closeMobileNav();
    if (phone) {
      navigate("/account/password", { state: { taskReturn: location.pathname + location.search } });
      return;
    }
    setPasswordOpen(true);
  };
  const openRecovery = (event) => {
    rememberUtilityTrigger(event);
    closeMobileNav();
    setRecoveryOpen(true);
  };
  const openSecurityKey = (event) => {
    rememberUtilityTrigger(event);
    closeMobileNav();
    setSecurityKeyOpen(true);
  };
  const openUpdate = (event) => {
    rememberUtilityTrigger(event);
    closeMobileNav();
    if (phone) {
      navigate("/updates", { state: { taskReturn: location.pathname + location.search } });
      return;
    }
    setUpdateOpen(true);
  };
  const logOut = () => {
    closeMobileNav();
    endSession();
  };
  useMenuAction("settings", openSettings);
  useMenuAction("lock", logOut);
  useMenuAction("check-updates", checkForUpdates);
  useMenuAction("toggle-theme", () => setMode(mode === "dark" ? "light" : "dark"));

  const navItems = [
    { id: "/passwords", label: t("vault.title"), icon: Lock },
    { id: "/passwords?tool=folders", label: t("folderAccess.manageShort"), icon: FolderOpen },
    { id: "/passwords?tool=backup", label: t("vault.backup"), icon: ArrowDownToLine },
    { id: "/passwords?tool=import", label: t("vault.import"), icon: ArrowUpFromLine },
    { id: "/passwords?tool=health", label: t("vault.health"), icon: HeartPulse },
    { id: "/passwords?tool=trash", label: t("vault.trash"), icon: TrashBin },
    ...(admin ? [{ id: "/users", label: t("navigation.accounts"), icon: Persons }] : []),
  ];
  const navigation = (
    <Box as="nav" aria-label={t("navigation.workspace")}>
      <Flex direction="column" qa="navigation-items">
        {navItems.map((item) => {
          const selected = `${location.pathname}${location.search}` === item.id;
          return (
            <Box key={item.id} paddingBlockEnd="spacing-1">
              <List.ItemView
                component={Link}
                to={item.id}
                size="xl"
                selected={selected}
                selectionStyle="highlight"
                aria-current={selected ? "page" : undefined}
                data-navigation-id={item.id}
                startContent={<Icon data={item.icon} />}
                onClick={closeMobileNav}
                state={{ taskReturn: location.pathname + location.search }}
              >
                {item.label}
              </List.ItemView>
            </Box>
          );
        })}
      </Flex>
    </Box>
  );
  const utilityItems = [
    ...(admin
      ? [{ id: "settings", label: t("topMenu.settings"), icon: Gear, action: openSettings }]
      : []),
    { id: "password", label: t("auth.changePassword"), icon: Key, action: openPassword },
    ...(!IS_DESKTOP
      ? [{ id: "security-key", label: t("auth.securityKey"), icon: Key, action: openSecurityKey }]
      : []),
    { id: "recovery", label: t("auth.recoveryTitle"), icon: Key, action: openRecovery },
    ...(updateAvailable
      ? [
          {
            id: "update",
            label: t("common.actions.update"),
            icon: ArrowRotateRight,
            action: openUpdate,
          },
        ]
      : []),
  ];
  const utilities = (
    <Flex direction="column" gap="spacing-1">
      {utilityItems.map((item) => (
        <List.ItemView
          key={item.id}
          component="button"
          type="button"
          size="xl"
          onClick={item.action}
          startContent={<Icon data={item.icon} />}
        >
          {item.label}
        </List.ItemView>
      ))}
    </Flex>
  );
  const profile = (
    <Flex
      as="footer"
      direction="column"
      gap="spacing-2"
      padding="spacing-3"
      flexShrink={0}
      qa="navigation-footer"
    >
      <Flex alignItems="center" gap="spacing-3" minWidth="0" qa="navigation-account">
        <Avatar text={currentUser?.username ?? "?"} size="m" aria-label={currentUser?.username} />
        <Flex direction="column" gap="spacing-1" minWidth="0">
          <Text variant="subheader-1" wordBreak="break-word">
            {currentUser?.username}
          </Text>
          <Text color="secondary" variant="caption-2" wordBreak="break-word">
            {t(`users.roles.${currentUser?.role}`)}
          </Text>
        </Flex>
      </Flex>
      <Flex direction="column" qa="navigation-preferences">
        <Menu
          placement="top-end"
          trigger={(triggerProps, triggerRef) => (
            <List.ItemView
              {...triggerProps}
              ref={triggerRef}
              component="button"
              type="button"
              role="button"
              size="xl"
              startContent={<Icon data={Globe} />}
              endContent={
                <Flex alignItems="center" gap="spacing-1">
                  <Text color="secondary" variant="body-1">
                    {languageLabel}
                  </Text>
                  <Icon data={ChevronDown} size={14} />
                </Flex>
              }
            >
              {t("language.label")}
            </List.ItemView>
          )}
        >
          <MenuItem selected={language === "ru"} onClick={() => i18n.changeLanguage("ru")}>
            {t("language.russian")}
          </MenuItem>
          <MenuItem selected={language === "en"} onClick={() => i18n.changeLanguage("en")}>
            {t("language.english")}
          </MenuItem>
        </Menu>
        <Menu
          placement="top-end"
          trigger={(triggerProps, triggerRef) => (
            <List.ItemView
              {...triggerProps}
              ref={triggerRef}
              component="button"
              type="button"
              role="button"
              size="xl"
              startContent={<Icon data={mode === "dark" ? Moon : Sun} />}
              endContent={
                <Flex alignItems="center" gap="spacing-1">
                  <Text color="secondary" variant="body-1">
                    {themeLabel}
                  </Text>
                  <Icon data={ChevronDown} size={14} />
                </Flex>
              }
            >
              {t("theme.label")}
            </List.ItemView>
          )}
        >
          <MenuItem selected={mode === "light"} onClick={() => setMode("light")}>
            {t("theme.light")}
          </MenuItem>
          <MenuItem selected={mode === "dark"} onClick={() => setMode("dark")}>
            {t("theme.dark")}
          </MenuItem>
        </Menu>
      </Flex>
      <Divider />
      <List.ItemView
        component="button"
        type="button"
        size="xl"
        onClick={logOut}
        startContent={<Icon data={ArrowRightFromSquare} />}
      >
        {t("auth.logOut")}
      </List.ItemView>
    </Flex>
  );
  const shell = (mobile) => (
    <Flex
      direction="column"
      height="100dvh"
      minHeight="0"
      width={mobile ? "100vw" : undefined}
      maxWidth={mobile ? "360px" : undefined}
      qa="navigation-shell"
    >
      <Flex
        alignItems="center"
        justifyContent="space-between"
        gap="spacing-2"
        padding="spacing-4"
        flexShrink={0}
        qa="navigation-header"
      >
        <Brand version={version} onClick={closeMobileNav} />
        {mobile && (
          <Button
            type="button"
            view="flat-secondary"
            size="xl"
            aria-label={t("common.actions.close")}
            onClick={closeMobileNav}
          >
            <Icon data={Xmark} />
          </Button>
        )}
      </Flex>
      <Flex
        direction="column"
        gap="spacing-4"
        paddingInline="spacing-3"
        paddingBlockEnd="spacing-4"
        flexGrow={1}
        minHeight="0"
        overflow="auto"
        qa="navigation-body"
      >
        {navigation}
        <Divider />
        {utilities}
        {mobile && (
          <>
            <Divider />
            {profile}
          </>
        )}
      </Flex>
      {!mobile && (
        <>
          <Divider />
          {profile}
        </>
      )}
    </Flex>
  );

  return (
    <>
      {desktop ? (
        <Flex
          as="aside"
          width="288px"
          flexShrink={0}
          position="sticky"
          top="0"
          height="100dvh"
          backgroundColor="generic"
        >
          <Box flexGrow={1} minWidth="0">
            {shell(false)}
          </Box>
          <Divider orientation="vertical" />
        </Flex>
      ) : (
        <Flex as="header" direction="column" qa="mobile-header">
          <Flex
            alignItems="center"
            gap="spacing-3"
            paddingInline="spacing-3"
            paddingBlock="spacing-2"
          >
            <Button
              ref={mobileMenuButton}
              qa="burger"
              type="button"
              view="flat-secondary"
              size="xl"
              aria-label={t("navigation.more")}
              onClick={() => setMobileNavOpen(true)}
            >
              <Icon data={Bars} />
            </Button>
            <Brand />
          </Flex>
          <Divider />
        </Flex>
      )}

      <Drawer
        open={mobileNavOpen}
        onOpenChange={setMobileNavOpen}
        placement="left"
        size="auto"
        returnFocus={mobileMenuButton}
        disableLayer={false}
        aria-label={t("navigation.workspace")}

        contentOverflow="visible"
      >
        {shell(true)}
      </Drawer>

      {admin && <SettingsModal open={settingsOpen} onClose={() => closeUtility(setSettingsOpen)} />}
      <PasswordChangeDialog open={passwordOpen} onClose={() => closeUtility(setPasswordOpen)} />
      <RecoveryCodeDialog open={recoveryOpen} onClose={() => closeUtility(setRecoveryOpen)} />
      {!IS_DESKTOP && (
        <SecurityKeyDialog
          open={securityKeyOpen}
          onClose={() => closeUtility(setSecurityKeyOpen)}
        />
      )}
      <UpdateDialog open={updateOpen} onClose={() => closeUtility(setUpdateOpen)} />
    </>
  );
};

export default TopMenu;
