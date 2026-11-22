//! Password-protected notes.
//!
//! Locking a note moves its content into `note_locks`, encrypted with XChaCha20-Poly1305 under a
//! key derived from the password with Argon2id (random 16-byte salt per note). The note row keeps
//! only its title, so lists, search by title, folders and reminders still work. The note id is
//! authenticated with the ciphertext, so content cannot be swapped between notes.
//!
//! The derived key stays in this process's memory only while the note is open and unlocked
//! (`UNLOCKED`), so autosave can re-encrypt; it is wiped on relock or when the app closes.
//! There is no recovery: a forgotten password means the content is lost.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::rand_core::RngCore;
use chacha20poly1305::aead::{Aead, AeadCore, KeyInit, OsRng, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use super::{now_unix, open_connection, set_note_tags, writes::SaveNoteDraft};

/// OWASP's recommended Argon2id setting (19 MiB, 2 passes). Stored with each lock so it can change.
const KDF: &str = "argon2id:v=19,m=19456,t=2,p=1";
pub const MIN_PASSWORD: usize = 4;
const EMPTY_DOC: &str = r#"{"type":"doc","content":[{"type":"paragraph"}]}"#;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LockedContent {
  pub content_md: String,
  pub content_rich_json: String,
  pub content_plain: String,
}

struct Unlocked { key: Zeroizing<[u8; 32]>, salt: Vec<u8> }

static UNLOCKED: Mutex<Option<HashMap<String, Unlocked>>> = Mutex::new(None);
static FAILURES: Mutex<Option<HashMap<String, u32>>> = Mutex::new(None);

fn derive(password: &str, salt: &[u8], kdf: &str) -> Result<Zeroizing<[u8; 32]>, String> {
  let parse = |name: &str| kdf.split([':', ',']).find_map(|part| part.strip_prefix(name)).and_then(|value| value.parse::<u32>().ok());
  if !kdf.starts_with("argon2id:") { return Err("Formato de protección desconocido".into()); }
  let params = Params::new(parse("m=").unwrap_or(19_456), parse("t=").unwrap_or(2), parse("p=").unwrap_or(1), Some(32))
    .map_err(|error| error.to_string())?;
  let mut key = Zeroizing::new([0u8; 32]);
  Argon2::new(Algorithm::Argon2id, Version::V0x13, params).hash_password_into(password.as_bytes(), salt, key.as_mut())
    .map_err(|error| error.to_string())?;
  Ok(key)
}

fn encrypt(key: &[u8; 32], note_id: &str, content: &LockedContent) -> Result<(Vec<u8>, Vec<u8>), String> {
  let cipher = XChaCha20Poly1305::new(key.into());
  let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
  let plain = Zeroizing::new(serde_json::to_vec(content).map_err(|error| error.to_string())?);
  let ciphertext = cipher.encrypt(&nonce, Payload { msg: &plain, aad: note_id.as_bytes() }).map_err(|_| "No se pudo cifrar la nota".to_string())?;
  Ok((nonce.to_vec(), ciphertext))
}

fn decrypt(key: &[u8; 32], note_id: &str, nonce: &[u8], ciphertext: &[u8]) -> Option<LockedContent> {
  if nonce.len() != 24 { return None; }
  let cipher = XChaCha20Poly1305::new(key.into());
  let plain = Zeroizing::new(cipher.decrypt(XNonce::from_slice(nonce), Payload { msg: ciphertext, aad: note_id.as_bytes() }).ok()?);
  serde_json::from_slice(&plain).ok()
}

fn attachment_names(markdown: &str) -> String {
  let mut names: Vec<&str> = crate::attachments::references(markdown).collect();
  names.sort_unstable();
  names.dedup();
  names.join(" ")
}

pub fn is_locked(connection: &Connection, note_id: &str) -> Result<bool, String> {
  connection.query_row("SELECT 1 FROM note_locks WHERE note_id=?1", [note_id], |_| Ok(())).optional()
    .map(|found| found.is_some()).map_err(|error| error.to_string())
}

#[cfg(test)]
fn is_unlocked(note_id: &str) -> bool {
  UNLOCKED.lock().ok().and_then(|guard| guard.as_ref().map(|map| map.contains_key(note_id))).unwrap_or(false)
}

