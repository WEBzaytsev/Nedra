// All password-strength scoring lives here. Two scales share one character-class
// core: a 5-level scale for stored vault entries (getPasswordStrength) and a
// 4-level scale for the master password on the login screen (getMasterPasswordStrength).

const charClasses = (password) => ({
  lower: /[a-z]/.test(password),
  upper: /[A-Z]/.test(password),
  number: /\d/.test(password),
  special: /[^A-Za-z0-9]/.test(password),
});

const STRENGTH_LEVELS = [
  { labelKey: "strength.veryWeak", recommend: true },
  { labelKey: "strength.weak", recommend: true },
  { labelKey: "strength.fair", recommend: true },
  { labelKey: "strength.strong", recommend: false },
  { labelKey: "strength.veryStrong", recommend: false },
];

// 5-level scale used across the vault (strength bar + row icons).
export const getPasswordStrength = (password) => {
  if (!password) return null;

  const { lower, upper, number, special } = charClasses(password);
  let score = 0;
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (password.length >= 16) score++;
  if (lower && upper) score++;
  if (number) score++;
  if (special) score++;

  // Short passwords are capped regardless of character variety.
  if (password.length < 6) score = Math.min(score, 0);
  else if (password.length < 8) score = Math.min(score, 1);

  const level = Math.min(Math.max(Math.floor((score / 6) * 5), 0), 4);
  return { level, ...STRENGTH_LEVELS[level] };
};

// 4-level scale for the master password. `value` drives Gravity Progress and
// the create-vault threshold; `theme` is a native Gravity severity.
export const getMasterPasswordStrength = (password) => {
  if (!password) return null;

  const classes = charClasses(password);
  const variety = Object.values(classes).filter(Boolean).length;

  if (password.length < 8) return { labelKey: "strength.tooShort", value: 20, theme: "danger" };
  if (password.length < 12 || variety < 2)
    return { labelKey: "strength.weak", value: 40, theme: "danger" };
  if (password.length < 16 || variety < 3)
    return { labelKey: "strength.fair", value: 70, theme: "warning" };
  return { labelKey: "strength.strong", value: 100, theme: "success" };
};
