mod vault_metadata;
use vault_metadata::{parse_vault_document, VaultDocument};
#[cfg(test)]
use vault_metadata::split_frontmatter;
pub mod migrations;
mod writes;
mod startup;
mod managed_backups;
mod folders;
mod reminders;
pub mod locks;
pub use reminders::{
  clear_reminder_on_path, complete_reminder_on_path, list_reminders, set_reminder_on_path, snooze_reminder_on_path, ReminderRecord,
};

/// Creates an empty, fully migrated database at `path` (diagnostics only; never the user's).
pub fn create_isolated_database(path: &Path) -> Result<(), String> {
  if path.exists() { return Err("La base de diagnóstico ya existe".into()); }
  let connection = Connection::open(path).map_err(|error| error.to_string())?;
  connection.execute_batch(include_str!("sql/0001_init.sql")).map_err(|error| error.to_string())?;
  for migration in migrations::sqlite_migrations().into_iter().filter(|migration| migration.version > 1) {
    connection.execute_batch(migration.sql).map_err(|error| error.to_string())?;
  }
  Ok(())
}

pub fn open_reminders_connection(path: &Path) -> Result<Connection, String> { open_connection(path) }
/// Deletes images that no note, trashed note or saved version uses any more.
pub fn remove_orphan_attachments(path: &Path, grace: Duration) -> Result<usize, String> {
  crate::attachments::remove_orphans(&open_connection(path)?, &crate::attachments::directory(path), grace)
}
pub fn native_reminder_plan(connection: &Connection, now: chrono::DateTime<chrono::Utc>, native_repeats: bool) -> Result<Vec<crate::reminders::schedule::NativeRequest>, String> {
  reminders::native_plan(connection, now, native_repeats)
}
pub fn note_has_reminder(connection: &Connection, note_id: &str) -> Result<bool, String> {
  connection.query_row("SELECT EXISTS(SELECT 1 FROM reminders WHERE note_id=?1 AND status='scheduled')", [note_id], |row| row.get(0))
    .map_err(|error| error.to_string())
}
pub fn sweep_due_reminders(path: &Path, now: chrono::DateTime<chrono::Utc>) -> Result<bool, String> { reminders::sweep_due_on_path(path, now) }
pub use folders::{create_folder_on_path, delete_folder_on_path, move_folder_on_path, move_note_to_folder_on_path, rename_folder_on_path};
pub use managed_backups::{list_managed_backups, resolve_managed_backup};
pub use startup::{safety_plugin, validation_plugin};
pub use writes::{change_note_state_on_path, restore_version_on_path, save_note_on_path, NoteAction, SaveNoteDraft};

