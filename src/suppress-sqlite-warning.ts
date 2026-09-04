/**
 * node:sqlite prints ExperimentalWarning on first import. That line is the
 * first thing `init` shows; it is not our prompt. Must load before db.
 *
 * Node 22+ emits this via `process.emit("warning", …)` from
 * `emitExperimentalWarning`, not `process.emitWarning`. Hook both.
 */
function isSqliteExperimental(warning: unknown): boolean {
  const text =
    typeof warning === "string"
      ? warning
      : warning && typeof warning === "object" && "message" in warning
        ? String((warning as { message: unknown }).message)
        : "";
  return text.includes("SQLite is an experimental feature");
}

const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
  if (isSqliteExperimental(warning)) return;
  return (emitWarning as (warning: unknown, ...rest: unknown[]) => void)(
    warning,
    ...rest,
  );
}) as typeof process.emitWarning;

const emit = process.emit.bind(process);
process.emit = function (this: typeof process, event: string, ...args: unknown[]) {
  if (event === "warning" && isSqliteExperimental(args[0])) return false;
  return emit.apply(this, [event, ...args] as [string, ...unknown[]]);
} as typeof process.emit;
