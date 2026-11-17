import { withStorageTimeout } from './access';

/** The selected local directory, as displayed by the system file provider. */
export interface StoredFolder {
  name: string;
}

export interface FolderStatus {
  folder: StoredFolder | null;
  needsReselection: boolean;
}

export interface FolderWriteResult {
  saved: boolean;
  name: string;
  folderName?: string;
}

export interface FolderPlugin {
  getFolder(): Promise<{ name?: string; needsReselection?: boolean }>;
  chooseFolder(): Promise<{ canceled: boolean }>;
  clearFolder(): Promise<void>;
  openFolder(): Promise<{ opened: boolean }>;
  writeFile(options: { name: string; base64: string }): Promise<FolderWriteResult>;
}

export interface FolderAccess {
  current(): Promise<StoredFolder | null>;
  status(): Promise<FolderStatus>;
  /** Returns false when the system picker is canceled. */
  choose(): Promise<boolean>;
  available(): Promise<boolean>;
  clear(): Promise<void>;
  open(): Promise<boolean>;
  write(name: string, base64: string): Promise<FolderWriteResult>;
}

// Capacitor's plugin proxy is thenable; keep it wrapped in a plain object.
export interface NativeBridge {
  readonly plugin: FolderPlugin;
}

async function loadNativePlugin(): Promise<NativeBridge | null> {
  const { Capacitor, registerPlugin } = await import('@capacitor/core');
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('Folder')
    ? { plugin: registerPlugin<FolderPlugin>('Folder') }
    : null;
}

export function createFolderAccess(
  loadPlugin: () => Promise<NativeBridge | null> = loadNativePlugin
): FolderAccess {
  async function status(): Promise<FolderStatus> {
    const bridge = await loadPlugin();
    if (bridge === null) return { folder: null, needsReselection: false };
    const result = await bridge.plugin.getFolder();
    const name = typeof result?.name === 'string' ? result.name.trim() : '';
    return {
      folder: name ? { name } : null,
      needsReselection: !name && result?.needsReselection === true,
    };
  }

  return {
    status,
    async current() {
      // Exports still have a cache destination if the provider is unavailable.
      return (await withStorageTimeout(status, '读取备份目录超时。').catch(() => null))?.folder ?? null;
    },
    async available() {
      return (await loadPlugin().catch(() => null)) !== null;
    },
    async choose() {
      const bridge = await loadPlugin();
      return bridge !== null && (await bridge.plugin.chooseFolder()).canceled === false;
    },
    async clear() {
      const bridge = await loadPlugin();
      await bridge?.plugin.clearFolder();
    },
    async open() {
      const bridge = await loadPlugin().catch(() => null);
      if (bridge === null) return false;
      return (await bridge.plugin.openFolder().catch(() => null))?.opened === true;
    },
    async write(name, base64) {
      const bridge = await loadPlugin();
      return bridge === null ? { saved: false, name } : bridge.plugin.writeFile({ name, base64 });
    },
  };
}

export const deviceFolder = createFolderAccess();
