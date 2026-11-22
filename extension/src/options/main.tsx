import { render } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";

import { ext, t } from "../shared/browser";
import { TARGET, VERSION } from "../shared/constants";
import type { Status } from "../shared/messages";
import { serverOrigin } from "../shared/url";
import { NedraIcon, send } from "../ui/shared";
import { notNeededBy, permissionOrigins, targetFor } from "../shared/target";

const formatTimeout = (ms: number | null): string => {
  if (!ms) return t("ui_timeout_vault");
  if (ms < 60_000 || ms % 60_000 !== 0)
    return t("ui_timeout_seconds", String(Math.round(ms / 1000)));
  return t("ui_timeout_minutes", String(ms / 60_000));
};

const Connection = ({ status, reload }: { status: Status; reload: () => void }) => {
  const [vault, setVault] = useState(status.vault ?? "");
  const [api, setApi] = useState(
    status.api && status.vault && status.api !== `${status.vault}/api` ? status.api : ""
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);

  const connect = async (event: Event) => {
    event.preventDefault();
    setMessage(null);
    const target = targetFor(vault, api || null);
    if (typeof target === "string") {
      setMessage({ text: target, bad: true });
      return;
    }
    const origins = permissionOrigins(target);
    const held =
      status.vault && status.api ? permissionOrigins({ vault: status.vault, api: status.api }) : [];
    const drop = async (patterns: string[]) => {
      if (patterns.length) await ext.permissions.remove({ origins: patterns }).catch(() => false);
    };
    const granted = await ext.permissions.request({ origins }).catch(() => false);
    if (!granted) {
      setMessage({
        text: t("ui_permission_address"),
        bad: true,
      });
      return;
    }
    setBusy(true);
    try {
      const next = await send<Status>({
        type: "configure",
        vault: target.vault,
        api: target.api,
      });
      if (next.phase === "too-old") {
        await drop(notNeededBy(origins, held));
        setMessage({ text: next.error ?? t("ui_update_first"), bad: true });
        return;
      }
      await drop(notNeededBy(held, origins));
      setMessage({
        text: t("ui_connected_open"),
        bad: false,
      });
      reload();
    } catch (err) {
      await drop(notNeededBy(origins, held));
      setMessage({
        text: err instanceof Error ? err.message : t("ui_error_could_not_connect"),
        bad: true,
      });
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await send({ type: "forget" });
      setVault("");
      setApi("");
      setMessage({ text: t("ui_disconnected"), bad: false });
      reload();
    } catch (err) {
      setMessage({
        text: err instanceof Error ? err.message : t("ui_error_could_not_disconnect"),
        bad: true,
      });
      reload();
    } finally {
      setBusy(false);
    }
  };

  const connected = status.mode === "server" && status.phase !== "setup";
  return (
    <section aria-labelledby="connection">
      <h2 id="connection">{t("ui_connection")}</h2>
      {connected ? (
        <div class="row">
          <span class={`status ${status.phase === "unlocked" ? "on" : ""}`}>
            {status.phase === "unlocked"
              ? t("ui_unlocked")
              : status.phase === "locked"
                ? t("ui_locked")
                : t("ui_not_reachable")}
          </span>
          <code>{status.vault}</code>
        </div>
      ) : (
        <p>
          {t(
            "ui_connect_to_your_own_nedra_server_the_extension_asks_your_browser_for_access_to_that_one_address_only"
          )}
        </p>
      )}
      <form onSubmit={connect}>
        <label for="vault">{t("ui_vault_address")}</label>
        <input
          id="vault"
          class="field mono"
          placeholder="https://vault.example.com"
          value={vault}
          autoFocus={!connected}
          spellcheck={false}
          onInput={(e) => setVault((e.target as HTMLInputElement).value)}
        />
        <details open={Boolean(api)}>
          <summary>{t("ui_api_on_another_address")}</summary>
          <label for="api">{t("ui_api_address")}</label>
          <input
            id="api"
            class="field mono"
            placeholder={
              serverOrigin(vault)
                ? `${vault.replace(/\/+$/, "")}/api`
                : "https://vault.example.com:8000/api"
            }
            value={api}
            spellcheck={false}
            onInput={(e) => setApi((e.target as HTMLInputElement).value)}
          />
          <p style={{ marginTop: "6px", fontSize: "12px" }}>{t("ui_api_hint")}</p>
        </details>
        <div class="buttons">
          <button class="button primary" type="submit" disabled={busy || !vault.trim()}>
            {busy ? t("ui_connecting") : connected ? t("ui_save") : t("ui_connect")}
          </button>
          {connected && (
            <button class="button danger" type="button" onClick={disconnect}>
              {t("ui_disconnect")}
            </button>
          )}
        </div>
      </form>
      {message && (
        <p
          class={message.bad ? "error" : ""}
          role={message.bad ? "alert" : "status"}
          style={{ marginTop: "12px" }}
        >
          {message.text}
        </p>
      )}
    </section>
  );
};

const NEEDS_NATIVE_PERMISSION = t("ui_native_permission");

