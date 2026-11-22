//! macOS: UNUserNotificationCenter calendar triggers. The OS stores pending requests and delivers
//! them while MazmiNotas is closed or its process has exited. A Mac that is off or asleep at the
//! trigger time shows the notification when it wakes, per the system's own rules.

use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, ProtocolObject};
use objc2::{define_class, AllocAnyThread, DefinedClass};
use objc2_foundation::{NSArray, NSDateComponents, NSDictionary, NSError, NSObject, NSObjectProtocol, NSString, NSTimeZone};
use objc2_user_notifications::{
  UNAuthorizationOptions, UNAuthorizationStatus, UNCalendarNotificationTrigger, UNMutableNotificationContent, UNNotification,
  UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse, UNNotificationSettings, UNNotificationSound,
  UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};

use super::schedule::{Components, NativeRequest, Trigger};
use super::Permission;

/// Apple limits pending local notifications per app; stay under it with the earliest requests.
pub const MAX_PENDING: usize = 60;
const WAIT: Duration = Duration::from_secs(10);
const NOTE_KEY: &str = "noteId";

fn center() -> Retained<UNUserNotificationCenter> {
  UNUserNotificationCenter::currentNotificationCenter()
}

pub fn permission() -> Permission {
  let (sender, receiver) = mpsc::channel();
  let block = RcBlock::new(move |settings: std::ptr::NonNull<UNNotificationSettings>| {
    let status = unsafe { settings.as_ref() }.authorizationStatus();
    let _ = sender.send(status);
  });
  center().getNotificationSettingsWithCompletionHandler(&block);
  match receiver.recv_timeout(WAIT) {
    Ok(UNAuthorizationStatus::Authorized) | Ok(UNAuthorizationStatus::Provisional) | Ok(UNAuthorizationStatus::Ephemeral) => Permission::Granted,
    Ok(UNAuthorizationStatus::Denied) => Permission::Denied,
    Ok(_) => Permission::Unknown,
    Err(_) => Permission::Unavailable,
  }
}

/// Shows the system permission prompt the first time; later calls return the stored answer.
pub fn request_permission() -> Result<Permission, String> {
  let (sender, receiver) = mpsc::channel();
  let block = RcBlock::new(move |granted: Bool, error: *mut NSError| {
    let message = unsafe { error.as_ref() }.map(|error| error.localizedDescription().to_string());
    let _ = sender.send((granted.as_bool(), message));
  });
  center().requestAuthorizationWithOptions_completionHandler(UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound, &block);
  // The first time, a person answers the system prompt.
  match receiver.recv_timeout(Duration::from_secs(120)) {
    Ok((true, _)) => Ok(Permission::Granted),
    Ok((false, Some(message))) => Err(format!("macOS no permite las notificaciones: {message}")),
    Ok((false, None)) => Ok(Permission::Denied),
    Err(_) => Err("macOS no respondió a la solicitud de permiso".into()),
  }
}

fn date_components(components: &Components, zone: &str) -> Retained<NSDateComponents> {
  let value = NSDateComponents::new();
  if let Some(year) = components.year { value.setYear(year as isize); }
  if let Some(month) = components.month { value.setMonth(month as isize); }
  if let Some(day) = components.day { value.setDay(day as isize); }
  if let Some(weekday) = components.weekday { value.setWeekday(weekday as isize); }
  value.setHour(components.hour as isize);
  value.setMinute(components.minute as isize);
  value.setSecond(0);
  // Matching happens in the reminder's own zone, so DST and travelling keep the wall-clock time.
  if let Some(zone) = NSTimeZone::timeZoneWithName(&NSString::from_str(zone)) { value.setTimeZone(Some(&zone)); }
  value
}

pub fn add(request: &NativeRequest) -> Result<(), String> {
  let content = UNMutableNotificationContent::new();
  content.setTitle(&NSString::from_str(if request.title.trim().is_empty() { "Sin título" } else { request.title.trim() }));
  content.setBody(&NSString::from_str("Recordatorio de MazmiNotas"));
  content.setSound(Some(&UNNotificationSound::defaultSound()));
  content.setThreadIdentifier(&NSString::from_str("mazminotas.reminders"));
  let key = NSString::from_str(NOTE_KEY);
  let note = NSString::from_str(&request.note_id);
  let info: Retained<NSDictionary<NSString, NSString>> = NSDictionary::from_slices(&[&*key], &[&*note]);
  // SAFETY: a dictionary of NSString keys and values is a valid property-list userInfo.
  unsafe { content.setUserInfo(Retained::cast_unchecked::<NSDictionary>(info).as_ref()) };
  let (components, repeats) = match &request.trigger {
    Trigger::Once(components) => (components, false),
    Trigger::Repeating(components) => (components, true),
  };
  let trigger = UNCalendarNotificationTrigger::triggerWithDateMatchingComponents_repeats(&date_components(components, &request.zone), repeats);
  let native = UNNotificationRequest::requestWithIdentifier_content_trigger(&NSString::from_str(&request.id), &content, Some(&trigger));
  let (sender, receiver) = mpsc::channel();
  let block = RcBlock::new(move |error: *mut NSError| {
    let _ = sender.send(unsafe { error.as_ref() }.map(|error| error.localizedDescription().to_string()));
  });
  center().addNotificationRequest_withCompletionHandler(&native, Some(&block));
  match receiver.recv_timeout(WAIT) {
    Ok(None) => Ok(()),
    Ok(Some(message)) => Err(message),
    Err(_) => Err("macOS no confirmó la programación".into()),
  }
}

