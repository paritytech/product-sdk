/**
 * @parity/product-sdk-logger — Structured, namespace-filtered logging for the SDK.
 *
 * Each package calls `createLogger(namespace)` to emit structured `LogEntry`
 * records; the host application calls `configure` once to set the log level,
 * decide which namespaces are enabled, and route entries into its own
 * observability stack via a custom `LogHandler`.
 *
 * @packageDocumentation
 */
export { configure } from "./configure.js";
export { createLogger } from "./create-logger.js";
export type { LogLevel, LogEntry, LogHandler, LoggerConfig, Logger } from "./types.js";
