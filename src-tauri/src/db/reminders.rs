use super::*;
use crate::reminders::schedule::{self, Repeat};
use chrono::{DateTime, Utc};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReminderRecord {
  pub id: String,
  pub note_id: String,
  pub note_title: String,
  pub local_time: String,
  pub time_zone: String,
  pub repeat: String,
  pub status: String,
  pub next_fire_at: Option<i64>,
  pub snoozed_until: Option<i64>,
  pub last_fired_at: Option<i64>,
  pub needs_attention: bool,
  pub note_deleted: bool,
}

fn instant(seconds: i64) -> DateTime<Utc> {
  DateTime::from_timestamp(seconds, 0).unwrap_or_default()
}

const SELECT: &str = "SELECT r.id, r.note_id, n.title, r.local_time, r.time_zone, r.repeat, r.status, r.next_fire_at,
  r.snoozed_until, r.last_fired_at, r.needs_attention, n.is_deleted FROM reminders r JOIN notes n ON n.id = r.note_id";

fn read(row: &rusqlite::Row<'_>) -> rusqlite::Result<ReminderRecord> {
  Ok(ReminderRecord {
    id: row.get(0)?, note_id: row.get(1)?, note_title: row.get(2)?, local_time: row.get(3)?, time_zone: row.get(4)?,
    repeat: row.get(5)?, status: row.get(6)?, next_fire_at: row.get(7)?, snoozed_until: row.get(8)?,
    last_fired_at: row.get(9)?, needs_attention: row.get::<_, i64>(10)? == 1, note_deleted: row.get::<_, i64>(11)? == 1,
  })
}

pub fn list_reminders(connection: &Connection) -> Result<Vec<ReminderRecord>, String> {
  let mut statement = connection.prepare(&format!("{SELECT} ORDER BY COALESCE(r.next_fire_at, r.last_fired_at)")).map_err(|error| error.to_string())?;
  let rows = statement.query_map([], read).map_err(|error| error.to_string())?;
  rows.collect::<Result<_, _>>().map_err(|error| error.to_string())
}

pub fn reminder_for_note(connection: &Connection, note_id: &str) -> Result<Option<ReminderRecord>, String> {
  connection.query_row(&format!("{SELECT} WHERE r.note_id = ?1"), [note_id], read).optional().map_err(|error| error.to_string())
}

/// Creates or replaces the reminder of a note. The time must still be ahead for one-off reminders.
pub fn set_reminder_on_path(path: &Path, note_id: &str, local_time: &str, time_zone: &str, repeat: &str, now: DateTime<Utc>) -> Result<ReminderRecord, String> {
  let start = schedule::parse_local(local_time)?;
  let zone = schedule::parse_zone(time_zone)?;
  let repeat = Repeat::parse(repeat)?;
  let next = schedule::next_after(start, zone, repeat, now)
    .ok_or("La fecha del recordatorio ya ha pasado")?;
  let mut connection = open_connection(path)?;
  let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
  let exists: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM notes WHERE id=?1 AND is_deleted=0)", [note_id], |row| row.get(0))
    .map_err(|error| error.to_string())?;
  if !exists { return Err("La nota no existe o está en la papelera".into()); }
  let stamp = now.timestamp();
  transaction.execute(
    "INSERT INTO reminders (id, note_id, local_time, time_zone, repeat, status, next_fire_at, snoozed_until, last_fired_at, needs_attention, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'scheduled', ?6, NULL, NULL, 0, ?7, ?7)
     ON CONFLICT(note_id) DO UPDATE SET local_time=excluded.local_time, time_zone=excluded.time_zone, repeat=excluded.repeat,
       status='scheduled', next_fire_at=excluded.next_fire_at, snoozed_until=NULL, needs_attention=0, updated_at=excluded.updated_at",
    params![generate_id("reminder"), note_id, local_time, time_zone, repeat.as_str(), next.timestamp(), stamp],
  ).map_err(|error| format!("No se pudo guardar el recordatorio: {error}"))?;
  let record = reminder_for_note(&transaction, note_id)?.ok_or("No se pudo leer el recordatorio")?;
  transaction.commit().map_err(|error| error.to_string())?;
  Ok(record)
}

pub fn clear_reminder_on_path(path: &Path, note_id: &str) -> Result<Option<String>, String> {
  let connection = open_connection(path)?;
  let id: Option<String> = connection.query_row("SELECT id FROM reminders WHERE note_id=?1", [note_id], |row| row.get(0))
    .optional().map_err(|error| error.to_string())?;
  connection.execute("DELETE FROM reminders WHERE note_id=?1", [note_id]).map_err(|error| error.to_string())?;
  Ok(id)
}