use std::{
  collections::{BTreeMap, HashSet},
  fs,
  io::Write,
  path::{Path, PathBuf},
  sync::atomic::{AtomicU64, Ordering},
  time::Duration,
  time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use tauri::Manager;

pub const DB_FILE_NAME: &str = "notes.db";

static ID_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Serialize, Deserialize)]
pub struct BackupPayload {
  pub version: u32,
  pub exported_at: i64,
  pub notes: Vec<BackupNote>,
  pub tags: Vec<BackupTag>,
  pub note_tags: Vec<BackupNoteTag>,
  pub note_versions: Vec<BackupVersion>,
  pub note_links: Vec<BackupLink>,
  #[serde(default)]
  pub folders: Vec<BackupFolder>,
  #[serde(default)]
  pub reminders: Vec<BackupReminder>,
  /// Images the notes and versions reference, so a backup restores them on any machine.
  #[serde(default)]
  pub attachments: Vec<BackupAttachment>,
  /// Protected notes: their encrypted content (the password is never stored).
  #[serde(default)]
  pub locks: Vec<BackupLock>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BackupLock {
  pub note_id: String,
  pub kdf: String,
  /// Base64 (standard alphabet).
  pub salt: String,
  pub nonce: String,
  pub ciphertext: String,
  pub attachments: String,
  pub created_at: i64,
  pub updated_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BackupAttachment {
  pub name: String,
  /// Base64 (standard alphabet) of the file's bytes.
  pub data: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BackupReminder {
  pub id: String,
  pub note_id: String,
  pub local_time: String,
  pub time_zone: String,
  pub repeat: String,
  pub status: String,
  pub next_fire_at: Option<i64>,
  pub snoozed_until: Option<i64>,
  pub last_fired_at: Option<i64>,
  pub needs_attention: i64,
  pub created_at: i64,
  pub updated_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BackupFolder {
  pub id: String,
  pub name: String,
  pub parent_id: Option<String>,
  pub position: i64,
  pub created_at: i64,
  pub updated_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BackupNote {
  pub id: String,
  pub title: String,
  pub content_rich_json: String,
  pub content_md: String,
  pub content_plain: String,
  pub created_at: i64,
  pub updated_at: i64,
  pub is_deleted: i64,
  pub deleted_at: Option<i64>,
  #[serde(default)]
  pub folder_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BackupTag {
  pub id: String,
  pub name: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BackupNoteTag {
  pub note_id: String,
  pub tag_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BackupVersion {
  pub id: String,
  pub note_id: String,
  pub snapshot_rich_json: String,
  pub snapshot_plain: String,
  #[serde(default)]
  pub snapshot_md: Option<String>,
  pub created_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BackupLink {
  pub from_note_id: String,
  pub to_note_id: String,
  pub link_text: String,
}

#[derive(Debug)]
struct NoteForVault {
  folder_id: Option<String>,
  id: String,
  title: String,
  content_md: String,
  content_plain: String,
  updated_at: i64,
}

pub fn database_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  let config_dir = app
    .path()
    .app_config_dir()
    .map_err(|error| format!("No se pudo resolver app_config_dir: {error}"))?;

  fs::create_dir_all(&config_dir)
    .map_err(|error| format!("No se pudo crear el directorio de la DB: {error}"))?;

  Ok(config_dir.join(DB_FILE_NAME))
}

pub fn backup_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  let data_dir = app
    .path()
    .app_data_dir()
    .map_err(|error| format!("No se pudo resolver app_data_dir: {error}"))?;

  let backup_dir = data_dir.join("backups");
  fs::create_dir_all(&backup_dir)
    .map_err(|error| format!("No se pudo crear el directorio de backups: {error}"))?;

  Ok(backup_dir)
}

fn now_unix() -> i64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|duration| duration.as_secs() as i64)
    .unwrap_or(0)
}

fn generate_id(prefix: &str) -> String {
  let nanos = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|duration| duration.as_nanos())
    .unwrap_or(0);

  format!("{prefix}-{nanos}-{}-{}", std::process::id(), ID_SEQUENCE.fetch_add(1, Ordering::Relaxed))
}

fn open_connection(db_path: &Path) -> Result<Connection, String> {
  let connection = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_WRITE)
    .map_err(|error| format!("No se pudo abrir la base de datos en {db_path:?}: {error}"))?;

  connection
    .execute_batch("PRAGMA foreign_keys = ON;")
    .map_err(|error| format!("No se pudo habilitar foreign keys: {error}"))?;

  connection.busy_timeout(Duration::from_secs(5)).map_err(|error| error.to_string())?;
  validate_schema(&connection)?;
  Ok(connection)
}

pub fn validate_schema(connection: &Connection) -> Result<(), String> {
  for query in [
    "SELECT id,title,content_rich_json,content_md,content_plain,created_at,updated_at,is_deleted,deleted_at FROM notes LIMIT 0",
    "SELECT id,name FROM tags LIMIT 0",
    "SELECT note_id,tag_id FROM note_tags LIMIT 0",
    "SELECT id,note_id,snapshot_rich_json,snapshot_plain,snapshot_md,created_at FROM note_versions LIMIT 0",
    "SELECT from_note_id,to_note_id,link_text FROM note_links LIMIT 0",
    "SELECT note_id,title,content_plain,tags_text FROM notes_fts LIMIT 0",
    "SELECT id,name,parent_id,position,created_at,updated_at FROM folders LIMIT 0",
    "SELECT folder_id FROM notes LIMIT 0",
    "SELECT id,note_id,local_time,time_zone,repeat,status,next_fire_at,snoozed_until,last_fired_at,needs_attention FROM reminders LIMIT 0",
    "SELECT note_id,kdf,salt,nonce,ciphertext,attachments,created_at,updated_at FROM note_locks LIMIT 0",
  ] {
    connection.prepare(query).map_err(|error| format!("Esquema incompleto; se requieren migraciones SQLx: {error}"))?;
  }
  // foreign_key_check alone misses dangling parent definitions when child tables are empty.
  for (table, expected) in [
    ("note_tags", &[("note_id", "notes"), ("tag_id", "tags")][..]),
    ("note_versions", &[("note_id", "notes")][..]),
    ("note_links", &[("from_note_id", "notes"), ("to_note_id", "notes")][..]),
  ] {
    let mut statement = connection.prepare(&format!("PRAGMA foreign_key_list({table})")).map_err(|error| error.to_string())?;
    let actual: HashSet<(String, String, String, String)> = statement.query_map([], |row| {
      Ok((row.get(3)?, row.get(2)?, row.get(4)?, row.get(6)?))
    }).map_err(|error| error.to_string())?.collect::<Result<_, _>>().map_err(|error| error.to_string())?;
    let expected: HashSet<_> = expected.iter().map(|(column, parent)| {
      (column.to_string(), parent.to_string(), "id".to_string(), "CASCADE".to_string())
    }).collect();
    if actual != expected {
      return Err(format!("Esquema incompleto: claves foraneas invalidas en {table}; se requieren migraciones SQLx"));
    }
  }
  for (kind, names) in [
    ("trigger", &[
      "notes_ai", "notes_au", "notes_ad", "note_tags_ai", "note_tags_ad", "tags_au",
    ][..]),
    ("index", &[
      "idx_notes_updated_at", "idx_notes_title", "idx_notes_deleted", "idx_tags_name",
      "idx_note_versions_note_id", "idx_note_links_to_note", "idx_note_links_from_note",
    ][..]),
  ] {
    for name in names {
      let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type=?1 AND name=?2)",
        params![kind, name], |row| row.get(0),
      ).map_err(|error| error.to_string())?;
      if !exists { return Err(format!("Esquema incompleto: falta {kind} {name}")); }
    }
  }
  Ok(())
}

fn markdown_to_plain(markdown: &str) -> String {
  markdown
    .replace("```", "")
    .replace(['#', '*', '_', '`', '>', '-', '[', ']', '(', ')'], " ")
    .split_whitespace()
    .collect::<Vec<_>>()
    .join(" ")
}

fn parse_wikilinks(input: &str) -> Vec<String> {
  let mut results = Vec::new();
  let bytes = input.as_bytes();
  let mut index = 0usize;

  while index + 3 < bytes.len() {
    if bytes[index] == b'[' && bytes[index + 1] == b'[' {
      let start = index + 2;
      let mut cursor = start;
      while cursor + 1 < bytes.len() {
        if bytes[cursor] == b']' && bytes[cursor + 1] == b']' {
          let candidate = input[start..cursor].trim();
          if !candidate.is_empty() {
            results.push(candidate.to_string());
          }
          index = cursor + 2;
          break;
        }
        cursor += 1;
      }

      if cursor + 1 >= bytes.len() {
        break;
      }

      continue;
    }

    index += 1;
  }

  let mut dedup = HashSet::new();
  results.retain(|item| dedup.insert(item.to_lowercase()));
  results
}

fn ensure_tag_id(transaction: &Transaction<'_>, tag_name: &str) -> Result<String, String> {
  let normalized = tag_name.trim().to_lowercase();
  if normalized.is_empty() {
    return Err("Tag vacío".to_string());
  }

  let existing: Option<String> = transaction
    .query_row(
      "SELECT id FROM tags WHERE name = ?1 LIMIT 1",
      [normalized.as_str()],
      |row| row.get(0),
    )
    .optional()
    .map_err(|error| format!("No se pudo buscar tag: {error}"))?;

  if let Some(id) = existing {
    return Ok(id);
  }

  let tag_id = generate_id("tag");
  transaction
    .execute(
      "INSERT INTO tags (id, name) VALUES (?1, ?2)",
      params![tag_id.as_str(), normalized.as_str()],
    )
    .map_err(|error| format!("No se pudo insertar tag: {error}"))?;

  Ok(tag_id)
}

fn set_note_tags(transaction: &Transaction<'_>, note_id: &str, tags: &[String]) -> Result<(), String> {
  transaction
    .execute("DELETE FROM note_tags WHERE note_id = ?1", [note_id])
    .map_err(|error| format!("No se pudieron limpiar tags de la nota: {error}"))?;

  let mut seen = HashSet::new();
  for tag in tags {
    let normalized = tag.trim().to_lowercase();
    if normalized.is_empty() || !seen.insert(normalized.clone()) {
      continue;
    }

    let tag_id = ensure_tag_id(transaction, &normalized)?;
    transaction
      .execute(
        "INSERT OR IGNORE INTO note_tags (note_id, tag_id) VALUES (?1, ?2)",
        params![note_id, tag_id],
      )
      .map_err(|error| format!("No se pudo asociar tag a la nota: {error}"))?;
  }

  Ok(())
}

fn insert_note_version(
  transaction: &Transaction<'_>,
  note_id: &str,
  snapshot_rich_json: &str,
  snapshot_plain: &str,
) -> Result<(), String> {
  let version_id = generate_id("ver");
  transaction
    .execute(
      "INSERT INTO note_versions (id, note_id, snapshot_rich_json, snapshot_plain, created_at, snapshot_md)
       VALUES (?1, ?2, ?3, ?4, ?5, (SELECT content_md FROM notes WHERE id=?2))",
      params![version_id, note_id, snapshot_rich_json, snapshot_plain, now_unix()],
    )
    .map_err(|error| format!("No se pudo insertar versión de nota: {error}"))?;

  Ok(())
}

fn refresh_note_links(transaction: &Transaction<'_>, note_id: &str, text: &str) -> Result<(), String> {
  transaction
    .execute("DELETE FROM note_links WHERE from_note_id = ?1", [note_id])
    .map_err(|error| format!("No se pudieron limpiar links previos: {error}"))?;

  for link_title in parse_wikilinks(text) {
    let linked_note: Option<String> = transaction
      .query_row(
        "SELECT id FROM notes WHERE lower(title) = lower(?1) AND is_deleted = 0 LIMIT 1",
        [link_title.as_str()],
        |row| row.get(0),
      )
      .optional()
      .map_err(|error| format!("No se pudo resolver wikilink: {error}"))?;

    if let Some(target_id) = linked_note {
      transaction
        .execute(
          "INSERT OR IGNORE INTO note_links (from_note_id, to_note_id, link_text) VALUES (?1, ?2, ?3)",
          params![note_id, target_id, link_title],
        )
        .map_err(|error| format!("No se pudo insertar link entre notas: {error}"))?;
    }
  }

  Ok(())
}

fn refresh_all_links(transaction: &Transaction<'_>) -> Result<(), String> {
  let mut statement = transaction.prepare("SELECT id,content_md || char(10) || content_plain FROM notes WHERE is_deleted=0")
    .map_err(|error| error.to_string())?;
  let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
    .map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
  drop(statement);
  transaction.execute("DELETE FROM note_links", []).map_err(|error| error.to_string())?;
  for (id, text) in rows { refresh_note_links(transaction, &id, &text)?; }
  Ok(())
}

pub fn run_self_check_on_path(db_path: &Path) -> Result<String, String> {
  let mut connection = open_connection(db_path)?;
  let transaction = connection
    .transaction()
    .map_err(|error| format!("No se pudo iniciar transacción self-check: {error}"))?;

  let marker = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map_err(|error| format!("Error generando marcador temporal: {error}"))?
    .as_nanos();

  let note_a = format!("self-a-{marker}");
  let note_b = format!("self-b-{marker}");
  let now = now_unix();

  transaction
    .execute(
      "INSERT INTO notes (id, title, content_rich_json, content_md, content_plain, created_at, updated_at, is_deleted, deleted_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, NULL)",
      params![
        note_b,
        "Self Target",
        r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"target"}]}]}"#,
        "target",
        "target",
        now,
        now,
      ],
    )
    .map_err(|error| format!("No se pudo crear nota target: {error}"))?;

  let plain_a = "alpha beta [[Self Target]]";
  let rich_a = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"alpha beta [[Self Target]]"}]}]}"#;

  transaction
    .execute(
      "INSERT INTO notes (id, title, content_rich_json, content_md, content_plain, created_at, updated_at, is_deleted, deleted_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, NULL)",
      params![note_a, "Self Alpha", rich_a, plain_a, plain_a, now, now],
    )
    .map_err(|error| format!("No se pudo crear nota alpha: {error}"))?;

  set_note_tags(&transaction, &note_a, &["qa".to_string(), "v4".to_string()])?;
  insert_note_version(&transaction, &note_a, rich_a, plain_a)?;
  refresh_note_links(&transaction, &note_a, plain_a)?;

  let fts_count: i64 = transaction
    .query_row(
      "SELECT COUNT(*) FROM notes_fts WHERE notes_fts MATCH 'alpha'",
      [],
      |row| row.get(0),
    )
    .map_err(|error| format!("MATCH FTS falló: {error}"))?;

  if fts_count < 1 {
    return Err("FTS5 no devolvió resultados esperados para 'alpha'".to_string());
  }

  transaction
    .execute(
      "UPDATE notes SET is_deleted = 1, deleted_at = ?1, updated_at = ?1 WHERE id = ?2",
      params![now_unix(), note_a.as_str()],
    )
    .map_err(|error| format!("No se pudo hacer soft delete en self-check: {error}"))?;

  let deleted_in_fts: i64 = transaction
    .query_row(
      "SELECT COUNT(*) FROM notes_fts WHERE note_id = ?1",
      [note_a.as_str()],
      |row| row.get(0),
    )
    .map_err(|error| format!("No se pudo validar salida de FTS tras soft delete: {error}"))?;

  if deleted_in_fts != 0 {
    return Err("La nota en papelera no fue removida del índice FTS".to_string());
  }

  transaction
    .execute(
      "UPDATE notes SET is_deleted = 0, deleted_at = NULL, updated_at = ?1 WHERE id = ?2",
      params![now_unix(), note_a.as_str()],
    )
    .map_err(|error| format!("No se pudo restaurar nota en self-check: {error}"))?;

  let restored_in_fts: i64 = transaction
    .query_row(
      "SELECT COUNT(*) FROM notes_fts WHERE note_id = ?1",
      [note_a.as_str()],
      |row| row.get(0),
    )
    .map_err(|error| format!("No se pudo validar FTS tras restore: {error}"))?;

  if restored_in_fts == 0 {
    return Err("La nota restaurada no volvió al índice FTS".to_string());
  }

  transaction
    .execute("DELETE FROM notes WHERE id = ?1", [note_a.as_str()])
    .map_err(|error| format!("No se pudo borrar nota alpha: {error}"))?;
  transaction
    .execute("DELETE FROM notes WHERE id = ?1", [note_b.as_str()])
    .map_err(|error| format!("No se pudo borrar nota target: {error}"))?;

  transaction.rollback().map_err(|error| format!("No se pudo revertir self-check: {error}"))?;

  Ok("La biblioteca está en buen estado.".to_string())
}

