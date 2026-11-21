import { ext } from "../shared/browser";

export const REOPEN_OPTIONS = "reopenOptions";

const RESTART_GRACE_MS = 60_000;
const started = Date.now();

export const nativeMessagingReady = (): boolean =>
  typeof (ext.runtime as Partial<typeof ext.runtime>).connectNative === "function";

export const restart = async ({
  reopenOptions,
  force = false,
}: {
  reopenOptions: boolean;
  force?: boolean;
}): Promise<boolean> => {
  if (!force && Date.now() - started < RESTART_GRACE_MS) return false;
  if (reopenOptions) await ext.storage.local.set({ [REOPEN_OPTIONS]: true });
  setTimeout(() => ext.runtime.reload(), 200);
  return true;
};

export const resumeAfterRestart = async (): Promise<void> => {
  const stored = (await ext.storage.local.get(REOPEN_OPTIONS)) as Record<string, unknown>;
  if (stored[REOPEN_OPTIONS] !== true) return;
  await ext.storage.local.remove(REOPEN_OPTIONS);
  await ext.runtime.openOptionsPage();
};
