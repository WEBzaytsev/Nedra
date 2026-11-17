import { useEffect, useState } from "react";
import { Button, Text, Tooltip } from "@gravity-ui/uikit";
import { useTranslation } from "react-i18next";

import { generateTotp, totpRemaining } from "../../lib/totp";

const PERIOD = 30;

const TotpCell = ({ secret, onCopy }) => {
  const { t } = useTranslation();
  const [code, setCode] = useState("");
  const [remaining, setRemaining] = useState(PERIOD);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    let active = true;
    const tick = async () => {
      try {
        const next = await generateTotp(secret);
        if (!active) return;
        setCode(next);
        setInvalid(false);
      } catch {
        if (active) setInvalid(true);
      }
      if (active) setRemaining(totpRemaining(PERIOD));
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [secret]);

  if (invalid) return <Text color="danger">{t("totp.invalid")}</Text>;
  if (!code) return null;

  return (
    <Tooltip content={t("totp.copy")}>
      <Button
        type="button"
        view="flat-secondary"
        size="xl"
        aria-label={`${t("totp.copy")} ${code.slice(0, 3)} ${code.slice(3)} ${remaining}s`}
        onClick={() => onCopy?.(code)}
      >
        <Text as="span" variant="code-1">
          {code.slice(0, 3)} {code.slice(3)}
        </Text>{" "}
        <Text as="span" aria-hidden="true" color={remaining <= 5 ? "warning" : "secondary"}>
          {remaining}s
        </Text>
      </Button>
    </Tooltip>
  );
};

export default TotpCell;