pub fn get_note_for_export(db_path: &Path, note_id: &str) -> Result<(String, String), String> {
  let connection = open_connection(db_path)?;
  if locks::is_locked(&connection, note_id)? { return Err("Las notas protegidas con contraseña no se exportan".into()); }

  connection
    .query_row(
      "SELECT title, content_md, content_plain FROM notes WHERE id = ?1",
      [note_id],
      |row| {
        let title: String = row.get(0)?;
        let content_md: String = row.get(1)?;
        let content_plain: String = row.get(2)?;
        let content = if content_md.trim().is_empty() {
          content_plain
        } else {
          content_md
        };
        Ok((title, content))
      },
    )
    .map_err(|error| format!("No se encontró la nota para exportar: {error}"))
}

fn has_folders(connection: &Connection) -> Result<bool, String> {
  connection.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('notes') WHERE name='folder_id')", [], |row| row.get(0))
    .map_err(|error| error.to_string())
}

fn collect_backup_payload(connection: &Connection) -> Result<BackupPayload, String> {
  // Recovery copies are also taken while repairing databases older than the folders migration.
  let folders_ready = has_folders(connection)?;
  let notes = {
    let mut statement = connection
      .prepare(if folders_ready {
        "SELECT id, title, content_rich_json, content_md, content_plain, created_at, updated_at, is_deleted, deleted_at, folder_id
         FROM notes"
      } else {
        "SELECT id, title, content_rich_json, content_md, content_plain, created_at, updated_at, is_deleted, deleted_at, NULL
         FROM notes"
      })
      .map_err(|error| format!("No se pudo preparar query de notas para backup: {error}"))?;

    let rows = statement
      .query_map([], |row| {
        Ok(BackupNote {
          id: row.get(0)?,
          title: row.get(1)?,
          content_rich_json: row.get(2)?,
          content_md: row.get(3)?,
          content_plain: row.get(4)?,
          created_at: row.get(5)?,
          updated_at: row.get(6)?,
          is_deleted: row.get(7)?,
          deleted_at: row.get(8)?,
          folder_id: row.get(9)?,
        })
      })
      .map_err(|error| format!("No se pudieron leer notas para backup: {error}"))?;

    rows
      .collect::<Result<Vec<_>, _>>()
      .map_err(|error| format!("No se pudo mapear notas para backup: {error}"))?
  };

  let tags = {
    let mut statement = connection
      .prepare("SELECT id, name FROM tags")
      .map_err(|error| format!("No se pudo preparar query de tags para backup: {error}"))?;

    let rows = statement
      .query_map([], |row| {
        Ok(BackupTag {
          id: row.get(0)?,
          name: row.get(1)?,
        })
      })
      .map_err(|error| format!("No se pudieron leer tags para backup: {error}"))?;

    rows
      .collect::<Result<Vec<_>, _>>()
      .map_err(|error| format!("No se pudo mapear tags para backup: {error}"))?
  };

  let note_tags = {
    let mut statement = connection
      .prepare("SELECT note_id, tag_id FROM note_tags")
      .map_err(|error| format!("No se pudo preparar query de note_tags para backup: {error}"))?;

    let rows = statement
      .query_map([], |row| {
        Ok(BackupNoteTag {
          note_id: row.get(0)?,
          tag_id: row.get(1)?,
        })
      })
      .map_err(|error| format!("No se pudieron leer note_tags para backup: {error}"))?;

    rows
      .collect::<Result<Vec<_>, _>>()
      .map_err(|error| format!("No se pudo mapear note_tags para backup: {error}"))?
  };

  let note_versions = {
    let mut statement = connection
      .prepare("SELECT id, note_id, snapshot_rich_json, snapshot_plain, created_at, snapshot_md FROM note_versions")
      .map_err(|error| format!("No se pudo preparar query de note_versions para backup: {error}"))?;

    let rows = statement
      .query_map([], |row| {
        Ok(BackupVersion {
          id: row.get(0)?,
          note_id: row.get(1)?,
          snapshot_rich_json: row.get(2)?,
          snapshot_plain: row.get(3)?,
          created_at: row.get(4)?,
          snapshot_md: row.get(5)?,
        })
      })
      .map_err(|error| format!("No se pudieron leer note_versions para backup: {error}"))?;

    rows
      .collect::<Result<Vec<_>, _>>()
      .map_err(|error| format!("No se pudo mapear note_versions para backup: {error}"))?
  };

  let note_links = {
    let mut statement = connection
      .prepare("SELECT from_note_id, to_note_id, link_text FROM note_links")
      .map_err(|error| format!("No se pudo preparar query de note_links para backup: {error}"))?;

    let rows = statement
      .query_map([], |row| {
        Ok(BackupLink {
          from_note_id: row.get(0)?,
          to_note_id: row.get(1)?,
          link_text: row.get(2)?,
        })
      })
      .map_err(|error| format!("No se pudieron leer note_links para backup: {error}"))?;

    rows
      .collect::<Result<Vec<_>, _>>()
      .map_err(|error| format!("No se pudo mapear note_links para backup: {error}"))?
  };

  let folders = if !folders_ready { Vec::new() } else {
    let mut statement = connection
      .prepare("SELECT id, name, parent_id, position, created_at, updated_at FROM folders")
      .map_err(|error| format!("No se pudo leer carpetas para backup: {error}"))?;
    let rows = statement
      .query_map([], |row| Ok(BackupFolder {
        id: row.get(0)?, name: row.get(1)?, parent_id: row.get(2)?, position: row.get(3)?, created_at: row.get(4)?, updated_at: row.get(5)?,
      }))
      .map_err(|error| format!("No se pudieron leer carpetas para backup: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|error| format!("No se pudo mapear carpetas para backup: {error}"))?
  };

  let reminders_ready: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='reminders')", [], |row| row.get(0))
    .map_err(|error| error.to_string())?;
  let reminders = if !reminders_ready { Vec::new() } else {
    let mut statement = connection.prepare(
      "SELECT id, note_id, local_time, time_zone, repeat, status, next_fire_at, snoozed_until, last_fired_at, needs_attention, created_at, updated_at FROM reminders",
    ).map_err(|error| format!("No se pudieron leer recordatorios para backup: {error}"))?;
    let rows = statement.query_map([], |row| Ok(BackupReminder {
      id: row.get(0)?, note_id: row.get(1)?, local_time: row.get(2)?, time_zone: row.get(3)?, repeat: row.get(4)?, status: row.get(5)?,
      next_fire_at: row.get(6)?, snoozed_until: row.get(7)?, last_fired_at: row.get(8)?, needs_attention: row.get(9)?, created_at: row.get(10)?, updated_at: row.get(11)?,
    })).map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?
  };

  let locks = if connection.prepare("SELECT 1 FROM note_locks LIMIT 0").is_ok() {
    use base64::Engine;
    let encode = |bytes: Vec<u8>| base64::engine::general_purpose::STANDARD.encode(bytes);
    let mut statement = connection.prepare("SELECT note_id, kdf, salt, nonce, ciphertext, attachments, created_at, updated_at FROM note_locks")
      .map_err(|error| error.to_string())?;
    let rows = statement.query_map([], |row| Ok(BackupLock {
      note_id: row.get(0)?, kdf: row.get(1)?, salt: encode(row.get(2)?), nonce: encode(row.get(3)?), ciphertext: encode(row.get(4)?),
      attachments: row.get(5)?, created_at: row.get(6)?, updated_at: row.get(7)?,
    })).map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?
  } else { Vec::new() };

  Ok(BackupPayload {
    version: 6,
    locks,
    folders,
    reminders,
    exported_at: now_unix(),
    notes,
    tags,
    note_tags,
    note_versions,
    note_links,
    attachments: Vec::new(),
  })
}

/// Embeds every image the payload's notes and versions reference. A missing file is skipped:
/// the rest of the backup is still worth keeping.
fn embed_attachments(payload: &mut BackupPayload, db_path: &Path) {
  use base64::Engine;
  let directory = crate::attachments::directory(db_path);
  let mut names = std::collections::BTreeSet::new();
  for note in &payload.notes {
    names.extend(crate::attachments::references(&note.content_md).map(str::to_string));
    names.extend(crate::attachments::references(&note.content_rich_json).map(str::to_string));
  }
  for lock in &payload.locks { names.extend(lock.attachments.split_whitespace().map(str::to_string)); }
  for version in &payload.note_versions {
    names.extend(crate::attachments::references(&version.snapshot_rich_json).map(str::to_string));
    if let Some(markdown) = &version.snapshot_md { names.extend(crate::attachments::references(markdown).map(str::to_string)); }
  }
  payload.attachments = names.into_iter().filter_map(|name| {
    let bytes = crate::attachments::read(&directory, &name).ok()?;
    Some(BackupAttachment { data: base64::engine::general_purpose::STANDARD.encode(bytes), name })
  }).collect();
}

/// Writes a backup's images into the store, verifying each one against its name.
fn restore_attachments(payload: &BackupPayload, db_path: &Path) -> Result<(), String> {
  use base64::Engine;
  let directory = crate::attachments::directory(db_path);
  for attachment in &payload.attachments {
    let bytes = base64::engine::general_purpose::STANDARD.decode(&attachment.data)
      .map_err(|_| format!("Imagen {} dañada en la copia", attachment.name))?;
    crate::attachments::store_expected(&directory, &attachment.name, &bytes)?;
  }
  Ok(())
}

pub fn backup_now(db_path: &Path, backup_dir: &Path) -> Result<PathBuf, String> {
  let mut connection = open_connection(db_path)?;
  let transaction = connection.transaction().map_err(|error| error.to_string())?;
  let mut payload = collect_backup_payload(&transaction)?;
  transaction.commit().map_err(|error| error.to_string())?;
  embed_attachments(&mut payload, db_path);
  let output_path = write_backup_payload(&payload, backup_dir, "backup")?;

  Ok(output_path)
}

fn private_file(path: &Path) -> Result<fs::File, String> {
  let mut options = fs::OpenOptions::new();
  options.write(true).create_new(true);
  #[cfg(unix)]
  {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600);
  }
  options.open(path).map_err(|error| format!("No se pudo crear archivo privado: {error}"))
}

