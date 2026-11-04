import { ArrowRotateRight } from "@gravity-ui/icons";
import { Button, Card, Flex, Icon, Slider, Text, Tooltip } from "@gravity-ui/uikit";
import { useTranslation } from "react-i18next";

const CHAR_OPTS = [
  { key: "uppercase", label: "A–Z" },
  { key: "lowercase", label: "a–z" },
  { key: "numbers", label: "0–9" },
  { key: "symbols", label: "!@#" },
];

const CHAR_KEYS = CHAR_OPTS.map((option) => option.key);

const PasswordGenerator = ({
  options,
  onChangeLength,
  onToggleClass,
  onRegenerate,
  canUndo = false,
  onUndo,
}) => {
  const { t } = useTranslation();

  return (
    <Card type="container" view="filled" size="l">
      <Flex direction="column" gap="spacing-4" minWidth="0" padding="spacing-4" as="section">
        <Flex gap="spacing-2" alignItems="baseline" justifyContent="space-between">
          <Text>{t("generator.length")}</Text>
          <Text as="output" variant="subheader-2">
            {options.length}
          </Text>
        </Flex>
        <Slider
          value={options.length}
          min={8}
          max={64}
          step={1}
          onUpdate={onChangeLength}
          aria-label={t("generator.length")}
        />
        <Flex gap="spacing-2" minWidth="0" wrap="wrap" alignItems="center">
          {CHAR_OPTS.map(({ key, label }) => (
            <Button
              key={key}
              type="button"
              size="xl"
              selected={options[key]}
              view="outlined"
              onClick={() => onToggleClass(key)}
              aria-pressed={options[key]}
            >
              <Text wordBreak="break-word" variant="code-1">
                {label}
              </Text>
            </Button>
          ))}
        </Flex>
        <Flex gap="spacing-2" justifyContent="space-between" wrap="wrap">
          {canUndo && (
            <Button type="button" size="xl" view="flat-secondary" onClick={onUndo}>
              {t("generator.undoReplacement")}
            </Button>
          )}
          <Tooltip content={t("generator.regenerate")}>
            <Button
              type="button"
              size="xl"
              view="flat-secondary"
              onClick={onRegenerate}
              aria-label={t("generator.regenerate")}
            >
              <Icon data={ArrowRotateRight} />
            </Button>
          </Tooltip>
        </Flex>
      </Flex>
    </Card>
  );
};

export { CHAR_KEYS };
export default PasswordGenerator;
