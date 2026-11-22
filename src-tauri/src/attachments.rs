//! Images attached to notes.
//!
//! Files live next to the database in `attachments/`, named by the SHA-256 of their bytes
//! (`<64 hex>.<ext>`): references are stable, identical images are stored once and a name can
//! never point at different content. Notes reference them in Markdown as
//! `![alt](attachment:<name>)`; the webview loads them through the read-only
//! `mazmi-attachment://` scheme, so the frontend never gets filesystem access.
//!
//! Only raster formats recognised by their magic bytes are accepted (PNG, JPEG, GIF, WebP).
//! SVG is refused on purpose: it can carry scripts.

use std::{
  collections::HashSet,
  fs,
  io::Write,
  path::{Path, PathBuf},
  time::{Duration, SystemTime},
};

use rusqlite::Connection;
use sha2::{Digest, Sha256};

pub const SCHEME: &str = "mazmi-attachment";
pub const REFERENCE_PREFIX: &str = "attachment:";
/// Largest single image accepted (bytes).
pub const MAX_BYTES: usize = 20 * 1024 * 1024;
/// Orphans younger than this are kept: the note that uses them may not be saved yet.
pub const ORPHAN_GRACE: Duration = Duration::from_secs(24 * 3600);

pub fn directory(db_path: &Path) -> PathBuf {
  db_path.parent().unwrap_or_else(|| Path::new(".")).join("attachments")
}

/// Detects the format from the content, never from a file name or a declared type.
pub fn sniff(bytes: &[u8]) -> Option<&'static str> {
  if bytes.starts_with(b"\x89PNG\r\n\x1a\n") { return Some("png"); }
  if bytes.starts_with(&[0xff, 0xd8, 0xff]) { return Some("jpg"); }
  if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") { return Some("gif"); }
  if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" { return Some("webp"); }
  None
}

pub fn mime(name: &str) -> &'static str {
  match name.rsplit('.').next() {
    Some("png") => "image/png",
    Some("jpg") => "image/jpeg",
    Some("gif") => "image/gif",
    Some("webp") => "image/webp",
    _ => "application/octet-stream",
  }
}

/// `<64 lowercase hex>.<png|jpg|gif|webp>`: also the guard against path traversal.
pub fn is_valid_name(name: &str) -> bool {
  let Some((hash, extension)) = name.split_once('.') else { return false };
  hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    && matches!(extension, "png" | "jpg" | "gif" | "webp")
}

fn hex(bytes: &[u8]) -> String {
  bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn name_for(bytes: &[u8]) -> Result<String, String> {
  if bytes.is_empty() { return Err("La imagen está vacía".into()); }
  if bytes.len() > MAX_BYTES { return Err(format!("La imagen supera el límite de {} MB", MAX_BYTES / 1024 / 1024)); }
  let extension = sniff(bytes).ok_or("Formato de imagen no admitido (usa PNG, JPEG, GIF o WebP)")?;
  Ok(format!("{}.{extension}", hex(&Sha256::digest(bytes))))
}

fn ensure_directory(directory: &Path) -> Result<(), String> {
  fs::create_dir_all(directory).map_err(|error| format!("No se pudo crear la carpeta de imágenes: {error}"))?;
  let metadata = fs::symlink_metadata(directory).map_err(|error| error.to_string())?;
  if metadata.file_type().is_symlink() || !metadata.is_dir() { return Err("La carpeta de imágenes no es válida".into()); }
  Ok(())
}

/// Stores `bytes` (validated) and returns its name. Storing the same image twice is a no-op.
pub fn store(directory: &Path, bytes: &[u8]) -> Result<String, String> {
  let name = name_for(bytes)?;
  ensure_directory(directory)?;
  let destination = directory.join(&name);
  if fs::symlink_metadata(&destination).is_ok_and(|metadata| metadata.is_file()) { return Ok(name); }
  let temporary = directory.join(format!(".{name}.{}.tmp", std::process::id()));
  let mut options = fs::OpenOptions::new();
  options.write(true).create(true).truncate(true);
  #[cfg(unix)]
  {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600);
  }
  let mut file = options.open(&temporary).map_err(|error| format!("No se pudo guardar la imagen: {error}"))?;
  file.write_all(bytes).and_then(|_| file.sync_all()).map_err(|error| format!("No se pudo guardar la imagen: {error}"))?;
  drop(file);
  fs::rename(&temporary, &destination).map_err(|error| {
    let _ = fs::remove_file(&temporary);
    format!("No se pudo guardar la imagen: {error}")
  })?;
  Ok(name)
}

