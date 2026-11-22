-- Nested folders. Deleting a folder is done by the application, which first moves its
-- notes and subfolders to its parent, so no note is ever deleted with a folder.
CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0 AND length(name) <= 200),
  parent_id TEXT NULL REFERENCES folders(id),
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX idx_folders_parent ON folders(parent_id, position, name);

ALTER TABLE notes ADD COLUMN folder_id TEXT NULL REFERENCES folders(id) ON DELETE SET NULL;
CREATE INDEX idx_notes_folder ON notes(folder_id, is_deleted, updated_at);