fn publish_file(temporary: &Path, destination: &Path) -> Result<(), String> {
  // A same-directory hard link publishes atomically and cannot replace an existing file.
  fs::hard_link(temporary, destination).map_err(|error| format!("No se pudo publicar copia: {error}"))?;
  fs::remove_file(temporary).map_err(|error| error.to_string())?;
  #[cfg(unix)]
  fs::File::open(destination.parent().ok_or("Ruta sin directorio")?)
    .and_then(|directory| directory.sync_all()).map_err(|error| error.to_string())?;
  Ok(())
}

fn write_backup_payload(payload: &BackupPayload, directory: &Path, prefix: &str) -> Result<PathBuf, String> {
  fs::create_dir_all(directory).map_err(|error| error.to_string())?;
  reject_symlink(directory)?;
  let output = directory.join(format!("{}.json", generate_id(prefix)));
  let temporary = output.with_extension("tmp");
  let bytes = serde_json::to_vec_pretty(payload).map_err(|error| error.to_string())?;
  let mut file = private_file(&temporary)?;
  file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|error| error.to_string())?;
  drop(file);
  publish_file(&temporary, &output)?;
  Ok(output)
}

pub fn recovery_directory(db_path: &Path) -> Result<PathBuf, String> {
  Ok(db_path.parent().ok_or("DB sin directorio")?.join("recovery-backups"))
}

