use std::path::{Path, PathBuf};

use tauri_plugin_dialog::{DialogExt, FilePath};

use crate::attachments;
use crate::db;
use crate::reminders;

static NOTIFIED_TITLES: std::sync::Mutex<std::collections::BTreeMap<String, String>> = std::sync::Mutex::new(std::collections::BTreeMap::new());

/// Rebuilds native reminder requests off the calling thread; failures are logged, not fatal.
fn resync_reminders(app: &tauri::AppHandle) {
  let Ok(path) = db::database_path(app) else { return };
  std::thread::spawn(move || {
    if let Err(error) = reminders::resync(&path) { log::warn!("No se pudieron reprogramar los recordatorios: {error}"); }
  });
}

#[tauri::command]
pub fn save_note(app: tauri::AppHandle, note_id: Option<String>, draft: db::SaveNoteDraft) -> Result<String, String> {
  let path = db::database_path(&app)?;
  // An open protected note is re-encrypted with the key kept since it was unlocked.
  if let Some(id) = note_id.as_deref() {
    if db::locks::is_locked(&db::open_reminders_connection(&path)?, id)? {
      db::locks::save_locked_on_path(&path, id, &draft)?;
      return Ok(id.to_string());
    }
  }
  let id = db::save_note_on_path(&path, note_id.as_deref(), &draft)?;
  // Notification titles follow the note title; autosaves that keep the title do nothing.
  let title = draft.title.trim().to_string();
  let renamed = NOTIFIED_TITLES.lock().map(|mut titles| titles.insert(id.clone(), title.clone()) != Some(title)).unwrap_or(false);
  if note_id.is_some() && renamed && db::open_reminders_connection(&path).ok()
    .and_then(|connection| db::note_has_reminder(&connection, &id).ok()).unwrap_or(false) {
    resync_reminders(&app);
  }
  Ok(id)
}

#[tauri::command]
pub fn restore_version(app: tauri::AppHandle, note_id: String, version_id: String) -> Result<(), String> {
  db::restore_version_on_path(&db::database_path(&app)?, &note_id, &version_id)?;
  Ok(())
}

#[tauri::command]
pub fn move_to_trash(app: tauri::AppHandle, note_id: String) -> Result<(), String> {
  db::change_note_state_on_path(&db::database_path(&app)?, &note_id, db::NoteAction::Trash)?;
  resync_reminders(&app);
  Ok(())
}

#[tauri::command]
pub fn restore_note(app: tauri::AppHandle, note_id: String) -> Result<(), String> {
  db::change_note_state_on_path(&db::database_path(&app)?, &note_id, db::NoteAction::Restore)?;
  resync_reminders(&app);
  Ok(())
}

#[tauri::command]
pub fn delete_note_permanently(app: tauri::AppHandle, note_id: String) -> Result<(), String> {
  db::change_note_state_on_path(&db::database_path(&app)?, &note_id, db::NoteAction::Delete)?;
  resync_reminders(&app);
  Ok(())
}

#[tauri::command]
pub fn create_folder(app: tauri::AppHandle, name: String, parent_id: Option<String>) -> Result<String, String> {
  db::create_folder_on_path(&db::database_path(&app)?, &name, parent_id.as_deref())
}

#[tauri::command]
pub fn rename_folder(app: tauri::AppHandle, folder_id: String, name: String) -> Result<(), String> {
  db::rename_folder_on_path(&db::database_path(&app)?, &folder_id, &name)
}

#[tauri::command]
pub fn move_folder(app: tauri::AppHandle, folder_id: String, parent_id: Option<String>) -> Result<(), String> {
  db::move_folder_on_path(&db::database_path(&app)?, &folder_id, parent_id.as_deref())
}

#[tauri::command]
pub fn delete_folder(app: tauri::AppHandle, folder_id: String) -> Result<(), String> {
  db::delete_folder_on_path(&db::database_path(&app)?, &folder_id)
}

