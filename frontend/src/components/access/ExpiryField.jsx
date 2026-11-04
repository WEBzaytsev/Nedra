import { useContext, useId, useMemo } from "react";
import { Calendar, DatePicker } from "@gravity-ui/date-components";
import { settings as dateSettings, dateTime } from "@gravity-ui/date-utils";
import { Flex, MobileContext, Text } from "@gravity-ui/uikit";
import { useTranslation } from "react-i18next";

import { LOCAL_EXPIRY_FORMAT, parseLocalExpiry } from "../../lib/accessExpiry";

const ExpiryField = ({ value, onUpdate, disabled, invalid }) => {
  const { t, i18n } = useTranslation();
  const inputId = useId();
  const hintId = useId();
  const mobileContext = useContext(MobileContext);
  const datePickerContext = useMemo(() => ({ ...mobileContext, mobile: false }), [mobileContext]);
  const language = (i18n.resolvedLanguage ?? i18n.language)?.startsWith("ru") ? "ru" : "en";
  const timeZone = dateSettings.getDefaultTimeZone();

  return (
    <Flex direction="column" gap="spacing-2" minWidth="0" width="100%">
      <Text as="label" htmlFor={inputId}>
        {t("folderAccess.expiresAt")}
      </Text>
      <MobileContext.Provider value={datePickerContext}>
        <DatePicker
          className="nedra-expiry-picker"
          id={inputId}
          size="xl"
          format={language === "ru" ? "DD.MM.YYYY HH:mm" : "MM/DD/YYYY HH:mm"}
          value={value ? parseLocalExpiry(value) : null}
          minValue={dateTime({ timeZone }).startOf("minute").add(1, "minute")}
          disabled={disabled}
          hasClear
          onUpdate={(nextValue) => onUpdate(nextValue?.format(LOCAL_EXPIRY_FORMAT) ?? "")}
          validationState={invalid ? "invalid" : undefined}
          errorMessage={invalid ? t("folderAccess.expiresValidation") : undefined}
          aria-label={t("folderAccess.expiresAt")}
          aria-describedby={hintId}
        >
          {(calendarProps) => (
            <Calendar
              {...calendarProps}
              className="nedra-expiry-calendar"
              size={mobileContext.mobile ? "l" : "m"}
              style={
                mobileContext.mobile
                  ? { "--g-date-calendar-day-size": "40px", "--g-date-calendar-padding": "4px" }
                  : undefined
              }
            />
          )}
        </DatePicker>
      </MobileContext.Provider>
      <Text id={hintId} variant="caption-2" color="secondary">
        {t("folderAccess.expiresHint")}
      </Text>
    </Flex>
  );
};

export default ExpiryField;
