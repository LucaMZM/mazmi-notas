-- The old duplicate migration runner renamed notes twice. SQLite rewrote the
-- surviving child foreign keys to notes_legacy before that parent was dropped.
-- Rebuild only the children, inside SQLx's transaction, with foreign keys ON.
CREATE TABLE note_versions_repaired (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL,
  snapshot_rich_json TEXT NOT NULL,
  snapshot_plain TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  snapshot_md TEXT NULL,
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
);

INSERT INTO note_versions_repaired (id, note_id, snapshot_rich_json, snapshot_plain, created_at, snapshot_md)
SELECT id, note_id, snapshot_rich_json, snapshot_plain, created_at, snapshot_md FROM note_versions;

DROP TABLE note_versions;
ALTER TABLE note_versions_repaired RENAME TO note_versions;
CREATE INDEX idx_note_versions_note_id ON note_versions(note_id, created_at DESC);

CREATE TABLE note_links_repaired (
  from_note_id TEXT NOT NULL,
  to_note_id TEXT NOT NULL,
  link_text TEXT NOT NULL,
  PRIMARY KEY (from_note_id, to_note_id, link_text),
  FOREIGN KEY (from_note_id) REFERENCES notes(id) ON DELETE CASCADE,
  FOREIGN KEY (to_note_id) REFERENCES notes(id) ON DELETE CASCADE
);

INSERT INTO note_links_repaired (from_note_id, to_note_id, link_text)
SELECT from_note_id, to_note_id, link_text FROM note_links;

DROP TABLE note_links;
ALTER TABLE note_links_repaired RENAME TO note_links;
CREATE INDEX idx_note_links_to_note ON note_links(to_note_id, from_note_id);
CREATE INDEX idx_note_links_from_note ON note_links(from_note_id, to_note_id);
