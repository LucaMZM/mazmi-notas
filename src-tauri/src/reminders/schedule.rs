//! Pure reminder time arithmetic: wall-clock times in an IANA zone, DST-aware.
//! Nothing here touches the OS, so every rule is covered by unit tests.

use chrono::{DateTime, Datelike, Duration, LocalResult, NaiveDate, NaiveDateTime, TimeZone, Timelike, Utc};
use chrono_tz::Tz;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Repeat { None, Daily, Weekly, Monthly }

impl Repeat {
  pub fn parse(value: &str) -> Result<Self, String> {
    match value {
      "none" => Ok(Self::None), "daily" => Ok(Self::Daily), "weekly" => Ok(Self::Weekly), "monthly" => Ok(Self::Monthly),
      _ => Err("Repetición no válida".into()),
    }
  }
  pub fn as_str(self) -> &'static str {
    match self { Self::None => "none", Self::Daily => "daily", Self::Weekly => "weekly", Self::Monthly => "monthly" }
  }
}

pub fn parse_zone(name: &str) -> Result<Tz, String> {
  name.parse::<Tz>().map_err(|_| format!("Zona horaria desconocida: {name}"))
}

/// `YYYY-MM-DDTHH:MM` wall-clock time.
pub fn parse_local(value: &str) -> Result<NaiveDateTime, String> {
  NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M").map_err(|_| "Fecha u hora no válidas".to_string())
}

/// The instant for a wall-clock time. Ambiguous times (clocks going back) use the first
/// occurrence; times that do not exist (clocks going forward) move to the first valid minute.
pub fn resolve(zone: Tz, local: NaiveDateTime) -> DateTime<Utc> {
  match zone.from_local_datetime(&local) {
    LocalResult::Single(value) => value.with_timezone(&Utc),
    LocalResult::Ambiguous(first, _) => first.with_timezone(&Utc),
    LocalResult::None => {
      let mut probe = local;
      for _ in 0..(24 * 60) {
        probe += Duration::minutes(1);
        if let LocalResult::Single(value) | LocalResult::Ambiguous(value, _) = zone.from_local_datetime(&probe) {
          return value.with_timezone(&Utc);
        }
      }
      zone.from_utc_datetime(&local).with_timezone(&Utc)
    }
  }
}

fn days_in_month(year: i32, month: u32) -> u32 {
  let (next_year, next_month) = if month == 12 { (year + 1, 1) } else { (year, month + 1) };
  NaiveDate::from_ymd_opt(next_year, next_month, 1).and_then(|first| first.pred_opt()).map(|last| last.day()).unwrap_or(28)
}

/// The k-th occurrence's wall-clock time (k = 0 is the start). Monthly reminders on the 29th–31st
/// fall on the last day of shorter months.
fn occurrence(start: NaiveDateTime, repeat: Repeat, k: i64) -> Option<NaiveDateTime> {
  match repeat {
    Repeat::None => (k == 0).then_some(start),
    Repeat::Daily => start.date().checked_add_signed(Duration::days(k)).map(|date| date.and_time(start.time())),
    Repeat::Weekly => start.date().checked_add_signed(Duration::weeks(k)).map(|date| date.and_time(start.time())),
    Repeat::Monthly => {
      let months = start.month0() as i64 + k;
      let year = start.year() + months.div_euclid(12) as i32;
      let month = months.rem_euclid(12) as u32 + 1;
      let day = start.day().min(days_in_month(year, month));
      NaiveDate::from_ymd_opt(year, month, day).map(|date| date.and_time(start.time()))
    }
  }
}

/// First occurrence strictly after `after`, or None when a one-off reminder already passed.
pub fn next_after(start: NaiveDateTime, zone: Tz, repeat: Repeat, after: DateTime<Utc>) -> Option<DateTime<Utc>> {
  if repeat == Repeat::None {
    let at = resolve(zone, start);
    return (at > after).then_some(at);
  }
  // Jump close to `after` instead of iterating from a start years in the past.
  let elapsed_days = (after.with_timezone(&zone).naive_local().date() - start.date()).num_days().max(0);
  let mut k = match repeat {
    Repeat::Daily => elapsed_days - 1,
    Repeat::Weekly => elapsed_days / 7 - 1,
    Repeat::Monthly => elapsed_days / 31 - 1,
    Repeat::None => 0,
  }.max(0);
  for _ in 0..400 {
    let at = resolve(zone, occurrence(start, repeat, k)?);
    if at > after { return Some(at); }
    k += 1;
  }
  None
}

