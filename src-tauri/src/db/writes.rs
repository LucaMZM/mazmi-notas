use super::*;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveNoteDraft {
  pub title: String,
  pub content_rich_json: String,
  pub content_md: String,
  pub content_plain: String,
  pub tags: Vec<String>,
  /// Only used when creating a note; moving notes has its own command.
  #[serde(default)]
  pub folder_id: Option<String>,
}

pub enum NoteAction { Trash, Restore, Delete }

/// Autosave runs about once per second while typing. Instead of two full snapshots per save,
/// an edit records the state it starts from only when the note has no version from the last
/// few minutes: one restore point per writing session (and every few minutes of continuous
/// writing). Existing versions are never modified; the current content lives in `notes`.
pub const VERSION_SESSION_SECONDS: i64 = 300;

pub fn save_note_on_path(path: &Path, id: Option<&str>, draft: &SaveNoteDraft) -> Result<String, String> {
  if draft.content_rich_json.len() + draft.content_md.len() + draft.content_plain.len() > 24 * 1024 * 1024
    || draft.tags.len() > 200 || draft.title.len() > 4096 {
    return Err("Nota demasiado grande".into());
  }
  let rich: serde_json::Value = serde_json::from_str(&draft.content_rich_json)
    .map_err(|error| format!("Documento rich invalido: {error}"))?;
  if rich.get("type").and_then(|v| v.as_str()) != Some("doc") || !rich.get("content").is_some_and(|v| v.is_array()) {
    return Err("Se requiere un documento rich valido".into());
  }
  let mut connection = open_connection(path)?;
  let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
  let note_id = id.map(str::to_owned).unwrap_or_else(|| generate_id("note"));
  let now = now_unix();
  if id.is_some() {
    if latest_session_version(&transaction, &note_id, now)?.is_none() { snapshot_current_if_new(&transaction, &note_id)?; }
    let changed = transaction.execute(
      "UPDATE notes SET title=?1,content_rich_json=?2,content_md=?3,content_plain=?4,updated_at=?5 WHERE id=?6 AND is_deleted=0",
      params![draft.title.trim(), draft.content_rich_json, draft.content_md, draft.content_plain, now, note_id],
    ).map_err(|error| error.to_string())?;
    if changed != 1 { return Err("Nota no encontrada o en papelera".into()); }
  } else {
    let folder = match draft.folder_id.as_deref() {
      Some(folder) => transaction.query_row("SELECT id FROM folders WHERE id=?1", [folder], |row| row.get::<_, String>(0))
        .optional().map_err(|error| error.to_string())?,
      None => None,
    };
    transaction.execute(
      "INSERT INTO notes (id,title,content_rich_json,content_md,content_plain,created_at,updated_at,is_deleted,deleted_at,folder_id)
       VALUES (?1,?2,?3,?4,?5,?6,?6,0,NULL,?7)",
      params![note_id, draft.title.trim(), draft.content_rich_json, draft.content_md, draft.content_plain, now, folder],
    ).map_err(|error| error.to_string())?;
  }
  set_note_tags(&transaction, &note_id, &draft.tags)?;
  refresh_all_links(&transaction)?;
  // A new note starts its history with its first content.
  if id.is_none() { insert_note_version(&transaction, &note_id, &draft.content_rich_json, &draft.content_plain)?; }
  transaction.commit().map_err(|error| error.to_string())?;
  Ok(note_id)
}

/// The newest version of the note when it was created inside the current writing session.
fn latest_session_version(transaction: &Transaction<'_>, id: &str, now: i64) -> Result<Option<String>, String> {
  transaction.query_row(
    "SELECT id FROM note_versions WHERE note_id=?1 AND created_at>=?2 ORDER BY created_at DESC, rowid DESC LIMIT 1",
    params![id, now - VERSION_SESSION_SECONDS],
    |row| row.get(0),
  ).optional().map_err(|error| error.to_string())
}

/// Records the current state unless the newest version already holds exactly that content.
fn snapshot_current_if_new(transaction: &Transaction<'_>, id: &str) -> Result<(), String> {
  let unchanged: bool = transaction.query_row(
    "SELECT EXISTS(SELECT 1 FROM notes n JOIN (SELECT * FROM note_versions WHERE note_id=?1 ORDER BY created_at DESC, rowid DESC LIMIT 1) v
       ON v.note_id=n.id WHERE n.id=?1 AND v.snapshot_rich_json=n.content_rich_json AND v.snapshot_plain=n.content_plain
       AND v.snapshot_md IS n.content_md)",
    [id], |row| row.get(0),
  ).map_err(|error| error.to_string())?;
  if unchanged { Ok(()) } else { snapshot_current(transaction, id) }
}

fn snapshot_current(transaction: &Transaction<'_>, id: &str) -> Result<(), String> {
  let (rich, plain): (String, String) = transaction.query_row(
    "SELECT content_rich_json,content_plain FROM notes WHERE id=?1 AND is_deleted=0", [id],
    |row| Ok((row.get(0)?, row.get(1)?)),
  ).map_err(|error| format!("Nota no encontrada o en papelera: {error}"))?;
  insert_note_version(transaction, id, &rich, &plain)
}

pub fn restore_version_on_path(path: &Path, id: &str, version: &str) -> Result<(), String> {
  let mut connection = open_connection(path)?;
  let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
  let (rich, plain, markdown): (String, String, Option<String>) = transaction.query_row(
    "SELECT snapshot_rich_json,snapshot_plain,snapshot_md FROM note_versions WHERE id=?1 AND note_id=?2",
    params![version,id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
  ).map_err(|error| format!("Version no encontrada: {error}"))?;
  snapshot_current(&transaction, id)?;
  // A legacy snapshot has no recoverable Markdown. Keep its rich document and use its recorded plain text.
  let markdown = markdown.unwrap_or_else(|| plain.clone());
  transaction.execute(
    "UPDATE notes SET content_rich_json=?1,content_plain=?2,content_md=?3,updated_at=?4 WHERE id=?5",
    params![rich, plain, markdown, now_unix(), id],
  ).map_err(|error| error.to_string())?;
  refresh_all_links(&transaction)?;
  insert_note_version(&transaction, id, &rich, &plain)?;
  transaction.commit().map_err(|error| error.to_string())
}

pub fn change_note_state_on_path(path: &Path, id: &str, action: NoteAction) -> Result<(), String> {
  let mut connection = open_connection(path)?;
  let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
  let query = match action {
    NoteAction::Trash => "UPDATE notes SET is_deleted=1,deleted_at=?2,updated_at=?2 WHERE id=?1 AND is_deleted=0",
    NoteAction::Restore => "UPDATE notes SET is_deleted=0,deleted_at=NULL,updated_at=?2 WHERE id=?1 AND is_deleted=1",
    NoteAction::Delete => "DELETE FROM notes WHERE id=?1 AND is_deleted=1 AND ?2>=0",
  };
  let changed = transaction.execute(query, params![id,now_unix()]).map_err(|error| error.to_string())?;
  if changed != 1 { return Err("Nota no encontrada o estado no permitido".into()); }
  refresh_all_links(&transaction)?;
  transaction.commit().map_err(|error| error.to_string())
}
