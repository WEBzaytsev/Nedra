import { ext } from "../shared/browser";
import type { Message, Reply } from "../shared/messages";

export class BackgroundError extends Error {
  constructor(
    message: string,
    readonly code: string | null
  ) {
    super(message);
  }
}

// One request to the background; its answer, or a BackgroundError.
export const send = async <T,>(message: Message): Promise<T> => {
  const reply = (await ext.runtime.sendMessage(message)) as Reply<T> | undefined;
  if (!reply) throw new BackgroundError("Nedra did not answer.", null);
  if (!reply.ok) throw new BackgroundError(reply.error, reply.code ?? null);
  return reply.value;
};

export const NedraIcon = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" fill="currentColor" aria-hidden="true">
    <path d="M40 8H16L8 16V40H32L40 32V20H32V28L28 32H16V20L20 16H40V8Z" />
    <path d="M24 20H28V28H20V24L24 20Z" />
  </svg>
);

const ICONS = {
  lock: "M7 10V7a5 5 0 0 1 10 0v3h1a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h1Zm2 0h6V7a3 3 0 0 0-6 0v3Z",
  gear: "M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm8.6 4.6-1.9-.4a6.9 6.9 0 0 1-.6 1.5l1.1 1.6-1.6 1.6-1.6-1.1c-.5.3-1 .5-1.5.6l-.4 1.9h-2.2l-.4-1.9a6.9 6.9 0 0 1-1.5-.6l-1.6 1.1-1.6-1.6 1.1-1.6c-.3-.5-.5-1-.6-1.5l-1.9-.4v-2.2l1.9-.4c.1-.5.3-1 .6-1.5L5.3 6.6l1.6-1.6 1.6 1.1c.5-.3 1-.5 1.5-.6l.4-1.9h2.2l.4 1.9c.5.1 1 .3 1.5.6l1.6-1.1 1.6 1.6-1.1 1.6c.3.5.5 1 .6 1.5l1.9.4v2.2Z",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 2c-4 0-7 2-7 4.5V20h14v-1.5C19 16 16 14 12 14Z",
  key: "M14.5 3a6.5 6.5 0 0 0-6.2 8.4L3 16.7V21h4.3v-2h2v-2h2l1.3-1.3A6.5 6.5 0 1 0 14.5 3Zm1.5 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4Z",
  timer: "M10 2h4v2h-4V2Zm2 4a8 8 0 1 1 0 16 8 8 0 0 1 0-16Zm-1 4v5l4 2 .8-1.6-2.8-1.4V10h-2Z",
  search:
    "M10.5 3a7.5 7.5 0 0 1 6 12l4.3 4.3-1.4 1.4-4.3-4.3A7.5 7.5 0 1 1 10.5 3Zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z",
  star: "m12 3 2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6L3.3 9.3l6.1-.7L12 3Z",
  shield:
    "M12 2 4 5v6c0 5 3.4 9.6 8 11 4.6-1.4 8-6 8-11V5l-8-3Zm-1 13-3.5-3.5 1.4-1.4 2.1 2.1 4.6-4.6 1.4 1.4L11 15Z",
} as const;

export const Icon = ({ name, size = 18 }: { name: keyof typeof ICONS; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d={ICONS[name]} />
  </svg>
);
