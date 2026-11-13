import { useEffect, useId, useState } from "react";

import {
  Flex,
  Text,
  Alert,
  Button,
  Col,
  Divider,
  NumberInput,
  Row,
  Switch,
  Tab,
  TabList,
  TabPanel,
  TabProvider,
} from "@gravity-ui/uikit";
import { toaster } from "@gravity-ui/uikit/toaster-singleton";
import { useStoreActions, useStoreState } from "easy-peasy";
import { useTranslation } from "react-i18next";
import apiClient from "../api/client";
import { errorDetail } from "../lib/http";
import { IS_DESKTOP } from "../platform";
import DesktopExtensionSettings from "./extension/DesktopExtensionSettings";
import Dialog from "./TaskSurface";

const FIELDS = [
  {
    key: "inactivity_ms",
    labelKey: "settings.fields.inactivity",
    tooltipKey: "settings.fields.inactivityHelp",
    min: 30,
    max: 3600,
  },
  {
    key: "warn_before_ms",
    labelKey: "settings.fields.warning",
    tooltipKey: "settings.fields.warningHelp",
    min: 5,
    max: 600,
  },
  {
    key: "hidden_ms",
    labelKey: "settings.fields.hidden",
    tooltipKey: "settings.fields.hiddenHelp",
    min: 10,
    max: 3600,
  },
  {
    key: "debounce_ms",
    labelKey: "settings.fields.debounce",
    tooltipKey: "settings.fields.debounceHelp",
    min: 1,
    max: 10,
  },
  {
    key: "clipboard_clear_ms",
    labelKey: "settings.fields.clipboard",
    tooltipKey: "settings.fields.clipboardHelp",
    min: 5,
    max: 600,
  },
];

const toSec = (ms) => Math.round(ms / 1000);
const toMs = (sec) => Math.round(Number(sec)) * 1000;

const toForm = (settings) => ({
  ...Object.fromEntries(FIELDS.map(({ key }) => [key, toSec(settings[key])])),
  update_check_enabled: settings.update_check_enabled ?? true,
});

const isDirty = (form, settings) =>
  FIELDS.some(({ key }) => Number(form[key]) !== toSec(settings[key])) ||
  form.update_check_enabled !== (settings.update_check_enabled ?? true);

