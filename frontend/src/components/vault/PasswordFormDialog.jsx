import { useEffect, useRef, useState } from "react";
import {
  CircleQuestion,
  Copy,
  Eye,
  EyeSlash,
  FileText,
  Key,
  MagicWand,
  Plus,
  Star,
  StarFill,
  TrashBin,
} from "@gravity-ui/icons";
import {
  Flex,
  Text,
  Disclosure,
  Button,
  Dialog,
  Icon,
  SegmentedRadioGroup,
  Select,
  TextArea,
  TextInput,
  Tooltip,
} from "@gravity-ui/uikit";
import { useTranslation } from "react-i18next";

import { useSnackbar } from "../../hooks/useNotify";
import { DEFAULT_PASSWORD_OPTIONS, generatePassword } from "../../lib/passwordGenerator";
import { isAuth } from "../../utils";
import PasswordField from "../PasswordField";
import AttachmentsSection from "./AttachmentsSection";
import PasswordGenerator, { CHAR_KEYS } from "./PasswordGenerator";
import StrengthBar from "./StrengthBar";

const EMPTY_FORM = {
  password_name: "",
  kind: "login",
  username: "",
  password_value: "",
  url: "",
  totp_secret: "",
  description: "",
  tags: [],
  custom_fields: [],
  folder: "",
  folder_id: null,
  favorite: false,
};

const normalizeCustomFields = (fields) =>
  (fields ?? [])
    .map((field) => ({
      label: field.label.trim(),
      value: field.value,
      hidden: Boolean(field.hidden),
    }))
    .filter((field) => field.label);

const parseTags = (value) => [
  ...new Set(
    value
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean)
  ),
];

const toForm = (target, entryType) => {
  if (!target) return { ...EMPTY_FORM, kind: entryType === "note" ? "note" : "login" };
  return {
    password_name: target.password_name ?? "",
    kind: target.kind ?? (entryType === "note" ? "note" : "login"),
    username: target.username ?? "",
    password_value: target.password_value ?? "",
    url: target.url ?? "",
    totp_secret: target.totp_secret ?? "",
    description: target.description ?? "",
    tags: target.tags ?? [],
    custom_fields: (target.custom_fields ?? []).map((field) => ({
      label: field.label ?? "",
      value: field.value ?? "",
      hidden: Boolean(field.hidden),
    })),
    folder: target.folder ?? "",
    folder_id: target.folder_id ?? null,
    favorite: target.favorite ?? false,
  };
};

const sectionsForTarget = (target) => ({
  totp: Boolean(target?.totp_secret),
  tags: (target?.tags?.length ?? 0) > 0,
  custom: (target?.custom_fields?.length ?? 0) > 0,
  notes: Boolean(target?.description),
  attachments: (target?.attachment_count ?? 0) > 0,
  history: false,
});

const FormSection = ({ label, count, open, onToggle, children }) => (
  <Disclosure
    expanded={open}
    onUpdate={onToggle}
    summary={`${label}${count > 0 ? ` (${count})` : ""}`}
  >
    <Flex direction="column" gap="spacing-3" paddingBlock="spacing-3">
      {children}
    </Flex>
  </Disclosure>
);

const CustomFieldRow = ({ field, onChange, onToggleHidden, onRemove }) => {
  const { t } = useTranslation();
  return (
    <Flex direction="column" gap="spacing-2" minWidth="0">
      <Flex as="label" direction="column" gap="spacing-2" minWidth="0">
        <Text>{t("entry.labels.label")}</Text>
        <TextInput
          size="xl"
          value={field.label}
          onUpdate={(value) => onChange({ ...field, label: value })}
          placeholder={t("entry.placeholders.customLabel")}
        />
      </Flex>
      <Flex as="label" direction="column" gap="spacing-2" minWidth="0">
        <Text>{t("entry.labels.value")}</Text>
        <TextInput
          size="xl"
          type={field.hidden ? "password" : "text"}
          value={field.value}
          onUpdate={(value) => onChange({ ...field, value })}
          autoComplete="off"
          controlProps={{ spellCheck: false, autoCorrect: "off", autoCapitalize: "none" }}
        />
      </Flex>
      <Flex gap="spacing-2" justifyContent="flex-end">
        <Tooltip
          content={t(field.hidden ? "entry.actions.valueHidden" : "entry.actions.hideValue")}
        >
          <Button
            type="button"
            size="xl"
            view="flat-secondary"
            onClick={onToggleHidden}
            aria-label={t(field.hidden ? "entry.actions.valueHidden" : "entry.actions.hideValue")}
          >
            <Icon data={field.hidden ? EyeSlash : Eye} />
          </Button>
        </Tooltip>
        <Tooltip content={t("entry.actions.removeField")}>
          <Button
            type="button"
            size="xl"
            view="flat-danger"
            onClick={onRemove}
            aria-label={t("entry.actions.removeField")}
          >
            <Icon data={TrashBin} />
          </Button>
        </Tooltip>
      </Flex>
    </Flex>
  );
};

