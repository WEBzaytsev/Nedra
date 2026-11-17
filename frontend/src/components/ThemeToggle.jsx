import { Moon, Sun } from "@gravity-ui/icons";
import { Button, Icon, Tooltip } from "@gravity-ui/uikit";
import { useTranslation } from "react-i18next";

import { useColorMode } from "../hooks/useColorMode";

const ThemeToggle = ({ showLabel = false, width = "auto" }) => {
  const { t } = useTranslation();
  const { mode, toggle } = useColorMode();
  const dark = mode === "dark";
  const label = t(dark ? "theme.switchToLight" : "theme.switchToDark");

  return (
    <Tooltip content={label} role={showLabel ? "tooltip" : "label"}>
      <Button
        type="button"
        view="flat-secondary"
        size="xl"
        width={width}
        aria-label={showLabel ? `${t(dark ? "theme.light" : "theme.dark")}: ${label}` : label}
        onClick={toggle}
      >
        <Icon data={dark ? Sun : Moon} />
        {showLabel && t(dark ? "theme.light" : "theme.dark")}
      </Button>
    </Tooltip>
  );
};

export default ThemeToggle;