/// Forgets a note's key (leaving the note, closing the app).
pub fn relock(note_id: &str) {
  if let Ok(mut guard) = UNLOCKED.lock() { if let Some(map) = guard.as_mut() { map.remove(note_id); } }
}

pub fn relock_all() {
  if let Ok(mut guard) = UNLOCKED.lock() { *guard = None; }
}

fn remember(note_id: &str, key: Zeroizing<[u8; 32]>, salt: Vec<u8>) {
  if let Ok(mut guard) = UNLOCKED.lock() { guard.get_or_insert_with(HashMap::new).insert(note_id.to_string(), Unlocked { key, salt }); }
}

fn blank_note(transaction: &Transaction<'_>, note_id: &str) -> Result<(), String> {
  transaction.execute("UPDATE notes SET content_rich_json=?1, content_md='', content_plain='' WHERE id=?2", params![EMPTY_DOC, note_id])
    .map_err(|error| error.to_string())?;
  // Links found in the content would reveal it; the note keeps none while locked.
  transaction.execute("DELETE FROM note_links WHERE from_note_id=?1", [note_id]).map_err(|error| error.to_string())?;
  Ok(())
}

/// Protects a note. Its saved versions are deleted: they hold the content in clear.
pub fn lock_on_path(path: &Path, note_id: &str, password: &str) -> Result<(), String> {
  if password.chars().count() < MIN_PASSWORD { return Err(format!("La contraseña debe tener al menos {MIN_PASSWORD} caracteres")); }
  let mut connection = open_connection(path)?;
  // Freed pages are overwritten with zeros, so the old text does not linger in the file.
  connection.pragma_update(None, "secure_delete", "ON").map_err(|error| error.to_string())?;
  let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
  if is_locked(&transaction, note_id)? { return Err("La nota ya está protegida".into()); }
  let content: LockedContent = transaction.query_row(
    "SELECT content_md, content_rich_json, content_plain FROM notes WHERE id=?1 AND is_deleted=0", [note_id],
    |row| Ok(LockedContent { content_md: row.get(0)?, content_rich_json: row.get(1)?, content_plain: row.get(2)? }),
  ).optional().map_err(|error| error.to_string())?.ok_or("Nota no encontrada o en la papelera")?;
  let mut salt = vec![0u8; 16];
  OsRng.fill_bytes(&mut salt);
  let key = derive(password, &salt, KDF)?;
  let (nonce, ciphertext) = encrypt(&key, note_id, &content)?;
  let now = now_unix();
  transaction.execute(
    "INSERT INTO note_locks (note_id, kdf, salt, nonce, ciphertext, attachments, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
    params![note_id, KDF, salt, nonce, ciphertext, attachment_names(&content.content_md), now],
  ).map_err(|error| error.to_string())?;
  blank_note(&transaction, note_id)?;
  transaction.execute("DELETE FROM note_versions WHERE note_id=?1", [note_id]).map_err(|error| error.to_string())?;
  // FTS5 only marks removed rows; merging rewrites the index without the old words.
  transaction.execute("INSERT INTO notes_fts(notes_fts) VALUES('optimize')", []).map_err(|error| error.to_string())?;
  transaction.commit().map_err(|error| error.to_string())?;
  // The write-ahead log still holds the previous pages until it is checkpointed and truncated.
  connection.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(())).map_err(|error| error.to_string())
}

/// Wrong passwords wait longer each time (0.25 s doubling up to 8 s) to slow down guessing.
fn throttle(note_id: &str) {
  let failures = FAILURES.lock().ok().and_then(|guard| guard.as_ref().and_then(|map| map.get(note_id).copied())).unwrap_or(0);
  if failures > 0 { std::thread::sleep(Duration::from_millis((250u64 << failures.min(5)).min(8_000))); }
}

fn record_failure(note_id: &str, failed: bool) {
  if let Ok(mut guard) = FAILURES.lock() {
    let map = guard.get_or_insert_with(HashMap::new);
    if failed { *map.entry(note_id.to_string()).or_insert(0) += 1; } else { map.remove(note_id); }
  }
}

/// kdf, salt, nonce, ciphertext.
type StoredLock = (String, Vec<u8>, Vec<u8>, Vec<u8>);