#[tauri::command]
pub fn move_note_to_folder(app: tauri::AppHandle, note_id: String, folder_id: Option<String>) -> Result<(), String> {
  db::move_note_to_folder_on_path(&db::database_path(&app)?, &note_id, folder_id.as_deref())
}

#[tauri::command]
pub fn self_check(app: tauri::AppHandle) -> Result<String, String> {
  let db_path = db::database_path(&app)?;
  db::run_self_check_on_path(&db_path)
}

#[tauri::command]
pub fn export_note_markdown(app: tauri::AppHandle, note_id: String) -> Result<String, String> {
  let db_path = db::database_path(&app)?;
  let (title, content_md) = db::get_note_for_export(&db_path, &note_id)?;

  let suggested_file_name = format!("{}.md", sanitize_file_stem(&title));

  let selected_path = app
    .dialog()
    .file()
    .add_filter("Markdown", &["md"])
    .set_file_name(suggested_file_name)
    .blocking_save_file();

  let Some(selected_path) = selected_path else {
    return Err("Exportación cancelada".to_string());
  };

  let output_path = file_path_to_path_buf(selected_path)?;

  if !has_markdown_extension(&output_path) {
    return Err("La ruta seleccionada debe terminar en .md".to_string());
  }

  // Images go to a sibling folder named after the file, linked relatively.
  let stem = output_path.file_stem().and_then(|value| value.to_str()).unwrap_or("nota").to_string();
  let images_folder = format!("{stem} imágenes");
  let parent = output_path.parent().ok_or("Ruta de exportación sin carpeta")?;
  let content_md = db::export_attachments(&content_md, &db_path, &parent.join(&images_folder), &format!("{}/", images_folder.replace(' ', "%20")))?;
  let output_content = if title.trim().is_empty() {
    content_md
  } else {
    format!("# {}\n\n{}", title.trim(), content_md)
  };

  std::fs::write(&output_path, output_content)
    .map_err(|error| format!("No se pudo escribir el archivo exportado: {error}"))?;

  Ok(format!("Exportado en {}", output_path.display()))
}

fn attachments_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  Ok(attachments::directory(&db::database_path(app)?))
}

/// Stores an image sent as the raw request body (paste, drop) and returns its reference name.
#[tauri::command]
pub async fn save_attachment(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
  let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("Se esperaban los bytes de la imagen".into()) };
  attachments::store(&attachments_directory(&app)?, bytes)
}

/// Lets the person choose images with the system dialog; the files are read here, in Rust.
#[tauri::command]
pub async fn pick_images(app: tauri::AppHandle) -> Result<Vec<String>, String> {
  let Some(selected) = app.dialog().file().add_filter("Imágenes", &["png", "jpg", "jpeg", "gif", "webp"]).blocking_pick_files() else {
    return Ok(Vec::new());
  };
  let directory = attachments_directory(&app)?;
  let mut names = Vec::new();
  let mut errors = Vec::new();
  for file in selected.into_iter().take(20) {
    let path = file_path_to_path_buf(file)?;
    let result = std::fs::metadata(&path).map_err(|error| error.to_string())
      .and_then(|metadata| if metadata.len() as usize > attachments::MAX_BYTES { Err(format!("La imagen supera el límite de {} MB", attachments::MAX_BYTES / 1024 / 1024)) } else { Ok(()) })
      .and_then(|_| std::fs::read(&path).map_err(|error| error.to_string()))
      .and_then(|bytes| attachments::store(&directory, &bytes));
    match result { Ok(name) => names.push(name), Err(error) => errors.push(error) }
  }
  if names.is_empty() { if let Some(error) = errors.into_iter().next() { return Err(error); } }
  Ok(names)
}

/// The bytes of a stored image (Word export embeds them).
#[tauri::command]
pub async fn read_attachment(app: tauri::AppHandle, name: String) -> Result<tauri::ipc::Response, String> {
  Ok(tauri::ipc::Response::new(attachments::read(&attachments_directory(&app)?, &name)?))
}

