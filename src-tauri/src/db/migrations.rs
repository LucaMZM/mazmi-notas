use tauri_plugin_sql::{Migration, MigrationKind};

/// Newest schema version; a consistent snapshot is taken before upgrading to it.
pub const LATEST_VERSION: i64 = 8;

pub fn sqlite_migrations() -> Vec<Migration> {
  vec![
    Migration {
      version: 1,
      description: "create_initial_tables",
      sql: include_str!("sql/0001_init.sql"),
      kind: MigrationKind::Up,
    },
    Migration {
      version: 2,
      description: "upgrade_to_scribedock_v4",
      sql: include_str!("sql/0002_v4_schema.sql"),
      kind: MigrationKind::Up,
    },
    Migration {
      version: 3,
      description: "repair_schema_and_preserve_markdown_snapshots",
      sql: include_str!("sql/0003_repair_and_markdown_snapshots.sql"),
      kind: MigrationKind::Up,
    },
    Migration {
      version: 4,
      description: "repair_legacy_foreign_key_parents",
      sql: include_str!("sql/0004_repair_legacy_foreign_keys.sql"),
      kind: MigrationKind::Up,
    },
    Migration {
      version: 5,
      description: "nested_folders",
      sql: include_str!("sql/0005_folders.sql"),
      kind: MigrationKind::Up,
    },
    Migration {
      version: 6,
      description: "note_reminders",
      sql: include_str!("sql/0006_reminders.sql"),
      kind: MigrationKind::Up,
    },
    Migration {
      version: 7,
      description: "semantic_index",
      sql: include_str!("sql/0007_semantic_index.sql"),
      kind: MigrationKind::Up,
    },
    Migration {
      version: 8,
      description: "note_locks",
      sql: include_str!("sql/0008_note_locks.sql"),
      kind: MigrationKind::Up,
    },
  ]
}
