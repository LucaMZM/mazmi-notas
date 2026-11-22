use super::*;

pub fn safety_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
  tauri::plugin::Builder::new("database-safety")
    .setup(|app, _| {
      let root = app.path().app_config_dir()?;
      pre_migration_snapshot(&root.join(DB_FILE_NAME), &root.join("migration-snapshots"))
        .map_err(std::io::Error::other)?;
      Ok(())
    }).build()
}

pub fn validation_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
  tauri::plugin::Builder::new("database-validation")
    .setup(|app, _| {
      let path = app.path().app_config_dir()?.join(DB_FILE_NAME);
      let connection = open_connection(&path).map_err(std::io::Error::other)?;
      validate_foreign_keys(&connection).map_err(std::io::Error::other)?;
      Ok(())
    }).build()
}

fn pre_migration_snapshot(source: &Path, directory: &Path) -> Result<Option<PathBuf>, String> {
  if !source.try_exists().map_err(|error| error.to_string())? { return Ok(None); }
  reject_symlink(source)?;
  let connection = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)
    .map_err(|error| error.to_string())?;
  connection.busy_timeout(Duration::from_secs(5)).map_err(|error| error.to_string())?;
  let has_metadata: bool = connection.query_row(
    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='_sqlx_migrations' AND type='table')", [], |r| r.get(0),
  ).map_err(|error| error.to_string())?;
  let latest: i64 = if has_metadata {
    connection.query_row("SELECT COALESCE(MAX(version),0) FROM _sqlx_migrations WHERE success=1", [], |r| r.get(0))
      .map_err(|error| error.to_string())?
  } else { 0 };
  if latest >= migrations::LATEST_VERSION { return Ok(None); }
  fs::create_dir_all(directory).map_err(|error| error.to_string())?;
  reject_symlink(directory)?;
  let output = directory.join(format!("{}.sqlite", generate_id(&format!("before-migration-v{}", migrations::LATEST_VERSION))));
  let temporary = output.with_extension("tmp");
  drop(private_file(&temporary)?);
  // VACUUM INTO owns a consistent read snapshot, including committed WAL pages.
  // It works on a read-only source and needs no additional Cargo feature.
  connection.execute("VACUUM main INTO ?1", [temporary.to_str().ok_or("Ruta de snapshot no UTF-8")?])
    .map_err(|error| format!("Snapshot SQLite fallido: {error}"))?;
  // FTS5 integrity validation needs write access to the private copy, never to the source.
  let verification = Connection::open_with_flags(&temporary, OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(|error| error.to_string())?;
  let mut statement = verification.prepare("PRAGMA integrity_check").map_err(|error| error.to_string())?;
  let checks = statement.query_map([], |row| row.get::<_, String>(0)).map_err(|error| error.to_string())?
    .collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
  if checks != ["ok"] { return Err(format!("Snapshot no supera integrity_check: {checks:?}")); }
  drop(statement);
  drop(verification);
  fs::OpenOptions::new().write(true).open(&temporary).and_then(|file| file.sync_all()).map_err(|error| error.to_string())?;
  publish_file(&temporary, &output)?;
  Ok(Some(output))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn startup_snapshot_captures_wal_and_does_not_replay_or_change_source() {
    let root = std::env::temp_dir().join(generate_id("scribedock-startup-test"));
    fs::create_dir_all(&root).unwrap();
    let path = root.join("notes.db");
    let connection = Connection::open(&path).unwrap();
    connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;").unwrap();
    connection.execute_batch(include_str!("sql/0001_init.sql")).unwrap();
    connection.execute("INSERT INTO notes VALUES ('wal','WAL row','kept','2026-03-05T10:30:00Z','2026-03-05T10:30:00Z')", []).unwrap();
    let snapshot = pre_migration_snapshot(&path, &root.join("snapshots")).unwrap().unwrap();
    let copy = Connection::open_with_flags(&snapshot, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(copy.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0)).unwrap(), "ok");
    assert_eq!(copy.query_row("SELECT content_md FROM notes WHERE id='wal'", [], |r| r.get::<_, String>(0)).unwrap(), "kept");
    connection.prepare("SELECT created_at FROM notes").unwrap();
    assert!(connection.prepare("SELECT snapshot_md FROM note_versions").is_err());
    drop(copy);
    drop(connection);
    fs::remove_dir_all(root).unwrap();
  }

  #[test]
  fn startup_snapshot_validates_legacy_fts_without_changing_source() {
    let root = std::env::temp_dir().join(generate_id("mazminotas-startup-fts"));
    fs::create_dir_all(&root).unwrap();
    let path = root.join("notes.db");
    let connection = Connection::open(&path).unwrap();
    connection.execute_batch(include_str!("sql/0001_init.sql")).unwrap();
    connection.execute_batch(include_str!("sql/0002_v4_schema.sql")).unwrap();
    connection.execute_batch(
      "CREATE TABLE _sqlx_migrations (version INTEGER PRIMARY KEY, success INTEGER NOT NULL);
       INSERT INTO _sqlx_migrations VALUES (1, 1), (2, 1);
       INSERT INTO notes (id,title,content_rich_json,content_md,content_plain,created_at,updated_at,is_deleted,deleted_at) VALUES ('kept','Keep','', '# Original', 'Original',10,20,0,NULL);"
    ).unwrap();
    drop(connection);
    let original = fs::read(&path).unwrap();

    let snapshot = pre_migration_snapshot(&path, &root.join("snapshots")).unwrap().unwrap();

    assert_eq!(fs::read(&path).unwrap(), original, "snapshot must not modify the source database");
    let copy = Connection::open_with_flags(&snapshot, OpenFlags::SQLITE_OPEN_READ_WRITE).unwrap();
    assert_eq!(copy.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0)).unwrap(), "ok");
    assert_eq!(copy.query_row("SELECT content_md FROM notes WHERE id='kept'", [], |r| r.get::<_, String>(0)).unwrap(), "# Original");
    assert_eq!(copy.query_row("SELECT count(*) FROM notes_fts WHERE notes_fts MATCH 'Original'", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    assert!(copy.prepare("SELECT snapshot_md FROM note_versions").is_err(), "snapshot must precede migration three");
    drop(copy);
    fs::remove_dir_all(root).unwrap();
  }

  #[test]
  fn startup_snapshot_protects_migration_three_database_before_next_repair() {
    let root = std::env::temp_dir().join(generate_id("mazminotas-before-repair"));
    fs::create_dir_all(&root).unwrap();
    let path = root.join("notes.db");
    let connection = Connection::open(&path).unwrap();
    for migration in migrations::sqlite_migrations().into_iter().filter(|m| m.version <= 3) {
      connection.execute_batch(migration.sql).unwrap();
    }
    connection.execute_batch("CREATE TABLE _sqlx_migrations (version INTEGER PRIMARY KEY, success INTEGER NOT NULL); INSERT INTO _sqlx_migrations VALUES (3,1);").unwrap();
    drop(connection);
    let before = fs::read(&path).unwrap();
    assert!(pre_migration_snapshot(&path, &root.join("snapshots")).unwrap().is_some());
    assert_eq!(fs::read(&path).unwrap(), before);
    let connection = Connection::open(&path).unwrap();
    connection.execute("INSERT INTO _sqlx_migrations VALUES (?1,1)", [migrations::LATEST_VERSION]).unwrap();
    drop(connection);
    assert!(pre_migration_snapshot(&path, &root.join("snapshots")).unwrap().is_none());
    fs::remove_dir_all(root).unwrap();
  }

  #[test]
  fn absent_database_is_not_created_and_snapshot_failure_is_fatal() {
    let root = std::env::temp_dir().join(generate_id("scribedock-startup-failure"));
    fs::create_dir_all(&root).unwrap();
    let path = root.join("absent.db");
    assert_eq!(pre_migration_snapshot(&path, &root.join("snapshots")).unwrap(), None);
    assert!(!path.exists());
    let connection = Connection::open(&path).unwrap();
    connection.execute_batch("CREATE TABLE marker (value TEXT);").unwrap();
    let blocked = root.join("blocked");
    fs::write(&blocked, "not a directory").unwrap();
    assert!(pre_migration_snapshot(&path, &blocked).is_err());
    assert_eq!(connection.query_row("SELECT count(*) FROM sqlite_master WHERE name='marker'", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    drop(connection);
    fs::remove_dir_all(root).unwrap();
  }
}
