import { Flex, Progress, Text } from "@gravity-ui/uikit";
import { useTranslation } from "react-i18next";

import { getPasswordStrength } from "../../lib/passwordStrength";

const StrengthBar = ({ password }) => {
  const { t } = useTranslation();
  const strength = getPasswordStrength(password);
  if (!strength) return null;

  const theme = strength.level < 2 ? "danger" : strength.level === 2 ? "warning" : "success";

  return (
    <Flex direction="column" gap="spacing-2">
      <Progress
        size="s"
        theme={theme}
        value={(strength.level + 1) * 20}
        aria-label={t(strength.labelKey)}
      />
      <Text variant="caption-2" color="secondary">
        {t(strength.labelKey)}
        {strength.recommend && ` — ${t("strength.recommendation")}`}
      </Text>
    </Flex>
  );
};

export default StrengthBar;
