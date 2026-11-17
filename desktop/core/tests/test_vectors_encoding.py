from pathlib import Path

from desktop_core import vectors


def test_frozen_vectors_work_with_a_windows_default_encoding(monkeypatch):
    repo = Path(__file__).resolve().parents[3]
    monkeypatch.syspath_prepend(str(repo / "backend"))
    original = Path.read_text

    def windows_default(self, encoding=None, errors=None, **kwargs):
        return original(self, encoding=encoding or "cp1252", errors=errors, **kwargs)

    monkeypatch.setattr(Path, "read_text", windows_default)
    assert vectors.run_all(repo / "testdata/vectors")["passed"] == 27
