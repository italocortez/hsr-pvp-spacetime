/**
 * Saves `blob` as a file named `fileName` through a temporary link with `download` (S14.3d). The blob's address is
 * released after a while, not at once: Firefox may still be reading it after the click returns.
 */
export function downloadBlob(blob: Blob, fileName: string, releaseAfterMs = 10_000): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.hidden = true;
    document.body.append(link);
    try {
        link.click();
    } finally {
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), releaseAfterMs);
    }
}
