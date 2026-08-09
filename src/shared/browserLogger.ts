export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3,
}

export class Logger {
    private static globalLevel: LogLevel = LogLevel.INFO;
    private readonly source: string;

    constructor(source: string) {
        this.source = source;
    }

    public static setLevel(_level: LogLevel): void {
        // no-op in browser
    }

    public static initialize(_logDirectory: string): void {
        // no-op in browser
    }

    public static close(): void {
        // no-op in browser
    }

    public debug(message: string, ..._data: any[]): void {
        if (LogLevel.DEBUG < Logger.globalLevel) return;
        console.debug(`[${this.source}] ${message}`);
    }

    public info(message: string, ..._data: any[]): void {
        if (LogLevel.INFO < Logger.globalLevel) return;
        console.info(`[${this.source}] ${message}`);
    }

    public warn(message: string, ..._data: any[]): void {
        if (LogLevel.WARN < Logger.globalLevel) return;
        console.warn(`[${this.source}] ${message}`);
    }

    public error(message: string, ..._data: any[]): void {
        if (LogLevel.ERROR < Logger.globalLevel) return;
        console.error(`[${this.source}] ${message}`);
    }
}
