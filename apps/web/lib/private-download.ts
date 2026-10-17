/** Add Storage's attachment option to an authorized signed URL, leaving the preview URL intact. */
export function privateDownloadUrl(signedUrl: string, filename: string): string {
  const url = new URL(signedUrl);
  url.searchParams.set("download", filename.replace(/[\u0000-\u001f\u007f/\\]/g, "_").slice(0, 240) || "file");
  return url.href;
}