/// Serves `mazmi-attachment://localhost/<name>`: read-only, validated names, immutable content.
pub fn serve_attachment(app: &tauri::AppHandle, path: &str) -> tauri::http::Response<Vec<u8>> {
  let name = path.trim_start_matches('/');
  let response = tauri::http::Response::builder().header("X-Content-Type-Options", "nosniff");
  match attachments_directory(app).and_then(|directory| attachments::read(&directory, name)) {
    Ok(bytes) => response.status(200).header("Content-Type", attachments::mime(name))
      .header("Cache-Control", "max-age=31536000, immutable").body(bytes),
    Err(_) => response.status(404).body(Vec::new()),
  }
  .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}

/// Removes unused images in the background: shortly after launch, then every six hours.
pub fn start_attachment_cleanup(app: tauri::AppHandle) {
  std::thread::spawn(move || {
    std::thread::sleep(std::time::Duration::from_secs(45));
    loop {
      match db::database_path(&app).and_then(|path| db::remove_orphan_attachments(&path, attachments::ORPHAN_GRACE)) {
        Ok(0) => {}
        Ok(removed) => log::info!("Imágenes sin usar eliminadas: {removed}"),
        Err(error) => log::warn!("Limpieza de imágenes: {error}"),
      }
      std::thread::sleep(std::time::Duration::from_secs(6 * 3600));
    }
  });
}

/// Protects a note with a password (its history is deleted: it holds the content in clear).
#[tauri::command]
pub async fn lock_note(app: tauri::AppHandle, note_id: String, password: String) -> Result<(), String> {
  let path = db::database_path(&app)?;
  let password = zeroize::Zeroizing::new(password);
  tauri::async_runtime::spawn_blocking(move || db::locks::lock_on_path(&path, &note_id, &password)).await.map_err(|error| error.to_string())?
}

