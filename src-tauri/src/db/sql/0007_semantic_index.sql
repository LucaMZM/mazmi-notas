-- Local semantic index. Derived data only: it can always be dropped and rebuilt from notes.
-- One row per passage; the embedding is DIMENSIONS little-endian f32 values.
CREATE TABLE semantic_chunks (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  context TEXT NOT NULL,
  text TEXT NOT NULL,
  embedding BLOB NOT NULL,
  PRIMARY KEY (note_id, ordinal)
);

-- What each note was indexed from, so only changed notes are embedded again.
CREATE TABLE semantic_notes (
  note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  model_id TEXT NOT NULL,
  indexed_at INTEGER NOT NULL
);
