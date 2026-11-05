import { useEffect, useRef, useState } from "react";
import { ArrowLeft, FileText, Key, Paperclip, StarFill } from "@gravity-ui/icons";
import {
  Box,
  Button,
  Dialog,
  Divider,
  Flex,
  Icon,
  List,
  PlaceholderContainer,
  Text,
  useLayoutContext,
} from "@gravity-ui/uikit";
import { useTranslation } from "react-i18next";

import EntryDetails from "./EntryDetails";
import EntryListActions from "./EntryListActions";
import TaskSurface from "../TaskSurface";

const EntryBrowser = ({
  entries,
  totalCount,
  emptyMessage,
  onResetFilters,
  onCopy,
  requestedEntryId,
  onRequestedEntryOpen,
  mobileEntry,
  onOpenEntry,
  onCloseEntry,
  taskActive = true,
  ...actions
}) => {
  const { t } = useTranslation();
  const { isMediaActive } = useLayoutContext();
  const fixedViewport = isMediaActive("l");
  const desktop = isMediaActive("xl");
  const phone = !isMediaActive("s");
  const [selectedId, setSelectedId] = useState(null);
  const [menuEntryId, setMenuEntryId] = useState(null);
  const [revealedEntryId, setRevealedEntryId] = useState(null);
  const listRef = useRef(null);
  const closeRef = useRef(null);
  const selectedTrigger = useRef(null);
  const previousMobileEntry = useRef(null);
  const selected = mobileEntry ?? entries.find((entry) => entry.id === selectedId);

  useEffect(() => {
    const previous = previousMobileEntry.current;
    previousMobileEntry.current = mobileEntry?.id ?? null;
    if (!phone || mobileEntry || previous == null) return undefined;
    const frame = requestAnimationFrame(() => {
      listRef.current
        ?.querySelector(`[data-entry-id="${previous}"]`)
        ?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [phone, mobileEntry]);

  useEffect(() => {
    if (selectedId !== null && !selected) setSelectedId(null);
  }, [selected, selectedId]);

  useEffect(() => {
    if (revealedEntryId !== null && !entries.some((entry) => entry.id === revealedEntryId)) {
      setRevealedEntryId(null);
    }
  }, [entries, revealedEntryId]);

  useEffect(() => {
    if (requestedEntryId == null || !entries.some((entry) => entry.id === requestedEntryId)) return;
    selectedTrigger.current = listRef.current?.querySelector(
      `[data-entry-id="${requestedEntryId}"]`
    );
    setRevealedEntryId(null);
    setSelectedId(requestedEntryId);
    onRequestedEntryOpen?.();
  }, [entries, requestedEntryId, onRequestedEntryOpen]);

  useEffect(() => {
    if (desktop && selectedId !== null) closeRef.current?.focus();
  }, [selectedId, desktop]);

  const closeDetails = () => {
    if (mobileEntry) {
      onCloseEntry();
      return;
    }
    setSelectedId(null);
    window.requestAnimationFrame(() => selectedTrigger.current?.focus());
  };
  const details = selected && (
    <EntryDetails
      key={selected.id}
      entry={selected}
      showTitle={desktop}
      onCopy={onCopy}
      {...actions}
      onEdit={(entry) => {
        if (desktop || phone || mobileEntry) actions.onEdit(entry);
        else {
          setSelectedId(null);
          window.requestAnimationFrame(() => actions.onEdit(entry));
        }
      }}
      onDelete={(entry) => {
        if (desktop || phone) actions.onDelete(entry);
        else {
          setSelectedId(null);
          window.requestAnimationFrame(() => actions.onDelete(entry));
        }
      }}
      onShare={(entry) => {
        if (desktop || phone || mobileEntry) actions.onShare(entry);
        else {
          setSelectedId(null);
          window.requestAnimationFrame(() => actions.onShare(entry));
        }
      }}
    />
  );

  const showPhoneDetails = Boolean(phone && selected && taskActive);

  return (
    <>
      {phone && (
        <TaskSurface
          open={showPhoneDetails}
          aria-label={selected?.password_name}
          onOpenChange={(open) => {
            if (!open) onCloseEntry();
          }}
        >
          <TaskSurface.Header caption={selected?.password_name} />
          <TaskSurface.Body>{details}</TaskSurface.Body>
          <TaskSurface.Footer
            onClickButtonCancel={onCloseEntry}
            textButtonCancel={t("navigation.back")}
            propsButtonCancel={{ qa: "task-back" }}
          />
        </TaskSurface>
      )}
      {!showPhoneDetails && (
        <Flex
          gap="spacing-6"
          alignItems={fixedViewport ? "stretch" : "flex-start"}
          flexGrow={fixedViewport ? 1 : undefined}
          minHeight={fixedViewport ? "0" : undefined}
          overflow={fixedViewport ? "hidden" : undefined}
          onKeyDown={(event) => {
            if (desktop && selected && event.key === "Escape" && !event.defaultPrevented) {
              event.stopPropagation();
              closeDetails();
            }
          }}
        >
          <Box
            minWidth="0"
            flexGrow={1}
            flexBasis="0"
            height={fixedViewport ? "100%" : undefined}
            minHeight={fixedViewport ? "0" : undefined}
            overflow={fixedViewport ? "auto" : undefined}
            as="section"
            aria-label={t("vault.browser.entries")}
            qa="entry-scroll-region"
          >
            {entries.length !== totalCount && (
              <Flex alignItems="center" gap="spacing-2" paddingBlockEnd="spacing-3">
                <Text variant="subheader-1">{t("vault.browser.entries")}</Text>
                <Text color="secondary">{entries.length}</Text>
              </Flex>
            )}
            {entries.length === 0 ? (
              <PlaceholderContainer
                size="s"
                direction="column"
                content={
                  <Text variant="subheader-1" wordBreak="break-word">
                    {emptyMessage}
                  </Text>
                }
                actions={[
                  {
                    text: t("vault.resetFilters"),
                    size: "xl",
                    view: "outlined",
                    onClick: onResetFilters,
                  },
                ]}
              />
            ) : (
              <List
                ref={listRef}
                qa="entry-list"
                aria-label={t("vault.browser.entries")}
                role="grid"
                size="xl"
                items={entries}
                getItemId={(entry) => String(entry.id)}
                getItemTextValue={(entry) => entry.password_name}
                selectionMode="single"
                selectedIds={selected ? [String(selected.id)] : []}
                onItemAction={(_id, entry, event) => {
                  selectedTrigger.current = event.currentTarget;
                  setRevealedEntryId(null);
                  if (phone) onOpenEntry(entry);
                  else setSelectedId(entry.id);
                }}
                renderItem={(ctx, { getItemProps, getItemViewProps, getCellProps }) => (
                  <List.ItemView
                    {...getItemProps({ "data-entry-id": ctx.item.id })}
                    {...getItemViewProps()}
                    hovered={menuEntryId === ctx.item.id ? true : undefined}
                    startContent={<Icon data={ctx.item.kind === "note" ? FileText : Key} />}
                    description={
                      <Flex direction="column" gap="spacing-2" minWidth="0" width="100%">
                        <Flex gap="spacing-2" wrap="wrap" alignItems="center" qa="entry-metadata">
                          <Text wordBreak="break-all" ellipsis={phone} qa="entry-primary-value">
                            {ctx.item.kind === "note"
                              ? t("entry.kind.note")
                              : ctx.item.username || ctx.item.url || t("entry.kind.login")}
                          </Text>
                          {ctx.item.access === "read" && (
                            <Text color="secondary">{t("sharing.readOnlyAccess")}</Text>
                          )}
                          {ctx.item.folder && (
                            <Text wordBreak="break-word" ellipsis={phone} color="secondary">
                              {ctx.item.folder}
                            </Text>
                          )}
                          {ctx.item.attachment_count > 0 && (
                            <Text>
                              <Icon data={Paperclip} size={12} /> {ctx.item.attachment_count}
                            </Text>
                          )}
                        </Flex>
                        {revealedEntryId === ctx.item.id && (
                          <Flex
                            direction="column"
                            gap="spacing-1"
                            minWidth="0"
                            qa="entry-revealed-value"
                          >
                            <Divider qa="entry-revealed-separator" />
                            <Text variant="caption-2" color="secondary">
                              {t(
                                ctx.item.kind === "note"
                                  ? "entry.labels.note"
                                  : "common.fields.password"
                              )}
                            </Text>
                            <Text
                              as="code"
                              variant="code-1"
                              whiteSpace="break-spaces"
                              wordBreak="break-all"
                            >
                              {ctx.item.password_value}
                            </Text>
                          </Flex>
                        )}
                      </Flex>
                    }
                    endContent={
                      desktop && !selected ? (
                        <Box {...getCellProps()} onClick={(event) => event.stopPropagation()}>
                          <EntryListActions
                            entry={ctx.item}
                            onCopy={onCopy}
                            {...actions}
                            revealed={revealedEntryId === ctx.item.id}
                            onRevealChange={(revealed) =>
                              setRevealedEntryId(revealed ? ctx.item.id : null)
                            }
                            onMenuOpenChange={(open) => setMenuEntryId(open ? ctx.item.id : null)}
                          />
                        </Box>
                      ) : undefined
                    }
                  >
                    <Flex {...getCellProps()} alignItems="center" gap="spacing-1" minWidth="0">
                      <Text
                        wordBreak="break-word"
                        ellipsisLines={phone ? 2 : undefined}
                        qa="entry-name"
                      >
                        {ctx.item.password_name}
                      </Text>
                      {ctx.item.favorite && <Icon data={StarFill} size={12} />}
                    </Flex>
                  </List.ItemView>
                )}
              />
            )}
          </Box>
          {desktop && selected && (
            <Flex
              as="section"
              aria-label={t("vault.browser.details")}
              direction="column"
              gap="spacing-4"
              flexBasis="50%"
              minWidth="0"
              minHeight="0"
              overflow="auto"
            >
              <Flex>
                <Button
                  size="xl"
                  ref={closeRef}
                  view="outlined"
                  onClick={closeDetails}
                  qa="entry-details-back"
                >
                  <Icon data={ArrowLeft} />
                  {t("vault.browser.back")}
                </Button>
              </Flex>
              {details}
            </Flex>
          )}
          {!desktop && !phone && (
            <Dialog
              open={Boolean(selected)}
              onOpenChange={(open) => {
                if (!open) closeDetails();
              }}
              aria-label={selected?.password_name}
              fullWidth
              maxWidth="m"
              contentOverflow="auto"
              returnFocus={selectedTrigger}
            >
              <Dialog.Header caption={selected?.password_name} />
              <Dialog.Body>{details}</Dialog.Body>
              <Dialog.Footer
                onClickButtonCancel={closeDetails}
                textButtonCancel={t("vault.browser.back")}
              />
            </Dialog>
          )}
        </Flex>
      )}
    </>
  );
};
export default EntryBrowser;
