import EventEmitter from "events";

export enum LogLevel {
  TRACE = "trace",
  DEBUG = "debug",
  INFO = "info",
  WARN = "warn",
  ERROR = "error",
}

export enum CustomerFacingContext {
  CUSTOMER_MESSAGE = "customerMessage",
  CUSTOMER_LEVEL = "customerLevel",
  CUSTOMER_FACING = "customerFacing",
  OMIT_FROM_CONSOLE = "omitFromConsole",
}

export interface CustomerFacingOptions {
  if?: boolean;
  msg?: string;
  level?: LogLevel;
  omitFromConsole?: boolean;
}

type LogFormatter = (message: LogMessage) => void;

export interface Logger {
  log: (message: string) => void;

  trace: (message: string) => void;
  debug: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;

  getLevel: () => LogLevel;
  with: () => LoggerContext;

  isTraceEnabled: () => boolean;
  isDebugEnabled: () => boolean;
}

export interface LogMessage {
  level: LogLevel;
  message: string;
  error?: {
    stack: string;
    message: string;
    toString: string;
  };
}

export interface LoggerContext {
  str: (key: string, value?: string) => LoggerContext;
  num: (key: string, value?: number) => LoggerContext;
  bool: (key: string, value?: boolean) => LoggerContext;
  any: (key: string, value?: any, stringify?: boolean) => LoggerContext;
  customerFacing: (options?: CustomerFacingOptions) => LoggerContext;
  array: (key: string, value?: any[]) => LoggerContext;
  error: (e: any) => LoggerContext;
  logger: () => Logger;
}

const contextLevels = resolveContextLevels();

let LOG_CONTEXT_FOR_TRACE = contextLevels.includes("trace");
let LOG_CONTEXT_FOR_DEBUG = contextLevels.includes("debug");
let LOG_CONTEXT_FOR_INFO = contextLevels.includes("info");
let LOG_CONTEXT_FOR_WARN = contextLevels.includes("warn");
let LOG_CONTEXT_FOR_ERROR = contextLevels.includes("error");

function resolveContextLevels() {
  let contextLevels: string[] = [];
  const contextLevelsEnv = process.env.GLOBAL_LOG_CONTEXT_FOR_LEVELS;
  if (contextLevelsEnv) {
    contextLevels = contextLevelsEnv.split(",");
  } else {
    contextLevels = ["trace", "debug", "info", "warn", "error"];
  }
  return contextLevels;
}

const logTimestamp: boolean = new Boolean(
  process.env.GLOBAL_LOG_TIMESTAMP
).valueOf();

export const MappedLoggerEvents = new EventEmitter();
export class MappedLogger implements Logger {
  protected _loglevel: LogLevel;
  protected _ctx: any;
  private formatter: LogFormatter;

  private emptyMethod(..._args: any[]): void {}

  public log: (message: string) => void;
  public trace: (message: string) => void;
  public debug: (message: string) => void;
  public info: (message: string) => void;
  public warn: (message: string) => void;
  public error: (message: string) => void;

  constructor(level?: LogLevel, ctx?: any) {
    this.formatter = this.formatJson;

    const logFormat: string = process.env.GLOBAL_LOG_FORMAT;

    switch (logFormat) {
      case "json":
        this.formatter = this.formatJson;
        break;
      case "simple":
        this.formatter = this.formatSimple;
        break;
    }

    this._loglevel = level ?? LogLevel.INFO;

    this._ctx = ctx ?? {};

    // Use applyLogFilters to apply conditional check to all logging methods
    this.log = (message: string) =>
      this._applyLogFilters(message, this._log.bind(this));
    this.trace = (message: string) =>
      this._applyLogFilters(message, this._trace.bind(this), LogLevel.TRACE);
    this.debug = (message: string) =>
      this._applyLogFilters(message, this._debug.bind(this), LogLevel.DEBUG);
    this.info = (message: string) =>
      this._applyLogFilters(message, this._info.bind(this), LogLevel.INFO);
    this.warn = (message: string) =>
      this._applyLogFilters(message, this._warn.bind(this), LogLevel.WARN);
    this.error = (message: string) =>
      this._applyLogFilters(message, this._error.bind(this), LogLevel.ERROR);

    switch (level) {
      case LogLevel.DEBUG:
        this.trace = this.emptyMethod;
        break;

      case LogLevel.INFO:
        this.trace = this.debug = this.emptyMethod;
        break;

      case LogLevel.WARN:
        this.trace = this.debug = this.info = this.emptyMethod;
        break;

      case LogLevel.ERROR:
        this.trace = this.debug = this.info = this.warn = this.emptyMethod;
        break;
    }
  }

