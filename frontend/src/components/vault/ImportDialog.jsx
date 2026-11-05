import { useEffect, useState } from "react";
import { FileArrowUp } from "@gravity-ui/icons";
import {
  Flex,
  Text,
  Alert,
  Button,
  Col,
  Icon,
  RadioGroup,
  Row,
  useFileInput,
} from "@gravity-ui/uikit";
import { Trans, useTranslation } from "react-i18next";
import Dialog from "../TaskSurface";

import { IS_DESKTOP, chooseBackup } from "../../platform";
import PasswordField from "../PasswordField";

const ReportedRows = ({ rows = [], count, titleKey, warning = false }) => {
  const { t } = useTranslation();
  const hidden = count - rows.length;
  return (
    <Flex direction="column" gap="spacing-3" minWidth="0">
      <Text as="div" color="secondary" wordBreak="break-word">
        <Text as="strong" color={warning ? "warning" : "primary"}>
          {count}
        </Text>{" "}
        {t(titleKey, { count })}
      </Text>
      <Flex direction="column" gap="spacing-2" minWidth="0">
        {rows.map((row) => (
          <Flex
            direction={{ xs: "column", m: "row" }}
            gap="spacing-2"
            minWidth="0"
            paddingBlock="spacing-2"
            justifyContent="space-between"
            key={row.where}
          >
            {row.where}
            {row.name ? ` (${row.name})` : ""}: {row.reason}
          </Flex>
        ))}
        {hidden > 0 && (
          <Flex
            direction={{ xs: "column", m: "row" }}
            gap="spacing-2"
            minWidth="0"
            paddingBlock="spacing-2"
            justifyContent="space-between"
          >
            {t("importDialog.andMore", { count: hidden })}
          </Flex>
        )}
      </Flex>
    </Flex>
  );
};

const restoredExtras = (result, t) =>
  [
    result.trashed > 0 && t("importDialog.restoredExtras.trash", { count: result.trashed }),
    result.attachments > 0 &&
      t("importDialog.restoredExtras.attachments", { count: result.attachments }),
    result.grants_restored > 0 &&
      t("importDialog.restoredExtras.grants", { count: result.grants_restored }),
    result.settings_restored && t("importDialog.restoredExtras.settings"),
  ].filter(Boolean);

const ImportResult = ({ result }) => {
  const { t } = useTranslation();
  const extras = restoredExtras(result, t);
  if (result.total === 0 && !result.ignored && extras.length === 0) {
    return (
      <Text as="div" color="secondary" wordBreak="break-word">
        {t("importDialog.noPasswords")}
      </Text>
    );
  }
  return (
    <Flex direction="column" gap="spacing-3" minWidth="0">
      {result.imported > 0 && (
        <Text as="div" color="secondary" wordBreak="break-word">
          <Trans
            i18nKey="importDialog.imported"
            count={result.imported}
            values={{ count: result.imported }}
            components={{ strong: <Text as="strong" /> }}
          />
        </Text>
      )}
      {result.overwritten > 0 && (
        <Text as="div" color="secondary" wordBreak="break-word">
          <Trans
            i18nKey="importDialog.overwritten"
            count={result.overwritten}
            values={{ count: result.overwritten }}
            components={{ strong: <Text as="strong" /> }}
          />
        </Text>
      )}
      {extras.length > 0 && (
        <Text as="div" color="secondary" wordBreak="break-word">
          {t("importDialog.alsoRestored", { items: extras.join(", ") })}
        </Text>
      )}
      {result.skipped > 0 && (
        <Text as="div" color="secondary" wordBreak="break-word">
          <Trans
            i18nKey="importDialog.skipped"
            count={result.skipped}
            values={{ count: result.skipped }}
            components={{ strong: <Text as="strong" /> }}
          />
        </Text>
      )}
      {result.renamed > 0 && (
        <ReportedRows
          rows={result.renamed_rows}
          count={result.renamed}
          titleKey="importDialog.renamed"
        />
      )}
      {result.ignored > 0 && (
        <ReportedRows
          rows={result.ignored_rows}
          count={result.ignored}
          titleKey="importDialog.ignored"
          warning
        />
      )}
    </Flex>
  );
};