fn preserve_recovery(transaction: &Transaction<'_>, db_path: &Path, reason: &str) -> Result<PathBuf, String> {
  let mut payload = collect_backup_payload(transaction)?;
  embed_attachments(&mut payload, db_path);
  write_backup_payload(&payload, &recovery_directory(db_path)?, reason)
}

fn reject_symlink(path: &Path) -> Result<(), String> {
  let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
  if metadata.file_type().is_symlink() { return Err(format!("No se permiten enlaces simbolicos: {}", path.display())); }
  #[cfg(windows)]
  {
    use std::os::windows::fs::MetadataExt;
    if metadata.file_attributes() & 0x400 != 0 { return Err("No se permiten puntos de reanalisis".into()); }
  }
  Ok(())
}

pub fn list_backups(backup_dir: &Path) -> Result<Vec<PathBuf>, String> {
  let mut backups = fs::read_dir(backup_dir)
    .map_err(|error| format!("No se pudo leer directorio de backups: {error}"))?
    .filter_map(Result::ok)
    .map(|entry| entry.path())
    .filter(|path| {
      path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("json"))
        && fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
    })
    .collect::<Vec<_>>();

  backups.sort();
  backups.reverse();
  Ok(backups)
}

pub fn restore_backup(db_path: &Path, backup_path: &Path) -> Result<(), String> {
  let json = fs::read_to_string(backup_path)
    .map_err(|error| format!("No se pudo leer backup {}: {error}", backup_path.display()))?;

  let payload: BackupPayload =
    serde_json::from_str(&json).map_err(|error| format!("Backup inválido: {error}"))?;
  if !matches!(payload.version, 1..=6) {
    return Err(format!("Version de backup no soportada: {}", payload.version));
  }
  if payload.notes.iter().any(|note| !matches!(note.is_deleted, 0 | 1)) {
    return Err("Backup con estado de papelera invalido".into());
  }
  // Content-addressed and verified: writing them first can never damage existing images.
  restore_attachments(&payload, db_path)?;

  let mut connection = open_connection(db_path)?;
  let transaction = connection
    .transaction_with_behavior(TransactionBehavior::Immediate)
    .map_err(|error| format!("No se pudo abrir transacción restore: {error}"))?;
  preserve_recovery(&transaction, db_path, "recovery-restore")?;

  transaction
    .execute_batch(
      "
      DELETE FROM note_links;
      DELETE FROM note_versions;
      DELETE FROM note_tags;
      DELETE FROM tags;
      DELETE FROM reminders;
      DELETE FROM note_locks;
      DELETE FROM notes;
      DELETE FROM folders;
      PRAGMA defer_foreign_keys = ON;
      ",
    )
    .map_err(|error| format!("No se pudo limpiar DB para restore: {error}"))?;

  // Foreign keys are checked at commit, so folders can arrive in any order.
  for folder in payload.folders {
    transaction
      .execute(
        "INSERT INTO folders (id, name, parent_id, position, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![folder.id, folder.name, folder.parent_id, folder.position, folder.created_at, folder.updated_at],
      )
      .map_err(|error| format!("No se pudo restaurar carpeta: {error}"))?;
  }

  for note in payload.notes {
    transaction
      .execute(
        "INSERT INTO notes (id, title, content_rich_json, content_md, content_plain, created_at, updated_at, is_deleted, deleted_at, folder_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
          note.id,
          note.title,
          note.content_rich_json,
          note.content_md,
          note.content_plain,
          note.created_at,
          note.updated_at,
          note.is_deleted,
          note.deleted_at,
          note.folder_id,
        ],
      )
      .map_err(|error| format!("No se pudo restaurar nota: {error}"))?;
  }

  for reminder in payload.reminders {
    transaction
      .execute(
        "INSERT INTO reminders (id, note_id, local_time, time_zone, repeat, status, next_fire_at, snoozed_until, last_fired_at, needs_attention, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![reminder.id, reminder.note_id, reminder.local_time, reminder.time_zone, reminder.repeat, reminder.status,
          reminder.next_fire_at, reminder.snoozed_until, reminder.last_fired_at, reminder.needs_attention, reminder.created_at, reminder.updated_at],
      )
      .map_err(|error| format!("No se pudo restaurar recordatorio: {error}"))?;
  }

  for tag in payload.tags {
    transaction
      .execute("INSERT INTO tags (id, name) VALUES (?1, ?2)", params![tag.id, tag.name])
      .map_err(|error| format!("No se pudo restaurar tag: {error}"))?;
  }

  for note_tag in payload.note_tags {
    transaction
      .execute(
        "INSERT INTO note_tags (note_id, tag_id) VALUES (?1, ?2)",
        params![note_tag.note_id, note_tag.tag_id],
      )
      .map_err(|error| format!("No se pudo restaurar relación note_tag: {error}"))?;
  }

  for version in payload.note_versions {
    transaction
      .execute(
        "INSERT INTO note_versions (id, note_id, snapshot_rich_json, snapshot_plain, created_at, snapshot_md)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
          version.id,
          version.note_id,
          version.snapshot_rich_json,
          version.snapshot_plain,
          version.created_at,
          version.snapshot_md,
        ],
      )
      .map_err(|error| format!("No se pudo restaurar versión: {error}"))?;
  }

  for lock in payload.locks {
    use base64::Engine;
    let decode = |value: &str| base64::engine::general_purpose::STANDARD.decode(value).map_err(|_| "Nota protegida dañada en la copia".to_string());
    transaction.execute(
      "INSERT INTO note_locks (note_id, kdf, salt, nonce, ciphertext, attachments, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
      params![lock.note_id, lock.kdf, decode(&lock.salt)?, decode(&lock.nonce)?, decode(&lock.ciphertext)?, lock.attachments, lock.created_at, lock.updated_at],
    ).map_err(|error| format!("No se pudo restaurar una nota protegida: {error}"))?;
  }

  for link in payload.note_links {
    transaction
      .execute(
        "INSERT OR IGNORE INTO note_links (from_note_id, to_note_id, link_text) VALUES (?1, ?2, ?3)",
        params![link.from_note_id, link.to_note_id, link.link_text],
      )
      .map_err(|error| format!("No se pudo restaurar link: {error}"))?;
  }

  validate_foreign_keys(&transaction)?;
  transaction
    .commit()
    .map_err(|error| format!("No se pudo confirmar restore: {error}"))?;
  // Keys of notes opened before the restore belong to content that no longer exists.
  locks::relock_all();

  Ok(())
}