  isTraceEnabled() {
    return this._loglevel === LogLevel.TRACE;
  }

  isDebugEnabled() {
    return this._loglevel === LogLevel.DEBUG || this.isTraceEnabled();
  }

  getLevel() {
    return this._loglevel;
  }

  private _log(message: string) {
    console.log({ message, ...this._ctx });
  }

  // NOT USING: console.trace on purpose, because it displays stacktrace for every log message
  // and we want to control the output.
  private _trace(message: string) {
    if (LOG_CONTEXT_FOR_TRACE) {
      console.log(
        this.formatter({ message, ...this._ctx, level: LogLevel.TRACE })
      );
    } else {
      console.log(this.formatter({ message, level: LogLevel.TRACE }));
    }
  }

  private _debug(message: string) {
    if (LOG_CONTEXT_FOR_DEBUG) {
      console.debug(
        this.formatter({ message, ...this._ctx, level: LogLevel.DEBUG })
      );
    } else {
      console.debug(this.formatter({ message, level: LogLevel.DEBUG }));
    }
  }

  private _info(message: string) {
    if (LOG_CONTEXT_FOR_INFO) {
      console.info(
        this.formatter({ message, ...this._ctx, level: LogLevel.INFO })
      );
    } else {
      console.info(this.formatter({ message, level: LogLevel.INFO }));
    }
  }

  private _warn(message: string) {
    if (LOG_CONTEXT_FOR_WARN) {
      console.warn(
        this.formatter({ message, ...this._ctx, level: LogLevel.WARN })
      );
    } else {
      console.warn(this.formatter({ message, level: LogLevel.WARN }));
    }
  }

  private _error(message: string) {
    if (LOG_CONTEXT_FOR_ERROR) {
      console.error(
        this.formatter({ message, ...this._ctx, level: LogLevel.ERROR })
      );
    } else {
      console.error(this.formatter({ message, level: LogLevel.ERROR }));
    }
  }

  private _applyLogFilters(
    message: string,
    fn: (message: string) => void,
    level?: LogLevel
  ) {
    // Add any global conditions that should apply to all log methods
    if (this._ctx[CustomerFacingContext.OMIT_FROM_CONSOLE]) {
      this.formatter({
        ...this._ctx,
        message,
        level: this._ctx[CustomerFacingContext.CUSTOMER_LEVEL]
          ? this._ctx[CustomerFacingContext.CUSTOMER_LEVEL]
          : level,
      });
      return; // Skip logging if omit_from_console is true
    }
    // You can add more conditional checks here as needed

    // If all conditions pass, execute the original log function
    fn(message);
  }

  setCtx(key: string, value?: any) {
    this._ctx[key] = value;
  }

  newLogger(level: LogLevel, ctx: any) {
    return new MappedLogger(level, JSON.parse(JSON.stringify(ctx)));
  }

  with() {
    // Need a better Deep Copy approach
    let logger = this.newLogger(
      this._loglevel,
      JSON.parse(JSON.stringify(this._ctx))
    );
    return new MappedLogContext(logger);
  }
  formatJson(message: LogMessage) {
    if (logTimestamp) {
      message["ts"] = new Date().toISOString();
    }
    this.enrichJson(message);

    const json = safeStringify(message);

    MappedLoggerEvents.emit("log", json);

    return json;
  }

  enrichJson(message: LogMessage): void {}

