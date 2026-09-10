# NanumSquare / 나눔스퀘어

This app uses the original **NanumSquare**, provided by NAVER, in Regular (400)
and Bold (700). These are not NanumSquare Round, NanumSquare Neo, or the `ac`
variants.

Copyright © 2016 NAVER Corporation. All rights reserved.
Font designed by Sandoll Communications Inc.

The original WOFF files are redistributed byte-for-byte: no conversion,
subsetting, glyph edits, metric changes, or renaming. The full Naver copyright
notice and SIL Open Font License 1.1 are included in `OFL-NanumSquare.txt`.
Only the font files are covered by that license.

## Official primary sources

Retrieved and checked on 2026-09-10:

- Font catalog and copyright policy: https://hangeul.naver.com/font
- Original Nanum font family: https://hangeul.naver.com/font/nanum
- Official webfont CSS: https://hangeul.pstatic.net/hangeul_static/css/nanum-square.css
- Regular, linked by that CSS: https://hangeul.pstatic.net/hangeul_static/webfont/NanumSquare/NanumSquareR.woff
- Bold, linked by that CSS: https://hangeul.pstatic.net/hangeul_static/webfont/NanumSquare/NanumSquareB.woff
- Naver license notice: https://help.naver.com/support/contents/contents.help?serviceNo=1074&categoryNo=3497

## File identity

Both fonts report family `NanumSquare`, version
`1.000;PS 1;hotconv 1.0.86;makeotf.lib2.5.63406`, and 12,258 glyphs.

| File | Weight | Bytes | SHA-256 |
| --- | --- | --- | --- |
| `NanumSquareR.woff` | 400 | 239,088 | `e69a7466f8f7dd16f0bc035d5d37e9d0f28c31255b232d82da2a0d2f929b8c69` |
| `NanumSquareB.woff` | 700 | 240,176 | `9d2ff3cd7bcfbb1ed5a9493dd0deae23c33751e865222122a67984aba962f258` |

The app serves both weights locally with `font-display: swap` and preloads
them before its JavaScript entry point. Both files participate in the PWA
app-shell content hash and precache. Emoji use platform emoji fonts; code
blocks may use the system monospace stack.
