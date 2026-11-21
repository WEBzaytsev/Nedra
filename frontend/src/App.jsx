import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  BrowserRouter as Router,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { useStoreActions } from "easy-peasy";
import {
  Box,
  Button,
  Container,
  Flex,
  Text,
  ToasterComponent,
  useLayoutContext,
} from "@gravity-ui/uikit";

import DesktopGate from "./platform/DesktopGate";
import { IS_DESKTOP } from "./platform";
import apiClient from "./api/client";
import PasswordChangeDialog from "./components/PasswordChangeDialog";
import PairingDialog from "./components/extension/PairingDialog";
import SecurityKeyPrompt from "./components/SecurityKeyPrompt";
import TopMenu from "./components/TopMenu";
import { ColorModeProvider } from "./hooks/useColorMode";
import useAutoLogout from "./hooks/useAutoLogout";
import routes from "./routes";
import { getCurrentUser, isAuth, setCurrentUser } from "./utils";
import { setMenuUnlocked } from "./platform/menu";
import { VaultViewContext } from "./hooks/VaultViewContext";
import { MobileTaskActionsContext } from "./hooks/MobileTaskActionsContext";
import { captureHandoff, clearHandoff, deliverToken, pendingHandoff } from "./lib/extensionHandoff";

const ExtensionHandoff = ({ handoff, onLeave }) => {
  const { t } = useTranslation();
  const [state, setState] = useState("ready");
  const started = useRef(false);
  const active = useRef(true);
  const connectButton = useRef(null);
  const leaveButton = useRef(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (
      state !== "ready" &&
      state !== "connecting" &&
      (document.activeElement === document.body || document.activeElement === connectButton.current)
    ) {
      leaveButton.current?.focus();
    }
  }, [state]);
  const connect = async () => {
    if (started.current) return;
    started.current = true;
    setState("connecting");
    try {
      const { data } = await apiClient.post("/extension/handoffs/approve", {
        request: handoff.request,
        tab: handoff.tab,
        browser: handoff.browser,
        client: handoff.client,
        origin: window.location.origin,
      });
      if (!active.current) return;
      if (!(await deliverToken({ request: handoff.request, redeem: data.redeem }))) {
        if (active.current) setState("waiting");
        return;
      }
      if (!active.current) return;
      clearHandoff();
      setState("connected");
    } catch {
      if (active.current) setState("error");
    }
  };
  return (
    <Container paddingBlock="spacing-6" gutters="spacing-6">
      <Box as="main" maxWidth="480px">
        <Text as="h1" variant="header-1">
          {t("extension.handoff.title")}
        </Text>
        <p>{t("extension.handoff.scope")}</p>
        {(state === "ready" || state === "connecting") && (
          <Button
            ref={connectButton}
            view="action"
            size="xl"
            disabled={state === "connecting"}
            onClick={connect}
          >
            {t("extension.handoff.connect", { browser: handoff.browser })}
          </Button>
        )}
        {state === "connecting" && <p role="status">{t("extension.handoff.connecting")}</p>}
        {state === "waiting" && <p role="alert">{t("extension.handoff.waiting")}</p>}
        {state === "connected" && <p role="status">{t("extension.handoff.connected")}</p>}
        {state === "error" && <p role="alert">{t("extension.handoff.error")}</p>}
        <Flex marginBlockStart="spacing-4">
          <Button
            ref={leaveButton}
            view={state === "ready" || state === "connecting" ? "flat-secondary" : "normal"}
            size="xl"
            disabled={state === "connecting"}
            onClick={onLeave}
          >
            {t("extension.handoff.leave")}
          </Button>
        </Flex>
      </Box>
    </Container>
  );
};