const SettingsModal = ({ open, onClose }) => {
  const { t, i18n } = useTranslation();
  const titleId = useId();
  const updatesLabelId = `${titleId}-updates`;

  const { update } = useStoreActions((a) => a.ciphermothModels.settings);
  const settings = useStoreState((s) => s.ciphermothModels.settings.settings);

  const [form, setForm] = useState(() => toForm(settings));
  const [formError, setFormError] = useState("");
  const [invalidKey, setInvalidKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState("general");
  const [sessions, setSessions] = useState([]);
  const [sessionsError, setSessionsError] = useState("");
  const [disconnecting, setDisconnecting] = useState("");

  useEffect(() => {
    if (open) {
      setForm(toForm(settings));
      setFormError("");
      setInvalidKey("");
      setTab("general");
      setSessionsError("");
    }
  }, [open, settings]);

  useEffect(() => {
    if (!open || tab !== "extension") return;
    apiClient
      .get("/extension/sessions")
      .then(({ data }) => setSessions(data))
      .catch(async (err) => setSessionsError(await errorDetail(err, t("extension.loadError"))));
  }, [open, tab, t]);

  const disconnect = async (id) => {
    setDisconnecting(id);
    setSessionsError("");
    try {
      await apiClient.delete(`/extension/sessions/${encodeURIComponent(id)}`);
      setSessions((current) => current.filter((session) => session.id !== id));
    } catch (err) {
      setSessionsError(await errorDetail(err, t("extension.disconnectError")));
    } finally {
      setDisconnecting("");
    }
  };

  const handleSave = async () => {
    const invalidField = FIELDS.find(({ key, min, max }) => {
      const value = Number(form[key]);
      return !Number.isInteger(value) || value < min || value > max;
    });
    if (invalidField) {
      setInvalidKey(invalidField.key);
      document.getElementById(`${titleId}-${invalidField.key}`)?.focus();
      setFormError(
        t("settings.rangeValidation", {
          label: t(invalidField.labelKey),
          min: invalidField.min,
          max: invalidField.max,
        })
      );
      return;
    }
    if (Number(form.warn_before_ms) >= Number(form.inactivity_ms)) {
      setInvalidKey("warn_before_ms");
      document.getElementById(`${titleId}-warn_before_ms`)?.focus();
      setFormError(t("settings.warningValidation"));
      return;
    }
    setSaving(true);
    try {
      await update({
        ...Object.fromEntries(FIELDS.map(({ key }) => [key, toMs(form[key])])),
        update_check_enabled: form.update_check_enabled,
      });
      toaster.add({ name: "settings-saved", theme: "success", title: t("settings.saved") });
      onClose();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const dirty = isDirty(form, settings);

  return (
    <Dialog
      aria-labelledby={titleId}

      contentOverflow="auto"
      disableEscapeKeyDown={saving}
      disableOutsideClick={saving}
      fullWidth
      hasCloseButton={false}
      maxWidth="m"
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !saving) onClose();
      }}
      open={open}
    >
      <Dialog.Header caption={t("settings.title")} id={titleId} />
      <Dialog.Body>
        <TabProvider value={tab} onUpdate={setTab}>
          <TabList contentOverflow="scroll" size="l">
            <Tab value="general">{t("settings.general")}</Tab>
            <Tab value="extension">{t("extension.title")}</Tab>
          </TabList>
          <TabPanel value="general">
            <Flex direction="column" gap="spacing-5" minWidth="0">
              {FIELDS.map(({ key, labelKey, tooltipKey, min, max }) => {
                const inputId = `${titleId}-${key}`;
                return (
                  <Row gap="spacing-3" alignItems="center" key={key}>
                    <Col size={{ xs: 12, s: 8 }} minWidth="0">
                      <Flex direction="column" gap="spacing-1">
                        <Text as="label" htmlFor={inputId} variant="subheader-1">
                          {t(labelKey)}
                        </Text>
                        <Text color="secondary" variant="caption-2">
                          {t(tooltipKey)}
                        </Text>
                      </Flex>
                    </Col>
                    <Col size={{ xs: 12, s: 4 }} minWidth="0">
                      <NumberInput
                        endContent={
                          <Text color="secondary">{t("common.labels.secondsShort")}</Text>
                        }
                        id={inputId}
                        validationState={invalidKey === key ? "invalid" : undefined}
                        errorMessage={invalidKey === key ? formError : undefined}
                        min={min}
                        max={max}
                        step={1}
                        onUpdate={(value) => {
                          setForm((prev) => ({ ...prev, [key]: value }));
                          setFormError("");
                          setInvalidKey("");
                        }}
                        size="xl"
                        value={form[key]}
                      />
                    </Col>
                  </Row>
                );
              })}
              <Divider />
              <Flex gap="spacing-4" minWidth="0" alignItems="center" justifyContent="space-between">
                <Flex direction="column" gap="spacing-1" minWidth="0">
                  <Text variant="subheader-1" wordBreak="break-word" id={updatesLabelId}>
                    {t("settings.fields.updates")}
                  </Text>
                  <Text color="secondary" variant="caption-2">
                    {t("settings.fields.updatesHelp")}
                  </Text>
                </Flex>
                <Switch
                  checked={form.update_check_enabled}
                  controlProps={{ "aria-labelledby": updatesLabelId }}
                  onUpdate={(checked) =>
                    setForm((prev) => ({ ...prev, update_check_enabled: checked }))
                  }
                  size="l"
                />
              </Flex>
              {formError && !invalidKey && (
                <Flex direction="column" gap="spacing-3" minWidth="0" role="alert">
                  <Alert message={formError} size="s" theme="danger" />
                </Flex>
              )}
            </Flex>
          </TabPanel>
          <TabPanel value="extension">
            {IS_DESKTOP ? (
              <DesktopExtensionSettings open={open} />
            ) : (
              <Flex direction="column" gap="spacing-4" minWidth="0">
                <Flex direction="column" gap="spacing-1">
                  <Text variant="subheader-1">{t("extension.connected")}</Text>
                  <Text color="secondary" variant="caption-2">
                    {t("extension.description")}
                  </Text>
                </Flex>
                {sessionsError && <Alert message={sessionsError} size="s" theme="danger" />}
                {sessions.length ? (
                  <Flex
                    aria-label={t("extension.connected")}
                    direction="column"
                    gap="spacing-3"
                    role="list"
                  >
                    {sessions.map((session) => (
                      <Row alignItems="center" gap="spacing-3" key={session.id} role="listitem">
                        <Col minWidth="0" size={{ xs: 12, s: 8 }}>
                          <Flex direction="column" gap="spacing-1">
                            <Text variant="subheader-1" wordBreak="break-word">
                              {session.browser}
                            </Text>
                            <Text color="secondary" variant="caption-2">
                              {t("extension.connectedAt", {
                                date: new Date(session.created).toLocaleString(
                                  i18n.resolvedLanguage
                                ),
                              })}
                            </Text>
                            <Text color="secondary" variant="caption-2">
                              {t("extension.lastUsed", {
                                date: new Date(session.last_used).toLocaleString(
                                  i18n.resolvedLanguage
                                ),
                              })}
                            </Text>
                          </Flex>
                        </Col>
                        <Col size={{ xs: 12, s: 4 }}>
                          <Button
                            disabled={disconnecting === session.id}
                            loading={disconnecting === session.id}
                            onClick={() => disconnect(session.id)}
                            size="l"
                            view="outlined-danger"
                          >
                            {t("extension.disconnect", { browser: session.browser })}
                          </Button>
                        </Col>
                      </Row>
                    ))}
                  </Flex>
                ) : (
                  <Text color="secondary">{t("extension.empty")}</Text>
                )}
              </Flex>
            )}
          </TabPanel>
        </TabProvider>
      </Dialog.Body>
      <Dialog.Footer
        loading={tab === "general" && saving}
        onClickButtonApply={tab === "general" ? handleSave : undefined}
        onClickButtonCancel={onClose}
        propsButtonApply={{
          disabled: tab !== "general" || !dirty,
          style: { display: tab === "general" ? undefined : "none" },
        }}
        textButtonApply={t("common.actions.save")}
        textButtonCancel={t("common.actions.cancel")}
      />
    </Dialog>
  );
};

export default SettingsModal;