const HistoryRow = ({ entry, onCopy }) => {
  const { t, i18n } = useTranslation();
  const [show, setShow] = useState(false);
  const when = new Date(entry.changed_at).toLocaleDateString(i18n.resolvedLanguage);
  return (
    <Flex
      direction={{ xs: "column", m: "row" }}
      gap="spacing-3"
      minWidth="0"
      wrap="wrap"
      alignItems={{ m: "center" }}
    >
      <Text as="code" variant="code-1" whiteSpace="break-spaces" wordBreak="break-all">
        {show ? entry.value : "••••••••••••"}
      </Text>
      <Text as="time" variant="caption-2" color="secondary" dateTime={entry.changed_at}>
        {when}
      </Text>
      <Tooltip content={t(show ? "passwordField.hide" : "passwordField.show")}>
        <Button
          type="button"
          size="xl"
          view="flat-secondary"
          onClick={() => setShow((value) => !value)}
          aria-label={t(show ? "passwordField.hide" : "passwordField.show")}
        >
          <Icon data={show ? EyeSlash : Eye} />
        </Button>
      </Tooltip>
      <Tooltip content={t("vault.columns.copyPassword")}>
        <Button
          type="button"
          size="xl"
          view="flat-secondary"
          onClick={() => onCopy?.(entry.value)}
          aria-label={t("vault.columns.copyPassword")}
        >
          <Icon data={Copy} />
        </Button>
      </Tooltip>
    </Flex>
  );
};

