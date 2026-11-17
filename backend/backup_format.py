"""
Reading and writing the frames of a backup file (backup format 2,
docs/VAULT_FORMAT.md section 5). The cryptography, including what each frame
is bound to, is in ``helpers.BackupKey``; this module only lays the frames out
and enforces sizes, order and completeness.
"""

import struct
from typing import IO

from helpers import (
    BACKUP_HEADER_BYTES,
    NONCE_BYTES,
    TAG_BYTES,
    BackupFormatError,
    BackupHeader,
    BackupKey,
)

MAX_FRAMES = 1_000_001
MAX_MANIFEST_BYTES = 64 * 1024 * 1024
MAX_ATTACHMENT_FRAME_BYTES = 10 * 1024 * 1024
MAX_ENTRY_FRAME_BYTES = 64 * 1024 * 1024
MAX_ENTRY_STORED_BYTES = MAX_ENTRY_FRAME_BYTES - 32 * 1024
FRAME_OVERHEAD = 4 + NONCE_BYTES + TAG_BYTES
# The format has a practical, enforced total-size ceiling. Entries and their
# attachments are separate frames, so no aggregate JSON manifest grows with
# vault size. The file itself remains ciphertext when staged or transported.
MAX_BACKUP_BYTES = 1024 * 1024 * 1024
_FRAME_PREFIX = struct.Struct(">I")
_INCOMPLETE = "The backup file is incomplete or damaged."


def _read_exactly(source: IO[bytes], size: int) -> bytes:
    data = source.read(size)
    if len(data) != size:
        raise BackupFormatError(_INCOMPLETE)
    return data


class BackupWriter:
    def __init__(self, target: IO[bytes], key: BackupKey, header: BackupHeader) -> None:
        self._target = target
        self._key = key
        self._header = header.pack()
        self._frames = header.frames
        self._index = 0
        target.write(self._header)

    def write(self, plaintext: bytes) -> None:
        if self._index >= self._frames:
            raise ValueError("More frames than the header announced.")
        last = self._index == self._frames - 1
        nonce, ciphertext = self._key.seal_frame(
            self._header, self._index, last, plaintext
        )
        self._target.write(_FRAME_PREFIX.pack(len(ciphertext)) + nonce + ciphertext)
        self._index += 1

    def finish(self) -> None:
        if self._index != self._frames:
            raise ValueError("Fewer frames than the header announced.")


class BackupReader:
    """
    Frames are read and authenticated strictly in order: each one is bound to
    the header, its position and whether it is the last, so a reordered,
    repeated, dropped, foreign or truncated frame fails, and so does anything
    after the last frame.
    """

    def __init__(self, source: IO[bytes]) -> None:
        self._source = source
        self._header = _read_exactly(source, BACKUP_HEADER_BYTES)
        self.header = BackupHeader.parse(self._header)
        if self.header.frames > MAX_FRAMES:
            raise BackupFormatError("The backup has too many parts.")
        self._index = 0

    @property
    def remaining(self) -> int:
        return self.header.frames - self._index

    def read(self, key: BackupKey, max_bytes: int) -> bytes:
        if self._index >= self.header.frames:
            raise BackupFormatError(_INCOMPLETE)
        (length,) = _FRAME_PREFIX.unpack(_read_exactly(self._source, 4))
        if length < TAG_BYTES or length > max_bytes + TAG_BYTES:
            raise BackupFormatError(_INCOMPLETE)
        nonce = _read_exactly(self._source, NONCE_BYTES)
        ciphertext = _read_exactly(self._source, length)
        last = self._index == self.header.frames - 1
        plaintext = key.open_frame(self._header, self._index, last, nonce, ciphertext)
        self._index += 1
        return plaintext

    def finish(self) -> None:
        if self._index != self.header.frames or self._source.read(1):
            raise BackupFormatError(_INCOMPLETE)