fn validate_foreign_keys(connection: &Connection) -> Result<(), String> {
  if connection.prepare("PRAGMA foreign_key_check").map_err(|error| error.to_string())?
    .exists([]).map_err(|error| error.to_string())? {
    return Err("La DB contiene relaciones huerfanas".into());
  }
  Ok(())
}

fn load_notes_for_vault(connection: &Connection) -> Result<Vec<NoteForVault>, String> {
  let mut statement = connection
    .prepare(
      "SELECT id, title, content_md, content_plain, updated_at, folder_id
       FROM notes
       WHERE is_deleted = 0
       ORDER BY updated_at DESC",
    )
    .map_err(|error| format!("No se pudo preparar lectura de notas para vault: {error}"))?;

  let rows = statement
    .query_map([], |row| {
      Ok(NoteForVault {
        id: row.get(0)?,
        title: row.get(1)?,
        content_md: row.get(2)?,
        content_plain: row.get(3)?,
        updated_at: row.get(4)?,
        folder_id: row.get(5)?,
      })
    })
    .map_err(|error| format!("No se pudieron leer notas para vault: {error}"))?;

  rows
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| format!("No se pudo mapear notas para vault: {error}"))
}

fn load_tags_for_note(connection: &Connection, note_id: &str) -> Result<Vec<String>, String> {
  let mut statement = connection
    .prepare(
      "SELECT t.name
       FROM tags t
       JOIN note_tags nt ON nt.tag_id = t.id
       WHERE nt.note_id = ?1
       ORDER BY t.name ASC",
    )
    .map_err(|error| format!("No se pudo preparar query de tags por nota: {error}"))?;

  let rows = statement
    .query_map([note_id], |row| row.get(0))
    .map_err(|error| format!("No se pudieron leer tags por nota: {error}"))?;

  rows
    .collect::<Result<Vec<String>, _>>()
    .map_err(|error| format!("No se pudo mapear tags por nota: {error}"))
}

