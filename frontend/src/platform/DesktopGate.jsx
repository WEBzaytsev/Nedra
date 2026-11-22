import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Box, Button, Container, Flex, Text, TextInput } from "@gravity-ui/uikit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";

import { IS_DESKTOP, clearClipboard, lockNative, openExternal } from "./index";
import { coreRestart, coreStatus, onCoreStatus } from "./core";
import { listenForMenuActions } from "./menu";
import BrandMark from "../components/BrandMark";
import LanguageSwitcher from "../components/LanguageSwitcher";
import LoadingScreen from "../components/LoadingScreen";
import ThemeToggle from "../components/ThemeToggle";
import { clearSession, isAuth } from "../utils";
import {
  SERVER_SELECTION,
  initialDesktopMode,
  serverFailure,
  statusMatchesOrigin,
  validServerAddress,
} from "./serverMode";

export default function DesktopGate({ children }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState(null);
  const [screen, setScreen] = useState("loading");
  const [address, setAddress] = useState("");
  const [serverState, setServerState] = useState("idle");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [invalid, setInvalid] = useState(false);
  const headingRef = useRef(null);
  const addressRef = useRef(null);
  const screenRef = useRef("loading");
  const originRef = useRef("");
  const operation = useRef({ id: 0, busy: "" });
  const mounted = useRef(false);

  const show = useCallback((next) => {
    screenRef.current = next;
    setScreen(next);
  }, []);
  const start = useCallback((action) => {
    operation.current = { id: operation.current.id + 1, busy: action };
    setBusy(action);
    setError("");
    return operation.current.id;
  }, []);
  const current = useCallback((id) => mounted.current && operation.current.id === id, []);
  const finish = useCallback(() => {
    operation.current.busy = "";
    setBusy("");
  }, []);

  const connect = useCallback(
    async (value) => {
      if (operation.current.busy) return;
      if (!validServerAddress(value)) {
        setInvalid(true);
        addressRef.current?.focus();
        return;
      }
      const id = start("connect");
      originRef.current = new URL(value.trim()).origin;
      setInvalid(false);
      setServerState("opening");
      show("server");
      clearSession();
      clearClipboard();
      try {
        const next = await invoke("server_connect", { address: value.trim() });
        if (!current(id)) return;
        sessionStorage.removeItem(SERVER_SELECTION);
        setAddress(next.origin);
        setServerState("open");
      } catch (reason) {
        if (current(id)) {
          setServerState("failed");
          setError(serverFailure(reason));
        }
      } finally {
        if (current(id)) finish();
      }
    },
    [current, finish, show, start]
  );

  const disconnect = useCallback(
    async (destination = "server", locked = false) => {
      if (operation.current.busy && operation.current.busy !== "connect") return;
      const id = start("disconnect");
      try {
        await invoke("server_disconnect");
        if (!current(id)) return;
        clearSession();
        clearClipboard();
        sessionStorage.removeItem(SERVER_SELECTION);
        setServerState(locked ? "locked" : "closed");
        show(destination);
      } catch {
        if (current(id)) setError("disconnectFailed");
      } finally {
        if (current(id)) finish();
      }
    },
    [current, finish, show, start]
  );

  const useLocal = async () => {
    if (operation.current.busy) return;
    const id = start("local");
    sessionStorage.setItem(SERVER_SELECTION, "local");
    try {
      await invoke("server_local");
      if (!current(id)) return;
      clearSession();
      sessionStorage.removeItem(SERVER_SELECTION);
      window.location.replace("/login");
    } catch {
      if (current(id)) {
        sessionStorage.setItem(SERVER_SELECTION, "1");
        setError("localFailed");
        finish();
      }
    }
  };

  useEffect(() => {
    if (!IS_DESKTOP) return undefined;
    mounted.current = true;
    let disposed = false;
    let generation;
    const unlisten = [];
    const locked = () => {
      clearClipboard();
      clearSession();
      if (screenRef.current === "local") window.location.replace("/login");
    };
    const update = (next) => {
      if (disposed) return;
      if (
        isAuth() &&
        (next.state !== "ready" || (generation !== undefined && next.generation !== generation))
      )
        locked();
      generation = next.generation;
      setStatus(next);
    };
    const serverUpdate = ({ payload }) => {
      if (disposed || screenRef.current !== "server") return;
      if (!statusMatchesOrigin(payload.origin, originRef.current)) return;
      if (!["opening", "open", "failed", "closed"].includes(payload.state)) return;
      if (operation.current.busy === "disconnect" && payload.state !== "closed") return;
      setServerState(payload.state);
      if (payload.state === "closed" || payload.state === "failed") {
        if (operation.current.busy === "connect") {
          operation.current.id += 1;
          finish();
        }
        setError(payload.state === "failed" ? serverFailure(payload.error) : "");
      }
    };
    const initialize = async () => {
      try {
        // Subscribe before connecting so a fast close/failure cannot be missed.
        await Promise.all(
          [
            onCoreStatus(update),
            listen("vault-locked", locked),
            listen("server-status", serverUpdate),
            listenForMenuActions(),
          ].map(async (subscription) => {
            const stop = await subscription;
            if (disposed) stop();
            else unlisten.push(stop);
          })
        );
        if (disposed) return;
        coreStatus()
          .then(update)
          .catch(() => {
            if (!disposed) setStatus({ state: "failed" });
          });
        const saved = await invoke("server_choice");
        if (disposed) return;
        const selecting = sessionStorage.getItem(SERVER_SELECTION) !== null;
        setAddress(saved.origin ?? "");
        originRef.current = saved.origin ? new URL(saved.origin).origin : "";
        const initial = initialDesktopMode(saved, selecting);
        if (!initial.autoConnect) {
          setServerState(saved.origin ? "closed" : "idle");
          show(initial.screen);
        } else {
          show(initial.screen);
          connect(saved.origin);
        }
      } catch {
        if (!disposed) {
          show("startupError");
          setError("choiceFailed");
        }
      }
    };
    initialize();
    const selectServer = async () => {
      if (operation.current.busy) return;
      const id = start("select");
      sessionStorage.setItem(SERVER_SELECTION, "1");
      show("choose");
      clearSession();
      clearClipboard();
      try {
        await lockNative();
      } catch {
        if (current(id)) setError("lockFailed");
      } finally {
        if (current(id)) finish();
      }
    };
    const click = (event) => {
      const link = event.target.closest?.("a[href]");
      if (link && /^https?:|^mailto:/i.test(link.href)) {
        event.preventDefault();
        openExternal(link.href).catch(() => {});
      }
    };
    const keydown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "l") {
        event.preventDefault();
        if (screenRef.current === "local") {
          import("../api/session").then(({ endSession }) => endSession());
        } else if (screenRef.current === "server") disconnect("server", true);
      }
    };
    window.addEventListener("nedra-select-server", selectServer);
    document.addEventListener("click", click, true);
    document.addEventListener("keydown", keydown);
    return () => {
      disposed = true;
      mounted.current = false;
      operation.current.id += 1;
      unlisten.forEach((stop) => stop());
      window.removeEventListener("nedra-select-server", selectServer);
      document.removeEventListener("click", click, true);
      document.removeEventListener("keydown", keydown);
    };
  }, [connect, current, disconnect, finish, show, start]);

  useEffect(() => {
    if (screen === "server" && ["idle", "closed"].includes(serverState))
      addressRef.current?.focus();
    else headingRef.current?.focus();
  }, [screen, serverState]);

  if (!IS_DESKTOP) return children;
  if (screen === "loading") return <LoadingScreen label={t("desktopGate.opening")} />;
  if (screen === "local" && status?.state === "ready") return children;
  if (screen === "local" && status?.state !== "failed")
    return (
      <LoadingScreen
        label={t("desktopGate.opening")}
        action={
          <Button
            type="button"
            size="xl"
            onClick={() => window.dispatchEvent(new Event("nedra-select-server"))}
          >
            {t("desktopGate.changeVault")}
          </Button>
        }
      />
    );

  const remoteOpen = screen === "server" && serverState === "open";
  const title =
    screen === "local"
      ? "openFailedTitle"
      : screen !== "server"
        ? "choose"
        : ({ opening: "connecting", open: "windowOpen", locked: "locked", closed: "closed" }[
            serverState
          ] ?? "connect");

  return (
    <Container maxWidth="480px" gutters="spacing-4" paddingBlock="spacing-6">
      <Flex justifyContent="space-between" alignItems="center" marginBlockEnd="spacing-8">
        <BrandMark width={32} height={32} />
        <Flex gap="spacing-1">
          <LanguageSwitcher placement="auth" />
          <ThemeToggle />
        </Flex>
      </Flex>
      <Flex as="main" direction="column" gap="spacing-5" aria-labelledby="desktop-gate-title">
        <Text as="h1" id="desktop-gate-title" variant="header-1" tabIndex={-1} ref={headingRef}>
          {t(`desktopGate.${title}`)}
        </Text>
        {error && (
          <Box role="alert">
            <Alert theme="danger" message={t(`desktopGate.${error}`)} />
          </Box>
        )}
        {screen === "choose" && (
          <Flex direction="column" gap="spacing-3">
            <Button
              type="button"
              size="xl"
              width="max"
              disabled={Boolean(busy)}
              onClick={useLocal}
              loading={busy === "local"}
            >
              {t("desktopGate.local")}
            </Button>
            <Button
              type="button"
              view="action"
              size="xl"
              width="max"
              disabled={Boolean(busy)}
              onClick={() => {
                setError("");
                setServerState("idle");
                show("server");
              }}
            >
              {t("desktopGate.connect")}
            </Button>
          </Flex>
        )}
        {screen === "server" && (
          <>
            {remoteOpen ? (
              <>
                <Text wordBreak="break-all">{address}</Text>
                <Text color="secondary">{t("desktopGate.serverSession")}</Text>
                <Button
                  type="button"
                  size="xl"
                  disabled={Boolean(busy)}
                  onClick={() => disconnect("server", true)}
                >
                  {t("desktopGate.lock")}
                </Button>
                <Button
                  type="button"
                  size="xl"
                  disabled={Boolean(busy)}
                  onClick={() => disconnect()}
                >
                  {t("desktopGate.closeWindow")}
                </Button>
              </>
            ) : (
              <Flex
                as="form"
                direction="column"
                gap="spacing-4"
                noValidate
                onSubmit={(event) => {
                  event.preventDefault();
                  connect(address);
                }}
              >
                <Flex direction="column" gap="spacing-2">
                  <Text as="label" htmlFor="nedra-server-address">
                    {t("desktopGate.address")}
                  </Text>
                  <TextInput
                    id="nedra-server-address"
                    controlRef={addressRef}
                    size="xl"
                    type="url"
                    value={address}
                    onUpdate={(value) => {
                      setAddress(value);
                      setInvalid(false);
                      setError("");
                    }}
                    controlProps={{
                      "aria-describedby": "desktop-server-hint",
                      spellCheck: false,
                      autoCapitalize: "none",
                    }}
                    placeholder="https://vault.example.com"
                    autoComplete="url"
                    disabled={Boolean(busy)}
                    validationState={invalid ? "invalid" : undefined}
                    errorMessage={invalid ? t("desktopGate.invalidAddress") : undefined}
                  />
                  <Text id="desktop-server-hint" color="secondary">
                    {t("desktopGate.addressHint")}
                  </Text>
                </Flex>

                <Button
                  type="submit"
                  view="action"
                  size="xl"
                  width="max"
                  loading={busy === "connect"}
                  disabled={Boolean(busy)}
                >
                  {t(serverState === "failed" ? "desktopGate.retry" : "desktopGate.connect")}
                </Button>
              </Flex>
            )}
            <Button
              type="button"
              size="xl"
              view="flat"
              disabled={Boolean(busy) && busy !== "connect"}
              loading={busy === "disconnect"}
              onClick={() => disconnect("choose")}
            >
              {t(remoteOpen ? "desktopGate.changeVault" : "desktopGate.back")}
            </Button>
          </>
        )}
        {screen === "startupError" && (
          <Button type="button" view="action" size="xl" onClick={() => window.location.reload()}>
            {t("desktopGate.retry")}
          </Button>
        )}
        {screen === "local" && (
          <>
            <Text color="secondary">{t("desktopGate.openFailedDescription")}</Text>
            <Button
              type="button"
              view="action"
              size="xl"
              disabled={Boolean(busy)}
              onClick={async () => {
                const id = start("restart");
                try {
                  await coreRestart();
                } catch {
                  if (current(id)) setError("localFailed");
                } finally {
                  if (current(id)) finish();
                }
              }}
            >
              {t("desktopGate.retry")}
            </Button>
            <Button
              type="button"
              size="xl"
              onClick={() => {
                setError("");
                show("choose");
              }}
            >
              {t("desktopGate.changeVault")}
            </Button>
          </>
        )}
      </Flex>
    </Container>
  );
}
