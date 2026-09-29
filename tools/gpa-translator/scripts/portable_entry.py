"""Entry script for the optional Windows executable build."""

from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from gpa_translator.portable import check_package, main


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "--self-test":
        raise SystemExit(check_package(
            Path(sys.argv[2]), Path(sys.argv[3]) if len(sys.argv) > 3 else None))
    main()
