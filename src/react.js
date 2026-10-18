import { useCallback, useEffect, useRef, useState } from 'react';

import { downloadHlsAsMp4, exportHlsToMp4 } from './export.js';

/**
 * React hook around `exportHlsToMp4` / `downloadHlsAsMp4` with progress state
 * and cancellation. One export runs at a time per hook instance; an export in
 * flight is cancelled when the component unmounts.
 *
 * `exportMp4` / `downloadMp4` take the same options as the plain functions and
 * resolve to their result, or to `null` if an export is already running. They
 * reject with an AbortError on `cancel()`.
 */
export const useHlsToMp4 = () => {
  const [progress, setProgress] = useState(null);
  const controllerRef = useRef(null);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const run = useCallback(async (fn, options = {}) => {
    if (controllerRef.current) return null;
    const controller = new AbortController();
    controllerRef.current = controller;
    const { signal: outerSignal, onProgress } = options;
    const forwardAbort = () => controller.abort();
    if (outerSignal?.aborted) controller.abort();
    outerSignal?.addEventListener('abort', forwardAbort);

    setProgress({ phase: 'downloading', ratio: 0, segmentsDone: 0, segmentsTotal: 0, bytesDownloaded: 0 });
    try {
      return await fn({
        ...options,
        signal: controller.signal,
        onProgress: (p) => {
          setProgress(p);
          onProgress?.(p);
        },
      });
    } finally {
      outerSignal?.removeEventListener('abort', forwardAbort);
      controllerRef.current = null;
      setProgress(null);
    }
  }, []);

  const exportMp4 = useCallback((options) => run(exportHlsToMp4, options), [run]);
  const downloadMp4 = useCallback((options) => run(downloadHlsAsMp4, options), [run]);
  const cancel = useCallback(() => controllerRef.current?.abort(), []);

  return { exportMp4, downloadMp4, cancel, progress, isRunning: progress !== null };
};