const AppContent = () => {
  useAutoLogout();

  const authed = isAuth();
  const navigate = useNavigate();
  const workspace = useRef(null);
  const [handoff, setHandoff] = useState(() => captureHandoff() ?? pendingHandoff());
  const leaveHandoff = () => {
    clearHandoff();
    setHandoff(null);
    navigate("/passwords", { replace: true });
    window.requestAnimationFrame(() => workspace.current?.focus());
  };
  const vaultView = useRef({});
  useEffect(() => {
    setMenuUnlocked(authed);
  }, [authed]);
  useEffect(() => {
    if (!authed) vaultView.current = {};
  }, [authed]);
  const location = useLocation();
  const { isMediaActive } = useLayoutContext();
  const desktopShell = isMediaActive("l");
  const phone = !isMediaActive("s");
  const vaultRoute = location.pathname === "/passwords";
  const [currentUser, setUser] = useState(getCurrentUser);
  const passwordChangeRequired = Boolean(currentUser?.must_change_password);
  const getSettings = useStoreActions((actions) => actions.nedraModels.settings.get);

  useEffect(() => {
    if (!authed || passwordChangeRequired) return;
    getSettings();
    apiClient
      .get("/auth/me")
      .then(({ data }) => {
        setCurrentUser(data);
        setUser(data);
      })
      .catch(() => {});
  }, [authed, passwordChangeRequired, getSettings]);

  const appRoutes = (
    <Routes>
      {routes.map((route) => (
        <Route key={route.path} path={route.path} element={route.element} />
      ))}
      <Route path="*" element={<Navigate to="/passwords" replace />} />
    </Routes>
  );

  if (!authed) return appRoutes;
  if (handoff) return <ExtensionHandoff handoff={handoff} onLeave={leaveHandoff} />;

  return (
    <VaultViewContext.Provider value={vaultView}>
      <Flex
        minHeight={phone ? "100%" : "100dvh"}
        height={desktopShell ? "100dvh" : undefined}
        overflow={desktopShell ? "hidden" : undefined}
        direction={{ xs: "column", l: "row" }}
      >
        <TopMenu />
        <Box
          as="main"
          ref={workspace}
          tabIndex={-1}
          flexGrow={1}
          minWidth="0"
          height={desktopShell ? "100%" : undefined}
          overflow={desktopShell ? (vaultRoute ? "hidden" : "auto") : undefined}
        >
          <Container
            paddingBlock={{ xs: "spacing-3", s: "spacing-6" }}
            gutters={{ xs: "spacing-3", m: "spacing-6" }}
          >
            {!passwordChangeRequired && appRoutes}
            {!desktopShell && (
              <PasswordChangeDialog
                open={passwordChangeRequired}
                required
                onClose={() => {}}
                onChanged={setUser}
              />
            )}
          </Container>
        </Box>
        {desktopShell && (
          <PasswordChangeDialog
            open={passwordChangeRequired}
            required
            onClose={() => {}}
            onChanged={setUser}
          />
        )}
      </Flex>
    </VaultViewContext.Provider>
  );
};

const AppFrame = () => {
  const { isMediaActive } = useLayoutContext();
  const phone = !isMediaActive("s");
  const [actionsTarget, setActionsTarget] = useState(null);
  const [viewportHeight, setViewportHeight] = useState();
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!phone || !viewport) return undefined;

    const resize = () =>
      setViewportHeight(
        viewport.scale === 1 ? `${viewport.height + viewport.offsetTop}px` : undefined
      );
    resize();
    viewport.addEventListener("resize", resize);
    viewport.addEventListener("scroll", resize);
    return () => {
      viewport.removeEventListener("resize", resize);
      viewport.removeEventListener("scroll", resize);
    };
  }, [phone]);
  return (
    <MobileTaskActionsContext.Provider value={actionsTarget}>
      <Flex
        direction="column"
        height={phone ? (viewportHeight ?? "100dvh") : undefined}
        overflow={phone ? "hidden" : undefined}
      >
        <Box
          flexGrow={1}
          minHeight="0"
          overflow={phone ? "auto" : undefined}
          qa={phone ? "page-scroll" : undefined}
        >
          <DesktopGate>
            <AppContent />
          </DesktopGate>
          {IS_DESKTOP && <PairingDialog />}
          <SecurityKeyPrompt />
        </Box>
        {phone ? (
          <Box
            flexShrink={0}
            maxHeight="40dvh"
            overflow="auto"
            paddingInline="spacing-2"
            aria-live="polite"
            aria-relevant="additions text"
          >
            <ToasterComponent hasPortal={false} mobile />
          </Box>
        ) : (
          <ToasterComponent />
        )}
        {phone && <Box ref={setActionsTarget} flexShrink={0} />}
      </Flex>
    </MobileTaskActionsContext.Provider>
  );
};

const App = () => (
  <Router>
    <ColorModeProvider>
      <AppFrame />
    </ColorModeProvider>
  </Router>
);

export default App;
