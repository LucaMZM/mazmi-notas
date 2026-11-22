use super::*;

struct TestDb {
  root: PathBuf,
  path: PathBuf,
}

impl TestDb {
  fn current() -> Self {
    let db = Self::legacy_v4();
    let connection = Connection::open(&db.path).unwrap();
    for migration in migrations::sqlite_migrations().into_iter().filter(|m| m.version > 2) {
      connection.execute_batch(migration.sql).unwrap();
    }
    connection.pragma_update(None, "user_version", 2).unwrap();
    db
  }

  fn legacy_v4() -> Self {
    let root = std::env::temp_dir().join(generate_id("scribedock-regression"));
    fs::create_dir_all(&root).unwrap();
    let path = root.join("notes.db");
    let connection = Connection::open(&path).unwrap();
    connection.execute_batch(include_str!("sql/0001_init.sql")).unwrap();
    connection.execute_batch(include_str!("sql/0002_v4_schema.sql")).unwrap();
    connection.pragma_update(None, "user_version", 1).unwrap();
    Self { root, path }
  }
}

impl Drop for TestDb {
  fn drop(&mut self) {
    let _ = fs::remove_dir_all(&self.root);
  }
}

#[test]
fn opening_sqlx_v4_never_replays_legacy_migrations() {
  let db = TestDb::legacy_v4();
  let connection = Connection::open(&db.path).unwrap();
  connection.execute("INSERT INTO notes (id,title,content_rich_json,content_md,content_plain,created_at,updated_at,is_deleted,deleted_at) VALUES ('n','Keep','rich','markdown','plain',10,20,1,20)", []).unwrap();
  drop(connection);
  // A pre-v3 schema may be rejected, but validation must never mutate it.
  let _ = open_connection(&db.path);
  let connection = Connection::open(&db.path).unwrap();
  let row: (String, i64, Option<i64>) = connection.query_row(
    "SELECT content_rich_json,is_deleted,deleted_at FROM notes WHERE id='n'", [],
    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
  ).unwrap();
  assert_eq!(row, ("rich".to_string(), 1, Some(20)));
  assert_eq!(connection.query_row("SELECT count(*) FROM sqlite_master WHERE type='trigger'", [], |r| r.get::<_, i64>(0)).unwrap(), 6);
}

#[test]
fn opening_missing_database_does_not_create_one() {
  let db = TestDb::legacy_v4();
  let missing = db.root.join("missing.db");
  assert!(open_connection(&missing).is_err());
  assert!(!missing.exists());
}

#[test]
fn frontmatter_accepts_crlf_and_preserves_unterminated_body() {
  let (id, tags, body) = split_frontmatter("\u{feff}---\r\nid: stable\r\ntags: [qa]\r\n---\r\n# Title\r\nBody");
  assert_eq!(id.as_deref(), Some("stable"));
  assert_eq!(tags, vec!["qa"]);
  assert_eq!(body, "# Title\nBody");
  let raw = "---\nid: keep\nThis is not closed";
  assert_eq!(split_frontmatter(raw).2, raw);
}

