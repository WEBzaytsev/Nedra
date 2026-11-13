import { useEffect, useId, useState } from "react";
import { Alert, Button, Flex, Select, Text, TextInput } from "@gravity-ui/uikit";
import { useTranslation } from "react-i18next";

import apiClient from "../api/client";
import { endSession } from "../api/session";
import { errorDetail } from "../lib/http";
import { registerSecurityKey } from "../lib/securityKey";
import { securityKeyStepUp } from "../lib/securityStepUp";
import PasswordField from "./PasswordField";
import Dialog from "./TaskSurface";

const SecurityKeyDialog = ({ open, onClose }) => {
  const { t } = useTranslation();
  const titleId = useId();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [keys, setKeys] = useState([]);
  const [devices, setDevices] = useState([]);
  const [passwordIntervalDays, setPasswordIntervalDays] = useState(14);
  const [adding, setAdding] = useState(false);
  const [deviceAdding, setDeviceAdding] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName("");
    setPassword("");
    setAdding(false);
    setDeviceAdding(false);
    setError("");
    Promise.all([apiClient.get("/security"), apiClient.get("/security/device-unlock")])
      .then(([security, deviceUnlock]) => {
        setEnabled(security.data.enabled);
        setKeys(security.data.security_keys);
        setDevices(deviceUnlock.data.devices);
        setPasswordIntervalDays(deviceUnlock.data.password_interval_days);
      })
      .catch(async (err) => setError(await errorDetail(err, t("errors.load"))));
  }, [open, t]);

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
      setError(await errorDetail(err, err.message || t("errors.save")));
    } finally {
      setBusy(false);
    }
  };

  const enrollDevice = async () => {
    setBusy(true);
    setError("");
    try {
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
      const response = await registerSecurityKey(options);
      const { data } = await apiClient.post("/security/device-unlock", {
        name,
        current_password: password,
        registration_rp_id: options.rp_id,
        ...response,
      });
      setDevices(data.devices);
      setDeviceAdding(false);
      setName("");
      setPassword("");
    } catch (err) {
      setError(await errorDetail(err, err.message || t("errors.save")));
    } finally {
      setBusy(false);
    }
  };

  const removeDevice = async (deviceId) => {
    setBusy(true);
    setError("");
    try {
      await apiClient.delete(`/security/device-unlock/${deviceId}`);
      await endSession();
    } catch (err) {
      setError(await errorDetail(err, err.message || t("errors.save")));
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
      setError(await errorDetail(err, err.message || t("errors.save")));
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
      setError(await errorDetail(err, err.message || t("errors.save")));
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
      setError(await errorDetail(err, err.message || t("errors.save")));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      aria-labelledby={titleId}
      disableEscapeKeyDown={busy}
      disableOutsideClick={busy}
      fullWidth
      hasCloseButton={!busy}
      maxWidth="s"
      onOpenChange={(next) => !next && !busy && onClose()}
      open={open}
    >
      <Dialog.Header caption={t("auth.securityKey")} id={titleId} />
      <Dialog.Body>
        <Flex direction="column" gap="spacing-5">
          {error && <Alert message={error} theme="danger" />}
          <Text color="secondary">
            {t(
              enabled && !adding
                ? "auth.securityKeyDisableDescription"
                : "auth.securityKeyDescription"
            )}
          </Text>
          {enabled && !adding && (
            <Flex direction="column" gap="spacing-2">
              {keys.map((key) => (
                <Flex alignItems="center" justifyContent="space-between" key={key.id}>
                  <Text>{key.name}</Text>
                  <Button
                    disabled={busy || !password}
                    onClick={() => remove(key.id)}
                    view="flat-danger"
                  >
                    {t("common.actions.remove")}
                  </Button>
                </Flex>
              ))}
              <Button disabled={busy} onClick={() => setAdding(true)} view="flat">
                {t("auth.securityKeyAdd")}
              </Button>
            </Flex>
          )}
          {devices.length > 0 && !deviceAdding && (
            <Flex direction="column" gap="spacing-2">
              <Text variant="subheader-2">{t("auth.deviceUnlock")}</Text>
              {devices.map((device) => (
                <Flex alignItems="center" justifyContent="space-between" key={device.id}>
                  <Text>{device.name}</Text>
                  <Button
                    disabled={busy}
                    onClick={() => removeDevice(device.id)}
                    view="flat-danger"
                  >
                    {t("common.actions.remove")}
                  </Button>
                </Flex>
              ))}
              <Select
                aria-label={t("auth.deviceUnlockPasswordInterval")}
                disabled={busy}
                label={t("auth.deviceUnlockPasswordInterval")}
                onUpdate={([value = passwordIntervalDays]) => updateDeviceUnlockPolicy(value)}
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
          {!deviceAdding && (
            <Button
              disabled={busy}
              onClick={() => {
                setAdding(false);
                setDeviceAdding(true);
                setName("");
              }}
              view="flat"
            >
              {t("auth.deviceUnlockAdd")}
            </Button>
          )}
          {(!enabled || adding || deviceAdding) && (
            <TextInput
              controlProps={{
                "aria-label": t(deviceAdding ? "auth.deviceUnlockName" : "auth.securityKeyName"),
              }}
              disabled={busy}
              label={t(deviceAdding ? "auth.deviceUnlockName" : "auth.securityKeyName")}
              onUpdate={setName}
              value={name}
            />
          )}
          <PasswordField
            autoComplete="current-password"
            disabled={busy}
            label={t("auth.currentPassword")}
            onChange={(event) => setPassword(event.target.value)}
            value={password}
          />
        </Flex>
      </Dialog.Body>
      <Dialog.Footer
        loading={busy}
        onClickButtonApply={deviceAdding ? enrollDevice : enabled && !adding ? disable : enroll}
        onClickButtonCancel={onClose}
        propsButtonApply={{ disabled: !password || (deviceAdding && !name.trim()) }}
        textButtonApply={t(
          deviceAdding
            ? "auth.deviceUnlockAdd"
            : enabled && !adding
              ? "auth.securityKeyDisable"
              : "auth.securityKeyAdd"
        )}
        textButtonCancel={t("common.actions.cancel")}
      />
    </Dialog>
  );
};

export default SecurityKeyDialog;