  formatSimple(message: LogMessage) {
    MappedLoggerEvents.emit("log", safeStringify(message));

    const messageString = message.message;
    const level = message.level;

    delete message.message;
    delete message.level;

    let ts = "";
    if (logTimestamp) {
      ts = ` [${new Date().toISOString()}] `;
    }

    switch (level) {
      case LogLevel.TRACE:
        return `\x1b[37m ${level.toUpperCase()} \x1b[0m ${ts} ${messageString}\n${
          LOG_CONTEXT_FOR_TRACE && message && Object.keys(message).length > 0
            ? "\n" + safeStringify(message) + "\n"
            : ""
        }`;
      case LogLevel.DEBUG:
        return `\x1b[36m ${level.toUpperCase()} \x1b[0m ${ts} ${messageString}\n${
          LOG_CONTEXT_FOR_DEBUG && message && Object.keys(message).length > 0
            ? "\n" + safeStringify(message) + "\n"
            : ""
        }`;
      case LogLevel.INFO:
        return `\x1b[32m ${level.toUpperCase()} \x1b[0m  ${ts} ${messageString}\n${
          LOG_CONTEXT_FOR_INFO && message && Object.keys(message).length > 0
            ? "\n" + safeStringify(message) + "\n"
            : ""
        }`;
      case LogLevel.WARN:
        return `\x1b[31m ${level.toUpperCase()} \x1b[0m  ${ts} ${messageString}\n${
          LOG_CONTEXT_FOR_WARN && message && Object.keys(message).length > 0
            ? "\n" + safeStringify(message) + "\n"
            : ""
        }`;
      case LogLevel.ERROR:
        const error = message.error;
        let errorStack = "";
        if (error) {
          errorStack = message["error"]?.stack;
          if (errorStack) {
            delete message.error;
          } else if (error.message === error.toString) {
            delete message.error.toString;
          }
        }

        return `\x1b[31m ${level.toUpperCase()} \x1b[0m ${ts} ${messageString}\n'$${
          LOG_CONTEXT_FOR_ERROR && message && Object.keys(message).length > 0
            ? "\n" + safeStringify(message) + "\n"
            : ""
        } ${errorStack ? "\n" + prettyFormatStack(errorStack) : ""}`;
      default:
        return `UNKNOWN: ${messageString}`;
    }
  }
}

export class MappedLogContext implements LoggerContext {
  private _logger: MappedLogger;

  constructor(logger: MappedLogger) {
    this._logger = logger;
  }

  str(key: string, value?: string) {
    return this.any(key, value);
  }

  num(key: string, value?: number) {
    return this.any(key, value);
  }

  bool(key: string, value?: boolean) {
    return this.any(key, value);
  }

  array(key: string, value?: any[]) {
    return this.any(key, value);
  }

  error(e: any) {
    if (e instanceof Error) {
      return this.any("error", {
        message: e?.message,
        stack: e?.stack,
        toString: e?.toString(),
      });
    } else if (typeof e === "string") {
      return this.str("error", e);
    } else {
      return this.any("error", e);
    }
  }

  any(key: string, value?: any, stringify?: boolean) {
    if (stringify) {
      this._logger.setCtx(key, JSON.stringify(value));
    } else {
      this._logger.setCtx(key, value);
    }

    return this;
  }

  customerFacing(options?: CustomerFacingOptions) {
    if (options?.if === false) {
      return;
    }

    if (options?.msg) {
      this.str(CustomerFacingContext.CUSTOMER_MESSAGE, options?.msg);
    }

    if (options?.level) {
      this.str(CustomerFacingContext.CUSTOMER_LEVEL, options?.level);
    }

    if (options?.omitFromConsole) {
      this.bool(
        CustomerFacingContext.OMIT_FROM_CONSOLE,
        options?.omitFromConsole
      );
    }

    return this.bool(CustomerFacingContext.CUSTOMER_FACING, true);
  }

  logger() {
    return this._logger;
  }
}

export function getLogger(): MappedLogger {
  return new MappedLogger(
    LogLevel[process.env.GLOBAL_LOG_LEVEL?.toUpperCase()] ?? LogLevel.INFO
  );
}

function prettyFormatStack(stack: string) {
  return (
    "\n" +
    stack
      .split("\n")
      .map((line) => {
        return line.replace(/\s+at\s+/, "\n  at ");
      })
      .join()
  );
}

function safeStringify(obj: any) {
  return JSON.stringify(obj, (_k, v) =>
    typeof v === "bigint" ? Number(v) : v
  );
}
