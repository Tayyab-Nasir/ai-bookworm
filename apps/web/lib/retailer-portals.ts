import type { RetailerChannel } from "@bookworm/api-client";

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
