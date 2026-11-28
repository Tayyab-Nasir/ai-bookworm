import type { RetailerChannel } from "@bookworm/api-client";
import type { RetailerSubmissionStatus } from "@bookworm/types";

export const retailerChannelNames: Record<RetailerChannel, string> = {
  kdp: "Amazon KDP", apple: "Apple Books", barnesnoble: "Barnes & Noble Press", lulu: "Lulu", googleplay: "Google Play Books",
};
export const retailerSubmissionLabels: Record<RetailerSubmissionStatus, string> = {
  not_submitted: "Not submitted", submitted: "Submitted", in_review: "In review",
  changes_requested: "Changes requested", published: "Published", withdrawn: "Withdrawn",
};
type RetailerPortal = {
  label: string;
  href: string;
  disclosure?: { guidance: string; href: string };
};
const portals: Record<RetailerChannel, RetailerPortal> = {
  kdp: {
    label: "KDP Bookshelf",
    href: "https://kdp.amazon.com/en_US/bookshelf",
    disclosure: {
      guidance: "KDP requires disclosure of AI-generated text, images (including covers), and translations, even after substantial edits. Using AI to edit your own work is exempt.",
      href: "https://kdp.amazon.com/en_US/help/topic/G200635600",
    },
  },
  apple: { label: "Apple Books Publishing Portal", href: "https://authors.apple.com/epub-upload" },
  barnesnoble: {
    label: "B&N Press",
    href: "https://press.barnesandnoble.com/",
    disclosure: {
      guidance: "Complete the B&N Press AI disclosure under Rights & Other Information. The form asks about both AI-assisted and AI-created content.",
      href: "https://help-press.barnesandnoble.com/hc/en-us/articles/28267750176923-Use-of-Generative-AI-in-Your-Project",
    },
  },
  lulu: { label: "Lulu print book projects", href: "https://www.lulu.com/create/print-books" },
  googleplay: { label: "Google Play Books Partner Center", href: "https://play.google.com/books/publish/" },
};

export function retailerPortal(channel: string) {
  return Object.hasOwn(portals, channel) ? portals[channel as RetailerChannel] : undefined;
}
