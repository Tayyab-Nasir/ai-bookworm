import type { RetailerChannel } from "@bookworm/api-client";
import type { RetailerSubmissionStatus } from "@bookworm/types";

export const retailerChannelNames: Record<RetailerChannel, string> = {
  kdp: "Amazon KDP", apple: "Apple Books", barnesnoble: "Barnes & Noble Press", lulu: "Lulu", googleplay: "Google Play Books",
};
export const retailerSubmissionLabels: Record<RetailerSubmissionStatus, string> = {
  not_submitted: "Not submitted", submitted: "Submitted", in_review: "In review",
  changes_requested: "Changes requested", published: "Published", withdrawn: "Withdrawn",
};
const portals: Record<RetailerChannel, { label: string; href: string }> = {
  kdp: { label: "KDP Bookshelf", href: "https://kdp.amazon.com/en_US/bookshelf" },
  apple: { label: "Apple Books Publishing Portal", href: "https://authors.apple.com/epub-upload" },
  barnesnoble: { label: "B&N Press", href: "https://press.barnesandnoble.com/" },
  lulu: { label: "Lulu print book projects", href: "https://www.lulu.com/create/print-books" },
  googleplay: { label: "Google Play Books Partner Center", href: "https://play.google.com/books/publish/" },
};

export function retailerPortal(channel: string) {
  return Object.hasOwn(portals, channel) ? portals[channel as RetailerChannel] : undefined;
}
