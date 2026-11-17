import { Globe } from "@gravity-ui/icons";
import { Button, Icon, Menu, MenuItem } from "@gravity-ui/uikit";
import { useTranslation } from "react-i18next";

const OPTIONS = [
  { language: "en", labelKey: "language.english" },
  { language: "ru", labelKey: "language.russian" },
];

const LanguageSwitcher = ({ placement = "inline", width = "auto" }) => {
  const { t, i18n } = useTranslation();
  const current = (i18n.resolvedLanguage ?? i18n.language)?.split("-")[0] ?? "en";

  return (
    <Menu
      placement={placement === "floating" || placement === "auth" ? "bottom-end" : "top-end"}
      trigger={
        <Button
          type="button"
          view="flat-secondary"
          size="xl"
          width={width}
          aria-label={`${t("language.label")}: ${current.toUpperCase()}`}
        >
          <Icon data={Globe} />
          {current.toUpperCase()}
        </Button>
      }
    >
      {OPTIONS.map(({ language, labelKey }) => (
        <MenuItem
          key={language}
          selected={current === language}
          onClick={() => i18n.changeLanguage(language)}
        >
          {t(labelKey)}
        </MenuItem>
      ))}
    </Menu>
  );
};

export default LanguageSwitcher;
