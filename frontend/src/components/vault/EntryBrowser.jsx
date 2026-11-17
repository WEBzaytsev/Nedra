import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRightFromSquare,
  ClockArrowRotateLeft,
  Copy,
  CopyPlus,
  EllipsisVertical,
  FileText,
  Key,
  Paperclip,
  Pencil,
  Pin,
  Star,
  StarFill,
  TrashBin,
} from "@gravity-ui/icons";
import {
  Box,
  Button,
  Checkbox,
  Dialog,
  Divider,
  Flex,
  Icon,
  List,
  Menu,
  MenuDivider,
  MenuItem,
  PlaceholderContainer,
  Text,
  useLayoutContext,
} from "@gravity-ui/uikit";
import { useTranslation } from "react-i18next";

import EntryDetails from "./EntryDetails";
import EntryListActions from "./EntryListActions";
import TaskSurface from "../TaskSurface";
import { IS_DESKTOP, openExternal } from "../../platform";

const contextTrigger = (left, top) => ({
  getBoundingClientRect: () => ({
    width: 0,
    height: 0,
    x: left,
    y: top,
    top,
    right: left,
    bottom: top,
    left,
  }),
});

const EntryContextMenu = ({ menu, onClose, onCopy, onCopyTotp, ...actions }) => {
  const { t } = useTranslation();
  const entry = menu?.entry;
  const writable = entry?.access === "owner" || entry?.access === "write";
  const run = (action) => () => {
    onClose();
    action();
  };
  const openWebsite = () => {
    const url = /^https?:\/\//i.test(entry.url) ? entry.url : `https://${entry.url}`;
    if (IS_DESKTOP) openExternal(url).catch(() => {});
    else window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <Menu
      aria-label={
        menu?.selection > 1
          ? t("vault.context.selectedActions", { count: menu.selection })
          : t("vault.context.actions", { name: entry?.password_name })
      }
      open={Boolean(menu)}
      trigger={menu?.trigger ?? null}
      placement="bottom-start"
      qa="entry-context-menu"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {menu?.selection > 1 ? (
        <>
          <MenuItem onClick={run(actions.onBulkMove)}>
            {t("vault.context.moveSelected", { count: menu.selection })}
          </MenuItem>
          <MenuItem theme="danger" onClick={run(actions.onBulkTrash)}>
            {t("vault.context.trashSelected", { count: menu.selection })}
          </MenuItem>
          <MenuDivider />
          <MenuItem onClick={run(actions.onClearSelection)}>
            {t("vault.bulk.clearSelection")}
          </MenuItem>
        </>
      ) : (
        entry && (
          <>
            {entry.kind !== "note" && entry.username && (
              <MenuItem icon={<Icon data={Copy} />} onClick={run(() => onCopy(entry.username))}>
                {t("vault.columns.copyUsername")}
              </MenuItem>
            )}
            <MenuItem icon={<Icon data={Copy} />} onClick={run(() => onCopy(entry.password_value))}>
              {t(entry.kind === "note" ? "vault.browser.copyNote" : "vault.columns.copyPassword")}
            </MenuItem>
            {entry.totp_secret && (
              <MenuItem icon={<Icon data={Pin} />} onClick={run(() => onCopyTotp(entry))}>
                {t("totp.copy")}
              </MenuItem>
            )}
            {entry.url && (
              <MenuItem icon={<Icon data={Copy} />} onClick={run(() => onCopy(entry.url))}>
                {t("vault.context.copyWebsite")}
              </MenuItem>
            )}
            {entry.url && (
              <MenuItem icon={<Icon data={ArrowUpRightFromSquare} />} onClick={run(openWebsite)}>
                {t("vault.columns.openWebsite")}
              </MenuItem>
            )}
            {entry.kind !== "note" && entry.password_history?.length > 0 && (
              <MenuItem
                icon={<Icon data={ClockArrowRotateLeft} />}
                onClick={run(() => actions.onHistory(entry))}
              >
                {t("entry.labels.passwordHistory", { count: entry.password_history.length })}
              </MenuItem>
            )}
            {writable && <MenuDivider />}
            {writable && (
              <MenuItem icon={<Icon data={Pencil} />} onClick={run(() => actions.onEdit(entry))}>
                {t("common.actions.edit")}
              </MenuItem>
            )}
            {writable && (
              <MenuItem
                icon={<Icon data={CopyPlus} />}
                onClick={run(() => actions.onDuplicate(entry))}
              >
                {t("vault.context.duplicate")}
              </MenuItem>
            )}
            {writable && (
              <MenuItem
                icon={<Icon data={entry.favorite ? StarFill : Star} />}
                onClick={run(() => actions.onToggleFavorite(entry))}
              >
                {t(entry.favorite ? "vault.columns.removeFavorite" : "vault.columns.markFavorite")}
              </MenuItem>
            )}
            {entry.access === "owner" && (
              <MenuItem onClick={run(() => actions.onShare(entry))}>{t("sharing.manage")}</MenuItem>
            )}
            {writable && (
              <MenuItem onClick={run(() => actions.onMove(entry))}>{t("vault.bulk.move")}</MenuItem>
            )}
            {writable && <MenuDivider />}
            {writable && (
              <MenuItem
                theme="danger"
                icon={<Icon data={TrashBin} />}
                onClick={run(() => actions.onDelete(entry.password_name))}
              >
                {t("vault.bulk.moveToTrash")}
              </MenuItem>
            )}
          </>
        )
      )}
    </Menu>
  );
};

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
  selectedEntryIds = [],
  onSelectedEntryIdsChange,
  onBulkTrash,
  bulkTrashPending = false,
  onBulkMove,
  bulkMovePending = false,
  onCopyTotp,
  onDuplicate,
  onMove,
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
  const [contextMenu, setContextMenu] = useState(null);
  const [revealedEntryId, setRevealedEntryId] = useState(null);
  const listRef = useRef(null);
  const closeRef = useRef(null);
  const selectedTrigger = useRef(null);
  const previousMobileEntry = useRef(null);
  const selected = mobileEntry ?? entries.find((entry) => entry.id === selectedId);
  const selectedEntryIdSet = new Set(selectedEntryIds);

  const closeContextMenu = () => {
    const restoreFocus = contextMenu?.restoreFocus;
    setContextMenu(null);
    window.requestAnimationFrame(() => restoreFocus?.focus({ preventScroll: true }));
  };

  const openContextMenu = (entry, restoreFocus, event) => {
    if (event?.shiftKey) return;
    event?.preventDefault();
    const box = restoreFocus.getBoundingClientRect();
    const pointer =
      event &&
      event.clientX >= box.left &&
      event.clientX <= box.right &&
      event.clientY >= box.top &&
      event.clientY <= box.bottom;
    restoreFocus.focus({ preventScroll: true });
    setContextMenu({
      entry,
      selection: selectedEntryIdSet.has(String(entry.id)) ? selectedEntryIds.length : 0,
      trigger: contextTrigger(
        pointer ? event.clientX : box.left,
        pointer ? event.clientY : box.bottom
      ),
      restoreFocus,
    });
  };

  const toggleSelection = (entryId, checked) => {
    const id = String(entryId);
    onSelectedEntryIdsChange?.(
      checked
        ? [...selectedEntryIds, id]
        : selectedEntryIds.filter((selectedId) => selectedId !== id)
    );
  };

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
            if (contextMenu && event.key === "Escape") {
              event.preventDefault();
              closeContextMenu();
              return;
            }
            if (
              !event.defaultPrevented &&
              !bulkMovePending &&
              selectedEntryIds.length > 0 &&
              (event.key === "Delete" || event.key === "Backspace")
            ) {
              event.preventDefault();
              onBulkTrash?.();
              return;
            }
            if (
              !event.defaultPrevented &&
              !bulkTrashPending &&
              !bulkMovePending &&
              selectedEntryIds.length > 0 &&
              event.key === "Escape"
            ) {
              event.preventDefault();
              onSelectedEntryIdsChange?.([]);
              return;
            }
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
            {selectedEntryIds.length > 0 && (
              <Flex
                direction={{ xs: "column", s: "row" }}
                gap="spacing-3"
                alignItems={{ s: "center" }}
                justifyContent="space-between"
                paddingBlockEnd="spacing-3"
                minWidth="0"
                qa="entry-bulk-actions"
              >
                <Text role="status">
                  {t("vault.bulk.selected", { count: selectedEntryIds.length })}
                </Text>
                <Flex gap="spacing-2" wrap="wrap">
                  <Button
                    size="xl"
                    view="outlined"
                    disabled={bulkTrashPending || bulkMovePending}
                    loading={bulkMovePending}
                    onClick={onBulkMove}
                  >
                    {t("vault.bulk.move")}
                  </Button>
                  <Button
                    size="xl"
                    view="outlined-danger"
                    disabled={bulkTrashPending || bulkMovePending}
                    loading={bulkTrashPending}
                    onClick={onBulkTrash}
                  >
                    <Icon data={TrashBin} />
                    {t("vault.bulk.moveToTrash")}
                  </Button>
                  <Button
                    size="xl"
                    view="outlined"
                    disabled={bulkTrashPending || bulkMovePending}
                    onClick={() => onSelectedEntryIdsChange?.([])}
                  >
                    {t("vault.bulk.clearSelection")}
                  </Button>
                </Flex>
              </Flex>
            )}
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
                    {...getItemProps({
                      "data-entry-id": ctx.item.id,
                      onContextMenu: (event) =>
                        openContextMenu(ctx.item, event.currentTarget, event),
                      onKeyDown: (event) => {
                        if (
                          event.key === "ContextMenu" ||
                          (event.shiftKey && event.key === "F10")
                        ) {
                          event.preventDefault();
                          openContextMenu(ctx.item, event.currentTarget);
                        }
                      },
                    })}
                    {...getItemViewProps()}
                    hovered={
                      menuEntryId === ctx.item.id || contextMenu?.entry.id === ctx.item.id
                        ? true
                        : undefined
                    }
                    startContent={
                      <Flex {...getCellProps()} gap="spacing-2" alignItems="center">
                        <Checkbox
                          checked={selectedEntryIdSet.has(String(ctx.item.id))}
                          disabled={
                            bulkTrashPending || bulkMovePending || ctx.item.access === "read"
                          }
                          size="xl"
                          controlProps={{
                            "aria-label": t("vault.bulk.selectEntry", {
                              name: ctx.item.password_name,
                            }),
                            tabIndex: -1,
                            onClick: (event) => event.stopPropagation(),
                            onKeyDown: (event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                event.stopPropagation();
                                toggleSelection(
                                  ctx.item.id,
                                  !selectedEntryIdSet.has(String(ctx.item.id))
                                );
                              } else if (event.key === " ") {
                                event.stopPropagation();
                              }
                            },
                          }}
                          onUpdate={(checked) => toggleSelection(ctx.item.id, checked)}
                        />
                        <Icon data={ctx.item.kind === "note" ? FileText : Key} />
                      </Flex>
                    }
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
                      ) : phone ? (
                        <Box {...getCellProps()} onClick={(event) => event.stopPropagation()}>
                          <Button
                            type="button"
                            view="flat-secondary"
                            size="xl"
                            aria-label={`${t("navigation.more")}: ${ctx.item.password_name}`}
                            qa="entry-context-more"
                            onClick={(event) => openContextMenu(ctx.item, event.currentTarget)}
                          >
                            <Icon data={EllipsisVertical} />
                          </Button>
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
      <EntryContextMenu
        menu={contextMenu}
        onClose={closeContextMenu}
        onCopy={onCopy}
        onCopyTotp={onCopyTotp}
        onEdit={actions.onEdit}
        onHistory={actions.onHistory}
        onShare={actions.onShare}
        onToggleFavorite={actions.onToggleFavorite}
        onDelete={actions.onDelete}
        onDuplicate={onDuplicate}
        onMove={onMove}
        onBulkTrash={onBulkTrash}
        onBulkMove={onBulkMove}
        onClearSelection={() => onSelectedEntryIdsChange?.([])}
      />
    </>
  );
};
export default EntryBrowser;