/// Opens a protected note: its content, and the key kept while it stays open.
#[tauri::command]
pub async fn unlock_note(app: tauri::AppHandle, note_id: String, password: String) -> Result<db::locks::LockedContent, String> {
  let path = db::database_path(&app)?;
  let password = zeroize::Zeroizing::new(password);
  // Argon2id is deliberately slow (and wrong attempts wait longer): off the async threads.
  tauri::async_runtime::spawn_blocking(move || db::locks::unlock_on_path(&path, &note_id, &password)).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn remove_note_lock(app: tauri::AppHandle, note_id: String, password: String) -> Result<db::locks::LockedContent, String> {
  let path = db::database_path(&app)?;
  let password = zeroize::Zeroizing::new(password);
  tauri::async_runtime::spawn_blocking(move || db::locks::remove_lock_on_path(&path, &note_id, &password)).await.map_err(|error| error.to_string())?
}

/// Forgets the key of a note that was left (it shows the lock screen again next time).
#[tauri::command]
pub fn relock_note(note_id: String) {
  db::locks::relock(&note_id);
}

/// Largest Word export accepted from the frontend (the document is generated there).
const MAX_DOCX_BYTES: usize = 64 * 1024 * 1024;

#[tauri::command]
pub async fn export_note_docx(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
  // Raw body: a document with images would be tens of MB as a JSON array.
  let tauri::ipc::InvokeBody::Raw(document) = request.body() else { return Err("Se esperaba el documento".into()) };
  let note_id = request.headers().get("x-note-id").and_then(|value| value.to_str().ok())
    .filter(|value| !value.is_empty() && value.len() < 200).ok_or("Falta la nota a exportar")?.to_string();
  validate_docx_payload(document)?;
  let db_path = db::database_path(&app)?;
  let (title, _) = db::get_note_for_export(&db_path, &note_id)?;

  let selected_path = app
    .dialog()
    .file()
    .add_filter("Documento de Word", &["docx"])
    .set_file_name(format!("{}.docx", sanitize_file_stem(&title)))
    .blocking_save_file();
  let Some(selected_path) = selected_path else {
    return Err("Exportación cancelada".to_string());
  };
  let output_path = file_path_to_path_buf(selected_path)?;
  if !has_extension(&output_path, "docx") {
    return Err("La ruta seleccionada debe terminar en .docx".to_string());
  }
  std::fs::write(&output_path, document)
    .map_err(|error| format!("No se pudo escribir el archivo exportado: {error}"))?;
  Ok(format!("Exportado en {}", output_path.display()))
}

/// The frontend only ever sends an OOXML package: a ZIP that starts with a local file header.
fn validate_docx_payload(document: &[u8]) -> Result<(), String> {
  if document.len() > MAX_DOCX_BYTES {
    return Err("El documento es demasiado grande para exportarlo".to_string());
  }
  if !document.starts_with(b"PK\x03\x04") {
    return Err("El documento de Word generado no es válido".to_string());
  }
  Ok(())
}

#[tauri::command]
pub fn backup_now(app: tauri::AppHandle) -> Result<String, String> {
  let db_path = db::database_path(&app)?;
  let backup_dir = db::backup_directory(&app)?;
  let backup_path = db::backup_now(&db_path, &backup_dir)?;
  Ok(format!("Copia de seguridad creada en {}", backup_path.display()))
}

#[tauri::command]
pub fn list_backups(app: tauri::AppHandle) -> Result<Vec<String>, String> {
  let backup_dir = db::backup_directory(&app)?;
  let recovery_dir = db::recovery_directory(&db::database_path(&app)?)?;
  let backups = db::list_managed_backups(&backup_dir, &recovery_dir)?;
  Ok(backups
    .into_iter()
    .map(|path| path.to_string_lossy().to_string())
    .collect())
}

#[tauri::command]
pub fn restore_backup(app: tauri::AppHandle, backup_file: Option<String>) -> Result<String, String> {
  let db_path = db::database_path(&app)?;
  let backup_dir = db::backup_directory(&app)?;

  let recovery_dir = db::recovery_directory(&db_path)?;
  let target_path = db::resolve_managed_backup(&backup_dir, &recovery_dir, backup_file.as_deref())?;

  db::restore_backup(&db_path, &target_path)?;
  resync_reminders(&app);
  Ok(format!("Biblioteca restaurada desde la copia {}", target_path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default()))
}

#[tauri::command]
pub fn export_vault(app: tauri::AppHandle) -> Result<String, String> {
  let db_path = db::database_path(&app)?;

  let selected_path = app.dialog().file().blocking_pick_folder();
  let Some(selected_path) = selected_path else {
    return Err("Exportación de vault cancelada".to_string());
  };

  let output_dir = file_path_to_path_buf(selected_path)?;
  std::fs::create_dir_all(&output_dir)
    .map_err(|error| format!("No se pudo preparar carpeta de exportación: {error}"))?;

  let exported = db::export_vault_to_directory(&db_path, &output_dir)?;
  Ok(format!("{} notas exportadas en {}", exported, output_dir.display()))
}

#[tauri::command]
pub fn import_vault(app: tauri::AppHandle) -> Result<String, String> {
  let db_path = db::database_path(&app)?;

  let selected_path = app.dialog().file().blocking_pick_folder();
  let Some(selected_path) = selected_path else {
    return Err("Importación de vault cancelada".to_string());
  };

  let input_dir = file_path_to_path_buf(selected_path)?;
  if !Path::new(&input_dir).exists() {
    return Err("La carpeta seleccionada no existe".to_string());
  }

  let imported = db::import_vault_from_directory(&db_path, &input_dir)?;
  resync_reminders(&app);
  Ok(format!("Importación completada: {} archivos", imported))
}

fn sanitize_file_stem(title: &str) -> String {
  let cleaned = title
    .trim()
    .chars()
    .map(|ch| match ch {
      '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
      _ => ch,
    })
    .collect::<String>();

  if cleaned.is_empty() {
    "nota".to_string()
  } else {
    cleaned
  }
}

fn has_markdown_extension(path: &Path) -> bool {
  has_extension(path, "md")
}

fn has_extension(path: &Path, extension: &str) -> bool {
  path.extension()
    .and_then(|value| value.to_str())
    .is_some_and(|value| value.eq_ignore_ascii_case(extension))
}

fn file_path_to_path_buf(path: FilePath) -> Result<PathBuf, String> {
  match path {
    FilePath::Path(path_buf) => Ok(path_buf),
    FilePath::Url(url) => url
      .to_file_path()
      .map_err(|_| "No se pudo convertir la ruta a ruta local".to_string()),
  }
}

#[cfg(test)]
mod docx_export_tests {
  use super::*;

  #[test]
  fn accepts_only_zip_packages_within_the_size_limit() {
    assert!(validate_docx_payload(b"PK\x03\x04rest").is_ok());
    assert!(validate_docx_payload(b"<html>").is_err());
    assert!(validate_docx_payload(&[]).is_err());
    assert!(has_extension(Path::new("/tmp/nota.DOCX"), "docx"));
    assert!(!has_extension(Path::new("/tmp/nota.docx.md"), "docx"));
  }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderChange {
  reminder: Option<db::ReminderRecord>,
  permission: reminders::Permission,
}

fn after_reminder_change(app: &tauri::AppHandle, reminder: Option<db::ReminderRecord>) -> Result<ReminderChange, String> {
  let path = db::database_path(app)?;
  if let Err(error) = reminders::resync(&path) { log::warn!("No se pudieron programar los recordatorios: {error}"); }
  let _ = tauri::Emitter::emit(app, reminders::CHANGED_EVENT, ());
  Ok(ReminderChange { reminder, permission: reminders::capabilities().permission })
}

#[tauri::command]
pub async fn list_reminders(app: tauri::AppHandle) -> Result<Vec<db::ReminderRecord>, String> {
  let path = db::database_path(&app)?;
  db::list_reminders(&db::open_reminders_connection(&path)?)
}

#[tauri::command]
pub async fn set_reminder(app: tauri::AppHandle, note_id: String, local_time: String, time_zone: String, repeat: String) -> Result<ReminderChange, String> {
  // The system prompt appears the first time a reminder is created, not at startup.
  if reminders::capabilities().permission == reminders::Permission::Unknown {
    if let Err(error) = reminders::request_permission() { log::warn!("{error}"); }
  }
  let record = db::set_reminder_on_path(&db::database_path(&app)?, &note_id, &local_time, &time_zone, &repeat, chrono::Utc::now())?;
  after_reminder_change(&app, Some(record))
}

#[tauri::command]
pub async fn clear_reminder(app: tauri::AppHandle, note_id: String) -> Result<ReminderChange, String> {
  if let Some(id) = db::clear_reminder_on_path(&db::database_path(&app)?, &note_id)? { reminders::clear_delivered(&id); }
  after_reminder_change(&app, None)
}

#[tauri::command]
pub async fn snooze_reminder(app: tauri::AppHandle, note_id: String, minutes: i64) -> Result<ReminderChange, String> {
  let record = db::snooze_reminder_on_path(&db::database_path(&app)?, &note_id, minutes, chrono::Utc::now())?;
  reminders::clear_delivered(&record.id);
  after_reminder_change(&app, Some(record))
}

#[tauri::command]
pub async fn complete_reminder(app: tauri::AppHandle, note_id: String) -> Result<ReminderChange, String> {
  let record = db::complete_reminder_on_path(&db::database_path(&app)?, &note_id, chrono::Utc::now())?;
  if let Some(record) = &record { reminders::clear_delivered(&record.id); }
  after_reminder_change(&app, record)
}

#[tauri::command]
pub async fn reminder_capabilities() -> reminders::Capabilities {
  reminders::capabilities()
}

#[tauri::command]
pub async fn request_reminder_permission() -> Result<reminders::Permission, String> {
  reminders::request_permission()
}

#[tauri::command]
pub fn take_pending_open_note() -> Option<String> {
  reminders::take_pending_open()
}
