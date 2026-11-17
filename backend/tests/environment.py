import os
import tempfile


def configure_test_environment() -> None:
    """Every test run gets its own throwaway data folder, so the suite can never
    open a real vault."""
    os.environ["NEDRA_DATA_DIR"] = tempfile.mkdtemp(prefix="nedra-test-")
    os.environ["NEDRA_RATE_LIMIT"] = "100000/hour"
