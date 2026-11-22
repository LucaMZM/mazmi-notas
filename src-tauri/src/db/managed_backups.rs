use super::*;

pub fn list_managed_backups(backup_dir: &Path, recovery_dir: &Path) -> Result<Vec<PathBuf>, String> {
  let mut files = Vec::new();
  for directory in [backup_dir, recovery_dir] {
    match fs::symlink_metadata(directory) {
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
      Err(error) => return Err(error.to_string()),
      Ok(_) => reject_symlink(directory)?,
    }
    let canonical_directory = fs::canonicalize(directory).map_err(|error| error.to_string())?;
    for path in list_backups(directory)? {
      reject_symlink(&path)?;
      let canonical = fs::canonicalize(&path).map_err(|error| error.to_string())?;
      if canonical.parent() != Some(canonical_directory.as_path()) {
        return Err("Backup fuera de su carpeta administrada".into());
      }
      files.push(canonical);
    }
  }
  files.sort();
  files.dedup();
  // Compare across directories; sorting full paths would always prefer one folder.
  files.sort_by_cached_key(|path| std::cmp::Reverse(
    fs::metadata(path).and_then(|metadata| metadata.modified()).unwrap_or(UNIX_EPOCH)
  ));
  Ok(files)
}

pub fn resolve_managed_backup(backup_dir: &Path, recovery_dir: &Path, requested: Option<&str>) -> Result<PathBuf, String> {
  let files = list_managed_backups(backup_dir, recovery_dir)?;
  let Some(requested) = requested else {
    return files.into_iter().next().ok_or_else(|| "No hay backups disponibles para restaurar".into());
  };
  let requested = Path::new(requested);
  if requested.is_absolute() {
    if requested.components().any(|component| matches!(component, std::path::Component::ParentDir)) {
      return Err("Ruta de backup no permitida".into());
    }
    reject_symlink(requested)?;
    reject_symlink(requested.parent().ok_or("Ruta sin directorio")?)?;
    let canonical = fs::canonicalize(requested).map_err(|error| error.to_string())?;
    return files.into_iter().find(|file| file == &canonical)
      .ok_or_else(|| "Backup fuera de las carpetas administradas".into());
  }
  let mut components = requested.components();
  if !matches!(components.next(), Some(std::path::Component::Normal(_))) || components.next().is_some() {
    return Err("Se requiere un nombre de backup sin traversal".into());
  }
  files.into_iter().find(|file| file.file_name() == requested.file_name())
    .ok_or_else(|| "Backup no encontrado en las carpetas administradas".into())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn lists_both_managed_directories_and_resolves_recovery_for_the_ui() {
    let root = std::env::temp_dir().join(generate_id("scribedock-managed"));
    let backups = root.join("backups");
    let recoveries = root.join("recovery-backups");
    fs::create_dir_all(&backups).unwrap();
    fs::write(backups.join("backup-old.json"), "original").unwrap();
    assert_eq!(list_managed_backups(&backups, &recoveries).unwrap().len(), 1);
    fs::create_dir(&recoveries).unwrap();
    let recovery = recoveries.join("recovery-restore.json");
    fs::write(&recovery, "recovery").unwrap();
    let files = list_managed_backups(&backups, &recoveries).unwrap();
    assert_eq!(files.len(), 2);
    assert!(files.contains(&fs::canonicalize(&recovery).unwrap()));
    assert_eq!(resolve_managed_backup(&backups, &recoveries, Some(recovery.to_str().unwrap())).unwrap(), fs::canonicalize(&recovery).unwrap());
    assert_eq!(resolve_managed_backup(&backups, &recoveries, Some("recovery-restore.json")).unwrap(), fs::canonicalize(&recovery).unwrap());
    fs::remove_dir_all(root).unwrap();
  }

  #[test]
  fn rejects_external_files_and_relative_traversal() {
    let root = std::env::temp_dir().join(generate_id("scribedock-contained"));
    let backups = root.join("backups");
    let recoveries = root.join("recovery-backups");
    fs::create_dir_all(&backups).unwrap();
    let outside = root.join("outside.json");
    fs::write(&outside, "outside").unwrap();
    assert!(resolve_managed_backup(&backups, &recoveries, Some(outside.to_str().unwrap())).is_err());
    assert!(resolve_managed_backup(&backups, &recoveries, Some("../outside.json")).is_err());
    assert!(resolve_managed_backup(&backups, &recoveries, None).is_err());
    fs::remove_dir_all(root).unwrap();
  }

  #[cfg(unix)]
  #[test]
  fn refuses_symlinked_files_and_managed_directories() {
    let root = std::env::temp_dir().join(generate_id("scribedock-no-links"));
    let backups = root.join("backups");
    let recoveries = root.join("recovery-backups");
    fs::create_dir_all(&backups).unwrap();
    let outside = root.join("outside.json");
    fs::write(&outside, "outside").unwrap();
    let link = backups.join("linked.json");
    std::os::unix::fs::symlink(&outside, &link).unwrap();
    assert!(list_managed_backups(&backups, &recoveries).unwrap().is_empty());
    assert!(resolve_managed_backup(&backups, &recoveries, Some(link.to_str().unwrap())).is_err());
    let alias = root.join("alias");
    std::os::unix::fs::symlink(&backups, &alias).unwrap();
    assert!(list_managed_backups(&alias, &recoveries).is_err());
    fs::remove_dir_all(root).unwrap();
  }
}
