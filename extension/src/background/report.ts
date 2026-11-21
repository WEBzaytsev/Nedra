export const reportUnexpected = (error: unknown): void => {
  const name = error instanceof Error ? error.name : typeof error;
  const frames =
    error instanceof Error && typeof error.stack === "string"
      ? error.stack
          .split("\n")

          .filter((line) => /^\s+at\s\S/.test(line) || /^\S*@\S+:\d+:\d+$/.test(line))
          .slice(0, 5)
          .map((line) => line.trim())
      : [];
  console.error(`Nedra: unexpected ${name}`, frames);
};
