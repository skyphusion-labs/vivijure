# Normalized structural dump of a sqlite/D1 database: tables, columns, indexes.
# Usage: python3 schema_dump.py <db-file>
# Ordering-insensitive (tables and index names sorted) so two build paths can be diffed.
import sqlite3
import sys

db = sqlite3.connect(sys.argv[1])
tables = [t for (t,) in db.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall()]
for t in sorted(tables):
    print("TABLE", t)
    for cid, name, typ, nn, dflt, pk in db.execute("PRAGMA table_info(%s)" % t).fetchall():
        print("  COL", cid, name, typ.upper(), "NOTNULL" if nn else "-", dflt, "PK" if pk else "-")
    idx = []
    for row in db.execute("PRAGMA index_list(%s)" % t).fetchall():
        iname, uniq, origin = row[1], row[2], row[3]
        cols = [r[2] for r in db.execute("PRAGMA index_info(%s)" % iname).fetchall()]
        idx.append("  IDX %s %s %s %s" % (iname, "UNIQUE" if uniq else "-", origin, cols))
    for line in sorted(idx):
        print(line)
