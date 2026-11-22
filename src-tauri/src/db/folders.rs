use super::*;

/// Deepest nesting accepted; deeper trees are unreadable in a sidebar and risk runaway recursion.
pub const MAX_FOLDER_DEPTH: usize = 12;

fn clean_name(name: &str) -> Result<String, String> {
  let name = name.trim();
  if name.is_empty() { return Err("La carpeta necesita un nombre".into()); }
  if name.chars().count() > 120 { return Err("El nombre de la carpeta es demasiado largo".into()); }
  if name.chars().any(char::is_control) { return Err("El nombre de la carpeta contiene caracteres no válidos".into()); }
  Ok(name.to_string())
}

fn folder_exists(connection: &Connection, id: &str) -> Result<bool, String> {
  connection.query_row("SELECT EXISTS(SELECT 1 FROM folders WHERE id=?1)", [id], |row| row.get(0))
    .map_err(|error| error.to_string())
}

fn ensure_unique_sibling(connection: &Connection, parent: Option<&str>, name: &str, except: Option<&str>) -> Result<(), String> {
  let taken: bool = connection.query_row(
    "SELECT EXISTS(SELECT 1 FROM folders WHERE parent_id IS ?1 AND lower(name)=lower(?2) AND id IS NOT ?3)",
    params![parent, name, except], |row| row.get(0),
  ).map_err(|error| error.to_string())?;
  if taken { return Err(format!("Ya existe una carpeta llamada «{name}» en ese lugar")); }
  Ok(())
}

/// Depth of `id` counting from the root (a root folder has depth 1).
fn depth(connection: &Connection, id: &str) -> Result<usize, String> {
  connection.query_row(
    "WITH RECURSIVE chain(id, parent_id, level) AS (
       SELECT id, parent_id, 1 FROM folders WHERE id=?1
       UNION ALL SELECT f.id, f.parent_id, chain.level + 1 FROM folders f JOIN chain ON f.id = chain.parent_id WHERE chain.level < 64
     ) SELECT COALESCE(MAX(level), 0) FROM chain",
    [id], |row| row.get::<_, i64>(0),
  ).map(|value| value as usize).map_err(|error| error.to_string())
}

/// Height of the subtree rooted at `id` (a folder without children has height 1).
fn subtree_height(connection: &Connection, id: &str) -> Result<usize, String> {
  connection.query_row(
    "WITH RECURSIVE tree(id, level) AS (
       SELECT id, 1 FROM folders WHERE id=?1
       UNION ALL SELECT f.id, tree.level + 1 FROM folders f JOIN tree ON f.parent_id = tree.id WHERE tree.level < 64
     ) SELECT COALESCE(MAX(level), 0) FROM tree",
    [id], |row| row.get::<_, i64>(0),
  ).map(|value| value as usize).map_err(|error| error.to_string())
}

fn is_descendant(connection: &Connection, candidate: &str, ancestor: &str) -> Result<bool, String> {
  connection.query_row(
    "WITH RECURSIVE tree(id) AS (
       SELECT id FROM folders WHERE parent_id=?1
       UNION SELECT f.id FROM folders f JOIN tree ON f.parent_id = tree.id
     ) SELECT EXISTS(SELECT 1 FROM tree WHERE id=?2)",
    params![ancestor, candidate], |row| row.get(0),
  ).map_err(|error| error.to_string())
}

fn next_position(connection: &Connection, parent: Option<&str>) -> Result<i64, String> {
  connection.query_row("SELECT COALESCE(MAX(position), -1) + 1 FROM folders WHERE parent_id IS ?1", [parent], |row| row.get(0))
    .map_err(|error| error.to_string())
}

pub fn create_folder_on_path(path: &Path, name: &str, parent: Option<&str>) -> Result<String, String> {
  let name = clean_name(name)?;
  let mut connection = open_connection(path)?;
  let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
  if let Some(parent) = parent {
    if !folder_exists(&transaction, parent)? { return Err("La carpeta superior no existe".into()); }
    if depth(&transaction, parent)? >= MAX_FOLDER_DEPTH { return Err("Se ha alcanzado la profundidad máxima de carpetas".into()); }
  }
  ensure_unique_sibling(&transaction, parent, &name, None)?;
  let id = generate_id("folder");
  let now = now_unix();
  transaction.execute(
    "INSERT INTO folders (id, name, parent_id, position, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
    params![id, name, parent, next_position(&transaction, parent)?, now],
  ).map_err(|error| format!("No se pudo crear la carpeta: {error}"))?;
  transaction.commit().map_err(|error| error.to_string())?;
  Ok(id)
}

pub fn rename_folder_on_path(path: &Path, id: &str, name: &str) -> Result<(), String> {
  let name = clean_name(name)?;
  let mut connection = open_connection(path)?;
  let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
  let parent: Option<String> = transaction.query_row("SELECT parent_id FROM folders WHERE id=?1", [id], |row| row.get(0))
    .optional().map_err(|error| error.to_string())?.ok_or("La carpeta no existe")?;
  ensure_unique_sibling(&transaction, parent.as_deref(), &name, Some(id))?;
  transaction.execute("UPDATE folders SET name=?1, updated_at=?2 WHERE id=?3", params![name, now_unix(), id])
    .map_err(|error| error.to_string())?;
  transaction.commit().map_err(|error| error.to_string())
}

