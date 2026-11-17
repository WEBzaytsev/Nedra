import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Flex, Switch, Text } from "@gravity-ui/uikit";
import { useTranslation } from "react-i18next";

import { allowExtensions, extensionStatus, unpairBrowser } from "../../platform/extension";

export default function DesktopExtensionSettings({ open }) {
  const { t, i18n } = useTranslation();
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(
    () =>
      extensionStatus()
        .then(setStatus)
        .catch(() => setStatus(null)),
    []
  );
  useEffect(() => {
    if (!open) return undefined;
    void refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [open, refresh]);

  const toggle = async (enabled) => {
    setBusy(true);
    try {
      setStatus(await allowExtensions(enabled));
    } finally {
      setBusy(false);
    }
  };
  const unpair = async (id) => {
    setBusy(true);
    try {
      setStatus(await unpairBrowser(id));
    } finally {
      setBusy(false);
    }
  };

  if (!status) return <Text color="secondary">{t("desktopExtension.unavailable")}</Text>;
  return (
    <Flex direction="column" gap="spacing-4" minWidth="0">
      <Flex alignItems="center" gap="spacing-3" justifyContent="space-between">
        <Flex direction="column" gap="spacing-1" minWidth="0">
          <Text variant="subheader-1">{t("desktopExtension.allow")}</Text>
          <Text color="secondary" variant="caption-2">
            {t("desktopExtension.description")}
          </Text>
        </Flex>
        <Switch
          checked={status.enabled}
          controlProps={{ "aria-label": t("desktopExtension.allow") }}
          disabled={busy}
          onUpdate={toggle}
          size="l"
        />
      </Flex>
      {status.error && <Alert message={status.error} size="s" theme="warning" />}
      {status.enabled && (
        <Text color="secondary" variant="caption-2">
          {status.browsers.length
            ? t("desktopExtension.available", { browsers: status.browsers.join(", ") })
            : t("desktopExtension.noBrowsers")}
        </Text>
      )}
      <Flex
        aria-label={t("desktopExtension.paired")}
        direction="column"
        gap="spacing-3"
        role="list"
      >
        <Text variant="subheader-1">{t("desktopExtension.paired")}</Text>
        {status.pairings.length ? (
          status.pairings.map((pairing) => (
            <Flex
              alignItems={{ xs: "stretch", s: "center" }}
              direction={{ xs: "column", s: "row" }}
              gap="spacing-3"
              justifyContent="space-between"
              key={pairing.id}
              role="listitem"
            >
              <Flex direction="column" gap="spacing-1" minWidth="0">
                <Text variant="body-2">{pairing.browser}</Text>
                <Text color="secondary" variant="caption-2">
                  {t("desktopExtension.pairedAt", {
                    date: pairing.created
                      ? new Date(pairing.created).toLocaleString(i18n.resolvedLanguage)
                      : "—",
                  })}
                </Text>
                {pairing.lastUsed && (
                  <Text color="secondary" variant="caption-2">
                    {t("desktopExtension.lastUsed", {
                      date: new Date(pairing.lastUsed).toLocaleString(i18n.resolvedLanguage),
                    })}
                  </Text>
                )}
              </Flex>
              <Button
                disabled={busy}
                loading={busy}
                onClick={() => unpair(pairing.id)}
                size="l"
                view="outlined-danger"
              >
                {t("desktopExtension.remove", { browser: pairing.browser })}
              </Button>
            </Flex>
          ))
        ) : (
          <Text color="secondary">{t("desktopExtension.empty")}</Text>
        )}
      </Flex>
    </Flex>
  );
}