#[test]
fn migration_three_repairs_partial_v4_without_touching_note_data() {
  let db = TestDb::legacy_v4();
  let connection = Connection::open(&db.path).unwrap();
  connection.execute("INSERT INTO notes (id,title,content_rich_json,content_md,content_plain,created_at,updated_at,is_deleted,deleted_at) VALUES ('n','Keep','rich','markdown','plain',2026,2026,1,20)", []).unwrap();
  connection.execute_batch("DROP TRIGGER notes_ai; DROP TRIGGER notes_au; DROP INDEX idx_notes_title;").unwrap();
  let migrations = migrations::sqlite_migrations();
  let repair = migrations.iter().find(|m| m.version == 3);
  assert!(repair.is_some(), "a repair migration is required, not a user_version bump");
  connection.execute_batch(repair.unwrap().sql).unwrap();
  let row: (String, i64, i64) = connection.query_row(
    "SELECT content_rich_json,is_deleted,created_at FROM notes", [],
    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
  ).unwrap();
  assert_eq!(row, ("rich".to_string(), 1, 2026));
  assert_eq!(connection.query_row("SELECT count(*) FROM sqlite_master WHERE type='trigger'", [], |r| r.get::<_, i64>(0)).unwrap(), 6);
  connection.prepare("SELECT snapshot_md FROM note_versions").unwrap();
  connection.execute("UPDATE notes SET is_deleted=0 WHERE id='n'", []).unwrap();
  assert_eq!(connection.query_row("SELECT count(*) FROM notes_fts WHERE notes_fts MATCH 'plain'", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
}

#[test]
fn restore_rejects_unknown_payload_version_without_deleting_notes() {
  let db = TestDb::current();
  let connection = Connection::open(&db.path).unwrap();
  connection.pragma_update(None, "user_version", 2).unwrap();
  connection.execute("INSERT INTO notes (id,title,content_rich_json,content_md,content_plain,created_at,updated_at,is_deleted,deleted_at) VALUES ('n','Keep','rich','markdown','plain',10,20,0,NULL)", []).unwrap();
  let mut payload = collect_backup_payload(&connection).unwrap();
  payload.version = 999;
  payload.notes.clear();
  let file = db.root.join("invalid.json");
  fs::write(&file, serde_json::to_vec(&payload).unwrap()).unwrap();
  assert!(restore_backup(&db.path, &file).is_err());
  assert_eq!(connection.query_row("SELECT count(*) FROM notes", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
}

#[test]
fn consecutive_backups_never_overwrite_the_same_file() {
  let db = TestDb::current();
  Connection::open(&db.path).unwrap().pragma_update(None, "user_version", 2).unwrap();
  let first = backup_now(&db.path, &db.root).unwrap();
  let second = backup_now(&db.path, &db.root).unwrap();
  assert_ne!(first, second);
  assert!(first.is_file() && second.is_file());
}

#[test]
fn backup_preserves_every_existing_file_without_rotation() {
  let db = TestDb::current();
  let directory = db.root.join("backups");
  fs::create_dir(&directory).unwrap();
  for index in 0..35 {
    fs::write(directory.join(format!("backup-{index:03}.json")), format!("original-{index}")).unwrap();
  }
  backup_now(&db.path, &directory).unwrap();
  for index in 0..35 {
    assert_eq!(fs::read_to_string(directory.join(format!("backup-{index:03}.json"))).unwrap(), format!("original-{index}"));
  }
  assert_eq!(list_backups(&directory).unwrap().len(), 36);
}

#[test]
fn restore_creates_recovery_and_rolls_back_invalid_foreign_keys() {
  let db = TestDb::current();
  let connection = Connection::open(&db.path).unwrap();
  connection.execute("INSERT INTO notes (id,title,content_rich_json,content_md,content_plain,created_at,updated_at,is_deleted,deleted_at) VALUES ('n','Keep','rich','markdown','plain',10,20,0,NULL)", []).unwrap();
  let mut payload = collect_backup_payload(&connection).unwrap();
  payload.notes[0].title = "Restored".into();
  let file = db.root.join("restore.json");
  fs::write(&file, serde_json::to_vec(&payload).unwrap()).unwrap();
  restore_backup(&db.path, &file).unwrap();
  let recovery = db.root.join("recovery-backups");
  assert!(recovery.is_dir(), "restore must preserve the pre-restore state");
  let old: BackupPayload = serde_json::from_str(&fs::read_to_string(list_backups(&recovery).unwrap().first().unwrap()).unwrap()).unwrap();
  assert_eq!(old.notes[0].title, "Keep");
  payload.note_tags.push(BackupNoteTag { note_id: "missing".into(), tag_id: "missing".into() });
  fs::write(&file, serde_json::to_vec(&payload).unwrap()).unwrap();
  assert!(restore_backup(&db.path, &file).is_err());
  assert_eq!(connection.query_row("SELECT title FROM notes WHERE id='n'", [], |r| r.get::<_, String>(0)).unwrap(), "Restored");
}

#[test]
fn import_creates_recovery_and_resolves_forward_wikilinks() {
  let db = TestDb::current();
  let vault = db.root.join("input");
  fs::create_dir(&vault).unwrap();
  fs::write(vault.join("a.md"), "---\nid: a\n---\n# Alpha\n[[Zeta]]").unwrap();
  fs::write(vault.join("z.md"), "---\nid: z\n---\n# Zeta\nTarget").unwrap();
  import_vault_from_directory(&db.path, &vault).unwrap();
  assert!(db.root.join("recovery-backups").is_dir());
  let connection = Connection::open(&db.path).unwrap();
  assert_eq!(connection.query_row("SELECT count(*) FROM note_links WHERE from_note_id='a' AND to_note_id='z'", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
}

#[cfg(unix)]
#[test]
fn recursive_import_rejects_symlink_cycles() {
  let db = TestDb::current();
  let vault = db.root.join("input");
  fs::create_dir(&vault).unwrap();
  std::os::unix::fs::symlink(&vault, vault.join("cycle")).unwrap();
  let mut files = Vec::new();
  assert!(recursive_note_files(&vault, &mut files).is_err());
}

#[cfg(unix)]
#[test]
fn export_rejects_symlinked_notes_directory() {
  let db = TestDb::current();
  let output = db.root.join("output");
  let outside = db.root.join("outside");
  fs::create_dir(&output).unwrap();
  fs::create_dir(&outside).unwrap();
  std::os::unix::fs::symlink(&outside, output.join("notes")).unwrap();
  assert!(export_vault_to_directory(&db.path, &output).is_err());
}

fn draft(text: &str) -> SaveNoteDraft {
  SaveNoteDraft {
    title: "Saved".into(),
    content_rich_json: serde_json::json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":text}]}]}).to_string(),
    content_md: format!("**{text}**"), content_plain: text.into(), tags: vec!["QA".into()], folder_id: None,
  }
}

fn legacy_replay_damage() -> TestDb {
  let db = TestDb::legacy_v4();
  let connection = Connection::open(&db.path).unwrap();
  connection.execute_batch(
    "INSERT INTO notes (id,title,content_rich_json,content_md,content_plain,created_at,updated_at,is_deleted,deleted_at) VALUES ('target','Target','','target','target',10,20,0,NULL);
     INSERT INTO notes (id,title,content_rich_json,content_md,content_plain,created_at,updated_at,is_deleted,deleted_at) VALUES ('source','Source','','[[Target]]','Target',10,20,0,NULL);
     INSERT INTO tags VALUES ('tag','kept');
     INSERT INTO note_tags VALUES ('source','tag');
     INSERT INTO note_versions VALUES ('version','source','legacy-rich','legacy plain',10);
     INSERT INTO note_links VALUES ('source','target','Target');"
  ).unwrap();
  // The former raw runner renamed the parent a second time, then failed after dropping it.
  let error = connection.execute_batch(include_str!("sql/0002_v4_schema.sql")).unwrap_err();
  assert!(error.to_string().contains("note_versions already exists"));
  let migration = migrations::sqlite_migrations().into_iter().find(|m| m.version == 3).unwrap();
  connection.execute_batch(migration.sql).unwrap();
  db
}

#[test]
fn repair_preserves_legacy_data_and_allows_native_note_lifecycle() {
  let db = legacy_replay_damage();
  let mut connection = Connection::open(&db.path).unwrap();
  let mut before = collect_backup_payload(&connection).unwrap();
  before.exported_at = 0;
  connection.pragma_update(None, "foreign_keys", true).unwrap();
  let transaction = connection.transaction().unwrap();
  for migration in migrations::sqlite_migrations().into_iter().filter(|m| m.version > 3) {
    transaction.execute_batch(migration.sql).unwrap();
  }
  transaction.commit().unwrap();
  let mut after = collect_backup_payload(&connection).unwrap();
  after.exported_at = 0;
  assert_eq!(serde_json::to_value(before).unwrap(), serde_json::to_value(after).unwrap());

  drop(connection);
  exercise_native_note_lifecycle(&db.path);
}

fn exercise_native_note_lifecycle(path: &Path) {
  let connection = open_connection(path).unwrap();
  let mut before = collect_backup_payload(&connection).unwrap();
  before.exported_at = 0;
  let mut target = draft("target");
  target.title = generate_id("diagnostic-target");
  let target_id = save_note_on_path(path, None, &target).unwrap();
  let id = save_note_on_path(path, None, &draft("before")).unwrap();
  let version: String = connection.query_row("SELECT id FROM note_versions WHERE note_id=?1", [&id], |r| r.get(0)).unwrap();
  save_note_on_path(path, Some(&id), &draft(&format!("[[{}]]", target.title))).unwrap();
  assert_eq!(connection.query_row("SELECT count(*) FROM note_links WHERE from_note_id=?1 AND to_note_id=?2", params![id,target_id], |r| r.get::<_, i64>(0)).unwrap(), 1);
  restore_version_on_path(path, &id, &version).unwrap();
  assert_eq!(connection.query_row("SELECT content_md FROM notes WHERE id=?1", [&id], |r| r.get::<_, String>(0)).unwrap(), "**before**");
  assert_eq!(load_tags_for_note(&connection, &id).unwrap(), vec!["qa"]);
  change_note_state_on_path(path, &id, NoteAction::Trash).unwrap();
  change_note_state_on_path(path, &id, NoteAction::Restore).unwrap();
  drop(connection);
  let connection = open_connection(path).unwrap();
  assert_eq!(connection.query_row("SELECT content_md FROM notes WHERE id=?1", [&id], |r| r.get::<_, String>(0)).unwrap(), "**before**");
  change_note_state_on_path(path, &id, NoteAction::Trash).unwrap();
  change_note_state_on_path(path, &id, NoteAction::Delete).unwrap();
  change_note_state_on_path(path, &target_id, NoteAction::Trash).unwrap();
  change_note_state_on_path(path, &target_id, NoteAction::Delete).unwrap();
  assert_eq!(connection.query_row("SELECT count(*) FROM note_versions WHERE note_id=?1", [&id], |r| r.get::<_, i64>(0)).unwrap(), 0);
  validate_foreign_keys(&connection).unwrap();
  // Diagnostic tags can remain after deleting the diagnostic notes; no original data may change.
  let mut after = collect_backup_payload(&connection).unwrap();
  after.exported_at = 0;
  after.tags.retain(|tag| before.tags.iter().any(|original| original.id == tag.id));
  assert!(serde_json::to_value(before).unwrap() == serde_json::to_value(after).unwrap(), "original rows changed during the diagnostic lifecycle");
}

#[test]
#[ignore = "requires MAZMINOTAS_LEGACY_COPY pointing to an offline SQLite copy"]
fn native_lifecycle_on_offline_incident_copy() {
  let source = std::env::var_os("MAZMINOTAS_LEGACY_COPY").expect("supply an offline database copy");
  let root = std::env::temp_dir().join(generate_id("mazminotas-offline-diagnostic"));
  fs::create_dir_all(&root).unwrap();
  let db = TestDb { path: root.join("notes.db"), root };
  fs::copy(source, &db.path).unwrap();
  let mut connection = Connection::open(&db.path).unwrap();
  connection.pragma_update(None, "foreign_keys", true).unwrap();
  let latest: i64 = connection.query_row("SELECT MAX(version) FROM _sqlx_migrations WHERE success=1", [], |r| r.get(0)).unwrap();
  let mut before = collect_backup_payload(&connection).unwrap();
  before.exported_at = 0;
  let transaction = connection.transaction().unwrap();
  for migration in migrations::sqlite_migrations().into_iter().filter(|m| m.version > latest) {
    transaction.execute_batch(migration.sql).unwrap();
  }
  transaction.commit().unwrap();
  let mut after = collect_backup_payload(&connection).unwrap();
  after.exported_at = 0;
  assert!(serde_json::to_value(before).unwrap() == serde_json::to_value(after).unwrap(), "repair changed original rows");
  drop(connection);
  exercise_native_note_lifecycle(&db.path);
}

#[test]
fn repair_rolls_back_without_losing_rows_when_a_child_is_orphaned() {
  let db = legacy_replay_damage();
  let mut connection = Connection::open(&db.path).unwrap();
  connection.pragma_update(None, "foreign_keys", false).unwrap();
  connection.execute("UPDATE note_links SET to_note_id='missing'", []).unwrap();
  let mut before = collect_backup_payload(&connection).unwrap();
  before.exported_at = 0;
  connection.pragma_update(None, "foreign_keys", true).unwrap();
  let transaction = connection.transaction().unwrap();
  let migration = migrations::sqlite_migrations().into_iter().find(|m| m.version == 4).unwrap();
  assert!(transaction.execute_batch(migration.sql).is_err());
  transaction.rollback().unwrap();
  let mut after = collect_backup_payload(&connection).unwrap();
  after.exported_at = 0;
  assert_eq!(serde_json::to_value(before).unwrap(), serde_json::to_value(after).unwrap());
  assert!(connection.prepare("SELECT * FROM note_versions_repaired").is_err());
  let parent: String = connection.query_row("SELECT \"table\" FROM pragma_foreign_key_list('note_versions')", [], |r| r.get(0)).unwrap();
  assert_eq!(parent, "notes_legacy");
}

#[test]
fn schema_validation_rejects_missing_foreign_key_parents_even_with_empty_tables() {
  let db = legacy_replay_damage();
  let connection = Connection::open(&db.path).unwrap();
  connection.execute_batch("PRAGMA foreign_keys=OFF; DELETE FROM note_versions; DELETE FROM note_links;").unwrap();
  validate_foreign_keys(&connection).unwrap();
  assert!(validate_schema(&connection).is_err(), "empty tables must not hide references to notes_legacy");
}

#[test]
fn save_is_atomic_when_version_insertion_fails() {
  let db = TestDb::current();
  let id = save_note_on_path(&db.path, None, &draft("before")).unwrap();
  let connection = Connection::open(&db.path).unwrap();
  // An older session whose last snapshot differs from the note: this save must snapshot it.
  connection.execute("UPDATE note_versions SET created_at=created_at-?1, snapshot_md='older'", [writes::VERSION_SESSION_SECONDS + 1]).unwrap();
  connection.execute_batch("CREATE TRIGGER fail_version BEFORE INSERT ON note_versions BEGIN SELECT RAISE(ABORT,'injected failure'); END;").unwrap();
  let mut changed = draft("after");
  changed.tags = vec!["changed".into()];
  assert!(save_note_on_path(&db.path, Some(&id), &changed).is_err());
  assert_eq!(connection.query_row("SELECT content_md FROM notes WHERE id=?1", [&id], |r| r.get::<_, String>(0)).unwrap(), "**before**");
  assert_eq!(connection.query_row("SELECT t.name FROM tags t JOIN note_tags nt ON nt.tag_id=t.id WHERE nt.note_id=?1", [&id], |r| r.get::<_, String>(0)).unwrap(), "qa");
  assert!(save_note_on_path(&db.path, None, &draft("new")).is_err());
  assert_eq!(connection.query_row("SELECT count(*) FROM notes", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
}

#[test]
fn save_preserves_exact_markdown_and_reconciles_forward_links() {
  let db = TestDb::current();
  let mut source = draft("[[Target]]");
  source.content_md = "3. exact\n4. numbering\n\n[[Target]]\n".into();
  let id = save_note_on_path(&db.path, None, &source).unwrap();
  let mut target = draft("target");
  target.title = "Target".into();
  let target_id = save_note_on_path(&db.path, None, &target).unwrap();
  let connection = Connection::open(&db.path).unwrap();
  assert_eq!(connection.query_row("SELECT snapshot_md FROM note_versions WHERE note_id=?1", [&id], |r| r.get::<_, String>(0)).unwrap(), source.content_md);
  assert_eq!(connection.query_row("SELECT count(*) FROM note_links WHERE from_note_id=?1 AND to_note_id=?2", params![id,target_id], |r| r.get::<_, i64>(0)).unwrap(), 1);
}

#[test]
fn restore_version_preserves_pre_restore_and_legacy_plain_fallback() {
  let db = TestDb::current();
  let id = save_note_on_path(&db.path, None, &draft("current")).unwrap();
  let connection = Connection::open(&db.path).unwrap();
  connection.execute("INSERT INTO note_versions (id,note_id,snapshot_rich_json,snapshot_plain,snapshot_md,created_at) VALUES ('legacy',?1,'legacy-rich','legacy plain',NULL,1)", [&id]).unwrap();
  restore_version_on_path(&db.path, &id, "legacy").unwrap();
  assert_eq!(connection.query_row("SELECT content_md FROM notes WHERE id=?1", [&id], |r| r.get::<_, String>(0)).unwrap(), "legacy plain");
  assert_eq!(connection.query_row("SELECT count(*) FROM note_versions WHERE note_id=?1 AND snapshot_md='**current**'", [&id], |r| r.get::<_, i64>(0)).unwrap(), 2);
  connection.execute("UPDATE note_versions SET snapshot_md='3. exact\n4. text' WHERE id='legacy'", []).unwrap();
  restore_version_on_path(&db.path, &id, "legacy").unwrap();
  assert_eq!(connection.query_row("SELECT content_md FROM notes WHERE id=?1", [&id], |r| r.get::<_, String>(0)).unwrap(), "3. exact\n4. text");
}

#[test]
fn trash_restore_and_delete_are_checked_native_operations() {
  let db = TestDb::current();
  let id = save_note_on_path(&db.path, None, &draft("current")).unwrap();
  assert!(change_note_state_on_path(&db.path, &id, NoteAction::Delete).is_err());
  change_note_state_on_path(&db.path, &id, NoteAction::Trash).unwrap();
  let connection = Connection::open(&db.path).unwrap();
  assert_eq!(connection.query_row("SELECT count(*) FROM notes_fts", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
  change_note_state_on_path(&db.path, &id, NoteAction::Restore).unwrap();
  assert_eq!(connection.query_row("SELECT count(*) FROM notes_fts", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
  change_note_state_on_path(&db.path, &id, NoteAction::Trash).unwrap();
  change_note_state_on_path(&db.path, &id, NoteAction::Delete).unwrap();
  assert_eq!(connection.query_row("SELECT count(*) FROM note_versions", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
  assert!(change_note_state_on_path(&db.path, "missing", NoteAction::Restore).is_err());
}

#[test]
fn vault_roundtrip_preserves_title_tags_and_markdown_whitespace() {
  let source = TestDb::current();
  let target = TestDb::current();
  let markdown = "    indented code\n\n\ntrailing spaces  \n\n";
  let title = "Título \"personal\": sin heading";
  let rich = serde_json::json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":markdown}]}]}).to_string();
  let id = save_note_on_path(&source.path, None, &SaveNoteDraft {
    title: title.into(), content_rich_json: rich, content_md: markdown.into(),
    content_plain: markdown.into(), tags: vec!["c++".into(), "tag, with comma".into()], folder_id: None,
  }).unwrap();
  let directory = source.root.join("export");
  fs::create_dir(&directory).unwrap();
  export_vault_to_directory(&source.path, &directory).unwrap();
  import_vault_from_directory(&target.path, &directory).unwrap();
  let connection = open_connection(&target.path).unwrap();
  let actual: (String,String) = connection.query_row(
    "SELECT title,content_md FROM notes WHERE id=?1", [&id], |row| Ok((row.get(0)?,row.get(1)?)),
  ).unwrap();
  assert_eq!(actual, (title.into(),markdown.into()));
  assert_eq!(load_tags_for_note(&connection,&id).unwrap(), vec!["c++", "tag, with comma"]);
}

#[test]
fn autosaves_within_a_session_extend_one_version_and_keep_the_previous_state() {
  let db = TestDb::current();
  let id = save_note_on_path(&db.path, None, &draft("first")).unwrap();
  for text in ["second", "third", "fourth"] { save_note_on_path(&db.path, Some(&id), &draft(text)).unwrap(); }
  let connection = Connection::open(&db.path).unwrap();
  let count = |connection: &Connection| connection
    .query_row("SELECT count(*) FROM note_versions WHERE note_id=?1", [&id], |r| r.get::<_, i64>(0)).unwrap();
  assert_eq!(count(&connection), 1);
  assert_eq!(connection.query_row("SELECT snapshot_md FROM note_versions WHERE note_id=?1", [&id], |r| r.get::<_, String>(0)).unwrap(), "**first**");

  // A later session records the state it started from, once.
  connection.execute("UPDATE note_versions SET created_at=created_at-?1 WHERE note_id=?2", rusqlite::params![writes::VERSION_SESSION_SECONDS + 1, &id]).unwrap();
  save_note_on_path(&db.path, Some(&id), &draft("fifth")).unwrap();
  save_note_on_path(&db.path, Some(&id), &draft("sixth")).unwrap();
  assert_eq!(count(&connection), 2);
  let recent: Vec<String> = connection.prepare("SELECT snapshot_md FROM note_versions WHERE note_id=?1 ORDER BY created_at DESC, rowid DESC").unwrap()
    .query_map([&id], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
  assert_eq!(recent, vec!["**fourth**", "**first**"]);
  assert_eq!(connection.query_row("SELECT content_md FROM notes WHERE id=?1", [&id], |r| r.get::<_, String>(0)).unwrap(), "**sixth**");
}

#[test]
fn folders_survive_backup_restore_and_vault_roundtrip() {
  let db = TestDb::current();
  let work = create_folder_on_path(&db.path, "Trabajo", None).unwrap();
  let projects = create_folder_on_path(&db.path, "Proyectos", Some(&work)).unwrap();
  let mut inner = draft("dentro");
  inner.folder_id = Some(projects.clone());
  let id = save_note_on_path(&db.path, None, &inner).unwrap();
  let backup = backup_now(&db.path, &db.root.join("backups")).unwrap();
  delete_folder_on_path(&db.path, &projects).unwrap();
  delete_folder_on_path(&db.path, &work).unwrap();
  restore_backup(&db.path, &backup).unwrap();
  let connection = Connection::open(&db.path).unwrap();
  assert_eq!(connection.query_row("SELECT folder_id FROM notes WHERE id=?1", [&id], |r| r.get::<_, Option<String>>(0)).unwrap(), Some(projects.clone()));
  assert_eq!(connection.query_row("SELECT count(*) FROM folders", [], |r| r.get::<_, i64>(0)).unwrap(), 2);

  // Vault export writes the folder path; importing into an empty library rebuilds it.
  let vault = db.root.join("vault");
  export_vault_to_directory(&db.path, &vault).unwrap();
  let exported = fs::read_dir(vault.join("notes")).unwrap().next().unwrap().unwrap().path();
  assert!(fs::read_to_string(&exported).unwrap().contains("folder: [\"Trabajo\",\"Proyectos\"]"));
  connection.execute_batch("PRAGMA foreign_keys=ON; DELETE FROM note_versions; DELETE FROM note_tags; DELETE FROM note_links; DELETE FROM notes; DELETE FROM folders;").unwrap();
  import_vault_from_directory(&db.path, &vault).unwrap();
  let folder: String = connection.query_row("SELECT folder_id FROM notes WHERE id=?1", [&id], |r| r.get(0)).unwrap();
  assert_eq!(folders::folder_path(&connection, &folder).unwrap(), vec!["Trabajo", "Proyectos"]);
}

#[test]
fn backups_from_before_folders_still_restore() {
  let db = TestDb::current();
  let id = save_note_on_path(&db.path, None, &draft("antigua")).unwrap();
  let backup = backup_now(&db.path, &db.root.join("backups")).unwrap();
  let mut json: serde_json::Value = serde_json::from_str(&fs::read_to_string(&backup).unwrap()).unwrap();
  json["version"] = 2.into();
  json.as_object_mut().unwrap().remove("folders");
  for note in json["notes"].as_array_mut().unwrap() { note.as_object_mut().unwrap().remove("folder_id"); }
  fs::write(&backup, serde_json::to_vec(&json).unwrap()).unwrap();
  restore_backup(&db.path, &backup).unwrap();
  let connection = Connection::open(&db.path).unwrap();
  assert_eq!(connection.query_row("SELECT content_md FROM notes WHERE id=?1", [&id], |r| r.get::<_, String>(0)).unwrap(), "**antigua**");
}

const TEST_PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01\x08\x06\0\0\0\x1f\x15\xc4\x89\0\0\0\rIDATx\x9cc\xf8\xcf\xc0\xf0\x1f\0\x05\0\x01\xff\x89\x99=\x1d\0\0\0\0IEND\xaeB`\x82";

fn note_with_image(db: &TestDb) -> (String, String) {
  let name = crate::attachments::store(&crate::attachments::directory(&db.path), TEST_PNG).unwrap();
  let mut with_image = draft("con imagen");
  with_image.content_md = format!("Antes\n\n![Plano](attachment:{name})");
  let id = save_note_on_path(&db.path, None, &with_image).unwrap();
  (id, name)
}

#[test]
fn backups_carry_images_and_restore_them_on_another_machine() {
  let db = TestDb::current();
  let (id, name) = note_with_image(&db);
  let backup = backup_now(&db.path, &db.root.join("backups")).unwrap();
  let json: serde_json::Value = serde_json::from_str(&fs::read_to_string(&backup).unwrap()).unwrap();
  assert_eq!(json["version"], 6);
  assert_eq!(json["attachments"][0]["name"], name.as_str());

  // A different machine: empty image store.
  fs::remove_dir_all(crate::attachments::directory(&db.path)).unwrap();
  restore_backup(&db.path, &backup).unwrap();
  assert_eq!(crate::attachments::read(&crate::attachments::directory(&db.path), &name).unwrap(), TEST_PNG);
  let connection = Connection::open(&db.path).unwrap();
  assert!(connection.query_row("SELECT content_md FROM notes WHERE id=?1", [&id], |r| r.get::<_, String>(0)).unwrap().contains(&name));
}

#[test]
fn restore_refuses_tampered_images_before_touching_notes() {
  let db = TestDb::current();
  let (id, name) = note_with_image(&db);
  let backup = backup_now(&db.path, &db.root.join("backups")).unwrap();
  let mut json: serde_json::Value = serde_json::from_str(&fs::read_to_string(&backup).unwrap()).unwrap();
  json["attachments"][0]["data"] = "PHN2Zz48L3N2Zz4=".into(); // "<svg></svg>"
  fs::write(&backup, serde_json::to_vec(&json).unwrap()).unwrap();
  change_note_state_on_path(&db.path, &id, NoteAction::Trash).unwrap();
  assert!(restore_backup(&db.path, &backup).is_err());
  let connection = Connection::open(&db.path).unwrap();
  assert_eq!(connection.query_row("SELECT is_deleted FROM notes WHERE id=?1", [&id], |r| r.get::<_, i64>(0)).unwrap(), 1);
  assert!(crate::attachments::directory(&db.path).join(&name).exists());
}

#[test]
fn vault_roundtrip_exports_and_reimports_images() {
  let db = TestDb::current();
  let (id, name) = note_with_image(&db);
  let vault = db.root.join("vault");
  export_vault_to_directory(&db.path, &vault).unwrap();
  assert_eq!(fs::read(vault.join("attachments").join(&name)).unwrap(), TEST_PNG);
  let exported = fs::read_dir(vault.join("notes")).unwrap().next().unwrap().unwrap().path();
  assert!(fs::read_to_string(&exported).unwrap().contains(&format!("![Plano](../attachments/{name})")));

  // Importing into a fresh library brings the image back as a managed reference.
  let fresh = TestDb::current();
  import_vault_from_directory(&fresh.path, &vault).unwrap();
  let connection = Connection::open(&fresh.path).unwrap();
  let markdown: String = connection.query_row("SELECT content_md FROM notes WHERE id=?1", [&id], |r| r.get(0)).unwrap();
  assert!(markdown.contains(&format!("![Plano](attachment:{name})")), "{markdown}");
  assert!(crate::attachments::directory(&fresh.path).join(&name).exists());
}

#[test]
fn vault_import_ignores_links_that_escape_or_lie() {
  let db = TestDb::current();
  let vault = db.root.join("vault");
  fs::create_dir_all(vault.join("notes")).unwrap();
  fs::create_dir_all(vault.join("attachments")).unwrap();
  let honest = crate::attachments::name_for(TEST_PNG).unwrap();
  // Right name, wrong bytes.
  let fake = format!("{}.png", "0".repeat(64));
  fs::write(vault.join("attachments").join(&fake), TEST_PNG).unwrap();
  // A link that would leave the imported folder.
  fs::write(db.root.join(&honest), TEST_PNG).unwrap();
  fs::write(vault.join("notes").join("a.md"), format!("---\nid: \"imp\"\ntitle: \"Imp\"\n---\n\n![x](../attachments/{fake})\n\n![y](../../{honest})\n\n![z](../../attachments/{honest})\n")).unwrap();
  import_vault_from_directory(&db.path, &vault).unwrap();
  let connection = Connection::open(&db.path).unwrap();
  let markdown: String = connection.query_row("SELECT content_md FROM notes WHERE id='imp'", [], |r| r.get(0)).unwrap();
  assert!(!markdown.contains("attachment:"), "{markdown}");
  assert!(!crate::attachments::directory(&db.path).exists() || fs::read_dir(crate::attachments::directory(&db.path)).unwrap().count() == 0);
}

#[test]
fn orphan_cleanup_keeps_images_of_trashed_notes_and_versions() {
  let db = TestDb::current();
  let (id, name) = note_with_image(&db);
  change_note_state_on_path(&db.path, &id, NoteAction::Trash).unwrap();
  assert_eq!(remove_orphan_attachments(&db.path, Duration::ZERO).unwrap(), 0);
  change_note_state_on_path(&db.path, &id, NoteAction::Delete).unwrap();
  assert_eq!(remove_orphan_attachments(&db.path, Duration::ZERO).unwrap(), 1);
  assert!(!crate::attachments::directory(&db.path).join(&name).exists());
}

#[test]
fn protected_notes_survive_backups_keep_their_images_and_are_not_exported() {
  let db = TestDb::current();
  let (id, name) = note_with_image(&db);
  locks::lock_on_path(&db.path, &id, "clave segura").unwrap();
  locks::relock(&id);

  // Backup carries the ciphertext; restoring on an empty library brings the note back locked.
  let backup = backup_now(&db.path, &db.root.join("backups")).unwrap();
  let json: serde_json::Value = serde_json::from_str(&fs::read_to_string(&backup).unwrap()).unwrap();
  assert_eq!(json["version"], 6);
  assert_eq!(json["locks"][0]["note_id"], id.as_str());
  assert!(!fs::read_to_string(&backup).unwrap().contains("Antes"), "la copia contiene el texto en claro");
  assert_eq!(json["attachments"][0]["name"], name.as_str(), "la imagen de la nota protegida no está en la copia");
  let connection = Connection::open(&db.path).unwrap();
  connection.execute_batch("PRAGMA foreign_keys=ON; DELETE FROM note_locks; DELETE FROM notes;").unwrap();
  restore_backup(&db.path, &backup).unwrap();
  assert!(locks::unlock_on_path(&db.path, &id, "clave segura").unwrap().content_md.contains(&name));
  locks::relock(&id);

  // Unused-image cleanup keeps images only a protected note uses.
  assert_eq!(remove_orphan_attachments(&db.path, Duration::ZERO).unwrap(), 0);

  // Exports never write the content; importing that export never overwrites the note.
  assert!(get_note_for_export(&db.path, &id).is_err());
  let vault = db.root.join("vault");
  export_vault_to_directory(&db.path, &vault).unwrap();
  let exported = fs::read_dir(vault.join("notes")).unwrap().next().unwrap().unwrap().path();
  let text = fs::read_to_string(&exported).unwrap();
  assert!(text.contains("Nota protegida") && !text.contains("Antes"));
  import_vault_from_directory(&db.path, &vault).unwrap();
  assert!(locks::unlock_on_path(&db.path, &id, "clave segura").unwrap().content_md.contains("Antes"));
  locks::relock(&id);
}
