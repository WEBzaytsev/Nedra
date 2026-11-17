# Bundled Martian fonts

Both variable WOFF2 files are distributed under the SIL Open Font License 1.1
(SPDX: OFL-1.1). Complete upstream license texts accompany them:

- `MartianGrotesk-VF.woff2` — Martian Grotesk by Roman Shamin / Evil Martians.
  Copyright 2021 The Martian Grotesk Project Authors.
  Upstream: https://github.com/evilmartians/grotesk
  License: `MartianGrotesk-OFL.txt`, copied verbatim from
  https://github.com/evilmartians/grotesk/blob/6a20e9e51936d53f5b39f2022ef2ad4a5dee52d8/OFL.txt
- `MartianMono-VF.woff2` — Martian Mono by Roman Shamin / Evil Martians.
  Copyright 2021 The Martian Mono Project Authors.
  Upstream: https://github.com/evilmartians/mono
  License: `MartianMono-OFL.txt`, copied verbatim from
  https://github.com/evilmartians/mono/blob/8babba8a76cabf54543dca3a994d7af85e425f98/OFL.txt

## Binary provenance

The files were copied without modification from the local Tunnly font assets.
SHA-256:

```text
d2223e87b0f1020b98a1c376282d5d2da61cc8347f59052a934f11460d952b95  MartianGrotesk-VF.woff2
7cdf8e985a4872246d8c2a19333bcc5e8cbcf512746128823f35c1c43aac238a  MartianMono-VF.woff2
```

The Grotesk binary was also verified byte-for-byte against the official OFL
repository's `fonts/variable/MartianGrotesk-VFVF.woff2` at commit
`6a20e9e51936d53f5b39f2022ef2ad4a5dee52d8` (the commit adding `OFL.txt`).
Its historical embedded copyright is “Copyright © 2020, Roman Shamin” and its
name table still links to an older EULA; these original bytes are preserved.
The accompanying upstream OFL release establishes this binary's provenance.
Mono's embedded notice is “Copyright 2020 The Martian Mono Project Authors”
and its embedded license explicitly specifies SIL Open Font License 1.1.

No glyphs, names, metrics, variable axes, or license metadata were modified.
