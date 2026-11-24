import { useCallback, useEffect, useId, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Flex,
  Select,
  Text,
  TextInput,
  useLayoutContext,
} from "@gravity-ui/uikit";
import { useTranslation } from "react-i18next";

import apiClient from "../api/client";
import { endSession } from "../api/session";
import { errorDetail } from "../lib/http";
import { errorMessage } from "../lib/errorMessage";
import { registerSecurityKey } from "../lib/securityKey";
import { securityKeyStepUp } from "../lib/securityStepUp";
import { IS_DESKTOP } from "../platform";
import {
  biometricAvailable,
  biometricEnroll,
  biometricRemove,
  biometricStatus,
} from "../platform/biometric";
import { getCurrentUser, getSessionToken } from "../utils";
import PasswordField from "./PasswordField";
import Dialog from "./TaskSurface";

const dialogError = (error, fallback) =>
  typeof error === "string"
    ? errorMessage(error, fallback)
    : errorDetail(error, error?.isAxiosError ? fallback : errorMessage(error, fallback));

const SecurityKeyDialog = ({ open, onClose }) => {
  const { t } = useTranslation();
  const { isMediaActive } = useLayoutContext();
  const phone = !isMediaActive("s");
  const titleId = useId();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState("overview");
  const [target, setTarget] = useState(null);
  const [enabled, setEnabled] = useState(false);
  const [keys, setKeys] = useState([]);
  const [devices, setDevices] = useState([]);
  const [touchIdAvailable, setTouchIdAvailable] = useState(false);
  const [passwordIntervalDays, setPasswordIntervalDays] = useState(14);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setName("");
    setPassword("");
    setMode("overview");
    setTarget(null);
    setLoading(true);
    setLoadFailed(false);
    setError("");
    Promise.all([
      apiClient.get("/security"),
      apiClient.get("/security/device-unlock"),
      biometricAvailable(),
    ])
      .then(async ([security, deviceUnlock, hasTouchId]) => {
        const nativeStatus = hasTouchId
          ? await biometricStatus(getSessionToken())
          : { devices: [] };
        if (!active) return;
        setEnabled(security.data.enabled);
        setKeys(security.data.security_keys);
        setTouchIdAvailable(hasTouchId);
        setDevices([
          ...deviceUnlock.data.devices.map((device) => ({ ...device, kind: "webauthn" })),
          ...nativeStatus.devices.map((device) => ({ ...device, kind: "touch-id" })),
        ]);
        setPasswordIntervalDays(deviceUnlock.data.password_interval_days);
      })
      .catch(async (err) => {
        const message = await dialogError(err, t("errors.load"));
        if (active) {
          setError(message);
          setLoadFailed(true);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, reload, t]);

  const choose = useCallback(
    (next, selected = null) => {
      setMode(next);
      setTarget(selected);
      setName("");
      setPassword("");
      setError("");
      if (next === "overview" && phone) {
        window.requestAnimationFrame(() =>
          document.getElementById(titleId)?.focus({ preventScroll: true })
        );
      }
    },
    [phone, titleId]
  );

  const closeTask = useCallback(() => {
    if (busy) return;
    if (mode === "overview") onClose();
    else choose("overview");
  }, [busy, mode, onClose, choose]);

  useEffect(() => {
    if (!open || !phone) return undefined;
    const handleEscape = (event) => {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      closeTask();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [open, phone, busy, closeTask]);

  const startDeviceEnrollment = async () => {
    if (!IS_DESKTOP) {
      try {
        const supported =
          window.isSecureContext &&
          window.PublicKeyCredential &&
          (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()) &&
          (await PublicKeyCredential.getClientCapabilities?.())?.["extension:prf"] !== false;
        if (!supported) throw new Error(t("auth.deviceUnlockUnavailable"));
      } catch (err) {
        setError(await dialogError(err, t("auth.deviceUnlockUnavailable")));
        return;
      }
    }
    choose("add-device");
  };

  const enroll = async () => {
    setBusy(true);
    setError("");
    try {
      const securityKeyAssertion = enabled
        ? await securityKeyStepUp("security-key-add", {
            current_password: password,
            rp_id: window.location.hostname,
          })
        : undefined;
      const { data: options } = await apiClient.post("/security/keys/options", {
        current_password: password,
        rp_id: window.location.hostname,
        ...(securityKeyAssertion ? { security_key_assertion: securityKeyAssertion } : {}),
      });
      const response = await registerSecurityKey(options);
      await apiClient.post("/security/keys", {
        name: name || t("auth.securityKeyDefaultName"),
        current_password: password,
        registration_rp_id: options.rp_id,
        ...response,
      });
      onClose();
      window.location.assign("/login");
    } catch (err) {
      setError(await dialogError(err, t("errors.save")));
    } finally {
      setBusy(false);
    }
  };

  const enrollDevice = async () => {
    setBusy(true);
    setError("");
    try {
      const deviceName = name.trim();
      if (touchIdAvailable) {
        const securityKeyAssertion = enabled
          ? await securityKeyStepUp("device-unlock-enroll", {
              current_password: password,
              name: deviceName,
              native: true,
            })
          : undefined;
        const status = await biometricEnroll(
          getSessionToken(),
          getCurrentUser().username,
          deviceName,
          password,
          securityKeyAssertion
        );
        setDevices([
          ...devices.filter((device) => device.kind === "webauthn"),
          ...status.devices.map((device) => ({ ...device, kind: "touch-id" })),
        ]);
        choose("overview");
        return;
      }
      if (!IS_DESKTOP) {
        const supported =
          window.isSecureContext &&
          window.PublicKeyCredential &&
          (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()) &&
          (await PublicKeyCredential.getClientCapabilities?.())?.["extension:prf"] !== false;
        if (!supported) throw new Error(t("auth.deviceUnlockUnavailable"));
      }
      const securityKeyAssertion = enabled
        ? await securityKeyStepUp("device-unlock-enroll", {
            current_password: password,
            rp_id: window.location.hostname,
          })
        : undefined;
      const { data: options } = await apiClient.post("/security/device-unlock/options", {
        current_password: password,
        rp_id: window.location.hostname,
        ...(securityKeyAssertion ? { security_key_assertion: securityKeyAssertion } : {}),
      });
      const response = await registerSecurityKey(options, { platformAuthenticator: true });
      const { data } = await apiClient.post("/security/device-unlock", {
        name: deviceName,
        current_password: password,
        registration_rp_id: options.rp_id,
        ...response,
      });
      setDevices(data.devices);
      choose("overview");
    } catch (err) {
      setError(await dialogError(err, t("errors.save")));
    } finally {
      setBusy(false);
    }
  };

  const removeDevice = async (device) => {
    setBusy(true);
    setError("");
    try {
      if (device.kind === "touch-id") {
        await biometricRemove(getSessionToken(), getCurrentUser().username, device.id);
      } else {
        await apiClient.delete(`/security/device-unlock/${device.id}`);
      }
      await endSession();
    } catch (err) {
      setError(await dialogError(err, t("errors.save")));
    } finally {
      setBusy(false);
    }
  };

  const updateDeviceUnlockPolicy = async (next) => {
    setBusy(true);
    setError("");
    try {
      const { data } = await apiClient.put("/security/device-unlock/policy", {
        password_interval_days: Number(next),
      });
      setPasswordIntervalDays(data.password_interval_days);
    } catch (err) {
      setError(await dialogError(err, t("errors.save")));
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    setError("");
    try {
      const securityKeyAssertion = await securityKeyStepUp("security-factor-disable", {
        current_password: password,
      });
      await apiClient.request({
        method: "DELETE",
        url: "/security/keys",
        data: { current_password: password, security_key_assertion: securityKeyAssertion },
      });
      onClose();
      window.location.assign("/login");
    } catch (err) {
      setError(await dialogError(err, t("errors.save")));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (keyId) => {
    setBusy(true);
    setError("");
    try {
      const securityKeyAssertion = await securityKeyStepUp("security-key-remove", {
        current_password: password,
        target_key_id: keyId,
      });
      await apiClient.request({
        method: "DELETE",
        url: `/security/keys/${keyId}`,
        data: { current_password: password, security_key_assertion: securityKeyAssertion },
      });
      onClose();
      window.location.assign("/login");
    } catch (err) {
      setError(await dialogError(err, t("errors.save")));
    } finally {
      setBusy(false);
    }
  };

  const caption =
    mode === "overview"
      ? t("auth.securityKey")
      : t(
          {
            "add-key": "auth.securityKeyAdd",
            "add-device": "auth.deviceUnlockAdd",
            "disable-key": "auth.securityKeyDisable",
            "remove-key": "auth.securityKeyRemove",
            "remove-device": "auth.deviceUnlockRemove",
          }[mode]
        );
  const submit = {
    "add-key": enroll,
    "add-device": enrollDevice,
    "disable-key": disable,
    "remove-key": () => remove(target.id),
    "remove-device": () => removeDevice(target),
  }[mode];

  return (
    <Dialog
      aria-labelledby={titleId}
      disableEscapeKeyDown={busy}
      disableOutsideClick={busy}
      fullWidth
      hasCloseButton={!busy}
      maxWidth="s"
      onOpenChange={(next) => {
        if (!next) closeTask();
      }}
      open={open}
    >
      <Dialog.Header caption={caption} id={titleId} />
      <Dialog.Body>
        <Flex direction="column" gap="spacing-5">
          {loading ? (
            <Text color="secondary" role="status">
              {t("common.labels.loading")}
            </Text>
          ) : (
            <>
              {error && (
                <Flex role="alert">
                  <Alert message={error} theme="danger" />
                </Flex>
              )}
              {loadFailed ? (
                <Button size="xl" onClick={() => setReload((value) => value + 1)}>
                  {t("auth.securityKeyRetry")}
                </Button>
              ) : mode === "overview" ? (
                <>
                  <Flex direction="column" gap="spacing-3" minWidth="0">
                    {!enabled && <Text color="secondary">{t("auth.securityKeyDescription")}</Text>}
                    {keys.map((key) => (
                      <Card key={key.id}>
                        <Flex
                          alignItems={phone ? "stretch" : "center"}
                          direction={phone ? "column" : "row"}
                          justifyContent="space-between"
                          gap="spacing-2"
                          padding="spacing-3"
                          minWidth="0"
                        >
                          <Text wordBreak="break-word">{key.name}</Text>
                          <Button
                            size="xl"
                            view="flat-danger"
                            disabled={busy}
                            onClick={() => choose("remove-key", key)}
                          >
                            {t("common.actions.remove")}
                          </Button>
                        </Flex>
                      </Card>
                    ))}
                    <Button
                      size="xl"
                      view={enabled ? "normal" : "action"}
                      disabled={busy}
                      onClick={() => choose("add-key")}
                    >
                      {t("auth.securityKeyAdd")}
                    </Button>
                    {enabled && (
                      <Button
                        size="xl"
                        view="flat-danger"
                        disabled={busy}
                        onClick={() => choose("disable-key")}
                      >
                        {t("auth.securityKeyDisable")}
                      </Button>
                    )}
                  </Flex>
                  <Flex direction="column" gap="spacing-3" minWidth="0">
                    <Text variant="subheader-2">{t("auth.deviceUnlock")}</Text>
                    {devices.map((device) => (
                      <Card key={`${device.kind}-${device.id}`}>
                        <Flex
                          alignItems={phone ? "stretch" : "center"}
                          direction={phone ? "column" : "row"}
                          justifyContent="space-between"
                          gap="spacing-2"
                          padding="spacing-3"
                          minWidth="0"
                        >
                          <Flex direction="column" gap="spacing-1" minWidth="0">
                            <Text wordBreak="break-word">{device.name}</Text>
                            {device.kind === "touch-id" && (
                              <Text color="secondary" variant="caption-2">
                                {t("auth.touchId")}
                              </Text>
                            )}
                          </Flex>
                          <Button
                            size="xl"
                            view="flat-danger"
                            disabled={busy}
                            onClick={() => choose("remove-device", device)}
                          >
                            {t("common.actions.remove")}
                          </Button>
                        </Flex>
                      </Card>
                    ))}
                    {devices.length > 0 && (
                      <Flex direction="column" gap="spacing-2">
                        <Text>{t("auth.deviceUnlockPasswordInterval")}</Text>
                        <Select
                          aria-label={t("auth.deviceUnlockPasswordInterval")}
                          disabled={busy}
                          onUpdate={([value = passwordIntervalDays]) =>
                            updateDeviceUnlockPolicy(value)
                          }
                          options={[7, 14, 30].map((days) => ({
                            value: String(days),
                            content: t("auth.deviceUnlockPasswordIntervalOption", { days }),
                          }))}
                          value={[String(passwordIntervalDays)]}
                        />
                        <Text color="secondary" variant="caption-2">
                          {t("auth.deviceUnlockPasswordIntervalHint")}
                        </Text>
                      </Flex>
                    )}
                    <Button size="xl" disabled={busy} onClick={startDeviceEnrollment}>
                      {t("auth.deviceUnlockAdd")}
                    </Button>
                  </Flex>
                </>
              ) : (
                <>
                  {mode === "add-key" && !enabled && (
                    <Alert message={t("auth.securityKeyDescription")} theme="warning" />
                  )}
                  {mode === "disable-key" && (
                    <Alert message={t("auth.securityKeyDisableDescription")} theme="warning" />
                  )}
                  {mode === "remove-key" && (
                    <Text>{t("auth.securityKeyRemoveConfirm", { name: target.name })}</Text>
                  )}
                  {mode === "remove-device" && (
                    <Text>{t("auth.deviceUnlockRemoveConfirm", { name: target.name })}</Text>
                  )}
                  {(mode === "add-key" || mode === "add-device") && (
                    <Flex direction="column" gap="spacing-2" minWidth="0">
                      <Text as="label" htmlFor={`${titleId}-name`}>
                        {t(
                          mode === "add-device" ? "auth.deviceUnlockName" : "auth.securityKeyName"
                        )}
                      </Text>
                      <TextInput
                        id={`${titleId}-name`}
                        size="xl"
                        autoFocus
                        disabled={busy}
                        onUpdate={setName}
                        placeholder={
                          mode === "add-key" ? t("auth.securityKeyDefaultName") : undefined
                        }
                        value={name}
                      />
                    </Flex>
                  )}
                  {mode !== "remove-device" && (
                    <PasswordField
                      autoComplete="current-password"
                      autoFocus={mode !== "add-key" && mode !== "add-device"}
                      disabled={busy}
                      label={t("auth.currentPassword")}
                      onChange={(event) => setPassword(event.target.value)}
                      value={password}
                    />
                  )}
                </>
              )}
            </>
          )}
        </Flex>
      </Dialog.Body>
      <Dialog.Footer
        loading={busy}
        onClickButtonApply={submit}
        onClickButtonCancel={closeTask}
        propsButtonApply={{
          disabled:
            loading ||
            loadFailed ||
            (mode !== "remove-device" && !password) ||
            (mode === "add-device" && !name.trim()),
          view: mode.startsWith("remove") || mode === "disable-key" ? "flat-danger" : "action",
        }}
        textButtonApply={mode === "overview" ? undefined : caption}
        textButtonCancel={t(mode === "overview" ? "common.actions.close" : "common.actions.cancel")}
      />
    </Dialog>
  );
};

export default SecurityKeyDialog;
