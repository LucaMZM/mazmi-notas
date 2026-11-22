pub(super) struct VaultDocument {
  pub id: Option<String>,
  pub title: Option<String>,
  pub tags: Vec<String>,
  /// Folder names from the root, e.g. ["Trabajo", "Proyectos"].
  pub folder: Vec<String>,
  pub body: String,
}

fn scalar(value: &str) -> String {
  serde_json::from_str::<String>(value.trim())
    .unwrap_or_else(|_| value.trim().trim_matches('\'').to_string())
}

pub(super) fn parse_vault_document(text: &str) -> VaultDocument {
  let unchanged = || VaultDocument { id: None, title: None, tags: Vec::new(), folder: Vec::new(), body: text.to_string() };
  let normalized = text.trim_start_matches('\u{feff}').replace("\r\n", "\n");
  if !normalized.starts_with("---\n") { return unchanged(); }

  let mut result = unchanged();
  let mut offset = 4;
  for line in normalized[4..].split_inclusive('\n') {
    let value = line.trim_end_matches('\n');
    offset += line.len();
    if value.trim() == "---" {
      // Consume the single separator exported after frontmatter, never trim code/body.
      let body = &normalized[offset..];
      result.body = body.strip_prefix('\n').unwrap_or(body).to_string();
      return result;
    }
    if let Some(value) = value.strip_prefix("id:") {
      let id = scalar(value);
      if !id.is_empty() { result.id = Some(id); }
    } else if let Some(value) = value.strip_prefix("title:") {
      result.title = Some(scalar(value));
    } else if let Some(value) = value.strip_prefix("folder:") {
      result.folder = serde_json::from_str::<Vec<String>>(value.trim()).unwrap_or_default();
    } else if let Some(value) = value.strip_prefix("tags:") {
      result.tags = serde_json::from_str::<Vec<String>>(value.trim()).unwrap_or_else(|_| {
        value.trim().trim_start_matches('[').trim_end_matches(']')
          .split(',').map(scalar).filter(|tag| !tag.is_empty()).collect()
      });
    }
  }
  unchanged()
}

#[cfg(test)]
pub(super) fn split_frontmatter(text: &str) -> (Option<String>, Vec<String>, String) {
  let parsed = parse_vault_document(text);
  (parsed.id, parsed.tags, parsed.body)
}
