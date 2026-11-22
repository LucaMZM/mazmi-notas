mod attachments;
mod commands;
mod db;
mod reminders;

/// Hidden diagnostics for verifying native reminders end to end (no database access):
/// `--reminders-selftest <seconds>` schedules one real notification and exits;
/// `--reminders-status` prints permission, pending and delivered notifications.
pub fn run_diagnostics(args: &[String]) -> Option<i32> {
  match args.get(1).map(String::as_str) {
    Some("--reminders-selftest") => {
      let seconds = args.get(2).and_then(|value| value.parse().ok()).unwrap_or(60);
      println!("permission(before): {:?}", reminders::capabilities().permission);
      match reminders::request_permission() { Ok(permission) => println!("permission: {permission:?}"), Err(error) => println!("permission error: {error}") }
      match reminders::diagnostics::schedule_test(seconds) {
        Ok(id) => { println!("scheduled: {id}"); println!("zone: {}", reminders::diagnostics::iana_zone()); }
        Err(error) => { println!("error: {error}"); return Some(1); }
      }
      println!("pending: {:?}", reminders::diagnostics::pending());
      Some(0)
    }
    // End to end on an isolated database: note + reminder -> native request -> process exits.
    Some("--reminders-e2e") => {
      let (Some(path), Some(minutes)) = (args.get(2), args.get(3).and_then(|value| value.parse::<i64>().ok())) else { return Some(2) };
      let path = std::path::Path::new(path);
      let result = (|| -> Result<String, String> {
        db::create_isolated_database(path)?;
        let draft = db::SaveNoteDraft { title: "Prueba E2E de recordatorio".into(), content_rich_json: r#"{"type":"doc","content":[]}"#.into(),
          content_md: "Comprobar la entrega con la app cerrada".into(), content_plain: String::new(), tags: vec![], folder_id: None };
        let note = db::save_note_on_path(path, None, &draft)?;
        let zone = reminders::diagnostics::iana_zone();
        let tz = reminders::schedule::parse_zone(&zone)?;
        let at = (chrono::Utc::now() + chrono::Duration::minutes(minutes)).with_timezone(&tz).format("%Y-%m-%dT%H:%M").to_string();
        let record = db::set_reminder_on_path(path, &note, &at, &zone, "none", chrono::Utc::now())?;
        let connection = db::open_reminders_connection(path)?;
        let plan = db::native_reminder_plan(&connection, chrono::Utc::now(), true)?;
        for request in &plan { reminders::diagnostics::add(request)?; }
        Ok(format!("note {note} reminder {} local {at} {zone} requests {:?}", record.id, plan.iter().map(|request| &request.id).collect::<Vec<_>>()))
      })();
      match result { Ok(message) => { println!("{message}"); Some(0) } Err(error) => { println!("error: {error}"); Some(1) } }
    }
    // After the trigger time: the restart sweep must flag the reminder as fired and needing attention.
    Some("--reminders-e2e-check") => {
      let Some(path) = args.get(2) else { return Some(2) };
      let path = std::path::Path::new(path);
      let result = (|| -> Result<String, String> {
        let changed = db::sweep_due_reminders(path, chrono::Utc::now())?;
        let connection = db::open_reminders_connection(path)?;
        let records = db::list_reminders(&connection)?;
        let delivered = reminders::diagnostics::delivered();
        let shown = records.iter().all(|record| delivered.iter().any(|(id, _)| id.contains(&record.id)));
        Ok(format!("sweep_changed {changed} delivered_by_os {shown} records {}", serde_json::to_string(&records).unwrap_or_default()))
      })();
      match result { Ok(message) => { println!("{message}"); Some(0) } Err(error) => { println!("error: {error}"); Some(1) } }
    }
    Some("--reminders-status") => {
      let capabilities = reminders::capabilities();
      println!("platform: {} works_when_closed: {} permission: {:?}", capabilities.platform, capabilities.works_when_closed, capabilities.permission);
      println!("pending: {:?}", reminders::diagnostics::pending());
      for (id, at) in reminders::diagnostics::delivered() {
        println!("delivered: {id} at {}", chrono::DateTime::from_timestamp(at as i64, 0).map(|value| value.to_rfc3339()).unwrap_or_default());
      }
      Some(0)
    }
    _ => None,
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    // Plugin setup runs in registration order, before app.setup and SQL preloading.
    .plugin(db::safety_plugin())
    .plugin(
      tauri_plugin_sql::Builder::default()
        .add_migrations("sqlite:notes.db", db::migrations::sqlite_migrations())
        .build(),
    )
    .plugin(db::validation_plugin())
    .register_uri_scheme_protocol(attachments::SCHEME, |context, request| {
      commands::serve_attachment(context.app_handle(), request.uri().path())
    })
    .invoke_handler(tauri::generate_handler![
      commands::save_note,
      commands::restore_version,
      commands::move_to_trash,
      commands::restore_note,
      commands::delete_note_permanently,
      commands::self_check,
      commands::create_folder,
      commands::rename_folder,
      commands::move_folder,
      commands::delete_folder,
      commands::move_note_to_folder,
      commands::list_reminders,
      commands::set_reminder,
      commands::clear_reminder,
      commands::snooze_reminder,
      commands::complete_reminder,
      commands::reminder_capabilities,
      commands::request_reminder_permission,
      commands::take_pending_open_note,
      commands::export_note_markdown,
      commands::export_note_docx,
      commands::save_attachment,
      commands::pick_images,
      commands::read_attachment,
      commands::lock_note,
      commands::unlock_note,
      commands::remove_note_lock,
      commands::relock_note,
      commands::backup_now,
      commands::list_backups,
      commands::restore_backup,
      commands::export_vault,
      commands::import_vault
    ])
    .setup(|app| {
      // Before launch finishes, so a notification click that launched the app is delivered.
      reminders::install();
      reminders::start(app.handle().clone());
      commands::start_attachment_cleanup(app.handle().clone());
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
