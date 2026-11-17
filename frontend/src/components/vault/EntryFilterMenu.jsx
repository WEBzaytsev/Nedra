import { useState } from "react";
import { Button, Flex, Menu, MenuDivider, MenuItem, Text } from "@gravity-ui/uikit";
import { useTranslation } from "react-i18next";

import { ENTRY_FILTERS } from "../../lib/entryFilters";

const EntryFilterMenu = ({ active, counts, onChange }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const title = t("vault.filters.title");
  const label = active.size ? t("vault.filters.active", { count: active.size }) : title;

  const toggle = (key) => {
    const next = new Set(active);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(next);
  };

  return (
    <Menu
      aria-label={title}
      open={open}
      onOpenChange={setOpen}
      placement="bottom-start"
      size="xl"
      trigger={
        <Button
          type="button"
          view="outlined"
          size="xl"
          width="max"
          selected={active.size > 0}
          qa="entry-filters"
        >
          {label}
        </Button>
      }
    >
      {ENTRY_FILTERS.map((filter) => {
        const count = counts.get(filter.key) ?? 0;
        const selected = active.has(filter.key);
        return (
          <MenuItem
            key={filter.key}
            qa={`entry-filter-${filter.key}`}
            selected={selected}
            disabled={count === 0 && !selected}
            onClick={() => toggle(filter.key)}
          >
            <Flex alignItems="center" gap="spacing-4" justifyContent="space-between" width="100%">
              <Text>{t(filter.labelKey)}</Text>
              <Text color="secondary">{count}</Text>
            </Flex>
          </MenuItem>
        );
      })}
      <MenuDivider />
      <MenuItem
        qa="entry-filters-clear"
        disabled={active.size === 0}
        onClick={() => {
          onChange(new Set());
          setOpen(false);
        }}
      >
        {t("vault.filters.clear")}
      </MenuItem>
    </Menu>
  );
};

export default EntryFilterMenu;
