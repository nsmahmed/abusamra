from __future__ import annotations

import argparse
import sys


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="Fetch the free geospatial foundation for the Abu Samra customs port."
    )
    sub = parser.add_subparsers(dest="command", required=True)
    fetch = sub.add_parser("fetch", help="Download OpenStreetMap and elevation, then write the dataset")
    fetch.add_argument("--refresh", action="store_true", help="Ignore cached downloads and fetch again")
    sub.add_parser("validate", help="Check that the written dataset is ready for 2D/3D work")
    args = parser.parse_args(argv)

    if args.command == "fetch":
        from abu_samra.pipeline import fetch_all

        fetch_all(refresh=args.refresh)
        return
    from abu_samra.validate import validate

    if validate():
        sys.exit(1)


if __name__ == "__main__":
    main()
