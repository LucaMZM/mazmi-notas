PRAGMA foreign_keys = OFF;

ALTER TABLE notes RENAME TO notes_legacy;
ALTER TABLE tags RENAME TO tags_legacy;
ALTER TABLE note_tags RENAME TO note_tags_legacy;

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content_rich_json TEXT NOT NULL DEFAULT '',
  content_md TEXT NOT NULL DEFAULT '',
  content_plain TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER NULL
);

INSERT INTO notes (
  id,
  title,
  content_rich_json,
  content_md,
  content_plain,
  created_at,
  updated_at,
  is_deleted,
  deleted_at
)
SELECT
  id,
  COALESCE(title, ''),
  '',
  COALESCE(content_md, ''),
  COALESCE(content_md, ''),
  CASE
    WHEN typeof(created_at) = 'integer' THEN created_at
    WHEN CAST(created_at AS INTEGER) > 0 THEN CAST(created_at AS INTEGER)
    ELSE COALESCE(CAST(strftime('%s', created_at) AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER))
  END,
  CASE
    WHEN typeof(updated_at) = 'integer' THEN updated_at
    WHEN CAST(updated_at AS INTEGER) > 0 THEN CAST(updated_at AS INTEGER)
    ELSE COALESCE(CAST(strftime('%s', updated_at) AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER))
  END,
  0,
  NULL
FROM notes_legacy;

CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

INSERT INTO tags (id, name)
SELECT lower(hex(randomblob(16))), name
FROM tags_legacy;

CREATE TABLE note_tags (
  note_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  PRIMARY KEY (note_id, tag_id),
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

INSERT INTO note_tags (note_id, tag_id)
SELECT nt.note_id, t.id
FROM note_tags_legacy nt
JOIN tags_legacy tl ON tl.id = nt.tag_id
JOIN tags t ON t.name = tl.name;

DROP TABLE note_tags_legacy;
DROP TABLE tags_legacy;
DROP TABLE notes_legacy;

CREATE TABLE note_versions (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL,
  snapshot_rich_json TEXT NOT NULL,
  snapshot_plain TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
);

CREATE TABLE note_links (
  from_note_id TEXT NOT NULL,
  to_note_id TEXT NOT NULL,
  link_text TEXT NOT NULL,
  PRIMARY KEY (from_note_id, to_note_id, link_text),
  FOREIGN KEY (from_note_id) REFERENCES notes(id) ON DELETE CASCADE,
  FOREIGN KEY (to_note_id) REFERENCES notes(id) ON DELETE CASCADE
);

CREATE VIRTUAL TABLE notes_fts USING fts5(
  note_id UNINDEXED,
  title,
  content_plain,
  tags_text
);

CREATE INDEX idx_notes_updated_at ON notes(updated_at);
CREATE INDEX idx_notes_title ON notes(title);
CREATE INDEX idx_notes_deleted ON notes(is_deleted, deleted_at);
CREATE INDEX idx_tags_name ON tags(name);
CREATE INDEX idx_note_versions_note_id ON note_versions(note_id, created_at DESC);
CREATE INDEX idx_note_links_to_note ON note_links(to_note_id, from_note_id);
CREATE INDEX idx_note_links_from_note ON note_links(from_note_id, to_note_id);

CREATE TRIGGER notes_ai AFTER INSERT ON notes
WHEN NEW.is_deleted = 0
BEGIN
  INSERT INTO notes_fts (note_id, title, content_plain, tags_text)
  SELECT
    NEW.id,
    NEW.title,
    NEW.content_plain,
    COALESCE(
      (
        SELECT GROUP_CONCAT(t.name, ' ')
        FROM note_tags nt
        JOIN tags t ON t.id = nt.tag_id
        WHERE nt.note_id = NEW.id
      ),
      ''
    );
END;

CREATE TRIGGER notes_au AFTER UPDATE ON notes
BEGIN
  DELETE FROM notes_fts WHERE note_id = OLD.id;
  INSERT INTO notes_fts (note_id, title, content_plain, tags_text)
  SELECT
    NEW.id,
    NEW.title,
    NEW.content_plain,
    COALESCE(
      (
        SELECT GROUP_CONCAT(t.name, ' ')
        FROM note_tags nt
        JOIN tags t ON t.id = nt.tag_id
        WHERE nt.note_id = NEW.id
      ),
      ''
    )
  WHERE NEW.is_deleted = 0;
END;

CREATE TRIGGER notes_ad AFTER DELETE ON notes
BEGIN
  DELETE FROM notes_fts WHERE note_id = OLD.id;
END;

CREATE TRIGGER note_tags_ai AFTER INSERT ON note_tags
BEGIN
  DELETE FROM notes_fts WHERE note_id = NEW.note_id;
  INSERT INTO notes_fts (note_id, title, content_plain, tags_text)
  SELECT
    n.id,
    n.title,
    n.content_plain,
    COALESCE(
      (
        SELECT GROUP_CONCAT(t.name, ' ')
        FROM note_tags nt
        JOIN tags t ON t.id = nt.tag_id
        WHERE nt.note_id = n.id
      ),
      ''
    )
  FROM notes n
  WHERE n.id = NEW.note_id AND n.is_deleted = 0;
END;

CREATE TRIGGER note_tags_ad AFTER DELETE ON note_tags
BEGIN
  DELETE FROM notes_fts WHERE note_id = OLD.note_id;
  INSERT INTO notes_fts (note_id, title, content_plain, tags_text)
  SELECT
    n.id,
    n.title,
    n.content_plain,
    COALESCE(
      (
        SELECT GROUP_CONCAT(t.name, ' ')
        FROM note_tags nt
        JOIN tags t ON t.id = nt.tag_id
        WHERE nt.note_id = n.id
      ),
      ''
    )
  FROM notes n
  WHERE n.id = OLD.note_id AND n.is_deleted = 0;
END;

CREATE TRIGGER tags_au AFTER UPDATE ON tags
BEGIN
  DELETE FROM notes_fts
  WHERE note_id IN (
    SELECT nt.note_id
    FROM note_tags nt
    WHERE nt.tag_id = NEW.id
  );

  INSERT INTO notes_fts (note_id, title, content_plain, tags_text)
  SELECT
    n.id,
    n.title,
    n.content_plain,
    COALESCE(
      (
        SELECT GROUP_CONCAT(t.name, ' ')
        FROM note_tags nt
        JOIN tags t ON t.id = nt.tag_id
        WHERE nt.note_id = n.id
      ),
      ''
    )
  FROM notes n
  WHERE n.id IN (
    SELECT nt.note_id
    FROM note_tags nt
    WHERE nt.tag_id = NEW.id
  )
    AND n.is_deleted = 0;
END;

INSERT INTO notes_fts (note_id, title, content_plain, tags_text)
SELECT
  n.id,
  n.title,
  n.content_plain,
  COALESCE(
    (
      SELECT GROUP_CONCAT(t.name, ' ')
      FROM note_tags nt
      JOIN tags t ON t.id = nt.tag_id
      WHERE nt.note_id = n.id
    ),
    ''
  )
FROM notes n
WHERE n.is_deleted = 0;

PRAGMA foreign_keys = ON;