fn read_lock(connection: &Connection, note_id: &str) -> Result<StoredLock, String> {
  connection.query_row("SELECT kdf, salt, nonce, ciphertext FROM note_locks WHERE note_id=?1", [note_id],
    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))).optional().map_err(|error| error.to_string())?
    .ok_or_else(|| "La nota no está protegida".into())
}

/// Opens a protected note: returns its content and keeps the key while the note stays open.
pub fn unlock_on_path(path: &Path, note_id: &str, password: &str) -> Result<LockedContent, String> {
  throttle(note_id);
  let connection = open_connection(path)?;
  let (kdf, salt, nonce, ciphertext) = read_lock(&connection, note_id)?;
  let key = derive(password, &salt, &kdf)?;
  let Some(content) = decrypt(&key, note_id, &nonce, &ciphertext) else {
    record_failure(note_id, true);
    return Err("Contraseña incorrecta".into());
  };
  record_failure(note_id, false);
  remember(note_id, key, salt);
  Ok(content)
}

/// Removes the protection: the content goes back to the note in clear.
pub fn remove_lock_on_path(path: &Path, note_id: &str, password: &str) -> Result<LockedContent, String> {
  let content = unlock_on_path(path, note_id, password)?;
  let mut connection = open_connection(path)?;
  let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
  transaction.execute("UPDATE notes SET content_rich_json=?1, content_md=?2, content_plain=?3, updated_at=?4 WHERE id=?5",
    params![content.content_rich_json, content.content_md, content.content_plain, now_unix(), note_id]).map_err(|error| error.to_string())?;
  transaction.execute("DELETE FROM note_locks WHERE note_id=?1", [note_id]).map_err(|error| error.to_string())?;
  super::refresh_all_links(&transaction)?;
  transaction.commit().map_err(|error| error.to_string())?;
  relock(note_id);
  Ok(content)
}

