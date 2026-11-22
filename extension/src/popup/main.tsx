import { render } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";

import { ext, sha256Hex, t } from "../shared/browser";
import { CLIPBOARD_CLEAR_MS } from "../shared/constants";
import type { FillOutcome, Login, PageInfo, Status } from "../shared/messages";
import { unicodeHost } from "../shared/url";
import { BackgroundError, Icon, NedraIcon, send } from "../ui/shared";

interface Listing {
  page: PageInfo;
  logins: Login[];
  truncated: boolean;
}

type Toast = { text: string; tone: "ok" | "bad" | "warn" } | null;

type Prompt =
  | { kind: "mismatch"; login: Login }
  | { kind: "insecure"; login: Login; canFill: boolean }
  | { kind: "no-fields"; login: Login; text: string }
  | null;

const AVATAR_COLORS = ["#7dd3c0", "#a8e6d8", "#e0982f", "#8b9dc9", "#d9a3c7", "#9fd18b"];

const avatarColor = (name: string): string => {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length] ?? "#7dd3c0";
};

const initial = (name: string): string => (Array.from(name.trim())[0] ?? "?").toUpperCase();

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl+";

const targetTab = async (): Promise<number | null> => {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
};

const focusOnMount = (element: HTMLElement | null): void => element?.focus();

const close = () => {
  window.close();
};

const FILL_MESSAGES: Record<string, string> = {
  "username-only": t("ui_fill_username_only"),
  "password-only": t("ui_fill_password_only"),
  "no-fields": t("ui_fill_no_fields"),
  hidden: t("ui_fill_hidden"),
  "new-password": t("ui_fill_new_password"),
  origin: t("ui_fill_origin"),
  frame: t("ui_fill_frame"),
  blocked: t("ui_fill_blocked"),
};

const Header = ({
  onLock,
  lockLabel = t("ui_lock"),
}: {
  onLock?: () => void;
  lockLabel?: string;
}) => (
  <header class="top">
    <span class="brand-mark">
      <NedraIcon />
    </span>
    <span class="wordmark">Nedra</span>
    {onLock && (
      <button class="icon-button" title={lockLabel} aria-label={lockLabel} onClick={onLock}>
        <Icon name="lock" />
      </button>
    )}
    <button
      class="icon-button"
      title={t("ui_settings")}
      aria-label={t("ui_settings")}
      onClick={() => {
        void ext.runtime.openOptionsPage();
        close();
      }}
    >
      <Icon name="gear" />
    </button>
  </header>
);

const Ring = ({ seconds }: { seconds: number }) => {
  const radius = 6;
  const length = 2 * Math.PI * radius;
  return (
    <svg class="ring" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        stroke="currentColor"
        opacity="0.25"
        stroke-width="2"
      />
      <circle
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-dasharray={`${(length * seconds) / 30} ${length}`}
      />
    </svg>
  );
};

const Setup = () => (
  <main class="centered">
    <div class="hero">
      <NedraIcon size={44} />
    </div>
    <h1>{t("ui_fill_logins_from_your_nedra")}</h1>
    <p>{t("ui_connect_this_browser_to_your_own_nedra_server_no_account_nothing_in_between")}</p>
    <button
      class="button primary"
      ref={focusOnMount}
      onClick={() => {
        void ext.runtime.openOptionsPage();
        close();
      }}
    >
      {t("ui_set_up_nedra")}
    </button>
  </main>
);

const Problem = ({ status, onRetry }: { status: Status; onRetry: () => void }) => (
  <main class="centered" role="alert">
    <h1>
      {status.phase === "too-old" ? t("ui_nedra_needs_an_update") : t("ui_can_t_reach_nedra")}
    </h1>
    <p>{status.error}</p>
    <div class="stack">
      {status.phase === "offline" && (
        <button class="button primary" ref={focusOnMount} onClick={onRetry}>
          {t("ui_try_again")}
        </button>
      )}
      <button
        class="button"
        onClick={() => {
          void ext.runtime.openOptionsPage();
          close();
        }}
      >
        {t("ui_open_settings")}
      </button>
    </div>
  </main>
);

