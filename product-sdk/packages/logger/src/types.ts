/** Severity ranking — `"error"` is the highest, then `"warn"`, `"info"`, `"debug"`. The configured level is the lowest severity that gets emitted; less-severe entries are dropped. */
export type LogLevel = "error" | "warn" | "info" | "debug";

/** A structured record emitted by a {@link Logger}. */
export interface LogEntry {
    level: LogLevel;
    namespace: string;
    message: string;
    data?: unknown;
    timestamp: number;
}

/** Custom sink for log records. When set via {@link configure} it replaces the default `console.*` output and receives every {@link LogEntry} that passes the level filter. */
export type LogHandler = (entry: LogEntry) => void;

/** Global configuration for the logger system, applied via {@link configure}. */
export interface LoggerConfig {
    /** Minimum log level. Default: "warn" */
    level?: LogLevel;
    /** If set, only these namespaces use the configured level; others stay at "warn". */
    namespaces?: string[];
    /** Custom output handler. Replaces default console output. */
    handler?: LogHandler;
}

/** A namespaced logger. Each method emits a {@link LogEntry} at the matching {@link LogLevel}, or no-ops when filtered out by the current configuration. */
export interface Logger {
    error(message: string, data?: unknown): void;
    warn(message: string, data?: unknown): void;
    info(message: string, data?: unknown): void;
    debug(message: string, data?: unknown): void;
}