/// Moves a folder under `parent` (or to the root). Rejects moving a folder into itself or into
/// one of its own descendants, which would create a cycle and detach the subtree.
pub fn move_folder_on_path(path: &Path, id: &str, parent: Option<&str>) -> Result<(), String> {
  let mut connection = open_connection(path)?;
  let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
  let name: String = transaction.query_row("SELECT name FROM folders WHERE id=?1", [id], |row| row.get(0))
    .optional().map_err(|error| error.to_string())?.ok_or("La carpeta no existe")?;
  if let Some(parent) = parent {
    if parent == id || is_descendant(&transaction, parent, id)? {
      return Err("No se puede mover una carpeta dentro de sí misma".into());
    }
    if !folder_exists(&transaction, parent)? { return Err("La carpeta de destino no existe".into()); }
    if depth(&transaction, parent)? + subtree_height(&transaction, id)? > MAX_FOLDER_DEPTH {
      return Err("Se superaría la profundidad máxima de carpetas".into());
    }
  }
  ensure_unique_sibling(&transaction, parent, &name, Some(id))?;
  transaction.execute(
    "UPDATE folders SET parent_id=?1, position=?2, updated_at=?3 WHERE id=?4",
    params![parent, next_position(&transaction, parent)?, now_unix(), id],
  ).map_err(|error| error.to_string())?;
  transaction.commit().map_err(|error| error.to_string())
}

/// Deletes only the folder: its notes and subfolders move up to its parent folder.
pub fn delete_folder_on_path(path: &Path, id: &str) -> Result<(), String> {
  let mut connection = open_connection(path)?;
  let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
  let parent: Option<String> = transaction.query_row("SELECT parent_id FROM folders WHERE id=?1", [id], |row| row.get(0))
    .optional().map_err(|error| error.to_string())?.ok_or("La carpeta no existe")?;
  transaction.execute("UPDATE notes SET folder_id=?1 WHERE folder_id=?2", params![parent, id]).map_err(|error| error.to_string())?;
  // Name clashes with the new siblings are resolved by suffixing the moved child.
  let children: Vec<(String, String)> = {
    let mut statement = transaction.prepare("SELECT id, name FROM folders WHERE parent_id=?1 ORDER BY position").map_err(|error| error.to_string())?;
    let rows = statement.query_map([id], |row| Ok((row.get(0)?, row.get(1)?))).map_err(|error| error.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|error| error.to_string())?
  };
  for (child, name) in children {
    let mut candidate = name.clone();
    let mut suffix = 2;
    while ensure_unique_sibling(&transaction, parent.as_deref(), &candidate, Some(&child)).is_err() {
      candidate = format!("{name} ({suffix})");
      suffix += 1;
    }
    transaction.execute(
      "UPDATE folders SET parent_id=?1, name=?2, position=?3, updated_at=?4 WHERE id=?5",
      params![parent, candidate, next_position(&transaction, parent.as_deref())?, now_unix(), child],
    ).map_err(|error| error.to_string())?;
  }
  transaction.execute("DELETE FROM folders WHERE id=?1", [id]).map_err(|error| format!("No se pudo eliminar la carpeta: {error}"))?;
  validate_foreign_keys(&transaction)?;
  transaction.commit().map_err(|error| error.to_string())
}

pub fn move_note_to_folder_on_path(path: &Path, note_id: &str, folder: Option<&str>) -> Result<(), String> {
  let mut connection = open_connection(path)?;
  let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
  if let Some(folder) = folder {
    if !folder_exists(&transaction, folder)? { return Err("La carpeta de destino no existe".into()); }
  }
  let changed = transaction.execute("UPDATE notes SET folder_id=?1 WHERE id=?2", params![folder, note_id])
    .map_err(|error| error.to_string())?;
  if changed != 1 { return Err("La nota no existe".into()); }
  transaction.commit().map_err(|error| error.to_string())
}

/// Folder names from the root to `id`, used by vault exports.
pub(super) fn folder_path(connection: &Connection, id: &str) -> Result<Vec<String>, String> {
  let mut statement = connection.prepare(
    "WITH RECURSIVE chain(id, parent_id, name, level) AS (
       SELECT id, parent_id, name, 0 FROM folders WHERE id=?1
       UNION ALL SELECT f.id, f.parent_id, f.name, chain.level + 1 FROM folders f JOIN chain ON f.id = chain.parent_id WHERE chain.level < 64
     ) SELECT name FROM chain ORDER BY level DESC",
  ).map_err(|error| error.to_string())?;
  let rows = statement.query_map([id], |row| row.get(0)).map_err(|error| error.to_string())?;
  rows.collect::<Result<_, _>>().map_err(|error| error.to_string())
}