const DESKTOP_STATES: Partial<Record<Status["phase"], string>> = {
  unlocked: t("ui_desktop_unlocked"),
  locked: t("ui_desktop_locked"),
  "no-app": t("ui_desktop_no_app"),
  "no-host": t("ui_desktop_no_host"),
  offline: t("ui_desktop_offline"),
};

const spacedCode = (code: string | null): string =>
  code && /^\d{6}$/.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : "";

const DesktopConnection = ({ status, reload }: { status: Status; reload: () => void }) => {
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const pairing = status.phase === "pairing";

  useEffect(() => {
    if (!pairing) return;
    const timer = setInterval(reload, 1000);
    return () => clearInterval(timer);
  }, [pairing, reload]);

  const pair = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await send<Status>({ type: "pair" });
    } catch (err) {
      setMessage({
        text: err instanceof Error ? err.message : t("ui_error_could_not_pair"),
        bad: true,
      });
    } finally {
      setBusy(false);
      reload();
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await send({ type: "unpair" });
      setMessage({ text: t("ui_unpaired_from_app"), bad: false });
      reload();
    } catch (err) {
      setMessage({
        text: err instanceof Error ? err.message : t("ui_could_not_unpair"),
        bad: true,
      });
      reload();
    } finally {
      setBusy(false);
    }
  };

  const allow = async () => {
    setMessage(null);
    const granted = await ext.permissions
      .request({ permissions: ["nativeMessaging"] })
      .catch(() => false);
    if (!granted) {
      setMessage({ text: NEEDS_NATIVE_PERMISSION, bad: true });
      return;
    }
    try {
      await send<Status>({ type: "use-desktop" });
      reload();
    } catch (err) {
      setMessage({
        text: err instanceof Error ? err.message : t("ui_error_could_not_connect_to_app"),
        bad: true,
      });
    }
  };

  const state = DESKTOP_STATES[status.phase];
  return (
    <section aria-labelledby="desktop">
      <h2 id="desktop">{t("ui_nedra_app")}</h2>
      {status.phase === "setup" && (
        <>
          <p>{NEEDS_NATIVE_PERMISSION}</p>
          <div class="buttons">
            <button class="button primary" onClick={() => void allow()}>
              {t("ui_allow")}
            </button>
          </div>
        </>
      )}
      {status.phase === "unsupported" && (
        <p class="error" role="alert">
          {t("ui_unsupported")}
        </p>
      )}
      {state && (
        <div class="row">
          <span class={`status ${status.phase === "unlocked" ? "on" : ""}`}>{state}</span>
        </div>
      )}
      {status.phase === "unpaired" && (
        <>
          <p>{t("ui_pair_instructions")}</p>
          {status.error && (
            <p class="error" role="alert">
              {status.error}
            </p>
          )}
          <div class="buttons">
            <button class="button primary" onClick={pair} disabled={busy}>
              {busy ? t("ui_pairing") : t("ui_pair")}
            </button>
          </div>
        </>
      )}
      {pairing && (
        <>
          <p>{t("ui_check_pair_code")}</p>
          <p class="pairing-code" aria-label={t("ui_pairing_code", spacedCode(status.pairingCode))}>
            {spacedCode(status.pairingCode)}
          </p>
          <div class="buttons">
            <button
              class="button"
              onClick={() => {
                void send({ type: "cancel-pair" }).finally(reload);
              }}
            >
              {t("ui_cancel")}
            </button>
          </div>
        </>
      )}
      {status.phase !== "unpaired" &&
        !pairing &&
        status.phase !== "unsupported" &&
        status.phase !== "setup" && (
          <div class="buttons">
            <button class="button danger" type="button" onClick={disconnect}>
              {t("ui_unpair")}
            </button>
          </div>
        )}
      {message && (
        <p
          class={message.bad ? "error" : ""}
          role={message.bad ? "alert" : "status"}
          style={{ marginTop: "12px" }}
        >
          {message.text}
        </p>
      )}
      <p style={{ marginTop: "12px", fontSize: "12px" }}>{t("ui_native_transport")}</p>
    </section>
  );
};

const Mode = ({ status, reload }: { status: Status; reload: () => void }) => {
  const [chosen, setChosen] = useState<"server" | "desktop">(status.mode ?? "server");
  const [error, setError] = useState("");

  const choose = async (mode: "server" | "desktop") => {
    setError("");
    setChosen(mode);
    if (mode !== "desktop" || status.mode === "desktop") return;
    const granted = await ext.permissions
      .request({ permissions: ["nativeMessaging"] })
      .catch(() => false);
    if (!granted) {
      setChosen(status.mode ?? "server");
      setError(NEEDS_NATIVE_PERMISSION);
      return;
    }
    try {
      await send<Status>({ type: "use-desktop" });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("ui_error_could_not_switch"));
    }
    reload();
  };

  return (
    <section aria-labelledby="mode">
      <h2 id="mode">{t("ui_fill_from")}</h2>
      <div class="choices" role="radiogroup" aria-labelledby="mode">
        <label class="choice">
          <input
            type="radio"
            name="mode"
            checked={chosen === "desktop"}
            onChange={() => void choose("desktop")}
          />
          <span>
            {t("ui_nedra_app_on_this_computer")}
            <small>{t("ui_unlock_with_app")}</small>
          </span>
        </label>
        <label class="choice">
          <input
            type="radio"
            name="mode"
            checked={chosen === "server"}
            onChange={() => void choose("server")}
          />
          <span>
            {t("ui_your_nedra_server")}
            <small>{t("ui_server_https")}</small>
          </span>
        </label>
      </div>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      {chosen === "desktop" && status.mode === "desktop" && (
        <DesktopConnection status={status} reload={reload} />
      )}
      {chosen === "desktop" && status.mode !== "desktop" && (
        <div class="buttons">
          <button class="button primary" onClick={() => void choose("desktop")}>
            {t("ui_use_the_nedra_app")}
          </button>
        </div>
      )}
      {chosen === "server" && <Connection status={status} reload={reload} />}
    </section>
  );
};