/// Replaces every pending MazmiNotas notification with `requests` (idempotent: no duplicates).
pub fn replace_all(requests: &[NativeRequest]) -> Result<usize, String> {
  center().removeAllPendingNotificationRequests();
  let mut errors = Vec::new();
  let mut scheduled = 0;
  for request in requests.iter().take(MAX_PENDING) {
    match add(request) { Ok(()) => scheduled += 1, Err(error) => errors.push(error) }
  }
  if let Some(error) = errors.first() { return Err(format!("{} de {} avisos no se programaron: {error}", errors.len(), requests.len().min(MAX_PENDING))); }
  Ok(scheduled)
}

/// Removes a reminder's notifications already shown in Notification Center.
pub fn remove_delivered(ids: &[String]) {
  let values: Vec<Retained<NSString>> = ids.iter().map(|id| NSString::from_str(id)).collect();
  let refs: Vec<&NSString> = values.iter().map(|value| &**value).collect();
  center().removeDeliveredNotificationsWithIdentifiers(&NSArray::from_slice(&refs));
}

pub fn pending_ids() -> Vec<String> {
  let (sender, receiver) = mpsc::channel();
  let block = RcBlock::new(move |requests: std::ptr::NonNull<NSArray<UNNotificationRequest>>| {
    let ids = unsafe { requests.as_ref() }.iter().map(|request| request.identifier().to_string()).collect::<Vec<_>>();
    let _ = sender.send(ids);
  });
  center().getPendingNotificationRequestsWithCompletionHandler(&block);
  receiver.recv_timeout(WAIT).unwrap_or_default()
}

/// Delivered notifications (identifier, delivery time as UNIX seconds), for diagnostics.
pub fn delivered() -> Vec<(String, f64)> {
  let (sender, receiver) = mpsc::channel();
  let block = RcBlock::new(move |list: std::ptr::NonNull<NSArray<UNNotification>>| {
    let items = unsafe { list.as_ref() }.iter()
      .map(|notification| (notification.request().identifier().to_string(), notification.date().timeIntervalSince1970()))
      .collect::<Vec<_>>();
    let _ = sender.send(items);
  });
  center().getDeliveredNotificationsWithCompletionHandler(&block);
  receiver.recv_timeout(WAIT).unwrap_or_default()
}

fn note_of(notification: &UNNotification) -> Option<String> {
  let info = notification.request().content().userInfo();
  let key = NSString::from_str(NOTE_KEY);
  // SAFETY: userInfo keys are NSString; the value is checked before use.
  let value: Option<Retained<AnyObject>> = unsafe { Retained::cast_unchecked::<NSDictionary<NSString, AnyObject>>(info) }.objectForKey(&key);
  value.and_then(|value| value.downcast::<NSString>().ok()).map(|value| value.to_string())
}

pub struct DelegateIvars {
  on_open: Box<dyn Fn(String) + Send + Sync>,
}

define_class!(
  // SAFETY: NSObject has no subclassing requirements; the delegate holds no Objective-C state.
  #[unsafe(super(NSObject))]
  #[name = "MazmiNotasNotificationDelegate"]
  #[ivars = DelegateIvars]
  struct NotificationDelegate;

  unsafe impl NSObjectProtocol for NotificationDelegate {}

  unsafe impl UNUserNotificationCenterDelegate for NotificationDelegate {
    /// Show reminders even while MazmiNotas is the frontmost app.
    #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
    fn will_present(&self, _center: &UNUserNotificationCenter, _notification: &UNNotification,
      completion: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>) {
      completion.call((UNNotificationPresentationOptions::Banner | UNNotificationPresentationOptions::List | UNNotificationPresentationOptions::Sound,));
    }

    /// Clicking the notification opens its note (also when it launched the app).
    #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
    fn did_receive(&self, _center: &UNUserNotificationCenter, response: &UNNotificationResponse, completion: &block2::DynBlock<dyn Fn()>) {
      if let Some(note) = note_of(&response.notification()) { (self.ivars().on_open)(note); }
      completion.call(());
    }
  }
);

/// Must run before the app finishes launching so a click that launched the app is delivered.
pub fn install_delegate(on_open: impl Fn(String) + Send + Sync + 'static) {
  let delegate: Retained<NotificationDelegate> = {
    let this = NotificationDelegate::alloc().set_ivars(DelegateIvars { on_open: Box::new(on_open) });
    // SAFETY: plain NSObject initialisation.
    unsafe { objc2::msg_send![super(this), init] }
  };
  center().setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
  // The center keeps a weak reference; the delegate lives for the whole process.
  std::mem::forget(delegate);
}