/// Autosave of an open protected note: re-encrypts with the key kept since it was unlocked.
/// Protected notes keep no version history (it would hold the content in clear).
pub fn save_locked_on_path(path: &Path, note_id: &str, draft: &SaveNoteDraft) -> Result<(), String> {
  let (key, salt) = {
    let guard = UNLOCKED.lock().map_err(|_| "Estado de bloqueo no disponible".to_string())?;
    let unlocked = guard.as_ref().and_then(|map| map.get(note_id)).ok_or("La nota está bloqueada: desbloquéala para guardar")?;
    (Zeroizing::new(*unlocked.key), unlocked.salt.clone())
  };
  let content = LockedContent { content_md: draft.content_md.clone(), content_rich_json: draft.content_rich_json.clone(), content_plain: draft.content_plain.clone() };
  let (nonce, ciphertext) = encrypt(&key, note_id, &content)?;
  let mut connection = open_connection(path)?;
  let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
  let now = now_unix();
  // The salt must match the stored one: a lock replaced meanwhile is never overwritten blindly.
  let changed = transaction.execute(
    "UPDATE note_locks SET nonce=?1, ciphertext=?2, attachments=?3, updated_at=?4 WHERE note_id=?5 AND salt=?6",
    params![nonce, ciphertext, attachment_names(&content.content_md), now, note_id, salt],
  ).map_err(|error| error.to_string())?;
  if changed != 1 { return Err("La protección de la nota cambió; vuelve a abrirla".into()); }
  let updated = transaction.execute("UPDATE notes SET title=?1, updated_at=?2 WHERE id=?3 AND is_deleted=0", params![draft.title.trim(), now, note_id])
    .map_err(|error| error.to_string())?;
  if updated != 1 { return Err("Nota no encontrada o en papelera".into()); }
  set_note_tags(&transaction, note_id, &draft.tags)?;
  transaction.commit().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn library() -> (std::path::PathBuf, std::path::PathBuf) {
    let root = std::env::temp_dir().join(super::super::generate_id("mazmi-locks"));
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("notes.db");
    super::super::create_isolated_database(&path).unwrap();
    (root, path)
  }

  fn draft(text: &str) -> SaveNoteDraft {
    SaveNoteDraft {
      title: "Diario".into(),
      content_rich_json: serde_json::json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":text}]}]}).to_string(),
      content_md: text.into(), content_plain: text.into(), tags: vec![], folder_id: None,
    }
  }

  fn row(path: &Path, sql: &str, id: &str) -> String {
    Connection::open(path).unwrap().query_row(sql, [id], |row| row.get::<_, String>(0)).unwrap()
  }

  #[test]
  fn locked_content_is_encrypted_and_only_the_password_opens_it() {
    let (root, path) = library();
    let id = super::super::save_note_on_path(&path, None, &draft("secreto ![p](attachment:aaaa)")).unwrap();
    super::super::save_note_on_path(&path, Some(&id), &draft("secreto muy íntimo")).unwrap();
    assert!(lock_on_path(&path, &id, "abc").is_err(), "contraseña demasiado corta");
    lock_on_path(&path, &id, "clave segura").unwrap();

    // Nothing readable is left: note row, full-text index, versions, raw file.
    assert_eq!(row(&path, "SELECT content_md FROM notes WHERE id=?1", &id), "");
    assert_eq!(row(&path, "SELECT title FROM notes WHERE id=?1", &id), "Diario");
    let connection = Connection::open(&path).unwrap();
    assert_eq!(connection.query_row("SELECT count(*) FROM note_versions WHERE note_id=?1", [&id], |r| r.get::<_, i64>(0)).unwrap(), 0);
    assert_eq!(connection.query_row("SELECT count(*) FROM notes_fts WHERE notes_fts MATCH 'intimo'", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    drop(connection);
    // Neither the database file nor its journal holds the words (as written, or as indexed).
    for file in [path.clone(), path.with_extension("db-wal")] {
      let raw = std::fs::read(&file).unwrap_or_default();
      for word in ["íntimo".as_bytes(), b"intimo", b"secreto"] {
        assert!(!raw.windows(word.len()).any(|window| window == word), "{} aparece en claro en {}", String::from_utf8_lossy(word), file.display());
      }
    }

    assert_eq!(unlock_on_path(&path, &id, "otra").unwrap_err(), "Contraseña incorrecta");
    assert!(!is_unlocked(&id));
    assert!(save_locked_on_path(&path, &id, &draft("x")).is_err(), "no se guarda sin desbloquear");
    let content = unlock_on_path(&path, &id, "clave segura").unwrap();
    assert_eq!(content.content_md, "secreto muy íntimo");
    assert!(is_unlocked(&id));

    // Autosave re-encrypts; the next unlock reads the new text.
    save_locked_on_path(&path, &id, &draft("versión nueva")).unwrap();
    assert_eq!(row(&path, "SELECT content_md FROM notes WHERE id=?1", &id), "");
    relock(&id);
    assert!(save_locked_on_path(&path, &id, &draft("y")).is_err());
    assert_eq!(unlock_on_path(&path, &id, "clave segura").unwrap().content_md, "versión nueva");

    // Removing the protection puts the content back in clear.
    remove_lock_on_path(&path, &id, "clave segura").unwrap();
    assert_eq!(row(&path, "SELECT content_md FROM notes WHERE id=?1", &id), "versión nueva");
    assert!(!is_locked(&Connection::open(&path).unwrap(), &id).unwrap());
    let _ = std::fs::remove_dir_all(root);
  }

  #[test]
  fn ciphertext_cannot_be_moved_to_another_note() {
    let (root, path) = library();
    let first = super::super::save_note_on_path(&path, None, &draft("uno")).unwrap();
    let second = super::super::save_note_on_path(&path, None, &draft("dos")).unwrap();
    lock_on_path(&path, &first, "clave").unwrap();
    lock_on_path(&path, &second, "clave").unwrap();
    let connection = Connection::open(&path).unwrap();
    connection.execute("UPDATE note_locks SET salt=(SELECT salt FROM note_locks WHERE note_id=?1), nonce=(SELECT nonce FROM note_locks WHERE note_id=?1),
      ciphertext=(SELECT ciphertext FROM note_locks WHERE note_id=?1) WHERE note_id=?2", params![first, second]).unwrap();
    assert_eq!(unlock_on_path(&path, &second, "clave").unwrap_err(), "Contraseña incorrecta");
    let _ = std::fs::remove_dir_all(root);
  }
}
