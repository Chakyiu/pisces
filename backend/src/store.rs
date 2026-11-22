//! Endpoint records. Docker endpoints all use this machine's engine (no socket path in v1).

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Serialize, Deserialize)]
pub struct Endpoint {
    pub id: String,
    pub name: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
}

pub struct Store {
    dir: PathBuf,
    path: PathBuf,
    endpoints: Vec<Endpoint>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StackMeta {
    project: String,
    created_at: String,
    updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_error: Option<String>,
}

fn replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
        let result = unsafe {
            MoveFileExW(
                from.as_ptr(),
                to.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if result == 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
    #[cfg(not(windows))]
    {
        fs::rename(from, to)
    }
}

impl Store {
    pub fn open(dir: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&dir)
            .map_err(|_| "The endpoint list could not be opened.".to_string())?;
        let path = dir.join("endpoints.json");
        let endpoints = if path.exists() {
            let text = fs::read_to_string(&path)
                .map_err(|_| "The endpoint list could not be opened.".to_string())?;
            serde_json::from_str(&text)
                .map_err(|_| "The endpoint list could not be opened.".to_string())?
        } else {
            Vec::new()
        };
        Ok(Self {
            dir,
            path,
            endpoints,
        })
    }

    pub fn list(&self) -> Vec<Endpoint> {
        self.endpoints.clone()
    }

    pub fn get(&self, id: &str) -> Option<Endpoint> {
        self.endpoints.iter().find(|e| e.id == id).cloned()
    }

    pub fn insert(&mut self, endpoint: Endpoint) -> Result<(), String> {
        if self.endpoints.iter().any(|e| e.name == endpoint.name) {
            return Err("An endpoint with that name already exists.".into());
        }
        self.endpoints.push(endpoint);
        self.save()
    }

    pub fn remove(&mut self, id: &str) -> Result<bool, String> {
        let before = self.endpoints.len();
        self.endpoints.retain(|e| e.id != id);
        if self.endpoints.len() == before {
            return Ok(false);
        }
        self.save()?;
        Ok(true)
    }

    pub fn stack_projects(&self, endpoint_id: &str) -> Vec<String> {
        let dir = self.dir.join("stacks").join(endpoint_id);
        let Ok(entries) = fs::read_dir(dir) else {
            return Vec::new();
        };
        entries
            .flatten()
            .filter(|entry| entry.path().is_dir())
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect()
    }

    pub fn stack_file(&self, endpoint_id: &str, project: &str) -> Option<String> {
        fs::read_to_string(self.stack_dir(endpoint_id, project)?.join("compose.yaml")).ok()
    }

    pub fn stack_exists(&self, endpoint_id: &str, project: &str) -> bool {
        self.stack_dir(endpoint_id, project)
            .is_some_and(|dir| dir.is_dir())
    }

    pub fn create_stack_dir(&self, endpoint_id: &str, project: &str) -> Result<PathBuf, String> {
        let dir = self
            .stack_dir(endpoint_id, project)
            .ok_or_else(|| "That stack name is not valid.".to_string())?;
        fs::create_dir_all(&dir)
            .map_err(|_| "The stack directory could not be created.".to_string())?;
        Ok(dir)
    }

    pub fn stage_stack_file(
        &self,
        endpoint_id: &str,
        project: &str,
        content: &str,
    ) -> Result<(), String> {
        let dir = self
            .stack_dir(endpoint_id, project)
            .ok_or_else(|| "That stack name is not valid.".to_string())?;
        fs::create_dir_all(&dir)
            .map_err(|_| "The stack directory could not be created.".to_string())?;
        fs::write(dir.join("compose.yaml.new"), content)
            .map_err(|_| "The Compose file could not be saved.".to_string())
    }

    pub fn commit_stack_file(&self, endpoint_id: &str, project: &str) -> Result<(), String> {
        let dir = self
            .stack_dir(endpoint_id, project)
            .ok_or_else(|| "That stack name is not valid.".to_string())?;
        replace_file(&dir.join("compose.yaml.new"), &dir.join("compose.yaml"))
            .map_err(|_| "The Compose file could not be saved.".to_string())?;
        self.save_stack_meta(endpoint_id, project, None)
    }

    pub fn keep_failed_create(&self, endpoint_id: &str, project: &str, message: &str) {
        if let Some(dir) = self.stack_dir(endpoint_id, project) {
            let candidate = dir.join("compose.yaml.new");
            let _ = fs::rename(candidate, dir.join("compose.yaml"));
            let _ = self.save_stack_meta(endpoint_id, project, Some(message));
        }
    }

    pub fn record_stack_error(&self, endpoint_id: &str, project: &str, message: &str) {
        let _ = self.save_stack_meta(endpoint_id, project, Some(message));
    }

    pub fn remove_stack(&self, endpoint_id: &str, project: &str) -> Result<(), String> {
        let dir = self
            .stack_dir(endpoint_id, project)
            .ok_or_else(|| "That stack name is not valid.".to_string())?;
        fs::remove_dir_all(dir).map_err(|_| "The stack directory could not be removed.".to_string())
    }

    fn stack_dir(&self, endpoint_id: &str, project: &str) -> Option<PathBuf> {
        let safe = |value: &str| {
            !value.is_empty()
                && value
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
        };
        (safe(endpoint_id) && safe(project))
            .then(|| self.dir.join("stacks").join(endpoint_id).join(project))
    }

    fn save_stack_meta(
        &self,
        endpoint_id: &str,
        project: &str,
        error: Option<&str>,
    ) -> Result<(), String> {
        let dir = self
            .stack_dir(endpoint_id, project)
            .ok_or_else(|| "That stack name is not valid.".to_string())?;
        let path = dir.join("meta.json");
        let old = fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<StackMeta>(&text).ok());
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs().to_string())
            .unwrap_or_default();
        let meta = StackMeta {
            project: project.to_string(),
            created_at: old
                .as_ref()
                .map(|meta| meta.created_at.clone())
                .unwrap_or_else(|| now.clone()),
            updated_at: now,
            last_error: error.map(|message| message.chars().take(1000).collect()),
        };
        let text = serde_json::to_string_pretty(&meta)
            .map_err(|_| "The stack record could not be saved.".to_string())?;
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, text).map_err(|_| "The stack record could not be saved.".to_string())?;
        replace_file(&tmp, &path).map_err(|_| "The stack record could not be saved.".to_string())
    }

    fn save(&self) -> Result<(), String> {
        let text = serde_json::to_string_pretty(&self.endpoints)
            .map_err(|_| "The endpoint list could not be saved.".to_string())?;
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, text).map_err(|_| "The endpoint list could not be saved.".to_string())?;
        replace_file(&tmp, &self.path)
            .map_err(|_| "The endpoint list could not be saved.".to_string())?;
        Ok(())
    }
}

