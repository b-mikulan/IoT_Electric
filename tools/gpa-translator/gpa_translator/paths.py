"""Shared paths for the Python app and a future portable build."""

from pathlib import Path
import sys

TOOL_DIRECTORY = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
DATA_DIRECTORY = TOOL_DIRECTORY / "data"
ICON_DIRECTORY = TOOL_DIRECTORY / ".cache" / "icons"
SCRIPT_DIRECTORY = TOOL_DIRECTORY / "scripts"