/// Latest occurrence at or before `until` (used to report what fired while the app was closed).
pub fn last_at_or_before(start: NaiveDateTime, zone: Tz, repeat: Repeat, until: DateTime<Utc>) -> Option<DateTime<Utc>> {
  let first = resolve(zone, start);
  if first > until { return None; }
  if repeat == Repeat::None { return Some(first); }
  let mut previous = first;
  let mut cursor = first;
  while let Some(next) = next_after(start, zone, repeat, cursor) {
    if next > until { break; }
    previous = next;
    cursor = next;
  }
  Some(previous)
}

/// Calendar fields an OS trigger matches, interpreted in `zone`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Components {
  pub year: Option<i32>,
  pub month: Option<u32>,
  pub day: Option<u32>,
  /// 1 = Sunday … 7 = Saturday (Foundation's convention).
  pub weekday: Option<u32>,
  pub hour: u32,
  pub minute: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Trigger {
  /// Fires once at this local date and time.
  Once(Components),
  /// Fires on every match of these fields, forever, without the app running.
  Repeating(Components),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeRequest {
  pub id: String,
  pub trigger: Trigger,
  pub zone: String,
  /// The UTC instant of the (first) delivery, used to keep the earliest requests under OS limits.
  pub first: DateTime<Utc>,
  /// Filled in by the caller: the note to open and the notification title.
  pub note_id: String,
  pub title: String,
}

fn components_once(zone: Tz, at: DateTime<Utc>) -> Components {
  let local = at.with_timezone(&zone);
  Components { year: Some(local.year()), month: Some(local.month()), day: Some(local.day()), weekday: None, hour: local.hour(), minute: local.minute() }
}

fn components_repeating(start: NaiveDateTime, repeat: Repeat) -> Components {
  let base = Components { year: None, month: None, day: None, weekday: None, hour: start.hour(), minute: start.minute() };
  match repeat {
    Repeat::Weekly => Components { weekday: Some(start.weekday().number_from_sunday()), ..base },
    Repeat::Monthly => Components { day: Some(start.day()), ..base },
    _ => base,
  }
}

/// The next instant the OS would fire a repeating calendar trigger after `now`.
fn natural_next(start: NaiveDateTime, zone: Tz, repeat: Repeat, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
  let local_now = now.with_timezone(&zone).naive_local();
  let earliest_start = match repeat {
    Repeat::Daily => local_now.date() - Duration::days(1),
    Repeat::Weekly => local_now.date() - Duration::weeks(1),
    Repeat::Monthly => local_now.date() - Duration::days(62),
    Repeat::None => return None,
  };
  // Re-anchor the pattern at a past date that has the same weekday / day of month.
  let mut anchor = earliest_start;
  for _ in 0..400 {
    let matches = match repeat {
      Repeat::Weekly => anchor.weekday() == start.weekday(),
      Repeat::Monthly => anchor.day() == start.day(),
      _ => true,
    };
    if matches { break; }
    anchor += Duration::days(1);
  }
  next_after(anchor.and_time(start.time()), zone, repeat, now)
}

/// Up to this many individual one-shots are queued when a repeat cannot be a native repeating
/// trigger (a future start date, or a month day that not every month has).
pub const ONE_SHOT_HORIZON: usize = 8;

/// The OS requests that represent one reminder from `now` on. Identifiers are deterministic, so
/// re-planning replaces requests instead of duplicating them.
#[allow(dead_code)]
pub fn plan(id: &str, start: NaiveDateTime, zone_name: &str, repeat: Repeat, snoozed_until: Option<DateTime<Utc>>, now: DateTime<Utc>) -> Result<Vec<NativeRequest>, String> {
  plan_with(id, start, zone_name, repeat, snoozed_until, now, true)
}

/// `native_repeats = false` expands repeats into one-shots (for systems without repeating triggers).
pub fn plan_with(id: &str, start: NaiveDateTime, zone_name: &str, repeat: Repeat, snoozed_until: Option<DateTime<Utc>>, now: DateTime<Utc>, native_repeats: bool) -> Result<Vec<NativeRequest>, String> {
  let zone = parse_zone(zone_name)?;
  let mut requests = Vec::new();
  let request = |suffix: &str, trigger: Trigger, first: DateTime<Utc>| NativeRequest {
    id: format!("mazmi.{id}.{suffix}"), trigger, zone: zone_name.to_string(), first, note_id: String::new(), title: String::new(),
  };
  if let Some(snooze) = snoozed_until.filter(|at| *at > now) {
    requests.push(request("snooze", Trigger::Once(components_once(zone, snooze)), snooze));
  }
  let Some(first) = next_after(start, zone, repeat, now) else { return Ok(requests) };
  let repeat_natively = native_repeats && repeat != Repeat::None
    && !(repeat == Repeat::Monthly && start.day() > 28)
    && natural_next(start, zone, repeat, now) == Some(first);
  if repeat_natively {
    requests.push(request("repeat", Trigger::Repeating(components_repeating(start, repeat)), first));
  } else {
    let mut at = Some(first);
    for index in 0..ONE_SHOT_HORIZON {
      let Some(current) = at else { break };
      requests.push(request(&format!("once{index}"), Trigger::Once(components_once(zone, current)), current));
      if repeat == Repeat::None { break; }
      at = next_after(start, zone, repeat, current);
    }
  }
  Ok(requests)
}

/// Every identifier `plan` can produce for a reminder, to remove stale requests.
pub fn all_ids(id: &str) -> Vec<String> {
  let mut ids = vec![format!("mazmi.{id}.snooze"), format!("mazmi.{id}.repeat")];
  ids.extend((0..ONE_SHOT_HORIZON).map(|index| format!("mazmi.{id}.once{index}")));
  ids
}

#[cfg(test)]
mod tests {
  use super::*;

  fn utc(value: &str) -> DateTime<Utc> { DateTime::parse_from_rfc3339(value).unwrap().with_timezone(&Utc) }
  fn local(value: &str) -> NaiveDateTime { parse_local(value).unwrap() }
  const MADRID: &str = "Europe/Madrid";

  #[test]
  fn one_off_reminders_resolve_in_their_zone() {
    let zone = parse_zone(MADRID).unwrap();
    assert_eq!(resolve(zone, local("2026-07-01T09:00")), utc("2026-07-01T07:00:00Z")); // CEST, UTC+2
    assert_eq!(resolve(zone, local("2026-12-01T09:00")), utc("2026-12-01T08:00:00Z")); // CET, UTC+1
    assert_eq!(next_after(local("2026-07-01T09:00"), zone, Repeat::None, utc("2026-07-01T07:00:00Z")), None);
  }

  #[test]
  fn daylight_saving_changes_keep_the_wall_clock_time() {
    let zone = parse_zone(MADRID).unwrap();
    // Clocks go forward on 29 March 2026: 09:00 stays 09:00 local, one hour earlier in UTC.
    let start = local("2026-03-27T09:00");
    let before = next_after(start, zone, Repeat::Daily, utc("2026-03-28T09:00:00Z")).unwrap();
    assert_eq!(before, utc("2026-03-29T07:00:00Z"));
    assert_eq!(next_after(start, zone, Repeat::Daily, utc("2026-03-28T07:59:00Z")).unwrap(), utc("2026-03-28T08:00:00Z"));
    // 02:30 does not exist that day: it moves to 03:00 local.
    assert_eq!(resolve(zone, local("2026-03-29T02:30")), utc("2026-03-29T01:00:00Z"));
    // 02:30 happens twice on 25 October 2026: the first one is used.
    assert_eq!(resolve(zone, local("2026-10-25T02:30")), utc("2026-10-25T00:30:00Z"));
  }

  #[test]
  fn weekly_and_monthly_repeats() {
    let zone = parse_zone("America/New_York").unwrap();
    let wednesday = local("2026-11-18T18:30");
    assert_eq!(next_after(wednesday, zone, Repeat::Weekly, utc("2026-11-19T00:00:00Z")).unwrap(), utc("2026-11-25T23:30:00Z"));
    let end_of_month = local("2026-01-31T08:00");
    let after_jan = next_after(end_of_month, zone, Repeat::Monthly, utc("2026-02-01T00:00:00Z")).unwrap();
    assert_eq!(after_jan.with_timezone(&zone).day(), 28);
    let march = next_after(end_of_month, zone, Repeat::Monthly, after_jan).unwrap();
    assert_eq!(march.with_timezone(&zone).day(), 31);
  }

  #[test]
  fn last_occurrence_reports_what_fired_while_closed() {
    let zone = parse_zone(MADRID).unwrap();
    let start = local("2026-11-01T08:00");
    assert_eq!(last_at_or_before(start, zone, Repeat::Daily, utc("2026-11-05T12:00:00Z")), Some(utc("2026-11-05T07:00:00Z")));
    assert_eq!(last_at_or_before(start, zone, Repeat::Daily, utc("2026-10-31T12:00:00Z")), None);
  }

  #[test]
  fn plans_native_repeating_triggers_when_possible() {
    let now = utc("2026-11-18T10:00:00Z");
    let plan = plan("r", local("2026-11-01T08:00"), MADRID, Repeat::Daily, None, now).unwrap();
    assert_eq!(plan.len(), 1);
    assert_eq!(plan[0].id, "mazmi.r.repeat");
    assert!(matches!(&plan[0].trigger, Trigger::Repeating(c) if c.hour == 8 && c.minute == 0 && c.day.is_none()));
    let weekly = plan_for("2026-11-18T18:30", Repeat::Weekly, now);
    assert!(matches!(&weekly[0].trigger, Trigger::Repeating(c) if c.weekday == Some(4)));
  }

  fn plan_for(start: &str, repeat: Repeat, now: DateTime<Utc>) -> Vec<NativeRequest> {
    plan("r", local(start), MADRID, repeat, None, now).unwrap()
  }

  #[test]
  fn future_starts_and_month_ends_use_individual_one_shots() {
    let now = utc("2026-11-18T10:00:00Z");
    let future = plan_for("2027-02-10T09:00", Repeat::Weekly, now);
    assert_eq!(future.len(), ONE_SHOT_HORIZON);
    assert!(future.iter().all(|request| matches!(request.trigger, Trigger::Once(_))));
    assert_eq!(future[0].first, utc("2027-02-10T08:00:00Z"));
    let month_end = plan_for("2026-11-30T09:00", Repeat::Monthly, now);
    assert!(matches!(&month_end[2].trigger, Trigger::Once(c) if c.month == Some(1) && c.day == Some(30)));
    assert!(matches!(&month_end[3].trigger, Trigger::Once(c) if c.month == Some(2) && c.day == Some(28)));
    let once = plan_for("2026-11-20T09:00", Repeat::None, now);
    assert_eq!(once.len(), 1);
    assert!(matches!(&once[0].trigger, Trigger::Once(c) if c.year == Some(2026) && c.day == Some(20) && c.hour == 9));
    assert!(plan_for("2026-11-01T09:00", Repeat::None, now).is_empty());
  }

  #[test]
  fn systems_without_repeating_triggers_get_upcoming_one_shots() {
    let now = utc("2026-11-18T10:00:00Z");
    let expanded = plan_with("r", local("2026-11-01T08:00"), MADRID, Repeat::Daily, None, now, false).unwrap();
    assert_eq!(expanded.len(), ONE_SHOT_HORIZON);
    assert_eq!(expanded[0].first, utc("2026-11-19T07:00:00Z"));
    assert_eq!(expanded[1].first, utc("2026-11-20T07:00:00Z"));
  }

  #[test]
  fn snoozing_adds_one_request_and_ids_are_stable() {
    let now = utc("2026-11-18T10:00:00Z");
    let snoozed = plan("r", local("2026-11-18T12:30"), MADRID, Repeat::None, Some(utc("2026-11-18T10:15:00Z")), now).unwrap();
    assert_eq!(snoozed.iter().map(|request| request.id.as_str()).collect::<Vec<_>>(), vec!["mazmi.r.snooze", "mazmi.r.once0"]);
    assert!(all_ids("r").iter().all(|id| id.starts_with("mazmi.r.")));
    assert!(parse_zone("Mars/Base").is_err());
    assert!(parse_local("2026-02-30T10:00").is_err());
  }
}
