//! Windows: ScheduledToastNotification. Windows stores scheduled toasts and shows them while
//! MazmiNotas is closed. Requires the AppUserModelID of the Start menu shortcut created by the
//! installer (the bundle identifier). Clicking a toast opens `mazminotas://note/<id>`, a URL
//! scheme registered per user on first run.
//!
//! NOT VERIFIED ON WINDOWS: written against the `windows` 0.61 crate API, but neither compiled for
//! nor run on a Windows target yet (development happens on macOS). Check on Windows before release.

use windows::core::HSTRING;
use windows::Data::Xml::Dom::XmlDocument;
use windows::Foundation::DateTime;
use windows::UI::Notifications::{ScheduledToastNotification, ToastNotificationManager, ToastNotifier};
use windows::Win32::System::Registry::{RegCreateKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_WRITE, REG_OPTION_NON_VOLATILE, REG_SZ};

use super::schedule::NativeRequest;
use super::Permission;

pub const APP_ID: &str = "com.scribedock.app";
const GROUP: &str = "mazminotas";
const MAX_PENDING: usize = 60;
pub const SCHEME: &str = "mazminotas";

fn notifier() -> Result<ToastNotifier, String> {
  ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(APP_ID)).map_err(|error| error.message().to_string())
}

pub fn permission() -> Permission {
  // Setting values: 0 = Enabled; anything else means the user or policy disabled toasts.
  match notifier().and_then(|notifier| notifier.Setting().map_err(|error| error.message().to_string())) {
    Ok(setting) if setting.0 == 0 => Permission::Granted,
    Ok(_) => Permission::Denied,
    Err(_) => Permission::Unavailable,
  }
}

/// Toast tags are limited to 16 characters, so the stable request id is hashed (FNV-1a).
fn tag(id: &str) -> String {
  let mut hash: u64 = 0xcbf29ce484222325;
  for byte in id.bytes() { hash ^= byte as u64; hash = hash.wrapping_mul(0x100000001b3); }
  format!("{hash:016x}")
}

fn escape(value: &str) -> String {
  value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn windows_time(unix_seconds: i64) -> DateTime {
  // WinRT DateTime: 100 ns intervals since 1601-01-01.
  DateTime { UniversalTime: (unix_seconds + 11_644_473_600) * 10_000_000 }
}

pub fn replace_all(requests: &[NativeRequest]) -> Result<usize, String> {
  let notifier = notifier()?;
  let existing = notifier.GetScheduledToastNotifications().map_err(|error| error.message().to_string())?;
  for toast in existing {
    if toast.Group().map(|group| group == GROUP).unwrap_or(false) { let _ = notifier.RemoveFromSchedule(&toast); }
  }
  let mut scheduled = 0;
  for request in requests.iter().take(MAX_PENDING) {
    let xml = XmlDocument::new().map_err(|error| error.message().to_string())?;
    let launch = format!("{SCHEME}://note/{}", request.note_id);
    xml.LoadXml(&HSTRING::from(format!(
      "<toast launch=\"{}\" activationType=\"protocol\"><visual><binding template=\"ToastGeneric\"><text>{}</text><text>Recordatorio de MazmiNotas</text></binding></visual></toast>",
      escape(&launch), escape(if request.title.trim().is_empty() { "Sin título" } else { request.title.trim() }),
    ))).map_err(|error| error.message().to_string())?;
    let toast = ScheduledToastNotification::CreateScheduledToastNotification(&xml, windows_time(request.first.timestamp()))
      .map_err(|error| error.message().to_string())?;
    toast.SetTag(&HSTRING::from(tag(&request.id))).map_err(|error| error.message().to_string())?;
    toast.SetGroup(&HSTRING::from(GROUP)).map_err(|error| error.message().to_string())?;
    notifier.AddToSchedule(&toast).map_err(|error| error.message().to_string())?;
    scheduled += 1;
  }
  Ok(scheduled)
}

fn set_value(key: HKEY, name: Option<&str>, value: &str) -> Result<(), String> {
  let wide: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
  let bytes = unsafe { std::slice::from_raw_parts(wide.as_ptr().cast::<u8>(), wide.len() * 2) };
  let name = name.map(HSTRING::from);
  unsafe { RegSetValueExW(key, name.as_ref().map(|n| windows::core::PCWSTR(n.as_ptr())).unwrap_or(windows::core::PCWSTR::null()), Some(0), REG_SZ, Some(bytes)) }
    .ok().map_err(|error| error.message().to_string())
}

fn create_key(path: &str) -> Result<HKEY, String> {
  let mut key = HKEY::default();
  unsafe { RegCreateKeyExW(HKEY_CURRENT_USER, &HSTRING::from(path), Some(0), None, REG_OPTION_NON_VOLATILE, KEY_WRITE, None, &mut key, None) }
    .ok().map_err(|error| error.message().to_string())?;
  Ok(key)
}

/// Registers `mazminotas://` for the current user so toast clicks reopen the right note.
pub fn register_scheme() -> Result<(), String> {
  let executable = std::env::current_exe().map_err(|error| error.to_string())?;
  let command = format!("\"{}\" \"%1\"", executable.display());
  let root = create_key(&format!("Software\\Classes\\{SCHEME}"))?;
  set_value(root, None, "URL:MazmiNotas")?;
  set_value(root, Some("URL Protocol"), "")?;
  let open = create_key(&format!("Software\\Classes\\{SCHEME}\\shell\\open\\command"))?;
  set_value(open, None, &command)
}

/// The note id from a `mazminotas://note/<id>` launch argument.
pub fn note_from_args(args: impl Iterator<Item = String>) -> Option<String> {
  args.filter_map(|arg| arg.strip_prefix(&format!("{SCHEME}://note/")).map(|id| id.trim_end_matches('/').to_string()))
    .find(|id| !id.is_empty() && id.len() < 200)
}
