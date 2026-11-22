-- 1. The local semantic search was removed (word search only). Its index was derived data;
--    0007 stays in the history because libraries already applied it.
DROP TABLE IF EXISTS semantic_chunks;
DROP TABLE IF EXISTS semantic_notes;

-- 2. Password-protected notes. While a note is locked, `notes` keeps only its title and empty
--    content; the real content lives here, encrypted (XChaCha20-Poly1305, key from Argon2id).
CREATE TABLE note_locks (
  note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  kdf TEXT NOT NULL,
  salt BLOB NOT NULL,
  nonce BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  -- Image names the note uses (space separated), so unused-image cleanup keeps them.
  attachments TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