const PasswordFormDialog = ({
  open,
  editTarget,
  onClose,
  onSubmit,
  onCopy,
  initialDraft,
  onDraftChange,
  draftError,
  folderOptions = [],
  entryType,
  page = false,
}) => {
  const { t } = useTranslation();
  const { enqueueSnackbar, closeSnackbar } = useSnackbar();
  const initialTarget = editTarget ?? initialDraft;
  const initialForm = toForm(initialTarget, entryType);
  const [form, setFormState] = useState(initialForm);
  const [tagsValue, setTagsValue] = useState(initialForm.tags.join(", "));
  const formRef = useRef(form);
  const nameInputRef = useRef(null);
  const valueInputRef = useRef(null);
  const [showValue, setShowValue] = useState(false);
  const [showTotp, setShowTotp] = useState(false);
  const [showGenerator, setShowGenerator] = useState(false);
  const [generatorUndo, setGeneratorUndo] = useState(null);
  const [sections, setSections] = useState(() => sectionsForTarget(initialTarget));
  const [genOpts, setGenOpts] = useState(DEFAULT_PASSWORD_OPTIONS);
  const [submitting, setSubmitting] = useState(false);
  const [attachmentsDirty, setAttachmentsDirty] = useState(false);

  const dirty = JSON.stringify(form) !== JSON.stringify(EMPTY_FORM);
  const setForm = (update) => {
    const next = update(formRef.current);
    formRef.current = next;
    if (!editTarget)
      onDraftChange?.(JSON.stringify(next) !== JSON.stringify(EMPTY_FORM) ? next : null);
    setFormState(next);
  };

  useEffect(() => () => closeSnackbar("entry-form-error"), [closeSnackbar]);

  useEffect(() => {
    if (draftError) {
      enqueueSnackbar(t("entry.draft.failed"), {
        key: "entry-draft-error",
        variant: "error",
        persist: true,
        preventDuplicate: true,
      });
    } else {
      closeSnackbar("entry-draft-error");
    }
    return () => closeSnackbar("entry-draft-error");
  }, [draftError, enqueueSnackbar, closeSnackbar, t]);

  useEffect(() => {
    if (editTarget || !dirty) return undefined;
    const beforeUnload = (event) => {
      if (!isAuth()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [editTarget, dirty]);

  const isNote = form.kind === "note";
  const selectedFolder = folderOptions.find(
    (folder) => folder.id === form.folder_id || (!form.folder_id && folder.name === form.folder)
  );
  const folderSelectValue = selectedFolder
    ? String(selectedFolder.id)
    : form.folder
      ? `legacy:${form.folder}`
      : "";
  const folderSelectOptions = folderOptions.map((folder) => ({
    value: String(folder.id),
    content: folder.name,
  }));
  if (form.folder && !selectedFolder) {
    folderSelectOptions.push({ value: folderSelectValue, content: form.folder });
  }
  const toggleSection = (key) => () =>
    setSections((previous) => ({ ...previous, [key]: !previous[key] }));
  const setValue = (field) => (value) => {
    setForm((previous) => ({ ...previous, [field]: value }));
    closeSnackbar("entry-form-error");
  };
  const setField = (field) => (event) => setValue(field)(event.target.value);

  const showError = (message, inputRef) => {
    enqueueSnackbar(message, {
      key: "entry-form-error",
      variant: "error",
      persist: true,
      preventDuplicate: true,
    });
    inputRef?.current?.focus();
  };

  const addCustomField = () => {
    setSections((previous) => ({ ...previous, custom: true }));
    setForm((previous) => ({
      ...previous,
      custom_fields: [...previous.custom_fields, { label: "", value: "", hidden: false }],
    }));
  };

  const updateCustomField = (index, next) => {
    setForm((previous) => ({
      ...previous,
      custom_fields: previous.custom_fields.map((field, fieldIndex) =>
        fieldIndex === index ? next : field
      ),
    }));
  };

  const removeCustomField = (index) => {
    setForm((previous) => ({
      ...previous,
      custom_fields: previous.custom_fields.filter((_, fieldIndex) => fieldIndex !== index),
    }));
  };

  const applyGenerated = (options) => {
    const previousValue = formRef.current.password_value;
    if (previousValue && generatorUndo === null) setGeneratorUndo(previousValue);
    setForm((previous) => ({ ...previous, password_value: generatePassword(options) }));
    setShowValue(true);
  };

  const toggleGenerator = () => setShowGenerator((value) => !value);

  const changeGenLength = (length) => {
    setGenOpts((previous) => ({ ...previous, length }));
  };

  const toggleGenClass = (key) => {
    const wouldHaveNone = CHAR_KEYS.every((item) =>
      item === key ? genOpts[item] : !genOpts[item]
    );
    if (wouldHaveNone) return;
    setGenOpts((previous) => ({ ...previous, [key]: !previous[key] }));
  };

  const undoGenerated = () => {
    if (generatorUndo === null) return;
    setForm((previous) => ({ ...previous, password_value: generatorUndo }));
    setGeneratorUndo(null);
  };

  const history = editTarget?.password_history ?? [];
  const customCount = normalizeCustomFields(form.custom_fields).length;
  const parsedTags = parseTags(tagsValue);
  const unchanged =
    Boolean(editTarget) &&
    form.username === (editTarget.username ?? "") &&
    form.password_value === editTarget.password_value &&
    form.url === (editTarget.url ?? "") &&
    form.totp_secret === (editTarget.totp_secret ?? "") &&
    form.description === (editTarget.description ?? "") &&
    form.favorite === (editTarget.favorite ?? false) &&
    (form.folder.trim() || "") === (editTarget.folder ?? "") &&
    form.folder_id === (editTarget.folder_id ?? null) &&
    parsedTags.join(" ") === (editTarget.tags ?? []).join(" ") &&
    JSON.stringify(normalizeCustomFields(form.custom_fields)) ===
      JSON.stringify(normalizeCustomFields(editTarget.custom_fields));

  const handleSubmit = async () => {
    if (!form.password_name.trim()) {
      showError(t("entry.validation.nameRequired"), nameInputRef);
      return;
    }
    if (!form.password_value.trim()) {
      showError(
        t(isNote ? "entry.validation.noteRequired" : "entry.validation.passwordRequired"),
        valueInputRef
      );
      return;
    }
    if (editTarget && unchanged) {
      onClose();
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit({
        password_name: form.password_name.trim(),
        kind: form.kind,
        username: isNote ? null : form.username.trim() || null,
        password_value: form.password_value,
        url: isNote ? null : form.url.trim() || null,
        totp_secret: isNote ? null : form.totp_secret.trim() || null,
        description: isNote ? null : form.description.trim() || null,
        tags: parsedTags,
        custom_fields: normalizeCustomFields(form.custom_fields),
        folder: form.folder.trim() || null,
        folder_id: form.folder_id,
        favorite: form.favorite,
      });
    } catch (error) {
      showError(error.message || t("errors.generic"));
    } finally {
      setSubmitting(false);
    }
  };

  const titleKey = editTarget
    ? isNote
      ? "entry.title.editNote"
      : "entry.title.editPassword"
    : isNote
      ? "entry.title.addNote"
      : "entry.title.addPassword";
  const submitLabel = t(
    editTarget
      ? unchanged && attachmentsDirty
        ? "common.actions.done"
        : "common.actions.update"
      : "common.actions.create"
  );

  const favoriteButton = (
    <Tooltip
      content={t(form.favorite ? "vault.columns.removeFavorite" : "vault.columns.markFavorite")}
    >
      <Button
        type="button"
        view="flat-secondary"
        size="xl"
        selected={form.favorite}
        onClick={() => setForm((previous) => ({ ...previous, favorite: !previous.favorite }))}
        aria-pressed={form.favorite}
        qa="entry-favorite-toggle"
        aria-label={t(
          form.favorite ? "vault.columns.removeFavorite" : "vault.columns.markFavorite"
        )}
      >
        <Icon data={form.favorite ? StarFill : Star} />
      </Button>
    </Tooltip>
  );

  const body = (
    <Flex direction="column" gap="spacing-5" minWidth="0">
      {!editTarget && !draftError && (
        <Text as="div" variant="caption-2" color="secondary" wordBreak="break-word">
          {t("entry.draft.savedLocally")}
        </Text>
      )}
      {!editTarget && (
        <Flex alignItems="center" gap="spacing-2" minWidth="0">
          <SegmentedRadioGroup
            size="l"
            name="entry-kind"
            value={form.kind}
            onUpdate={(value) => setForm((previous) => ({ ...previous, kind: value }))}
          >
            <SegmentedRadioGroup.Option value="login">
              <Text wordBreak="break-word">
                <Icon data={Key} />
                {t("common.fields.password")}
              </Text>
            </SegmentedRadioGroup.Option>
            <SegmentedRadioGroup.Option value="note">
              <Text wordBreak="break-word">
                <Icon data={FileText} />
                {t("entry.labels.note")}
              </Text>
            </SegmentedRadioGroup.Option>
          </SegmentedRadioGroup>
        </Flex>
      )}

      <Flex direction="column" gap="spacing-5" minWidth="0">
        <Flex direction="column" gap="spacing-4" minWidth="0">
          <Flex as="label" direction="column" gap="spacing-2" minWidth="0">
            <Text>{t("common.fields.name")}</Text>
            <TextInput
              size="xl"
              value={form.password_name}
              onUpdate={setValue("password_name")}
              disabled={Boolean(editTarget)}
              required
              autoFocus
              controlRef={nameInputRef}
              controlProps={{ maxLength: 255, "aria-label": t("common.fields.name") }}
              placeholder={
                isNote ? t("entry.placeholders.noteName") : t("entry.placeholders.passwordName")
              }
            />
            {editTarget && (
              <Text variant="caption-2" color="secondary">
                {t("entry.help.nameCannotChange")}
              </Text>
            )}
          </Flex>

          {isNote ? (
            <Flex as="label" direction="column" gap="spacing-2" minWidth="0">
              <Text>{t("entry.labels.note")}</Text>
              <TextArea
                size="l"
                value={form.password_value}
                onUpdate={setValue("password_value")}
                controlRef={valueInputRef}
                required
                minRows={6}
                maxRows={10}
                autoComplete="off"
                placeholder={t("entry.placeholders.note")}
                controlProps={{ spellCheck: false }}
              />
            </Flex>
          ) : (
            <>
              <Flex as="label" direction="column" gap="spacing-2" minWidth="0">
                <Text>{t("entry.labels.usernameOptional")}</Text>
                <TextInput
                  size="xl"
                  value={form.username}
                  onUpdate={setValue("username")}
                  placeholder={t("entry.placeholders.username")}
                  controlProps={{
                    "aria-label": t("entry.labels.usernameOptional"),
                    spellCheck: false,
                    autoCorrect: "off",
                    autoCapitalize: "none",
                  }}
                />
              </Flex>
              <Flex as="label" direction="column" gap="spacing-2" minWidth="0">
                <Text>{t("entry.labels.websiteOptional")}</Text>
                <TextInput
                  size="xl"
                  value={form.url}
                  onUpdate={setValue("url")}
                  placeholder={t("entry.placeholders.website")}
                  controlProps={{
                    "aria-label": t("entry.labels.websiteOptional"),
                    spellCheck: false,
                    autoCorrect: "off",
                    autoCapitalize: "none",
                  }}
                />
              </Flex>
              <PasswordField
                label={t("common.fields.password")}
                size="xl"
                value={form.password_value}
                onChange={(event) => {
                  setField("password_value")(event);
                  setGeneratorUndo(null);
                  if (showGenerator) setShowGenerator(false);
                }}
                inputRef={valueInputRef}
                required
                autoComplete="new-password"
                show={showValue}
                onToggleShow={() => setShowValue((value) => !value)}
                adornment={
                  <Tooltip
                    content={t(
                      showGenerator
                        ? "entry.actions.closeGenerator"
                        : "entry.actions.generatePassword"
                    )}
                  >
                    <Button
                      type="button"
                      size="xl"
                      view="flat-secondary"
                      selected={showGenerator}
                      onClick={toggleGenerator}
                      aria-label={t(
                        showGenerator
                          ? "entry.actions.closeGenerator"
                          : "entry.actions.generatePassword"
                      )}
                    >
                      <Icon data={MagicWand} />
                    </Button>
                  </Tooltip>
                }
              />
              {showGenerator && (
                <PasswordGenerator
                  options={genOpts}
                  onChangeLength={changeGenLength}
                  onToggleClass={toggleGenClass}
                  onRegenerate={() => applyGenerated(genOpts)}
                  canUndo={generatorUndo !== null}
                  onUndo={undoGenerated}
                />
              )}
              <StrengthBar password={form.password_value} />
            </>
          )}
          <Flex direction="column" gap="spacing-2" minWidth="0">
            <Text>{t("entry.labels.folderOptional")}</Text>
            <Select
              size="xl"
              width="max"
              value={folderSelectValue ? [folderSelectValue] : []}
              options={folderSelectOptions}
              filterable={folderSelectOptions.length > 8}
              hasClear
              disabled={Boolean(editTarget && editTarget.access !== "owner")}
              placeholder={t("entry.placeholders.folder")}
              aria-label={t("entry.labels.folderOptional")}
              onUpdate={([value = ""]) => {
                const match = folderOptions.find((folder) => String(folder.id) === value);
                setForm((previous) => ({
                  ...previous,
                  folder: match?.name ?? (value.startsWith("legacy:") ? previous.folder : ""),
                  folder_id: match?.id ?? null,
                }));
                closeSnackbar("entry-form-error");
              }}
            />
          </Flex>
        </Flex>
        <Flex direction="column" gap="spacing-3" minWidth="0">
          {!isNote && (
            <FormSection
              label={t("entry.labels.twoFactor")}
              preview={form.totp_secret ? t("common.labels.configured") : ""}
              open={sections.totp}
              onToggle={toggleSection("totp")}
            >
              <PasswordField
                label={t("entry.labels.twoFactorSecret")}
                size="xl"
                value={form.totp_secret}
                onChange={setField("totp_secret")}
                autoComplete="off"
                show={showTotp}
                onToggleShow={() => setShowTotp((value) => !value)}
                helperText={t("entry.help.twoFactor")}
                adornment={
                  <Tooltip content={t("entry.help.twoFactorTooltip")}>
                    <Icon data={CircleQuestion} />
                  </Tooltip>
                }
              />
            </FormSection>
          )}

          <FormSection
            label={t("common.fields.tags")}
            count={parsedTags.length}
            preview={parsedTags.slice(0, 3).join(", ")}
            open={sections.tags}
            onToggle={toggleSection("tags")}
          >
            <Flex as="label" direction="column" gap="spacing-2" minWidth="0">
              <Text>{t("common.fields.tags")}</Text>
              <TextInput
                size="xl"
                value={tagsValue}
                onUpdate={setTagsValue}
                onBlur={() =>
                  setForm((previous) => ({
                    ...previous,
                    tags: parseTags(tagsValue),
                  }))
                }
                placeholder={t("entry.placeholders.tags")}
              />
            </Flex>
          </FormSection>

          <FormSection
            label={t("entry.labels.customFields")}
            count={customCount}
            preview={normalizeCustomFields(form.custom_fields)
              .map((field) => field.label)
              .join(", ")}
            open={sections.custom}
            onToggle={toggleSection("custom")}
          >
            <Flex direction="column" gap="spacing-3" minWidth="0">
              {form.custom_fields.map((field, index) => (
                <CustomFieldRow
                  key={index}
                  field={field}
                  onChange={(next) => updateCustomField(index, next)}
                  onToggleHidden={() =>
                    updateCustomField(index, { ...field, hidden: !field.hidden })
                  }
                  onRemove={() => removeCustomField(index)}
                />
              ))}
              <Button type="button" size="xl" view="flat" onClick={addCustomField}>
                <Icon data={Plus} />
                {t("entry.actions.addField")}
              </Button>
            </Flex>
          </FormSection>

          {!isNote && (
            <FormSection
              label={t("entry.labels.notes")}
              preview={form.description}
              open={sections.notes}
              onToggle={toggleSection("notes")}
            >
              <Flex as="label" direction="column" gap="spacing-2" minWidth="0">
                <Text>{t("common.fields.description")}</Text>
                <TextArea
                  size="m"
                  value={form.description}
                  onUpdate={setValue("description")}
                  minRows={2}
                  maxRows={5}
                  placeholder={t("entry.placeholders.description")}
                />
              </Flex>
            </FormSection>
          )}
        </Flex>

        {editTarget && (
          <FormSection
            label={t("entry.labels.attachments")}
            count={editTarget.attachment_count ?? 0}
            open={sections.attachments}
            onToggle={toggleSection("attachments")}
          >
            <AttachmentsSection
              passwordName={editTarget.password_name}
              onChanged={() => setAttachmentsDirty(true)}
            />
          </FormSection>
        )}

        {!isNote && editTarget && history.length > 0 && (
          <FormSection
            label={t("entry.labels.passwordHistory")}
            count={history.length}
            open={sections.history}
            onToggle={toggleSection("history")}
          >
            <Flex direction="column" gap="spacing-3" minWidth="0">
              {history.map((entry, index) => (
                <HistoryRow key={index} entry={entry} onCopy={onCopy} />
              ))}
            </Flex>
          </FormSection>
        )}
      </Flex>
    </Flex>
  );

  const footer = (
    <Dialog.Footer
      onClickButtonCancel={onClose}
      textButtonCancel={t("common.actions.cancel")}
      onClickButtonApply={handleSubmit}
      textButtonApply={submitLabel}
      propsButtonCancel={{ disabled: submitting }}
      propsButtonApply={{
        view: "action",
        loading: submitting,
        disabled:
          submitting ||
          (unchanged && !attachmentsDirty) ||
          !form.password_name.trim() ||
          !form.password_value.trim(),
      }}
    />
  );

  if (page) {
    return (
      <Flex direction="column" gap="spacing-5" minWidth="0" as="section" aria-label={t(titleKey)}>
        <Flex
          alignItems="center"
          justifyContent="space-between"
          gap="spacing-3"
          minWidth="0"
          as="header"
        >
          <Text as="div" role="heading" aria-level={1} variant="header-1">
            {t(titleKey)}
          </Text>
          {favoriteButton}
        </Flex>
        {body}
        {footer}
      </Flex>
    );
  }

  return (
    <Dialog
      aria-label={t(titleKey)}

      contentOverflow="auto"
      fullWidth
      hasCloseButton={!submitting}
      maxWidth="l"
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !submitting) onClose();
      }}
    >
      <Dialog.Header
        caption={t(titleKey)}
        insertAfter={
          <Flex flexGrow={1} justifyContent="flex-end" minWidth="44px">
            {favoriteButton}
          </Flex>
        }
      />
      <Dialog.Body>{body}</Dialog.Body>
      {footer}
    </Dialog>
  );
};

export default PasswordFormDialog;