const Preferences = ({ status, reload }: { status: Status; reload: () => void }) => {
  const [error, setError] = useState("");
  const save = async (patch: Partial<Pick<Status, "subdomains" | "strictClipboard">>) => {
    setError("");
    try {
      await send({
        type: "settings",
        subdomains: patch.subdomains ?? status.subdomains,
        strictClipboard: patch.strictClipboard ?? status.strictClipboard,
      });
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("ui_error_could_not_save_settings"));
    }
  };

  const toggleStrict = async (on: boolean) => {
    if (on) {
      const granted = await ext.permissions
        .request({ permissions: ["clipboardRead"] })
        .catch(() => false);
      if (!granted) {
        setError(t("ui_error_clipboard_permission_needed"));
        return;
      }
    } else {
      const removed = await ext.permissions
        .remove({ permissions: ["clipboardRead"] })
        .catch(() => false);
      if (!removed) {
        setError(t("ui_error_could_not_remove_clipboard_permission"));
        return;
      }
    }
    await save({ strictClipboard: on });
  };

  const shortcuts = () => {
    if (TARGET === "chromium") void ext.tabs.create({ url: "chrome://extensions/shortcuts" });
  };

  return (
    <section aria-labelledby="filling">
      <h2 id="filling">{t("ui_filling")}</h2>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      <div class="toggle">
        <label for="subdomains" style={{ margin: 0 }}>
          <span>{t("ui_match_subdomains")}</span>
          <small>{t("ui_subdomain_help")}</small>
        </label>
        <input
          id="subdomains"
          type="checkbox"
          checked={status.subdomains}
          disabled={status.phase === "setup"}
          onChange={(e) => void save({ subdomains: (e.target as HTMLInputElement).checked })}
        />
      </div>
      <div class="toggle">
        <label for="strict" style={{ margin: 0 }}>
          <span>{t("ui_only_clear_what_nedra_copied")}</span>
          <small>{t("ui_clipboard_help")}</small>
        </label>
        <input
          id="strict"
          type="checkbox"
          checked={status.strictClipboard}
          disabled={status.phase === "setup"}
          onChange={(e) => void toggleStrict((e.target as HTMLInputElement).checked)}
        />
      </div>
      {status.mode === "desktop" ? (
        <p>{t("ui_desktop_lock_hint")}</p>
      ) : (
        <p>{t("ui_server_lock_hint", formatTimeout(status.idleTimeoutMs))}</p>
      )}
      <h2 style={{ marginTop: "18px" }}>{t("ui_keyboard_shortcuts")}</h2>
      <p>
        {t("ui_shortcut_hint")} <code>Alt+Shift+M</code>. {t("ui_fill_this_page")}{" "}
        <code>{/Mac/.test(navigator.platform) ? "⌘+Shift+L" : "Ctrl+Shift+L"}</code>.
      </p>
      {TARGET === "chromium" ? (
        <button class="button" onClick={shortcuts}>
          {t("ui_change_shortcuts")}
        </button>
      ) : (
        <p>{t("ui_firefox_shortcuts")}</p>
      )}
    </section>
  );
};

const About = () => (
  <section aria-labelledby="about">
    <h2 id="about">{t("ui_about")}</h2>
    <p>{t("ui_about_description", VERSION)}</p>
    <p>
      {t("ui_verify_install")} <code>shasum -a 256 -c SHA256SUMS</code>.{" "}
      {t("ui_reproducible_build")}
    </p>
  </section>
);

const App = () => {
  const [status, setStatus] = useState<Status | null>(null);
  const reload = useCallback(() => {
    send<Status>({ type: "status" }).then(setStatus, () => setStatus(null));
  }, []);
  useEffect(reload, [reload]);

  return (
    <main>
      <h1>
        <span class="brand-mark">
          <NedraIcon size={28} />
        </span>
        <span class="wordmark">Nedra</span>
      </h1>
      <p class="tagline">{t("ui_your_secrets_stay_in_the_dark")}</p>
      {status ? (
        <>
          <Mode status={status} reload={reload} />
          <Preferences status={status} reload={reload} />
        </>
      ) : (
        <p class="muted">{t("ui_loading_33ce41")}</p>
      )}
      <About />
    </main>
  );
};

const root = document.getElementById("app");
if (root) render(<App />, root);
