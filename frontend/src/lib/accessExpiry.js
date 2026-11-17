import { settings as dateSettings, dateTime } from "@gravity-ui/date-utils";

export const LOCAL_EXPIRY_FORMAT = "YYYY-MM-DDTHH:mm";

const LOCAL_EXPIRY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export const parseLocalExpiry = (value) => {
  const match = LOCAL_EXPIRY_PATTERN.exec(value);
  if (!match) return null;

  const [, year, month, day, hour, minute] = match;
  const timeZone = dateSettings.getDefaultTimeZone();
  const parsed = dateTime({
    input: [Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)],
    timeZone,
  });
  if (!parsed.isValid()) return null;

  const instant = parsed.toISOString();
  const roundTrip = dateTime({ input: instant }).timeZone(timeZone);
  if (roundTrip.format(LOCAL_EXPIRY_FORMAT) !== value) return null;

  const previousHour = roundTrip.subtract(1, "hour").timeZone(timeZone);
  const nextHour = roundTrip.add(1, "hour").timeZone(timeZone);
  if (
    previousHour.format(LOCAL_EXPIRY_FORMAT) === value ||
    nextHour.format(LOCAL_EXPIRY_FORMAT) === value
  ) {
    return null;
  }

  return parsed;
};

export const toUtcExpiry = (value) => {
  if (!value) return null;
  const parsed = parseLocalExpiry(value);
  if (!parsed) throw new RangeError("Invalid access expiry");
  return parsed.toISOString();
};

export const toLocalExpiry = (value) => {
  if (!value) return "";
  const iso = /[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`;
  const parsed = dateTime({ input: iso }).timeZone(dateSettings.getDefaultTimeZone());
  return parsed.isValid() ? parsed.format(LOCAL_EXPIRY_FORMAT) : "";
};

export const toPersistedExpiry = (value, originalValue) =>
  value === toLocalExpiry(originalValue) ? (originalValue ?? null) : toUtcExpiry(value);

export const isInvalidExpiry = (value, now = Date.now()) => {
  if (!value) return false;
  const parsed = parseLocalExpiry(value);
  return !parsed || parsed.valueOf() <= now;
};
