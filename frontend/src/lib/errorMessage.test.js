import assert from "node:assert/strict";
import test from "node:test";

import i18n from "../i18n/index.js";
import { errorMessage } from "./errorMessage.js";

test("localizes known Russian security-key errors", async () => {
  await i18n.changeLanguage("ru");
  assert.equal(
    errorMessage("WebAuthn is not available in this client.", "Не удалось войти."),
    "Для разблокировки устройством нужен Touch ID в приложении для macOS или встроенный аутентификатор с PRF по HTTPS либо localhost."
  );
});

test("preserves unknown error details in Russian", async () => {
  await i18n.changeLanguage("ru");
  assert.equal(
    errorMessage("WebAuthn driver failed with code 17.", "Не удалось войти."),
    "WebAuthn driver failed with code 17."
  );
});