/// Copies the images `markdown` uses into `target` and points the references at
/// `<link_prefix><name>`, so the exported Markdown opens with its images in any editor.
pub fn export_attachments(markdown: &str, db_path: &Path, target: &Path, link_prefix: &str) -> Result<String, String> {
  let names: std::collections::BTreeSet<&str> = crate::attachments::references(markdown).collect();
  if names.is_empty() { return Ok(markdown.to_string()); }
  let source = crate::attachments::directory(db_path);
  fs::create_dir_all(target).map_err(|error| format!("No se pudo crear la carpeta de imágenes: {error}"))?;
  reject_symlink(target)?;
  let mut output = markdown.to_string();
  for name in names {
    let destination = target.join(name);
    if !destination.exists() {
      let Ok(bytes) = crate::attachments::read(&source, name) else { continue };
      let mut file = private_file(&destination)?;
      file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|error| error.to_string())?;
    }
    output = output.replace(&format!("{}{name}", crate::attachments::REFERENCE_PREFIX), &format!("{link_prefix}{name}"));
  }
  Ok(output)
}

/// Turns relative links to exported images (`attachments/<name>`, `../attachments/<name>`) back
/// into managed references, importing each file after checking it matches its name. Links that
/// leave the imported folder, or whose file is missing or invalid, are left untouched.
fn import_attachments(markdown: &str, note_file: &Path, root: &Path, db_path: &Path) -> Result<String, String> {
  const MARKER: &str = "attachments/";
  if !markdown.contains(MARKER) { return Ok(markdown.to_string()); }
  let store = crate::attachments::directory(db_path);
  let root = root.canonicalize().map_err(|error| error.to_string())?;
  let base = note_file.parent().unwrap_or(&root);
  let mut output = String::with_capacity(markdown.len());
  let mut rest = markdown;
  while let Some(index) = rest.find(MARKER) {
    let before = &rest[..index];
    let prefix_len = ["../", "./"].iter().find(|prefix| before.ends_with(**prefix)).map(|prefix| prefix.len()).unwrap_or(0);
    let opener = before[..before.len() - prefix_len].chars().last();
    let after = &rest[index + MARKER.len()..];
    let name = ["png", "jpg", "gif", "webp"].iter()
      .find_map(|extension| after.get(..65 + extension.len()).filter(|candidate| crate::attachments::is_valid_name(candidate)));
    let imported = match (opener, name) {
      (Some('(') | Some('<'), Some(name)) => {
        let relative = format!("{}{MARKER}{name}", &before[before.len() - prefix_len..]);
        base.join(&relative).canonicalize().ok()
          .filter(|path| path.starts_with(&root))
          .filter(|path| fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_file() && metadata.len() as usize <= crate::attachments::MAX_BYTES))
          .and_then(|path| fs::read(path).ok())
          .and_then(|bytes| crate::attachments::store_expected(&store, name, &bytes).ok())
          .map(|_| name)
      }
      _ => None,
    };
    match imported {
      Some(name) => {
        output.push_str(&before[..before.len() - prefix_len]);
        output.push_str(crate::attachments::REFERENCE_PREFIX);
        output.push_str(name);
        rest = &after[name.len()..];
      }
      None => {
        output.push_str(&rest[..index + MARKER.len()]);
        rest = after;
      }
    }
  }
  output.push_str(rest);
  Ok(output)
}

pub fn export_vault_to_directory(db_path: &Path, directory: &Path) -> Result<usize, String> {
  let connection = open_connection(db_path)?;
  let notes = load_notes_for_vault(&connection)?;

  let notes_dir = directory.join("notes");
  fs::create_dir_all(&notes_dir)
    .map_err(|error| format!("No se pudo crear carpeta notes/ en vault: {error}"))?;
  reject_symlink(directory)?;
  reject_symlink(&notes_dir)?;

  let mut index = BTreeMap::new();

  for note in notes {
    let tags = load_tags_for_note(&connection, &note.id)?;
    if note.id.len() > 96 { return Err("ID demasiado largo para exportar de forma portable".into()); }
    let encoded_id = note.id.as_bytes().iter().map(|byte| format!("{byte:02x}")).collect::<String>();
    let filename = format!("note-{encoded_id}.md");
    let filepath = notes_dir.join(filename);

    let markdown_body = if locks::is_locked(&connection, &note.id)? {
      // Only the title leaves the app; the encrypted content stays in backups.
      "*Nota protegida con contraseña: su contenido no se exporta.*".to_string()
    } else if note.content_md.trim().is_empty() {
      note.content_plain.clone()
    } else {
      export_attachments(&note.content_md, db_path, &directory.join("attachments"), "../attachments/")?
    };

    let folder = match note.folder_id.as_deref() {
      Some(id) => format!("folder: {}\n", serde_json::to_string(&folders::folder_path(&connection, id)?).map_err(|error| error.to_string())?),
      None => String::new(),
    };
    let frontmatter = format!(
      "---\nid: {}\ntitle: {}\ntags: {}\n{folder}updated_at: {}\n---\n\n",
      serde_json::to_string(&note.id).map_err(|error| error.to_string())?,
      serde_json::to_string(&note.title).map_err(|error| error.to_string())?,
      serde_json::to_string(&tags).map_err(|error| error.to_string())?,
      note.updated_at
    );

    let file_content = format!("{}{}", frontmatter, markdown_body);

    // Refuse to overwrite stale exports or follow a planted file symlink.
    let mut file = private_file(&filepath)?;
    file.write_all(file_content.as_bytes()).and_then(|_| file.sync_all())
      .map_err(|error| format!("No se pudo escribir nota exportada {}: {error}", filepath.display()))?;

    index.insert(note.id.clone(), format!("notes/note-{encoded_id}.md"));
  }

  let index_path = directory.join("index.json");
  let index_json = serde_json::to_string_pretty(&index)
    .map_err(|error| format!("No se pudo serializar index.json de vault: {error}"))?;
  let mut file = private_file(&index_path)?;
  file.write_all(index_json.as_bytes()).and_then(|_| file.sync_all()).map_err(|error| error.to_string())?;

  Ok(index.len())
}