/// Shows the reminder again after `minutes`; repeating reminders keep their schedule.
pub fn snooze_reminder_on_path(path: &Path, note_id: &str, minutes: i64, now: DateTime<Utc>) -> Result<ReminderRecord, String> {
  if !(1..=60 * 24 * 14).contains(&minutes) { return Err("Duración de aplazamiento no válida".into()); }
  let connection = open_connection(path)?;
  let changed = connection.execute(
    "UPDATE reminders SET snoozed_until=?1, needs_attention=0, status='scheduled', updated_at=?2 WHERE note_id=?3",
    params![(now + chrono::Duration::minutes(minutes)).timestamp(), now.timestamp(), note_id],
  ).map_err(|error| error.to_string())?;
  if changed != 1 { return Err("La nota no tiene recordatorio".into()); }
  reminder_for_note(&connection, note_id)?.ok_or_else(|| "La nota no tiene recordatorio".into())
}

/// Acknowledges the reminder: a one-off one is done, a repeating one waits for its next time.
pub fn complete_reminder_on_path(path: &Path, note_id: &str, now: DateTime<Utc>) -> Result<Option<ReminderRecord>, String> {
  let connection = open_connection(path)?;
  connection.execute(
    "UPDATE reminders SET needs_attention=0, snoozed_until=NULL, updated_at=?1,
       status = CASE WHEN repeat='none' AND (next_fire_at IS NULL OR next_fire_at <= ?1) THEN 'done' ELSE status END
     WHERE note_id=?2",
    params![now.timestamp(), note_id],
  ).map_err(|error| error.to_string())?;
  reminder_for_note(&connection, note_id)
}

/// Marks what fired since the last sweep and advances repeating reminders. Returns whether
/// anything changed (the UI then refreshes). Safe to run any number of times.
pub fn sweep_due_on_path(path: &Path, now: DateTime<Utc>) -> Result<bool, String> {
  let mut connection = open_connection(path)?;
  let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
  let stamp = now.timestamp();
  let due: Vec<ReminderRecord> = {
    let mut statement = transaction.prepare(&format!(
      "{SELECT} WHERE r.status='scheduled' AND ((r.next_fire_at IS NOT NULL AND r.next_fire_at <= ?1) OR (r.snoozed_until IS NOT NULL AND r.snoozed_until <= ?1))"
    )).map_err(|error| error.to_string())?;
    let rows = statement.query_map([stamp], read).map_err(|error| error.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|error| error.to_string())?
  };
  for reminder in &due {
    let start = schedule::parse_local(&reminder.local_time)?;
    let zone = schedule::parse_zone(&reminder.time_zone)?;
    let repeat = Repeat::parse(&reminder.repeat)?;
    let snooze_fired = reminder.snoozed_until.filter(|at| *at <= stamp);
    let regular_fired = reminder.next_fire_at.filter(|at| *at <= stamp)
      .and_then(|_| schedule::last_at_or_before(start, zone, repeat, now)).map(|at| at.timestamp());
    let fired = regular_fired.into_iter().chain(snooze_fired).max();
    let next = reminder.next_fire_at.map(|at| if at <= stamp { schedule::next_after(start, zone, repeat, now).map(|n| n.timestamp()) } else { Some(at) }).unwrap_or(None);
    let snoozed = reminder.snoozed_until.filter(|at| *at > stamp);
    transaction.execute(
      "UPDATE reminders SET next_fire_at=?1, snoozed_until=?2, last_fired_at=COALESCE(?3, last_fired_at),
         needs_attention=CASE WHEN ?3 IS NOT NULL AND ?4 = 0 THEN 1 ELSE needs_attention END, updated_at=?5 WHERE id=?6",
      params![next, snoozed, fired, reminder.note_deleted as i64, stamp, reminder.id],
    ).map_err(|error| error.to_string())?;
  }
  transaction.commit().map_err(|error| error.to_string())?;
  Ok(!due.is_empty())
}