/// Finds or creates the folder chain `names` (used when importing a vault).
pub(super) fn ensure_folder_path(transaction: &Transaction<'_>, names: &[String]) -> Result<Option<String>, String> {
  let mut parent: Option<String> = None;
  for raw in names.iter().take(MAX_FOLDER_DEPTH) {
    let Ok(name) = clean_name(raw) else { continue };
    let existing: Option<String> = transaction.query_row(
      "SELECT id FROM folders WHERE parent_id IS ?1 AND lower(name)=lower(?2) LIMIT 1", params![parent, name], |row| row.get(0),
    ).optional().map_err(|error| error.to_string())?;
    parent = Some(match existing {
      Some(id) => id,
      None => {
        let id = generate_id("folder");
        let now = now_unix();
        transaction.execute(
          "INSERT INTO folders (id, name, parent_id, position, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
          params![id, name, parent, next_position(transaction, parent.as_deref())?, now],
        ).map_err(|error| error.to_string())?;
        id
      }
    });
  }
  Ok(parent)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::db::writes::SaveNoteDraft;

  fn database() -> (PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(generate_id("folders-test"));
    fs::create_dir_all(&root).unwrap();
    let path = root.join("notes.db");
    let connection = Connection::open(&path).unwrap();
    connection.execute_batch(include_str!("sql/0001_init.sql")).unwrap();
    for migration in migrations::sqlite_migrations().into_iter().filter(|m| m.version > 1) {
      connection.execute_batch(migration.sql).unwrap();
    }
    (root, path)
  }

  fn note(path: &Path, folder: Option<&str>) -> String {
    let draft = SaveNoteDraft {
      title: "Nota".into(), content_rich_json: r#"{"type":"doc","content":[]}"#.into(),
      content_md: "texto".into(), content_plain: "texto".into(), tags: vec![], folder_id: folder.map(str::to_string),
    };
    save_note_on_path(path, None, &draft).unwrap()
  }

  #[test]
  fn creates_nested_folders_and_rejects_cycles() {
    let (root, path) = database();
    let work = create_folder_on_path(&path, "Trabajo", None).unwrap();
    let projects = create_folder_on_path(&path, "Proyectos", Some(&work)).unwrap();
    let employees = create_folder_on_path(&path, "Empleados", Some(&projects)).unwrap();
    assert!(move_folder_on_path(&path, &work, Some(&employees)).unwrap_err().contains("dentro de sí misma"));
    assert!(move_folder_on_path(&path, &work, Some(&work)).is_err());
    assert!(create_folder_on_path(&path, "proyectos", Some(&work)).unwrap_err().contains("Ya existe"));
    assert!(create_folder_on_path(&path, "  ", None).is_err());
    move_folder_on_path(&path, &employees, None).unwrap();
    let connection = Connection::open(&path).unwrap();
    assert_eq!(folder_path(&connection, &employees).unwrap(), vec!["Empleados"]);
    assert_eq!(folder_path(&connection, &projects).unwrap(), vec!["Trabajo", "Proyectos"]);
    fs::remove_dir_all(root).unwrap();
  }

  #[test]
  fn deleting_a_folder_keeps_its_notes_and_subfolders() {
    let (root, path) = database();
    let work = create_folder_on_path(&path, "Trabajo", None).unwrap();
    let projects = create_folder_on_path(&path, "Proyectos", Some(&work)).unwrap();
    let inner = note(&path, Some(&projects));
    let direct = note(&path, Some(&work));
    delete_folder_on_path(&path, &work).unwrap();
    let connection = Connection::open(&path).unwrap();
    let folder_of = |id: &str| connection.query_row("SELECT folder_id FROM notes WHERE id=?1", [id], |r| r.get::<_, Option<String>>(0)).unwrap();
    assert_eq!(folder_of(&inner), Some(projects.clone()));
    assert_eq!(folder_of(&direct), None);
    let parent: Option<String> = connection.query_row("SELECT parent_id FROM folders WHERE id=?1", [&projects], |r| r.get(0)).unwrap();
    assert_eq!(parent, None);
    assert_eq!(connection.query_row("SELECT count(*) FROM notes", [], |r| r.get::<_, i64>(0)).unwrap(), 2);
    fs::remove_dir_all(root).unwrap();
  }

  #[test]
  fn moves_notes_and_limits_depth() {
    let (root, path) = database();
    let id = note(&path, None);
    let folder = create_folder_on_path(&path, "Ideas", None).unwrap();
    move_note_to_folder_on_path(&path, &id, Some(&folder)).unwrap();
    assert!(move_note_to_folder_on_path(&path, &id, Some("missing")).is_err());
    move_note_to_folder_on_path(&path, &id, None).unwrap();
    let mut parent = folder.clone();
    for level in 2..=MAX_FOLDER_DEPTH { parent = create_folder_on_path(&path, &format!("Nivel {level}"), Some(&parent)).unwrap(); }
    assert!(create_folder_on_path(&path, "Demasiado", Some(&parent)).is_err());
    fs::remove_dir_all(root).unwrap();
  }
}
