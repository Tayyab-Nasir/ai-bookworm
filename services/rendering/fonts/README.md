# Embedded inline-code fonts

Unmodified DejaVu Sans Mono regular, bold, oblique and bold-oblique fonts are
vendored from the official DejaVu 2.37 binary release. They are used for inline
code in paragraphs/headings whose selected font is Bookworm Vera, not as aliases
for Times, Helvetica or Courier. Other saved font choices retain their legacy
behavior. Keep `LICENSE-DejaVu.txt` with these files when packaging the service.

- Release: https://github.com/dejavu-fonts/dejavu-fonts/releases/tag/version_2_37
- Archive: https://github.com/dejavu-fonts/dejavu-fonts/releases/download/version_2_37/dejavu-fonts-ttf-2.37.zip
- License: https://dejavu-fonts.github.io/License.html
- Downloaded: September 18, 2026
- Archive SHA-256: `7576310b219e04159d35ff61dd4a4ec4cdba4f35c00e002a136f00e96a908b0a`

SHA-256 of the exact extracted files:

| File | SHA-256 |
| --- | --- |
| DejaVuSansMono.ttf | `b4a6c3e4faab8773f4ff761d56451646409f29abedd68f05d38c2df667d3c582` |
| DejaVuSansMono-Bold.ttf | `bce60f1b4421acd9ea51ba6623d7024ecbe6817a953e3654df62a5e6bdf8f769` |
| DejaVuSansMono-Oblique.ttf | `742097840c541870e8d6dc5c9b37bb1ceeea6c0dedd1d475faf903ef9df734b0` |
| DejaVuSansMono-BoldOblique.ttf | `91713a71d550bba22c2a6b2bb2a9ad8f9a159e12e4e9f0a5b2677998ba21213e` |

These are local artifact checksums, not a claim of independently signed upstream
attestation. Font embedding does not provide RTL shaping or full-script coverage.
