import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  Alert,
  Box,
  Button,
  Card,
  Checkbox,
  Container,
  Flex,
  Progress,
  Text,
  TextInput,
} from "@gravity-ui/uikit";
import { useStoreActions, useStoreState } from "easy-peasy";
import { useTranslation } from "react-i18next";

import LanguageSwitcher from "../components/LanguageSwitcher";
import LoadingScreen from "../components/LoadingScreen";
import BrandMark from "../components/BrandMark";
import PasswordField from "../components/PasswordField";
import ThemeToggle from "../components/ThemeToggle";
import { getMasterPasswordStrength } from "../lib/passwordStrength";
import { LOGOUT_NOTICE } from "../utils";

const LoginPage = () => {
  const { t, i18n } = useTranslation();
  const { state } = useLocation();
  const [acknowledged, setAcknowledged] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");
  const [notice, setNotice] = useState("");
  const usernameRef = useRef(null);
  const passwordRef = useRef(null);
  const confirmRef = useRef(null);
  const [invalidField, setInvalidField] = useState("");
  const reportError = (message, field, ref) => {
    setError(message);
    setInvalidField(field);
    ref?.current?.focus();
  };

  const {
    fetchStatus,
    authenticate,
    authenticateDevice,
    recover,
    continueRecovery,
    setUsername,
    setValue,
    setConfirm,
    setError,
  } = useStoreActions((actions) => actions.ciphermothModels.masterPassword);
  const {
    initialized,
    error,
    username,
    value,
    confirm,
    loading,
    recoveryCode: issuedRecoveryCode,
  } = useStoreState((storeState) => storeState.ciphermothModels.masterPassword);

  useEffect(() => {
    fetchStatus();
    const logoutNotice = sessionStorage.getItem(LOGOUT_NOTICE);
    if (logoutNotice) {
      sessionStorage.removeItem(LOGOUT_NOTICE);
      setNotice(t(logoutNotice));
    }
  }, [fetchStatus, t]);

  const strength = initialized === false ? getMasterPasswordStrength(value) : null;

  const handleLogin = () => {
    if (!username.trim()) {
      reportError(t("auth.validation.enterUsername"), "username", usernameRef);
      return;
    }
    if (!value.trim()) {
      reportError(t("auth.validation.enterMasterPassword"), "password", passwordRef);
      return;
    }
    authenticate({ endpoint: "/auth/login", username, password: value, returnTo: state?.returnTo });
  };

  const handleCreate = () => {
    if (!username.trim()) {
      reportError(t("auth.validation.enterAdministratorUsername"), "username", usernameRef);
      return;
    }
    if (!value) {
      reportError(t("auth.validation.enterNewMasterPassword"), "password", passwordRef);
      return;
    }
    if (value !== confirm) {
      reportError(t("auth.validation.passwordsDoNotMatch"), "confirm", confirmRef);
      return;
    }
    if (strength && strength.value < 70) {
      reportError(t("auth.validation.weakPassword"), "password", passwordRef);
      return;
    }
    if (!acknowledged) {
      setError(t("auth.validation.confirmNoRecovery"));
      return;
    }
    authenticate({
      endpoint: "/auth/bootstrap",
      username,
      password: value,
      returnTo: state?.returnTo,
    });
  };

  const handleAcknowledgement = (checked) => {
    setAcknowledged(checked);
    setError(null);
  };

  const handleRecovery = () => {
    if (!username.trim() || !recoveryCode.trim() || !value || value !== confirm) {
      reportError(t("auth.validation.enterRecovery"), "recovery", passwordRef);
      return;
    }
    if (getMasterPasswordStrength(value).value < 70) {
      reportError(t("auth.validation.weakPassword"), "password", passwordRef);
      return;
    }
    recover({ username, recoveryCode, password: value, returnTo: state?.returnTo });
  };

  if (initialized === null) return <LoadingScreen />;

  if (issuedRecoveryCode)
    return (
      <Container
        maxWidth="440px"
        gutters="spacing-3"
        paddingBlock={{ xs: "spacing-6", m: "spacing-10" }}
      >
        <Card view="outlined">
          <Flex direction="column" gap="spacing-5" padding={{ xs: "spacing-4", s: "spacing-6" }}>
            <Box as="h1" margin="0">
              <Text variant="header-1">{t("auth.recoveryTitle")}</Text>
            </Box>
            <Alert
              message={`${t("auth.recoverySaveCode")} ${issuedRecoveryCode}`}
              theme="warning"
            />
            <Button
              onClick={() => continueRecovery(state?.returnTo)}
              size="xl"
              view="action"
              width="max"
            >
              {t("auth.recoveryContinue")}
            </Button>
          </Flex>
        </Card>
      </Container>
    );

  return (
    <Container
      maxWidth="440px"
      gutters="spacing-3"
      paddingBlock={{ xs: "spacing-6", m: "spacing-10" }}
    >
      <Card view="outlined">
        <Flex
          as="form"
          direction="column"
          gap="spacing-5"
          padding={{ xs: "spacing-4", s: "spacing-6" }}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (!loading)
              (recovering ? handleRecovery : initialized ? handleLogin : handleCreate)();
          }}
        >
          <Flex alignItems="center" justifyContent="space-between" gap="spacing-2">
            <Flex alignItems="center" gap="spacing-2">
              <BrandMark />
              <Text variant="subheader-3">
                {i18n.resolvedLanguage?.startsWith("ru") ? "Недра" : "Nedra"}
              </Text>
            </Flex>
            <Flex alignItems="center" gap="spacing-1" flexShrink={0}>
              <ThemeToggle />
              <LanguageSwitcher />
            </Flex>
          </Flex>
          <Box as="h1" margin="0">
            <Text variant="header-1">
              {t(
                recovering
                  ? "auth.recoveryResetTitle"
                  : initialized
                    ? "auth.unlock"
                    : "auth.setupTitle"
              )}
            </Text>
          </Box>
          {!initialized && <Text color="secondary">{t("auth.setupDescription")}</Text>}
          {notice && <Alert theme="info" message={notice} />}
          {error && !invalidField && (
            <Box role="alert">
              <Alert theme="danger" message={error} />
            </Box>
          )}
          <Flex as="label" direction="column" gap="spacing-2">
            <Text>{t(initialized ? "auth.username" : "auth.administratorUsername")}</Text>
            <TextInput
              id="cm-auth-username"
              controlRef={usernameRef}
              validationState={error && invalidField === "username" ? "invalid" : undefined}
              errorMessage={invalidField === "username" ? error : undefined}
              required
              size="xl"
              value={username}
              disabled={loading}
              autoFocus
              autoComplete="username"
              onUpdate={(next) => {
                setUsername(next);
                setError(null);
                setInvalidField("");
              }}
              controlProps={{
                "aria-label": t(initialized ? "auth.username" : "auth.administratorUsername"),
                autoCapitalize: "none",
                spellCheck: false,
                required: true,
              }}
            />
            {!initialized && (
              <Text variant="caption-2" color="secondary">
                {t("auth.usernameRules")}
              </Text>
            )}
          </Flex>
          {recovering && (
            <PasswordField
              label={t("auth.recoveryCode")}
              required
              value={recoveryCode}
              disabled={loading}
              onUpdate={setRecoveryCode}
              autoComplete="off"
              controlProps={{ "aria-label": t("auth.recoveryCode") }}
            />
          )}
          <PasswordField
            label={t(recovering ? "auth.newPassword" : "auth.masterPassword")}
            controlRef={passwordRef}
            validationState={error && invalidField === "password" ? "invalid" : undefined}
            errorMessage={invalidField === "password" ? error : undefined}
            required
            value={value}
            onGenerate={initialized ? undefined : setValue}
            disabled={loading}
            onUpdate={(next) => {
              setValue(next);
              setError(null);
              setInvalidField("");
            }}
            autoComplete={initialized ? "current-password" : "new-password"}
            controlProps={{
              "aria-label": t(recovering ? "auth.newPassword" : "auth.masterPassword"),
            }}
          />
          {!initialized && value && strength && (
            <Flex direction="column" gap="spacing-2" aria-live="polite">
              <Progress value={strength.value} theme={strength.theme} size="s" />
              <Text color="secondary">{t(strength.labelKey)}</Text>
            </Flex>
          )}
          {(recovering || !initialized) && (
            <>
              <PasswordField
                label={t("auth.confirmMasterPassword")}
                controlRef={confirmRef}
                validationState={error && invalidField === "confirm" ? "invalid" : undefined}
                errorMessage={invalidField === "confirm" ? error : undefined}
                required
                value={confirm}
                disabled={loading}
                onUpdate={(next) => {
                  setConfirm(next);
                  setError(null);
                  setInvalidField("");
                }}
                autoComplete="new-password"
                controlProps={{ "aria-label": t("auth.confirmMasterPassword") }}
              />
              <Alert theme="warning" message={t("auth.noRecoveryWarning")} />
              <Checkbox
                checked={acknowledged}
                disabled={loading}
                size="l"
                onUpdate={handleAcknowledgement}
                content={t("auth.noRecoveryAcknowledgement")}
              />
            </>
          )}
          <Button
            type="submit"
            view="action"
            size="xl"
            width="max"
            loading={loading}
            disabled={!initialized && !acknowledged}
          >
            {t(recovering ? "auth.recoveryReset" : initialized ? "auth.unlock" : "auth.create")}
          </Button>
          {initialized && !recovering && (
            <Button
              disabled={loading || !username.trim()}
              onClick={() => authenticateDevice({ username, returnTo: state?.returnTo })}
              size="xl"
              view="outlined"
              width="max"
            >
              {t("auth.deviceUnlock")}
            </Button>
          )}
          {initialized && (
            <Button
              disabled={loading}
              onClick={() => {
                setRecovering(!recovering);
                setError(null);
                setInvalidField("");
              }}
              view="flat"
            >
              {t(recovering ? "auth.backToLogin" : "auth.useRecoveryCode")}
            </Button>
          )}
          <Text color="secondary" variant="caption-2">
            {t("auth.closeLocks")}
          </Text>
        </Flex>
      </Card>
    </Container>
  );
};

export default LoginPage;
