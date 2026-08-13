import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export interface AutoStartResult {
  enabled: boolean;
  platform: string;
  method: string;
}

export class AutoStartManager {
  private platform = os.platform();
  private homeDir = os.homedir();

  async isEnabled(): Promise<boolean> {
    switch (this.platform) {
      case 'linux':
        return this.isEnabledLinux();
      case 'win32':
        return this.isEnabledWindows();
      case 'darwin':
        return this.isEnabledDarwin();
      default:
        return false;
    }
  }

  async setEnabled(enabled: boolean): Promise<void> {
    switch (this.platform) {
      case 'linux':
        await this.setEnabledLinux(enabled);
        break;
      case 'win32':
        await this.setEnabledWindows(enabled);
        break;
      case 'darwin':
        await this.setEnabledDarwin(enabled);
        break;
      default:
        throw new Error(`Auto-start no soportado en plataforma: ${this.platform}`);
    }
  }

  getStatus(): AutoStartResult {
    return {
      enabled: false,
      platform: this.platform,
      method: 'unsupported',
    };
  }

  private getAutostartDirLinux() {
    return path.join(this.homeDir, '.config', 'autostart');
  }

  private getDesktopFileLinux() {
    return path.join(this.getAutostartDirLinux(), 'syncclient.desktop');
  }

  private async isEnabledLinux(): Promise<boolean> {
    try {
      await fs.access(this.getDesktopFileLinux());
      return true;
    } catch {
      return false;
    }
  }

  private async setEnabledLinux(enabled: boolean): Promise<void> {
    if (enabled) {
      await fs.mkdir(this.getAutostartDirLinux(), { recursive: true });
      const execPath = process.execPath;
      const desktopEntry = `[Desktop Entry]
Type=Application
Name=SyncClient
Exec=${execPath}
Icon=syncclient
Terminal=false
Categories=Utility;
`;
      await fs.writeFile(this.getDesktopFileLinux(), desktopEntry, 'utf8');
    } else {
      try {
        await fs.unlink(this.getDesktopFileLinux());
      } catch { /* ignore */ }
    }
  }

  private getRegistryKeyWindows() {
    return `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`;
  }

  private async isEnabledWindows(): Promise<boolean> {
    try {
      const { stdout } = await execAsync(`reg query "${this.getRegistryKeyWindows()}" /v SyncClient 2>nul`);
      return stdout.includes('SyncClient');
    } catch {
      return false;
    }
  }

  private async setEnabledWindows(enabled: boolean): Promise<void> {
    const key = this.getRegistryKeyWindows();
    const execPath = process.execPath.replace(/\\/g, '\\\\');
    if (enabled) {
      await execAsync(`reg add "${key}" /v SyncClient /t REG_SZ /d "${execPath}" /f`);
    } else {
      try {
        await execAsync(`reg delete "${key}" /v SyncClient /f`);
      } catch { /* ignore */ }
    }
  }

  private getPlistPathDarwin() {
    return path.join(this.homeDir, 'Library', 'LaunchAgents', 'com.syncclient.plist');
  }

  private async isEnabledDarwin(): Promise<boolean> {
    try {
      await fs.access(this.getPlistPathDarwin());
      return true;
    } catch {
      return false;
    }
  }

  private async setEnabledDarwin(enabled: boolean): Promise<void> {
    if (enabled) {
      await fs.mkdir(path.dirname(this.getPlistPathDarwin()), { recursive: true });
      const execPath = process.execPath;
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.syncclient</string>
  <key>ProgramArguments</key>
  <array>
    <string>${execPath}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</true>
  <key>StandardOutPath</key>
  <string>${path.join(this.homeDir, 'Library', 'Logs', 'syncclient', 'stdout.log')}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(this.homeDir, 'Library', 'Logs', 'syncclient', 'stderr.log')}</string>
</dict>
</plist>
`;
      await fs.writeFile(this.getPlistPathDarwin(), plist, 'utf8');
    } else {
      try {
        await fs.unlink(this.getPlistPathDarwin());
      } catch { /* ignore */ }
    }
  }
}

export const autoStartManager = new AutoStartManager();
