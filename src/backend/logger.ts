import fs from 'fs';
import path from 'path';

const isBrowser = typeof window !== 'undefined';

function inspectBrowser(value: any): string {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3,
}

export class Logger {
    private static globalLevel: LogLevel = LogLevel.INFO;
    private static logStream: fs.WriteStream | null = isBrowser ? null : null;

    public static setLevel(level: LogLevel): void {
        Logger.globalLevel = level;
    }

    public static initialize(logDirectory: string): void {
        if (isBrowser) return;
        try {
            if (!fs.existsSync(logDirectory)) {
                fs.mkdirSync(logDirectory, { recursive: true });
            }
            const logPath = path.join(logDirectory, 'sync-client.log');

            // FASE 3: Rotación básica de logs (Límite 5MB, mantener 3 historiales)
            if (fs.existsSync(logPath)) {
                const stats = fs.statSync(logPath);
                if (stats.size > 5 * 1024 * 1024) { // 5 MB
                    for (let i = 2; i >= 1; i--) {
                        const oldPath = path.join(logDirectory, `sync-client.${i}.log`);
                        const newerPath = path.join(logDirectory, `sync-client.${i + 1}.log`);
                        if (fs.existsSync(oldPath)) fs.renameSync(oldPath, newerPath);
                    }
                    fs.renameSync(logPath, path.join(logDirectory, 'sync-client.1.log'));
                }
            }

            Logger.logStream = fs.createWriteStream(logPath, { flags: 'a' });
            new Logger('Logger').info(`Logging to file: ${logPath}`);
        } catch (error) {
            new Logger('Logger').error('Failed to initialize file logging:', error);
            Logger.logStream = null;
        }
    }

    public static close(): void {
        if (isBrowser) return;
        if (Logger.logStream) {
            Logger.logStream.end();
            Logger.logStream = null;
        }
    }

    private readonly source: string;

    constructor(source: string) {
        this.source = source;
    }

    public debug(message: string, ...data: any[]): void {
        this.log(LogLevel.DEBUG, message, data);
    }

    public info(message: string, ...data: any[]): void {
        this.log(LogLevel.INFO, message, data);
    }

    public warn(message: string, ...data: any[]): void {
        this.log(LogLevel.WARN, message, data);
    }

    public error(message: string, ...data: any[]): void {
        this.log(LogLevel.ERROR, message, data);
    }

    private log(level: LogLevel, message: string, data: any[]): void {
        if (level < Logger.globalLevel) return;

        const timestamp = new Date().toISOString();
        const levelStr = LogLevel[level].padEnd(5);
        const formattedMessage = `[${timestamp}] [${levelStr}] [${this.source}] ${message}`;

        // Log to console
        const consoleMethod = this.getConsoleMethod(level);
        if (data.length > 0) {
            consoleMethod(formattedMessage, ...data);
        } else {
            consoleMethod(formattedMessage);
        }

        // Log to file
        if (!isBrowser && Logger.logStream) {
            const fileMessage = data.length > 0
                ? `${formattedMessage} ${data.map(d => inspectBrowser(d)).join(' ')}`
                : formattedMessage;
            Logger.logStream.write(`${fileMessage}\n`);
        }
    }

    private getConsoleMethod(level: LogLevel): (...args: any[]) => void {
        switch (level) {
            case LogLevel.DEBUG:
                return console.debug;
            case LogLevel.INFO:
                return console.log;
            case LogLevel.WARN:
                return console.warn;
            case LogLevel.ERROR:
                return console.error;
            default:
                return console.log;
        }
    }
}