#!/usr/bin/env python3
"""Persist ArcDock app clicks and launches in a small SQLite database."""

from __future__ import annotations

import argparse
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path


SCHEMA = """
CREATE TABLE IF NOT EXISTS apps (
    app_id TEXT PRIMARY KEY,
    app_name TEXT NOT NULL DEFAULT '',
    click_count INTEGER NOT NULL DEFAULT 0 CHECK (click_count >= 0),
    first_clicked_at TEXT,
    last_clicked_at TEXT,
    last_opened_at TEXT
);

CREATE TABLE IF NOT EXISTS app_clicks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id TEXT NOT NULL,
    app_name TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL,
    clicked_at TEXT NOT NULL,
    FOREIGN KEY (app_id) REFERENCES apps(app_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS app_opens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id TEXT NOT NULL,
    app_name TEXT NOT NULL DEFAULT '',
    opened_at TEXT NOT NULL,
    FOREIGN KEY (app_id) REFERENCES apps(app_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS app_clicks_app_time
    ON app_clicks(app_id, clicked_at DESC);
CREATE INDEX IF NOT EXISTS app_opens_time
    ON app_opens(opened_at DESC);
"""


def utc_now() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def prepare_database(path: Path) -> sqlite3.Connection:
    os.umask(0o077)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    connection = sqlite3.connect(path, timeout=5)
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA journal_mode = WAL")
    connection.executescript(SCHEMA)
    connection.commit()
    os.chmod(path, 0o600)
    return connection


def record_click(
    connection: sqlite3.Connection,
    app_id: str,
    app_name: str,
    source: str,
) -> None:
    clicked_at = utc_now()
    with connection:
        connection.execute(
            """
            INSERT INTO apps (
                app_id, app_name, click_count, first_clicked_at, last_clicked_at
            ) VALUES (?, ?, 1, ?, ?)
            ON CONFLICT(app_id) DO UPDATE SET
                app_name = CASE
                    WHEN excluded.app_name <> '' THEN excluded.app_name
                    ELSE apps.app_name
                END,
                click_count = apps.click_count + 1,
                first_clicked_at = COALESCE(apps.first_clicked_at, excluded.first_clicked_at),
                last_clicked_at = excluded.last_clicked_at
            """,
            (app_id, app_name, clicked_at, clicked_at),
        )
        connection.execute(
            """
            INSERT INTO app_clicks (app_id, app_name, source, clicked_at)
            VALUES (?, ?, ?, ?)
            """,
            (app_id, app_name, source, clicked_at),
        )


def record_open(
    connection: sqlite3.Connection,
    app_id: str,
    app_name: str,
) -> None:
    opened_at = utc_now()
    with connection:
        connection.execute(
            """
            INSERT INTO apps (app_id, app_name, last_opened_at)
            VALUES (?, ?, ?)
            ON CONFLICT(app_id) DO UPDATE SET
                app_name = CASE
                    WHEN excluded.app_name <> '' THEN excluded.app_name
                    ELSE apps.app_name
                END,
                last_opened_at = excluded.last_opened_at
            """,
            (app_id, app_name, opened_at),
        )
        connection.execute(
            """
            INSERT INTO app_opens (app_id, app_name, opened_at)
            VALUES (?, ?, ?)
            """,
            (app_id, app_name, opened_at),
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("database", type=Path)
    parser.add_argument("event", choices=("init", "click", "open"))
    parser.add_argument("app_id", nargs="?", default="")
    parser.add_argument("app_name", nargs="?", default="")
    parser.add_argument("source", nargs="?", default="")
    args = parser.parse_args()
    if args.event != "init" and not args.app_id:
        parser.error("app_id is required for click and open events")
    return args


def main() -> None:
    args = parse_args()
    connection = prepare_database(args.database)
    try:
        if args.event == "click":
            record_click(connection, args.app_id, args.app_name, args.source)
        elif args.event == "open":
            record_open(connection, args.app_id, args.app_name)
    finally:
        connection.close()


if __name__ == "__main__":
    main()
