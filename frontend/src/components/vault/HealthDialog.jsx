import { useId, useMemo } from "react";
import { Check, ChevronRight, Clock, Copy, ShieldExclamation } from "@gravity-ui/icons";
import { Divider, Flex, Icon, List, Progress, Text, useLayoutContext } from "@gravity-ui/uikit";
import Dialog from "../TaskSurface";
import { useTranslation } from "react-i18next";

import { analyzeVault } from "../../lib/vaultHealth";

const SCORE_THEME = { error: "danger", success: "success", warning: "warning" };

const scoreColor = (score) => {
  if (score >= 80) return "success";
  if (score >= 50) return "warning";
  return "error";
};

const scoreLabelKey = (score) => {
  if (score >= 80) return "health.healthy";
  if (score >= 50) return "health.needsAttention";
  return "health.atRisk";
};

const ScoreGauge = ({ score }) => {
  const { t } = useTranslation();
  const color = scoreColor(score);

  return (
    <Flex direction="column" gap="spacing-3" minWidth="0" as="section">
      <Flex gap="spacing-2" minWidth="0" alignItems="baseline">
        <Text as="output" variant="header-1">
          {score}
        </Text>
        <Text color="secondary">/ 100</Text>
        <Text as="strong">{t(scoreLabelKey(score))}</Text>
      </Flex>
      <Progress size="s" theme={SCORE_THEME[color]} value={score} />
    </Flex>
  );
};

const StatTile = ({ icon, label, count, color }) => (
  <Flex gap="spacing-2" alignItems="center" minWidth="0" flexGrow={1}>
    <Icon data={icon} />
    <Text as="strong" color={color === "error" ? "danger" : color}>
      {count}
    </Text>
    <Text wordBreak="break-word">{label}</Text>
  </Flex>
);

const IssueGroup = ({ icon, title, hint, color, entries, onSelect }) => {
  const { isMediaActive } = useLayoutContext();
  const phone = !isMediaActive("s");
  if (entries.length === 0) return null;

  return (
    <Flex direction="column" gap="spacing-3" minWidth="0" as="section" qa="health-issue-group">
      <Flex gap="spacing-2" alignItems="baseline" minWidth="0" wrap="wrap">
        <Icon data={icon} />
        <Text as="strong" color={color === "error" ? "danger" : color}>
          {title}
        </Text>
        <Text color="secondary">({entries.length})</Text>
      </Flex>
      <Text as="div" color="secondary" wordBreak="break-word">
        {hint}
      </Text>
      <Flex direction="column" gap="spacing-1" minWidth="0">
        {entries.map((entry) => (
          <List.ItemView
            key={entry.password_name}
            onClick={() => onSelect(entry)}
            component="button"
            type="button"
            size="xl"
            style={{ textAlign: "start" }}
            description={
              <Text wordBreak="break-all" ellipsis={phone}>
                {entry.username}
              </Text>
            }
            endContent={<Icon data={ChevronRight} />}
          >
            <Text wordBreak="break-word" ellipsisLines={phone ? 2 : undefined}>
              {entry.password_name}
            </Text>
          </List.ItemView>
        ))}
      </Flex>
    </Flex>
  );
};

const HealthDialog = ({ open, onClose, passwords, onSelect }) => {
  const { t } = useTranslation();
  const titleId = useId();
  const report = useMemo(() => analyzeVault(passwords), [passwords]);
  const allClear =
    report.weak.length === 0 && report.reused.length === 0 && report.stale.length === 0;

  return (
    <Dialog
      aria-labelledby={titleId}

      contentOverflow="auto"
      fullWidth
      hasCloseButton={false}
      maxWidth="l"
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      open={open}
    >
      <Dialog.Header caption={t("health.title")} id={titleId} />
      <Dialog.Body hasBorders>
        <Flex direction="column" gap="spacing-5" minHeight="0" minWidth="0">
          <ScoreGauge score={report.score} />
          <Flex
            direction={{ xs: "column", s: "row" }}
            gap="spacing-3"
            minWidth="0"
            wrap="wrap"
            alignItems={{ m: "center" }}
          >
            <StatTile
              color="error"
              count={report.weak.length}
              icon={ShieldExclamation}
              label={t("health.weak")}
            />
            <StatTile
              color="warning"
              count={report.reused.length}
              icon={Copy}
              label={t("health.reused")}
            />
            <StatTile
              color="secondary"
              count={report.stale.length}
              icon={Clock}
              label={t("health.old")}
            />
          </Flex>
          <Text as="div" color="secondary" wordBreak="break-word">
            {t("health.localOnly")}
          </Text>
          {allClear ? (
            <Flex gap="spacing-3" alignItems="center" minWidth="0">
              <Icon data={Check} />
              <Text>{t("health.allClear")}</Text>
            </Flex>
          ) : (
            <>
              <Divider />
              <Flex direction="column" gap="spacing-5" minWidth="0">
                <IssueGroup
                  color="error"
                  entries={report.weak}
                  hint={t("health.weakHint")}
                  icon={ShieldExclamation}
                  onSelect={onSelect}
                  title={t("health.weak")}
                />
                <IssueGroup
                  color="warning"
                  entries={report.reused}
                  hint={t("health.reusedHint")}
                  icon={Copy}
                  onSelect={onSelect}
                  title={t("health.reused")}
                />
                <IssueGroup
                  color="secondary"
                  entries={report.stale}
                  hint={t("health.oldHint")}
                  icon={Clock}
                  onSelect={onSelect}
                  title={t("health.old")}
                />
              </Flex>
            </>
          )}
        </Flex>
      </Dialog.Body>
      <Dialog.Footer
        onClickButtonApply={onClose}
        textButtonApply={t("common.actions.done")}
        propsButtonApply={{ view: "normal" }}
      />
    </Dialog>
  );
};

export default HealthDialog;