/// Native requests for every active reminder, earliest first. Trashed notes never notify.
pub fn native_plan(connection: &Connection, now: DateTime<Utc>, native_repeats: bool) -> Result<Vec<schedule::NativeRequest>, String> {
  let mut requests = Vec::new();
  for reminder in list_reminders(connection)? {
    if reminder.status != "scheduled" || reminder.note_deleted { continue; }
    let start = schedule::parse_local(&reminder.local_time)?;
    let repeat = Repeat::parse(&reminder.repeat)?;
    requests.extend(schedule::plan_with(&reminder.id, start, &reminder.time_zone, repeat, reminder.snoozed_until.map(instant), now, native_repeats)?
      .into_iter().map(|request| schedule::NativeRequest { note_id: reminder.note_id.clone(), title: reminder.note_title.clone(), ..request }));
  }
  requests.sort_by_key(|request| request.first);
  Ok(requests)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::db::writes::SaveNoteDraft;

  fn utc(value: &str) -> DateTime<Utc> { DateTime::parse_from_rfc3339(value).unwrap().with_timezone(&Utc) }
  fn native_plan_test(connection: &Connection, now: DateTime<Utc>) -> Result<Vec<schedule::NativeRequest>, String> { native_plan(connection, now, true) }

  fn setup() -> (PathBuf, PathBuf, String) {
    let root = std::env::temp_dir().join(generate_id("reminders-test"));
    fs::create_dir_all(&root).unwrap();
    let path = root.join("notes.db");
    let connection = Connection::open(&path).unwrap();
    connection.execute_batch(include_str!("sql/0001_init.sql")).unwrap();
    for migration in migrations::sqlite_migrations().into_iter().filter(|m| m.version > 1) { connection.execute_batch(migration.sql).unwrap(); }
    let draft = SaveNoteDraft { title: "Llamar a Ana".into(), content_rich_json: r#"{"type":"doc","content":[]}"#.into(),
      content_md: String::new(), content_plain: String::new(), tags: vec![], folder_id: None };
    let note = save_note_on_path(&path, None, &draft).unwrap();
    (root, path, note)
  }

  #[test]
  fn one_off_reminder_fires_once_and_needs_attention_until_completed() {
    let (root, path, note) = setup();
    let now = utc("2026-11-18T10:00:00Z");
    let record = set_reminder_on_path(&path, &note, "2026-11-18T12:00", "Europe/Madrid", "none", now).unwrap();
    assert_eq!(record.next_fire_at, Some(utc("2026-11-18T11:00:00Z").timestamp()));
    assert!(set_reminder_on_path(&path, &note, "2026-11-18T09:00", "Europe/Madrid", "none", now).is_err());
    assert!(!sweep_due_on_path(&path, utc("2026-11-18T10:59:00Z")).unwrap());
    assert!(sweep_due_on_path(&path, utc("2026-11-18T13:00:00Z")).unwrap());
    let connection = Connection::open(&path).unwrap();
    let fired = reminder_for_note(&connection, &note).unwrap().unwrap();
    assert!(fired.needs_attention);
    assert_eq!(fired.next_fire_at, None);
    assert_eq!(fired.last_fired_at, Some(utc("2026-11-18T11:00:00Z").timestamp()));
    assert!(native_plan_test(&connection, utc("2026-11-18T13:00:00Z")).unwrap().is_empty());
    // A second sweep changes nothing (idempotent).
    assert!(!sweep_due_on_path(&path, utc("2026-11-18T14:00:00Z")).unwrap());
    let done = complete_reminder_on_path(&path, &note, utc("2026-11-18T14:00:00Z")).unwrap().unwrap();
    assert_eq!((done.status.as_str(), done.needs_attention), ("done", false));
    fs::remove_dir_all(root).unwrap();
  }

  #[test]
  fn repeating_reminders_roll_forward_and_snoozes_fire_once() {
    let (root, path, note) = setup();
    let now = utc("2026-11-18T10:00:00Z");
    set_reminder_on_path(&path, &note, "2026-11-18T12:00", "Europe/Madrid", "daily", now).unwrap();
    // The app was closed for three days.
    sweep_due_on_path(&path, utc("2026-11-21T12:00:00Z")).unwrap();
    let connection = Connection::open(&path).unwrap();
    let rolled = reminder_for_note(&connection, &note).unwrap().unwrap();
    assert_eq!(rolled.last_fired_at, Some(utc("2026-11-21T11:00:00Z").timestamp()));
    assert_eq!(rolled.next_fire_at, Some(utc("2026-11-22T11:00:00Z").timestamp()));
    assert!(rolled.needs_attention);
    let snoozed = snooze_reminder_on_path(&path, &note, 15, utc("2026-11-21T12:00:00Z")).unwrap();
    assert_eq!(snoozed.snoozed_until, Some(utc("2026-11-21T12:15:00Z").timestamp()));
    let plan = native_plan_test(&connection, utc("2026-11-21T12:00:00Z")).unwrap();
    assert_eq!(plan.iter().map(|request| request.id.ends_with(".snooze")).filter(|value| *value).count(), 1);
    sweep_due_on_path(&path, utc("2026-11-21T12:16:00Z")).unwrap();
    let after = reminder_for_note(&connection, &note).unwrap().unwrap();
    assert_eq!((after.snoozed_until, after.needs_attention, after.status.as_str()), (None, true, "scheduled"));
    fs::remove_dir_all(root).unwrap();
  }

  #[test]
  fn trashed_notes_do_not_notify_and_deleting_a_note_removes_its_reminder() {
    let (root, path, note) = setup();
    let now = utc("2026-11-18T10:00:00Z");
    set_reminder_on_path(&path, &note, "2026-11-19T09:00", "Europe/Madrid", "weekly", now).unwrap();
    change_note_state_on_path(&path, &note, NoteAction::Trash).unwrap();
    let connection = Connection::open(&path).unwrap();
    assert!(native_plan_test(&connection, now).unwrap().is_empty());
    assert!(set_reminder_on_path(&path, &note, "2026-11-19T09:00", "Europe/Madrid", "none", now).is_err());
    change_note_state_on_path(&path, &note, NoteAction::Restore).unwrap();
    assert_eq!(native_plan_test(&connection, now).unwrap().len(), 1);
    change_note_state_on_path(&path, &note, NoteAction::Trash).unwrap();
    change_note_state_on_path(&path, &note, NoteAction::Delete).unwrap();
    assert!(list_reminders(&connection).unwrap().is_empty());
    assert!(set_reminder_on_path(&path, &note, "2026-11-19T09:00", "Nowhere/City", "none", now).is_err());
    fs::remove_dir_all(root).unwrap();
  }
}
