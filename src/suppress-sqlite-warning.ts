/**
 * node:sqlite prints ExperimentalWarning on first import. That line is the
 * first thing `init` shows; it is not our prompt. Must load before db.
 */
const emitWarning = process.emitWarning.bind(process);

process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
  const text =
    typeof warning === "string"
      ? warning
      : warning && typeof warning === "object" && "message" in warning
        ? String((warning as { message: unknown }).message)
        : "";
  if (text.includes("SQLite is an experimental feature")) return;
  return (emitWarning as (warning: unknown, ...rest: unknown[]) => void)(
    warning,
    ...rest,
  );
}) as typeof process.emitWarning;
