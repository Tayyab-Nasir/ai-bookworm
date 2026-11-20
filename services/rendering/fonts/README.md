# Embedded print fonts

## Amiri for Arabic and mixed-script print

The print renderer uses the four original Amiri 1.003 faces for the Amiri body
and heading choices. The typeface covers Arabic and Latin text. Typst shapes and
embeds those faces and the DejaVu Sans Mono code faces. The renderer disables
system font fallback and preflight reports characters missing from the selected
face. Keep `LICENSE-Amiri.txt` with the fonts.

[Amiri 1.003 release](https://github.com/aliftype/amiri/releases/tag/1.003)

The release lists archive SHA-256
`81af0aff7d2086d8af24cea7202f7546130997982534691373485cd96744d05e`.
The extracted files were verified from that archive.

| File | SHA-256 |
| --- | --- |
| Amiri-Regular.ttf | `cd2550c0f4c05eb341bf97958211aaa39382bca96577ba3a67d4a3b4912c43c0` |
| Amiri-Bold.ttf | `8cfed49b66de57e360ac61631d882dddfa23095d3ddb39fc2133eaf93892e79a` |
| Amiri-Italic.ttf | `ca02e830027f4376fc35ab4a058880a7d43affe7bd58108a6e6a02bd2515b343` |
| Amiri-BoldItalic.ttf | `765d9fd9eef1718b27da360b26963d5b344ae630b6e760b97d1a38c5efa4df12` |
| LICENSE-Amiri.txt | `72de68e5954f4fdd24702292ef5a32f003ca960ec9330dc86e5eefb5dffb9b22` |

## DejaVu Sans Mono for inline code

Unmodified DejaVu Sans Mono regular, bold, oblique and bold-oblique fonts are
vendored from the official DejaVu 2.37 binary release. The embedded print
families use them for inline code. Keep `LICENSE-DejaVu.txt` with these files
when packaging the service.

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

The checksums describe the extracted artifacts. Print preflight checks coverage
for each selected face.
