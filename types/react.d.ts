import type { DownloadOptions, ExportOptions, ExportProgress } from './index';

export interface UseHlsToMp4 {
  /** Resolves to the MP4 Blob, or null if an export is already running. */
  exportMp4: (options: ExportOptions) => Promise<Blob | null>;
  /** Exports and saves the file; null if an export is already running. */
  downloadMp4: (options: DownloadOptions) => Promise<{ blob: Blob; fileName: string } | null>;
  /** Cancel the running export (its promise rejects with an AbortError). */
  cancel: () => void;
  /** Progress of the running export, or null when idle. */
  progress: ExportProgress | null;
  isRunning: boolean;
}

/**
 * Progress state and cancellation for `exportHlsToMp4` / `downloadHlsAsMp4`.
 * One export at a time per hook; cancelled on unmount.
 */
export declare function useHlsToMp4(): UseHlsToMp4;
