const corrections = [
  { detail: "QR size is too small for this destination; increase QR size or shorten the HTTPS URL",
    code: "cover_qr_too_small", message: "Increase QR size or shorten the HTTPS destination in Cover composition." },
  { detail: "QR destination exceeds QR capacity; shorten the HTTPS URL",
    code: "cover_qr_destination_too_long", message: "Shorten the HTTPS destination in Cover composition so it fits in a QR code." },
  { detail: "QR code does not fit within the cover safe area; reduce QR size",
    code: "cover_qr_outside_safe_area", message: "Reduce QR size in Cover composition so it fits inside the cover safe area." },
  { detail: "QR label contains characters unsupported by the cover font",
    code: "cover_qr_label_invalid", message: "Change or remove the QR label in Cover composition. The cover font cannot render its characters." },
  { detail: "QR label does not fit at a readable size",
    code: "cover_qr_label_too_long", message: "Shorten or remove the QR label in Cover composition so it fits at a readable size." },
];

export function coverQrRendererFailure(body: string) {
  try {
    const detail: unknown = JSON.parse(body)?.detail;
    return corrections.find(value => value.detail === detail);
  } catch { return undefined; }
}

export function savedCoverQrCorrection(code: unknown) {
  return corrections.find(value => value.code === code)?.message;
}