const Locked = ({ status, onUnlocked }: { status: Status; onUnlocked: (s: Status) => void }) => {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [needsHandoff, setNeedsHandoff] = useState(false);

  const submit = async (event: Event) => {
    event.preventDefault();
    if (!username || !password || busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await send<Status>({ type: "unlock", username, password });
      setPassword("");
      onUnlocked(next);
    } catch (err) {
      if (err instanceof BackgroundError && err.code === "use_handoff") setNeedsHandoff(true);
      setError(err instanceof Error ? err.message : t("ui_error_could_not_unlock"));
    } finally {
      setBusy(false);
    }
  };

  const handoff = async () => {
    setError("");
    try {
      await send({ type: "handoff" });
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("ui_error_could_not_open_nedra"));
    }
  };

  return (
    <main class="centered">
      <h1>{t("ui_unlock")}</h1>
      <p class="mono" style={{ fontSize: "12px" }}>
        {status.vault}
      </p>
      {status.handoffPending && <p class="warn">{t("ui_handoff_pending")}</p>}
      {!needsHandoff && (
        <form class="stack" onSubmit={submit}>
          <label class="sr-only" for="username">
            {t("ui_username")}
          </label>
          <input
            id="username"
            class="field"
            type="text"
            autoComplete="username"
            placeholder={t("ui_username")}
            ref={focusOnMount}
            value={username}
            onInput={(e) => setUsername((e.target as HTMLInputElement).value)}
          />
          <label class="sr-only" for="password">
            {t("ui_password")}
          </label>
          <input
            id="password"
            class="field"
            type="password"
            autoComplete="current-password"
            placeholder={t("ui_password")}
            value={password}
            onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
          />
          <button class="button primary" type="submit" disabled={busy || !username || !password}>
            {busy ? t("ui_unlocking") : t("ui_unlock")}
          </button>
        </form>
      )}
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      <button class="button" onClick={handoff} ref={needsHandoff ? focusOnMount : null}>
        <Icon name="shield" size={16} /> {t("ui_unlock_in_nedra")}
      </button>
      {!needsHandoff && (
        <p style={{ fontSize: "12px" }}>
          {t("ui_use_this_for_a_security_key_passkey_or_touch_id")}
        </p>
      )}
    </main>
  );
};

const openSettings = () => {
  void ext.runtime.openOptionsPage();
  close();
};

const spacedCode = (code: string | null): string =>
  code && /^\d{6}$/.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : "";

const Notice = ({
  title,
  children,
  action,
}: {
  title: string;
  children: preact.ComponentChildren;
  action?: preact.ComponentChildren;
}) => (
  <main class="centered" role="status">
    <h1>{title}</h1>
    {children}
    <div class="stack">
      {action}
      <button class="button" onClick={openSettings}>
        {t("ui_open_settings")}
      </button>
    </div>
  </main>
);

const Unpaired = ({ status, onChange }: { status: Status; onChange: (s: Status) => void }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(status.error ?? "");
  const pair = async () => {
    setBusy(true);
    setError("");
    try {
      onChange(await send<Status>({ type: "pair" }));
    } catch (err) {
      setError(
        err instanceof BackgroundError && err.code === "locked"
          ? t("ui_unlock_first")
          : err instanceof Error
            ? err.message
            : t("ui_error_could_not_pair")
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <main class="centered">
      <div class="hero">
        <NedraIcon size={44} />
      </div>
      <h1>{t("ui_pair_with_the_nedra_app")}</h1>
      <p>
        {t(
          "ui_fill_logins_from_nedra_on_this_computer_you_confirm_a_code_in_the_app_once_for_this_browser"
        )}
      </p>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      <button class="button primary" ref={focusOnMount} onClick={pair} disabled={busy}>
        {busy ? t("ui_pairing") : t("ui_pair")}
      </button>
    </main>
  );
};

const Pairing = ({ status, onCancel }: { status: Status; onCancel: () => void }) => {
  const code = spacedCode(status.pairingCode);
  return (
    <main class="centered">
      <h1>{t("ui_confirm_in_nedra")}</h1>
      <p>{t("ui_nedra_asks_whether_to_allow_this_browser_check_that_it_shows_this_code")}</p>
      <p class="pairing-code" aria-label={t("ui_pairing_code", code)}>
        {code}
      </p>
      <p style={{ fontSize: "12px" }}>
        {t("ui_choose_allow_in_nedra_if_both_codes_match_if_they_differ_choose_don_t_allow")}
      </p>
      <button
        class="button"
        ref={focusOnMount}
        onClick={() => {
          void send({ type: "cancel-pair" }).finally(onCancel);
        }}
      >
        {t("ui_cancel")}
      </button>
    </main>
  );
};

const NoApp = () => {
  const [state, setState] = useState<"idle" | "starting" | "failed">("idle");
  const [error, setError] = useState("");
  const start = async () => {
    setState("starting");
    try {
      await send({ type: "open-app" });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("ui_error_could_not_start_nedra"));
      setState("failed");
    }
  };
  return (
    <Notice
      title={t("ui_nedra_isn_t_running")}
      action={
        <button
          class="button primary"
          ref={focusOnMount}
          onClick={start}
          disabled={state === "starting"}
        >
          {state === "starting" ? t("ui_opening") : t("ui_open_nedra")}
        </button>
      }
    >
      <p>{t("ui_open_the_nedra_app_on_this_computer_to_fill_logins")}</p>
      {state === "failed" && (
        <p class="error" role="alert">
          {error} {t("ui_open_it_yourself")}
        </p>
      )}
    </Notice>
  );
};

const DesktopLocked = () => {
  const [error, setError] = useState("");
  const show = async () => {
    setError("");
    try {
      await send({ type: "show-app" });
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("ui_error_could_not_reach_nedra"));
    }
  };
  return (
    <main class="centered">
      <h1>{t("ui_nedra_is_locked")}</h1>
      <p>{t("ui_unlock_it_in_the_app_with_your_master_password_security_key_or_touch_id")}</p>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      <button class="button primary" ref={focusOnMount} onClick={show}>
        <Icon name="shield" size={16} /> {t("ui_unlock_in_nedra")}
      </button>
    </main>
  );
};