const ImportDialog = ({ open, onClose, onImport, onImportCsv }) => {
  const { t } = useTranslation();
  const [mode, setMode] = useState("ciphermoth");
  const [file, setFile] = useState(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [onConflict, setOnConflict] = useState("skip");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (open) {
      setMode("ciphermoth");
      setFile(null);
      setPassword("");
      setError("");
      setOnConflict("skip");
      setResult(null);
    }
  }, [open]);

  const isCsv = mode === "csv";
  const { controlProps: fileInputProps, triggerProps: fileTriggerProps } = useFileInput({
    onUpdate: ([selectedFile]) => {
      setFile(selectedFile ?? null);
      setError("");
    },
  });

  const changeMode = (next) => {
    setMode(next);
    setFile(null);
    setError("");
  };

  const handleImport = async () => {
    if (!file) {
      setError(t(isCsv ? "importDialog.selectCsv" : "importDialog.selectBackup"));
      return;
    }
    if (!isCsv && !password.trim()) {
      setError(t("importDialog.enterBackupPassword"));
      return;
    }
    setLoading(true);
    setError("");
    try {
      const data = isCsv
        ? await onImportCsv({ file, onConflict })
        : await onImport({ file, masterPassword: password, onConflict });
      setResult(data);
    } catch (requestError) {
      setError(requestError.message);
      if (IS_DESKTOP && !isCsv) setFile(null);
    } finally {
      setLoading(false);
    }
  };

  const chooseFile = async () => {
    try {
      setFile(await chooseBackup());
      setError("");
    } catch {
      setError(t("importDialog.filePickerError"));
    }
  };

  return (
    <Dialog
      aria-label={t(result ? "importDialog.completeTitle" : "importDialog.title")}

      contentOverflow="auto"
      fullWidth
      hasCloseButton={!loading}
      maxWidth="m"
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !loading) onClose();
      }}
    >
      <Dialog.Header caption={t(result ? "importDialog.completeTitle" : "importDialog.title")} />
      <Dialog.Body>
        {result ? (
          <ImportResult result={result} />
        ) : (
          <Flex direction="column" gap="spacing-5" minWidth="0">
            <RadioGroup
              size="l"
              name="import-mode"
              direction="vertical"
              value={mode}
              onUpdate={changeMode}
              options={[
                { value: "ciphermoth", content: t("importDialog.backupMode") },
                { value: "csv", content: t("importDialog.csvMode") },
              ]}
            />

            <Text as="div" color="secondary" wordBreak="break-word">
              {isCsv ? t("importDialog.csvDescription") : t("importDialog.backupDescription")}
            </Text>

            <Row gap="spacing-6">
              <Col size={{ xs: 12, m: 7 }} minWidth="0">
                <Flex direction="column" gap="spacing-4">
                  {(!IS_DESKTOP || isCsv) && (
                    <input {...fileInputProps} accept={isCsv ? ".csv" : ".cmbackup,.zip"} />
                  )}
                  <Button
                    type="button"
                    view="outlined"
                    size="xl"
                    width="max"
                    onClick={IS_DESKTOP && !isCsv ? chooseFile : fileTriggerProps.onClick}
                  >
                    <Icon data={FileArrowUp} />
                    {t(isCsv ? "importDialog.chooseCsv" : "importDialog.chooseBackup")}
                  </Button>
                  {file && <Text wordBreak="break-all">{file.name}</Text>}

                  {!isCsv && (
                    <PasswordField
                      label={t("importDialog.backupPassword")}
                      value={password}
                      onChange={(event) => {
                        setPassword(event.target.value);
                        setError("");
                      }}
                      error={Boolean(error)}
                      helperText={error || t("importDialog.backupPasswordHelp")}
                      required
                      autoFocus
                      autoComplete="current-password"
                      onKeyDown={(event) => {
                        if (event.key === "Enter") handleImport();
                      }}
                    />
                  )}

                  {isCsv && error && <Alert theme="danger" view="outlined" message={error} />}
                </Flex>
              </Col>
              <Col size={{ xs: 12, m: 5 }} minWidth="0">
                <Flex direction="column" gap="spacing-3" minWidth="0" as="section">
                  <Text variant="subheader-1">{t("importDialog.existingLabel")}</Text>
                  <RadioGroup
                    aria-label={t("importDialog.existingLabel")}
                    direction="vertical"
                    value={onConflict}
                    onUpdate={setOnConflict}
                    options={[
                      { value: "skip", content: t("importDialog.keepExisting") },
                      { value: "overwrite", content: t("importDialog.overwrite") },
                    ]}
                  />
                </Flex>
              </Col>
            </Row>
          </Flex>
        )}
      </Dialog.Body>
      <Dialog.Footer
        onClickButtonApply={result ? onClose : handleImport}
        onClickButtonCancel={result ? undefined : onClose}
        textButtonApply={t(result ? "common.actions.done" : "common.actions.import")}
        textButtonCancel={result ? undefined : t("common.actions.cancel")}
        propsButtonApply={{ loading, disabled: loading, view: "action" }}
        propsButtonCancel={{ disabled: loading }}
      />
    </Dialog>
  );
};

export default ImportDialog;
