//! Reminders: the database is the source of truth; native OS requests are rebuilt from it after
//! every change and at startup. A Rust background thread (not a JavaScript timer) marks what
//! fired and advances repeating reminders while the app runs.

pub mod schedule;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use chrono::Utc;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::db;

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Permission { Granted, Denied, Unknown, Unavailable }

/// How reminders behave on this platform, shown in Settings.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
  pub platform: &'static str,
  /// The OS delivers notifications although MazmiNotas is closed or not running.
  pub works_when_closed: bool,
  pub permission: Permission,
}

static APP: OnceLock<AppHandle> = OnceLock::new();
static PENDING_OPEN: Mutex<Option<String>> = Mutex::new(None);
const OPEN_EVENT: &str = "reminders://open";
pub const CHANGED_EVENT: &str = "reminders://changed";

fn open_note(note: String) {
  *PENDING_OPEN.lock().unwrap_or_else(|error| error.into_inner()) = Some(note.clone());
  if let Some(app) = APP.get() {
    if let Some(window) = app.get_webview_window("main") {
      let _ = window.unminimize();
      let _ = window.show();
      let _ = window.set_focus();
    }
    let _ = app.emit(OPEN_EVENT, note);
  }
}

/// The note a notification click asked to open, consumed once (also covers app launches).
pub fn take_pending_open() -> Option<String> {
  PENDING_OPEN.lock().unwrap_or_else(|error| error.into_inner()).take()
}

/// Called from the builder before the app finishes launching.
pub fn install() {
  #[cfg(target_os = "macos")]
  macos::install_delegate(open_note);
  #[cfg(target_os = "windows")]
  {
    if let Err(error) = windows::register_scheme() { log::warn!("No se pudo registrar mazminotas://: {error}"); }
    if let Some(note) = windows::note_from_args(std::env::args()) { *PENDING_OPEN.lock().unwrap_or_else(|error| error.into_inner()) = Some(note); }
  }
}

pub fn capabilities() -> Capabilities {
  #[cfg(target_os = "macos")]
  return Capabilities { platform: "macos", works_when_closed: true, permission: macos::permission() };
  #[cfg(target_os = "windows")]
  return Capabilities { platform: "windows", works_when_closed: true, permission: windows::permission() };
  #[cfg(not(any(target_os = "macos", target_os = "windows")))]
  return Capabilities { platform: "other", works_when_closed: false, permission: Permission::Unavailable };
}

pub fn request_permission() -> Result<Permission, String> {
  #[cfg(target_os = "macos")]
  return macos::request_permission();
  #[cfg(target_os = "windows")]
  return Ok(windows::permission());
  #[cfg(not(any(target_os = "macos", target_os = "windows")))]
  return Ok(Permission::Unavailable);
}

/// Rebuilds the OS requests from the database. Errors are logged, never fatal to the UI.
pub fn resync(path: &std::path::Path) -> Result<usize, String> {
  let connection = db::open_reminders_connection(path)?;
  // Windows scheduled toasts cannot repeat: repeats are expanded into upcoming one-shots there.
  let requests = db::native_reminder_plan(&connection, Utc::now(), !cfg!(target_os = "windows"))?;
  #[cfg(target_os = "macos")]
  return macos::replace_all(&requests);
  #[cfg(target_os = "windows")]
  return windows::replace_all(&requests);
  #[cfg(not(any(target_os = "macos", target_os = "windows")))]
  return Ok(requests.len());
}

pub fn clear_delivered(reminder_id: &str) {
  #[cfg(target_os = "macos")]
  macos::remove_delivered(&schedule::all_ids(reminder_id));
  #[cfg(not(target_os = "macos"))]
  let _ = reminder_id;
}

/// Starts the sweep thread: marks what fired (also what fired while the app was closed),
/// advances repeating reminders, tops up native requests and tells the UI.
pub fn start(app: AppHandle) {
  let _ = APP.set(app.clone());
  std::thread::Builder::new().name("mazminotas-reminders".into()).spawn(move || {
    let Ok(path) = db::database_path(&app) else { return };
    let mut first = true;
    loop {
      match db::sweep_due_reminders(&path, Utc::now()) {
        Ok(changed) => {
          // Repeating reminders and one-shot horizons are re-planned as time advances.
          if changed || first {
            if let Err(error) = resync(&path) { log::warn!("No se pudieron programar los recordatorios: {error}"); }
            let _ = app.emit(CHANGED_EVENT, ());
          }
        }
        Err(error) => log::warn!("Revisión de recordatorios fallida: {error}"),
      }
      first = false;
      std::thread::sleep(Duration::from_secs(20));
    }
  }).ok();
}

/// Diagnostics used by `--reminders-selftest` and Settings.
pub mod diagnostics {
  use super::*;

  pub fn pending() -> Vec<String> {
    #[cfg(target_os = "macos")]
    return macos::pending_ids();
    #[cfg(not(target_os = "macos"))]
    return Vec::new();
  }

  pub fn add(request: &schedule::NativeRequest) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return super::macos::add(request);
    #[cfg(not(target_os = "macos"))]
    { let _ = request; Ok(()) }
  }

  pub fn delivered() -> Vec<(String, f64)> {
    #[cfg(target_os = "macos")]
    return macos::delivered();
    #[cfg(not(target_os = "macos"))]
    return Vec::new();
  }

  /// Schedules one real notification `seconds` from now through the same native path, without
  /// touching the notes database.
  pub fn schedule_test(seconds: i64) -> Result<String, String> {
    let at = Utc::now() + chrono::Duration::seconds(seconds.max(60));
    let zone = iana_zone();
    let tz = schedule::parse_zone(&zone)?;
    let local = at.with_timezone(&tz).naive_local();
    let mut requests = schedule::plan("selftest", local, &zone, schedule::Repeat::None, None, Utc::now())?;
    for request in &mut requests { request.title = "Prueba de recordatorio".into(); request.note_id = String::new(); }
    let id = requests.first().map(|request| request.id.clone()).ok_or("No se pudo planificar la prueba")?;
    // Added alongside the real reminders, never replacing them.
    #[cfg(target_os = "macos")]
    for request in &requests { super::macos::add(request)?; }
    Ok(format!("{id} @ {}", requests[0].first.to_rfc3339()))
  }

  /// The system zone as an IANA name (macOS keeps it in /etc/localtime).
  pub fn iana_zone() -> String {
    std::fs::read_link("/etc/localtime").ok()
      .and_then(|path| path.to_str().and_then(|value| value.split("zoneinfo/").nth(1)).map(str::to_string))
      .unwrap_or_else(|| "UTC".into())
  }
}