const Unlocked = ({
  vault,
  desktop,
  onLocked,
}: {
  vault: string | null;
  desktop: boolean;
  onLocked: () => void;
}) => {
  const [listing, setListing] = useState<Listing | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Login[] | null>(null);
  const [selected, setSelected] = useState(0);
  const [toast, setToast] = useState<Toast>(null);
  const [prompt, setPrompt] = useState<Prompt>(null);
  const [codes, setCodes] = useState<Record<number, { code: string; until: number }>>({});
  const [now, setNow] = useState(Date.now());
  const searchRef = useRef<HTMLInputElement>(null);
  const loaded = Boolean(listing);
  useEffect(() => {
    if (loaded) searchRef.current?.focus();
  }, [loaded]);

  const fail = useCallback(
    (err: unknown) => {
      if (
        err instanceof BackgroundError &&
        (err.code === "invalid_session" || err.code === "locked")
      )
        return onLocked();
      setToast({
        text: err instanceof Error ? err.message : t("ui_error_something_went_wrong"),
        tone: "bad",
      });
    },
    [onLocked]
  );

  useEffect(() => {
    (async () => {
      const tabId = await targetTab();
      if (tabId === null) {
        setListing({
          page: { tabId: -1, origin: null, host: null, insecure: false },
          logins: [],
          truncated: false,
        });
        return;
      }
      setListing(await send<Listing>({ type: "matches", tabId }));
    })().catch(fail);
  }, [fail]);

  useEffect(() => {
    if (!query.trim()) {
      setResults(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      send<{ logins: Login[] }>({ type: "search", query })
        .then((found) => {
          if (!live) return;
          setResults(found.logins);
          setSelected(0);
        })
        .catch((error) => {
          if (live) fail(error);
        });
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, fail]);

  useEffect(() => {
    if (!Object.keys(codes).length) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [codes]);

  const page = listing?.page ?? null;
  const matchIds = useMemo(() => new Set(listing?.logins.map((l) => l.id)), [listing]);
  const rows = results ?? listing?.logins ?? [];
  const current = rows[Math.min(selected, rows.length - 1)];

  const copy = async (login: Login, what: "password" | "username" | "totp") => {
    const origin = page?.origin ?? "https://invalid.invalid";
    const confirmed = !matchIds.has(login.id);
    try {
      let value: string;
      let label: string;
      if (what === "totp") {
        const totp = await send<{ code: string; expiresIn: number }>({
          type: "totp",
          id: login.id,
          origin,
          confirmed,
        });
        value = totp.code;
        label = t("ui_2fa_code");
        setCodes((all) => ({
          ...all,
          [login.id]: { code: totp.code, until: Date.now() + totp.expiresIn * 1000 },
        }));
      } else {
        const credential = await send<{ username: string | null; password: string }>({
          type: "credential",
          id: login.id,
          origin,
          confirmed,
        });
        value = (what === "password" ? credential.password : credential.username) ?? "";
        label = what === "password" ? t("ui_password") : t("ui_username");
      }
      await navigator.clipboard.writeText(value);
      await send({ type: "copied", digest: await sha256Hex(value) });
      setToast({
        text: t("ui_copied_clears", [label, String(Math.round(CLIPBOARD_CLEAR_MS / 1000))]),
        tone: "ok",
      });
    } catch (err) {
      fail(err);
    }
  };

  const doFill = async (login: Login, confirmed: boolean) => {
    if (!page?.origin) return;
    setPrompt(null);
    try {
      const outcome = await send<FillOutcome>({
        type: "fill",
        tabId: page.tabId,
        id: login.id,
        origin: page.origin,
        confirmed,
      });
      if (outcome.reason === "filled" || outcome.reason === "password-only") {
        setToast({ text: FILL_MESSAGES[outcome.reason] ?? t("ui_filled"), tone: "ok" });
        if (outcome.reason === "filled") close();
        return;
      }
      if (outcome.reason === "username-only") {
        setToast({ text: FILL_MESSAGES["username-only"] ?? "", tone: "ok" });
        return;
      }
      setPrompt({ kind: "no-fields", login, text: FILL_MESSAGES[outcome.reason] ?? "" });
    } catch (err) {
      fail(err);
    }
  };

  const fill = (login: Login) => {
    setToast(null);
    if (!page?.origin) {
      setToast({
        text: t("ui_error_no_web_page_to_fill"),
        tone: "warn",
      });
      return;
    }
    const matched = matchIds.has(login.id);
    if (page.insecure) {
      setPrompt({ kind: "insecure", login, canFill: matched });
      return;
    }
    if (!matched) {
      setPrompt({ kind: "mismatch", login });
      return;
    }
    void doFill(login, false);
  };

  const lockNow = async () => {
    try {
      await send({ type: "lock" });
      onLocked();
    } catch (err) {
      fail(err);
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const mod = isMac ? event.metaKey : event.ctrlKey;
    if (event.key === "Escape") {
      event.preventDefault();
      if (prompt) setPrompt(null);
      else close();
      return;
    }
    if (prompt) return;
    if (event.key === "ArrowDown" && document.activeElement === searchRef.current) {
      event.preventDefault();
      setSelected((s) => Math.min(s + 1, Math.max(rows.length - 1, 0)));
    } else if (event.key === "ArrowUp" && document.activeElement === searchRef.current) {
      event.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (event.key === "Enter" && current && document.activeElement === searchRef.current) {
      event.preventDefault();
      fill(current);
    } else if (mod && event.key.toLowerCase() === "c" && current) {
      const input = searchRef.current;
      const selecting =
        input && document.activeElement === input && input.selectionStart !== input.selectionEnd;
      if (selecting) return;
      event.preventDefault();
      void copy(current, event.shiftKey ? "username" : "password");
    }
  };

  const keyHandler = useRef(onKeyDown);
  keyHandler.current = onKeyDown;
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keyHandler.current(event);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);

  if (!listing) {
    return (
      <>
        <Header onLock={lockNow} lockLabel={desktop ? t("ui_lock_nedra") : t("ui_lock")} />
        <div class="loading" aria-label={t("ui_loading")}>
          <NedraIcon size={32} />
        </div>
      </>
    );
  }

  const unicode = page?.host ? unicodeHost(page.host.replace(/^http:\/\//, "")) : null;
  const listLabel = results ? t("ui_search_results") : t("ui_logins_for_this_site");

  return (
    <div>
      <Header onLock={lockNow} lockLabel={desktop ? t("ui_lock_nedra") : t("ui_lock")} />
      <div class="page mono" title={unicode ? `${page?.host} (${unicode})` : (page?.host ?? "")}>
        {page?.host ? (
          page.insecure ? (
            <span class="insecure">
              ⚠ {page.host} · {t("ui_insecure_label")}
            </span>
          ) : (
            page.host
          )
        ) : (
          t("ui_no_web_page_in_this_tab")
        )}
      </div>
      <div class="search">
        <span class="glass">
          <Icon name="search" size={16} />
        </span>
        <label class="sr-only" for="search">
          {t("ui_search_logins")}
        </label>
        <input
          id="search"
          ref={searchRef}
          class="field"
          type="search"
          placeholder={t("ui_search_logins")}
          autoComplete="off"
          spellcheck={false}

          role="combobox"
          aria-controls="logins"
          aria-expanded="true"
          aria-activedescendant={current ? `login-${current.id}` : undefined}
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
        />
      </div>

      {prompt && (
        <div
          class="panel"
          role="alertdialog"
          aria-label={t("ui_confirm_fill")}
          aria-live="assertive"
        >
          {prompt.kind === "mismatch" && (
            <>
              <p>
                {t("ui_mismatch_prompt", [
                  prompt.login.host ?? t("ui_no_website"),
                  page?.host ?? "",
                ])}
              </p>
              <div class="buttons">
                <button class="button" onClick={() => setPrompt(null)}>
                  {t("ui_cancel")}
                </button>
                <button
                  class="button primary"
                  ref={focusOnMount}
                  onClick={() => void doFill(prompt.login, true)}
                >
                  {t("ui_fill_anyway")}
                </button>
              </div>
            </>
          )}
          {prompt.kind === "insecure" && (
            <>
              <p>{t("ui_insecure_prompt")}</p>
              <div class="buttons">
                <button class="button" onClick={() => setPrompt(null)}>
                  {t("ui_cancel")}
                </button>
                {prompt.canFill && (
                  <button class="button" onClick={() => void doFill(prompt.login, false)}>
                    {t("ui_fill_anyway")}
                  </button>
                )}
                <button
                  class="button primary"
                  ref={focusOnMount}
                  onClick={() => {
                    setPrompt(null);
                    void copy(prompt.login, "password");
                  }}
                >
                  {t("ui_copy_password")}
                </button>
              </div>
            </>
          )}
          {prompt.kind === "no-fields" && (
            <>
              <p>{prompt.text}</p>
              <div class="buttons">
                <button class="button" onClick={() => setPrompt(null)}>
                  {t("ui_close")}
                </button>
                <button
                  class="button primary"
                  ref={focusOnMount}
                  onClick={() => {
                    setPrompt(null);
                    void copy(prompt.login, "password");
                  }}
                >
                  {t("ui_copy_password")}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {toast && (
        <div
          class={`toast ${toast.tone === "ok" ? "" : toast.tone}`}
          role={toast.tone === "bad" ? "alert" : "status"}
        >
          {toast.text}
        </div>
      )}

      {rows.length === 0 ? (
        <div class="empty">
          {results
            ? t("ui_no_logins_match_your_search")
            : page?.origin
              ? t("ui_no_logins_saved_for_this_site_search_all_your_logins_above")
              : t("ui_search_your_logins_to_copy_one")}
          {vault && (
            <div>
              <button
                class="button"
                onClick={() => {
                  void ext.tabs.create({ url: vault });
                  close();
                }}
              >
                {t("ui_open_nedra")}
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          <div class="section-label" id="logins-label">
            {listLabel}
          </div>
          <ul class="list" id="logins" role="listbox" aria-labelledby="logins-label">
            {rows.map((login, index) => {
              const code = codes[login.id];
              const left = code ? Math.max(0, Math.ceil((code.until - now) / 1000)) : 0;
              const sub =
                results || !matchIds.has(login.id)
                  ? [login.username, login.host].filter(Boolean).join(" · ")
                  : (login.username ?? "");
              return (
                <li
                  key={login.id}
                  id={`login-${login.id}`}
                  class="row"
                  role="option"
                  aria-selected={index === selected}
                  title={`${login.name}${sub ? ` — ${sub}` : ""}`}
                  onMouseEnter={() => setSelected(index)}
                  onClick={() => fill(login)}
                >
                  <span
                    class="avatar"
                    style={{ background: avatarColor(login.name) }}
                    aria-hidden="true"
                  >
                    {initial(login.name)}
                  </span>
                  <span class="who">
                    <span class="name">
                      {login.name}
                      {login.favorite && (
                        <span class="star" aria-label={t("ui_favorite")}>
                          <Icon name="star" size={13} />
                        </span>
                      )}
                    </span>
                    {sub && <span class="sub">{sub}</span>}
                  </span>
                  <span class="actions" onClick={(e) => e.stopPropagation()}>
                    {code && left > 0 && (
                      <span class="code" aria-label={t("ui_code_left", [code.code, String(left)])}>
                        {code.code}
                        <Ring seconds={left} />
                      </span>
                    )}
                    {login.username && (
                      <button
                        class="icon-button"
                        title={t("ui_copy_username")}
                        aria-label={t("ui_copy_username_for", login.name)}
                        onClick={() => void copy(login, "username")}
                      >
                        <Icon name="user" size={17} />
                      </button>
                    )}
                    <button
                      class="icon-button"
                      title={t("ui_copy_password")}
                      aria-label={t("ui_copy_password_for", login.name)}
                      onClick={() => void copy(login, "password")}
                    >
                      <Icon name="key" size={17} />
                    </button>
                    {login.has_totp && (
                      <button
                        class="icon-button"
                        title={t("ui_copy_2fa_code")}
                        aria-label={t("ui_copy_2fa_for", login.name)}
                        onClick={() => void copy(login, "totp")}
                      >
                        <Icon name="timer" size={17} />
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <footer class="hint">
        {t("ui_footer_fill")} <kbd>Enter</kbd> · {t("ui_footer_copy")} <kbd>{MOD}C</kbd> ·{" "}
        {t("ui_footer_username")} <kbd>{MOD}⇧C</kbd>
      </footer>
    </div>
  );
};

const WAITING: Partial<Record<Status["phase"], number>> = {
  pairing: 1000,
  locked: 1000,
  "no-app": 3000,
  "no-host": 3000,
};

const App = () => {
  const [status, setStatus] = useState<Status | null>(null);

  const fetchStatus = useCallback(
    () =>
      send<Status>({ type: "status" }).catch((err: unknown): Status => ({
        phase: "offline",
        mode: null,
        vault: null,
        api: null,
        serverVersion: null,
        idleTimeoutMs: null,
        subdomains: false,
        strictClipboard: false,
        handoffPending: false,
        pairingCode: null,
        error: err instanceof Error ? err.message : t("ui_error_something_went_wrong"),
      })),
    []
  );

  const load = useCallback(() => {
    setStatus(null);
    void fetchStatus().then(setStatus);
  }, [fetchStatus]);

  useEffect(load, [load]);

  const desktop = status?.mode === "desktop";
  const every = desktop && status !== null ? WAITING[status.phase] : undefined;
  useEffect(() => {
    if (!every) return;
    const timer = setInterval(() => void fetchStatus().then(setStatus), every);
    return () => clearInterval(timer);
  }, [every, fetchStatus]);

  if (!status) {
    return (
      <div class="loading" aria-label={t("ui_loading")}>
        <NedraIcon size={32} />
      </div>
    );
  }
  switch (status.phase) {
    case "setup":
      return <Setup />;
    case "too-old":
    case "offline":
      return (
        <>
          <Header />
          <Problem status={status} onRetry={load} />
        </>
      );
    case "locked":
      return (
        <>
          <Header />
          {desktop ? <DesktopLocked /> : <Locked status={status} onUnlocked={setStatus} />}
        </>
      );
    case "unsupported":
      return (
        <>
          <Header />
          <Notice title={t("ui_browser_too_old")}>
            <p>{t("ui_browser_update")}</p>
          </Notice>
        </>
      );
    case "unpaired":
      return (
        <>
          <Header />
          <Unpaired status={status} onChange={setStatus} />
        </>
      );
    case "pairing":
      return (
        <>
          <Header />
          <Pairing status={status} onCancel={load} />
        </>
      );
    case "no-host":
      return (
        <>
          <Header />
          <Notice
            title={t("ui_enable_extensions")}
            action={
              <button class="button primary" ref={focusOnMount} onClick={load}>
                {t("ui_try_again")}
              </button>
            }
          >
            <p>{t("ui_enable_extensions_hint")}</p>
          </Notice>
        </>
      );
    case "no-app":
      return (
        <>
          <Header />
          <NoApp />
        </>
      );
    case "unlocked":
      return (
        <Unlocked
          vault={status.vault}
          desktop={desktop}
          onLocked={() => setStatus({ ...status, phase: "locked" })}
        />
      );
  }
};

const root = document.getElementById("app");
if (root) render(<App />, root);
