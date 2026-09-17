import type { Download } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
/** Consume Playwright's stream; Chrome-created Windows files may carry restrictive ACLs. */
export async function downloadedArtifact(download: Download, outputPath?: string): Promise<Buffer> {
  const failure = await download.failure();
  if (failure) throw new Error('Download failed: ' + failure);
  const stream = await download.createReadStream();
  if (!stream) throw new Error('Download stream is unavailable.');
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks);
  if (outputPath) await writeFile(outputPath, bytes);
  return bytes;
}