fn recursive_note_files(root: &Path, output: &mut Vec<PathBuf>) -> Result<(), String> {
  scan_note_files(root, output, 0)
}

fn scan_note_files(root: &Path, output: &mut Vec<PathBuf>, depth: usize) -> Result<(), String> {
  if depth > 64 { return Err("Vault demasiado profundo".into()); }
  reject_symlink(root)?;
  for entry in fs::read_dir(root).map_err(|error| format!("No se pudo leer directorio {}: {error}", root.display()))? {
    let entry = entry.map_err(|error| format!("No se pudo leer entrada de directorio: {error}"))?;
    let path = entry.path();
    reject_symlink(&path)?;

    if path.is_dir() {
      scan_note_files(&path, output, depth + 1)?;
      continue;
    }

    let extension = path
      .extension()
      .and_then(|value| value.to_str())
      .unwrap_or_default()
      .to_lowercase();

    if extension == "md" || extension == "txt" {
      if output.len() >= 10_000 { return Err("Vault con demasiados archivos".into()); }
      output.push(path);
    }
  }

  Ok(())
}

pub fn import_vault_from_directory(db_path: &Path, directory: &Path) -> Result<usize, String> {
  let mut files = Vec::new();
  recursive_note_files(directory, &mut files)?;
  files.sort();

  let mut connection = open_connection(db_path)?;
  let transaction = connection
    .transaction_with_behavior(TransactionBehavior::Immediate)
    .map_err(|error| format!("No se pudo abrir transacción para importar vault: {error}"))?;
  preserve_recovery(&transaction, db_path, "recovery-import")?;

  let mut imported_count = 0usize;

  for file in files {
    reject_symlink(&file)?;
    if fs::metadata(&file).map_err(|error| error.to_string())?.len() > 8 * 1024 * 1024 {
      return Err("Nota de importacion demasiado grande".into());
    }
    let raw = fs::read_to_string(&file)
      .map_err(|error| format!("No se pudo leer archivo de vault {}: {error}", file.display()))?;

    let VaultDocument { id: frontmatter_id, title: metadata_title, tags, folder, body } = parse_vault_document(&raw);

    let title = metadata_title.or_else(|| body
      .lines()
      .find_map(|line| line.strip_prefix("# ").map(str::to_string)))
      .unwrap_or_else(|| {
        file
          .file_stem()
          .and_then(|value| value.to_str())
          .unwrap_or("Imported note")
          .to_string()
      });

    let content_md = import_attachments(&body, &file, directory, db_path)?;
    let content_plain = markdown_to_plain(&content_md);
    let rich_json = format!(
      "{{\"type\":\"doc\",\"content\":[{{\"type\":\"paragraph\",\"content\":[{{\"type\":\"text\",\"text\":{}}}]}}]}}",
      serde_json::to_string(&content_plain)
        .map_err(|error| format!("No se pudo serializar texto plano a rich_json: {error}"))?
    );

    let note_id = frontmatter_id.unwrap_or_else(|| generate_id("vault"));

    let existing: Option<String> = transaction
      .query_row("SELECT id FROM notes WHERE id = ?1", [note_id.as_str()], |row| row.get(0))
      .optional()
      .map_err(|error| format!("No se pudo verificar existencia de nota importada: {error}"))?;

    // A protected note is never overwritten by an import (its export holds only a placeholder).
    if existing.is_some() && locks::is_locked(&transaction, &note_id)? { continue; }

    if existing.is_some() {
      transaction
        .execute(
          "UPDATE notes SET title = ?1, content_rich_json = ?2, content_md = ?3, content_plain = ?4, updated_at = ?5, is_deleted = 0, deleted_at = NULL WHERE id = ?6",
          params![title, rich_json, content_md, content_plain, now_unix(), note_id],
        )
        .map_err(|error| format!("No se pudo actualizar nota importada: {error}"))?;
    } else {
      let now = now_unix();
      transaction
        .execute(
          "INSERT INTO notes (id, title, content_rich_json, content_md, content_plain, created_at, updated_at, is_deleted, deleted_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, NULL)",
          params![note_id, title, rich_json, content_md, content_plain, now, now],
        )
        .map_err(|error| format!("No se pudo crear nota importada: {error}"))?;
    }

    if !folder.is_empty() {
      let folder_id = folders::ensure_folder_path(&transaction, &folder)?;
      transaction.execute("UPDATE notes SET folder_id=?1 WHERE id=?2", params![folder_id, note_id])
        .map_err(|error| format!("No se pudo asignar la carpeta importada: {error}"))?;
    }
    set_note_tags(&transaction, &note_id, &tags)?;

    let current_rich: String = transaction
      .query_row(
        "SELECT content_rich_json FROM notes WHERE id = ?1",
        [note_id.as_str()],
        |row| row.get(0),
      )
      .map_err(|error| format!("No se pudo leer rich_json tras importación: {error}"))?;

    let current_plain: String = transaction
      .query_row(
        "SELECT content_plain FROM notes WHERE id = ?1",
        [note_id.as_str()],
        |row| row.get(0),
      )
      .map_err(|error| format!("No se pudo leer plain tras importación: {error}"))?;

    insert_note_version(&transaction, &note_id, &current_rich, &current_plain)?;

    imported_count += 1;
  }

  refresh_all_links(&transaction)?;
  validate_foreign_keys(&transaction)?;

  transaction
    .commit()
    .map_err(|error| format!("No se pudo confirmar importación de vault: {error}"))?;

  Ok(imported_count)
}

#[cfg(test)]
mod regression_tests;

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn db_self_check_smoke() {
    let marker = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .expect("system time")
      .as_nanos();

    let db_path = std::env::temp_dir().join(format!("scribedock-self-check-{marker}.db"));

    let connection = Connection::open(&db_path).expect("create disposable test database");
    for migration in migrations::sqlite_migrations() {
      connection.execute_batch(migration.sql).expect("explicit test schema initialization");
    }
    drop(connection);

    let result = run_self_check_on_path(&db_path);

    if db_path.exists() {
      let _ = std::fs::remove_file(&db_path);
    }

    assert!(result.is_ok(), "self-check failed: {result:?}")
  }
}
