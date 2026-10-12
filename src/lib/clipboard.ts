/**
 * Copies text to the clipboard. Returns false when the browser refuses (no permission, an insecure
 * page, no clipboard at all); the caller then lets the person select the text and copy it.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