/// Stores `bytes` only if they really are the image `expected` names (restore, import).
pub fn store_expected(directory: &Path, expected: &str, bytes: &[u8]) -> Result<(), String> {
  if !is_valid_name(expected) || name_for(bytes)? != expected {
    return Err(format!("La imagen {expected} no coincide con su contenido"));
  }
  store(directory, bytes).map(|_| ())
}

pub fn read(directory: &Path, name: &str) -> Result<Vec<u8>, String> {
  if !is_valid_name(name) { return Err("Referencia de imagen no válida".into()); }
  let path = directory.join(name);
  let metadata = fs::symlink_metadata(&path).map_err(|_| format!("No se encuentra la imagen {name}"))?;
  if !metadata.is_file() || metadata.file_type().is_symlink() { return Err("Referencia de imagen no válida".into()); }
  fs::read(&path).map_err(|error| format!("No se pudo leer la imagen: {error}"))
}

/// Every attachment name mentioned in `text` (Markdown or Rich JSON).
pub fn references(text: &str) -> impl Iterator<Item = &str> {
  text.match_indices(REFERENCE_PREFIX).filter_map(move |(index, _)| {
    let start = index + REFERENCE_PREFIX.len();
    let rest = &text[start..];
    // Exactly hash + extension, whatever follows (punctuation, a quote, a parenthesis).
    ["png", "jpg", "gif", "webp"].iter().find_map(|extension| {
      let length = 65 + extension.len();
      let candidate = rest.get(..length)?;
      is_valid_name(candidate).then_some(candidate)
    })
  })
}

fn table_exists(connection: &Connection, table: &str) -> bool {
  connection.query_row("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1", [table], |_| Ok(())).is_ok()
}

/// Attachments used by any note — trashed ones and saved versions included.
pub fn referenced(connection: &Connection) -> Result<HashSet<String>, String> {
  // Protected notes list their images in clear (names only), since their content is encrypted.
  let mut locked: Vec<String> = Vec::new();
  if table_exists(connection, "note_locks") {
    let mut statement = connection.prepare("SELECT attachments FROM note_locks").map_err(|error| error.to_string())?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0)).map_err(|error| error.to_string())?;
    for row in rows { locked.extend(row.map_err(|error| error.to_string())?.split_whitespace().filter(|name| is_valid_name(name)).map(str::to_string)); }
  }
  let mut names: HashSet<String> = locked.into_iter().collect();
  let mut collect = |sql: &str| -> Result<(), String> {
    let mut statement = connection.prepare(sql).map_err(|error| error.to_string())?;
    let rows = statement.query_map([], |row| row.get::<_, Option<String>>(0)).map_err(|error| error.to_string())?;
    for row in rows {
      if let Some(text) = row.map_err(|error| error.to_string())? { names.extend(references(&text).map(str::to_string)); }
    }
    Ok(())
  };
  let filter = format!("%{REFERENCE_PREFIX}%");
  collect(&format!("SELECT content_md FROM notes WHERE content_md LIKE '{filter}'"))?;
  collect(&format!("SELECT content_rich_json FROM notes WHERE content_rich_json LIKE '{filter}'"))?;
  if table_exists(connection, "note_versions") {
    collect(&format!("SELECT snapshot_rich_json FROM note_versions WHERE snapshot_rich_json LIKE '{filter}'"))?;
    let has_md = connection.prepare("SELECT snapshot_md FROM note_versions LIMIT 0").is_ok();
    if has_md { collect(&format!("SELECT snapshot_md FROM note_versions WHERE snapshot_md LIKE '{filter}'"))?; }
  }
  Ok(names)
}

/// Deletes attachments no note or version references any more, once they are older than `grace`.
/// Leftover temporary files from an interrupted save are removed too.
pub fn remove_orphans(connection: &Connection, directory: &Path, grace: Duration) -> Result<usize, String> {
  let Ok(entries) = fs::read_dir(directory) else { return Ok(0) };
  let used = referenced(connection)?;
  let now = SystemTime::now();
  let mut removed = 0;
  for entry in entries.flatten() {
    let name = entry.file_name().to_string_lossy().to_string();
    let Ok(metadata) = entry.metadata() else { continue };
    if !metadata.is_file() { continue; }
    let old = metadata.modified().ok().and_then(|modified| now.duration_since(modified).ok()).is_some_and(|age| age >= grace);
    let orphan = if is_valid_name(&name) { !used.contains(&name) } else { name.starts_with('.') && name.ends_with(".tmp") };
    if orphan && old && fs::remove_file(entry.path()).is_ok() { removed += 1; }
  }
  Ok(removed)
}