pub fn new_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}{:x}", std::process::id())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir() -> PathBuf {
        std::env::temp_dir().join(format!("pisces-store-{}", new_id()))
    }

    #[test]
    fn stack_files_are_staged_committed_and_persisted() {
        let dir = test_dir();
        let store = Store::open(dir.clone()).unwrap();
        let original = "services:\n  web:\n    image: nginx:alpine\n";
        let updated = "services:\n  web:\n    image: nginx:latest\n";

        store.create_stack_dir("endpoint-1", "sample").unwrap();
        store
            .stage_stack_file("endpoint-1", "sample", original)
            .unwrap();
        assert!(store.stack_file("endpoint-1", "sample").is_none());
        store.commit_stack_file("endpoint-1", "sample").unwrap();
        assert_eq!(
            store.stack_file("endpoint-1", "sample").as_deref(),
            Some(original)
        );

        store
            .stage_stack_file("endpoint-1", "sample", updated)
            .unwrap();
        assert_eq!(
            store.stack_file("endpoint-1", "sample").as_deref(),
            Some(original)
        );
        store.commit_stack_file("endpoint-1", "sample").unwrap();
        assert_eq!(
            store.stack_file("endpoint-1", "sample").as_deref(),
            Some(updated)
        );
        assert_eq!(store.stack_projects("endpoint-1"), vec!["sample"]);

        let reopened = Store::open(dir.clone()).unwrap();
        assert_eq!(
            reopened.stack_file("endpoint-1", "sample").as_deref(),
            Some(updated)
        );
        reopened.remove_stack("endpoint-1", "sample").unwrap();
        assert!(!reopened.stack_exists("endpoint-1", "sample"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_create_keeps_compose_and_records_a_bounded_error() {
        let dir = test_dir();
        let store = Store::open(dir.clone()).unwrap();
        store.create_stack_dir("endpoint-1", "sample").unwrap();
        store
            .stage_stack_file(
                "endpoint-1",
                "sample",
                "services:\n  web:\n    image: nginx\n",
            )
            .unwrap();
        store.keep_failed_create("endpoint-1", "sample", &"e".repeat(1500));

        assert!(store.stack_exists("endpoint-1", "sample"));
        assert!(store.stack_file("endpoint-1", "sample").is_some());
        let meta = fs::read_to_string(dir.join("stacks/endpoint-1/sample/meta.json")).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&meta).unwrap();
        assert_eq!(parsed["lastError"].as_str().unwrap().len(), 1000);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn stack_paths_reject_traversal_components() {
        let dir = test_dir();
        let store = Store::open(dir.clone()).unwrap();
        assert!(store.stack_dir("../endpoint", "sample").is_none());
        assert!(store.stack_dir("endpoint-1", "../sample").is_none());
        fs::remove_dir_all(dir).unwrap();
    }
}
