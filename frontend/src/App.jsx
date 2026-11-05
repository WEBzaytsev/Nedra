import { useEffect, useRef, useState } from "react";
import { BrowserRouter as Router, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useStoreActions } from "easy-peasy";
import { Box, Container, Flex, ToasterComponent, useLayoutContext } from "@gravity-ui/uikit";

import DesktopGate from "./platform/DesktopGate";
import apiClient from "./api/client";
import PasswordChangeDialog from "./components/PasswordChangeDialog";
import TopMenu from "./components/TopMenu";
import { ColorModeProvider } from "./hooks/useColorMode";
import useAutoLogout from "./hooks/useAutoLogout";
import routes from "./routes";
import { getCurrentUser, isAuth, setCurrentUser } from "./utils";
import { VaultViewContext } from "./hooks/VaultViewContext";
import { MobileTaskActionsContext } from "./hooks/MobileTaskActionsContext";

const AppContent = () => {
  useAutoLogout();

  const authed = isAuth();
  const vaultView = useRef({});
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
  const getSettings = useStoreActions((actions) => actions.ciphermothModels.settings.get);

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
    // The on-screen keyboard may resize only the visual viewport, not 100dvh.
    // Leave pinch zoom to the browser rather than reflowing the magnified page.
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
        </Box>
        {phone ? (
          <Box
            flexShrink={0}
            maxHeight="40dvh"
            overflow="auto"
            paddingInline="spacing-2"
            aria-live="polite"
            aria-relevant="additions text"
            qa="notification-shelf"
          >
            <ToasterComponent hasPortal={false} mobile />
          </Box>
        ) : (
          <ToasterComponent />
        )}
        {phone && <Box ref={setActionsTarget} flexShrink={0} qa="mobile-task-actions" />}
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
