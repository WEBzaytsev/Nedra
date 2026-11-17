import { Flex, Loader, Text } from "@gravity-ui/uikit";
import { useTranslation } from "react-i18next";

import BrandMark from "./BrandMark";

const LoadingScreen = ({ label }) => {
  const { t } = useTranslation();

  return (
    <Flex
      minHeight="100dvh"
      direction="column"
      gap="spacing-4"
      alignItems="center"
      justifyContent="center"
      role="status"
      aria-live="polite"
    >
      <BrandMark />
      <Loader size="l" />
      <Text color="secondary">{label ?? t("common.labels.loading")}</Text>
    </Flex>
  );
};

export default LoadingScreen;
