-- Historical SQLx checksums stay immutable. Repair objects lost by the old raw runner.
ALTER TABLE note_versions ADD COLUMN snapshot_md TEXT NULL;

-- Only surviving ISO text is recoverable; an integer such as 2026 is ambiguous.
UPDATE notes SET created_at = CAST(strftime('%s', created_at) AS INTEGER)
WHERE typeof(created_at) = 'text' AND created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'
AND strftime('%s', created_at) IS NOT NULL;
UPDATE notes SET updated_at = CAST(strftime('%s', updated_at) AS INTEGER)
WHERE typeof(updated_at) = 'text' AND updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'
AND strftime('%s', updated_at) IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON notes(updated_at);
CREATE INDEX IF NOT EXISTS idx_notes_title ON notes(title);
CREATE INDEX IF NOT EXISTS idx_notes_deleted ON notes(is_deleted, deleted_at);
CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);
CREATE INDEX IF NOT EXISTS idx_note_versions_note_id ON note_versions(note_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_note_links_to_note ON note_links(to_note_id, from_note_id);
CREATE INDEX IF NOT EXISTS idx_note_links_from_note ON note_links(from_note_id, to_note_id);

DROP TRIGGER IF EXISTS notes_ai;
DROP TRIGGER IF EXISTS notes_au;
DROP TRIGGER IF EXISTS notes_ad;
DROP TRIGGER IF EXISTS note_tags_ai;
DROP TRIGGER IF EXISTS note_tags_ad;
DROP TRIGGER IF EXISTS tags_au;

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

DELETE FROM notes_fts;
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