#[cfg(test)]
mod tests {
  use super::*;

  const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01\x08\x06\0\0\0\x1f\x15\xc4\x89\0\0\0\rIDATx\x9cc\xf8\xcf\xc0\xf0\x1f\0\x05\0\x01\xff\x89\x99=\x1d\0\0\0\0IEND\xaeB`\x82";

  fn scratch(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("mazmi-attachments-{label}-{}-{}", std::process::id(), SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_nanos()));
    fs::create_dir_all(&path).unwrap();
    path
  }

  #[test]
  fn validates_formats_names_and_size() {
    assert_eq!(sniff(PNG), Some("png"));
    assert_eq!(sniff(&[0xff, 0xd8, 0xff, 0xe0]), Some("jpg"));
    assert_eq!(sniff(b"GIF89a...."), Some("gif"));
    assert_eq!(sniff(b"RIFF\0\0\0\0WEBPVP8 "), Some("webp"));
    assert_eq!(sniff(b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"), None);
    assert!(name_for(&[]).is_err());
    assert!(name_for(&vec![0x89; MAX_BYTES + 1]).is_err());
    let name = name_for(PNG).unwrap();
    assert!(is_valid_name(&name) && name.ends_with(".png"));
    for bad in ["../notes.db", "abc.png", &format!("{}.svg", "a".repeat(64)), &format!("{}.png", "A".repeat(64)), &format!("{}/x.png", "a".repeat(63))] {
      assert!(!is_valid_name(bad), "{bad}");
    }
  }

  #[test]
  fn stores_once_and_reads_back() {
    let directory = scratch("store").join("attachments");
    let first = store(&directory, PNG).unwrap();
    let second = store(&directory, PNG).unwrap();
    assert_eq!(first, second);
    assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
    assert_eq!(read(&directory, &first).unwrap(), PNG);
    assert!(read(&directory, "../notes.db").is_err());
    assert!(store_expected(&directory, &format!("{}.png", "0".repeat(64)), PNG).is_err());
    assert!(store_expected(&directory, &first, PNG).is_ok());
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      assert_eq!(fs::metadata(directory.join(&first)).unwrap().permissions().mode() & 0o777, 0o600);
    }
  }

  #[test]
  fn finds_references_in_markdown_and_json() {
    let name = format!("{}.png", "ab".repeat(32));
    let markdown = format!("Texto ![plano](attachment:{name}) y ![x](attachment:nope.png) ![r](https://example.com/a.png) attachment:{name}.");
    assert_eq!(references(&markdown).collect::<Vec<_>>(), vec![name.as_str(), name.as_str()]);
    let json = format!("{{\"type\":\"image\",\"attrs\":{{\"src\":\"attachment:{name}\"}}}}");
    assert_eq!(references(&json).collect::<Vec<_>>(), vec![name.as_str()]);
  }

  #[test]
  fn removes_only_old_unreferenced_files() {
    let root = scratch("orphans");
    let directory = root.join("attachments");
    let used = store(&directory, PNG).unwrap();
    let mut other = PNG.to_vec();
    other.push(0);
    let orphan = store(&directory, &other).unwrap();
    let connection = Connection::open_in_memory().unwrap();
    connection.execute_batch("CREATE TABLE notes(content_md TEXT, content_rich_json TEXT); CREATE TABLE note_versions(snapshot_rich_json TEXT, snapshot_md TEXT);").unwrap();
    connection.execute("INSERT INTO note_versions VALUES ('', ?1)", [format!("![](attachment:{used})")]).unwrap();
    // Fresh orphans survive the grace period.
    assert_eq!(remove_orphans(&connection, &directory, ORPHAN_GRACE).unwrap(), 0);
    assert_eq!(remove_orphans(&connection, &directory, Duration::ZERO).unwrap(), 1);
    assert!(directory.join(&used).exists());
    assert!(!directory.join(&orphan).exists());
  }
}
