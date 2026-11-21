//! Endpoint records. Docker endpoints all use this machine's engine (no socket path in v1).

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
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
    path: PathBuf,
    endpoints: Vec<Endpoint>,
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
        Ok(Self { path, endpoints })
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

    fn save(&self) -> Result<(), String> {
        let text = serde_json::to_string_pretty(&self.endpoints)
            .map_err(|_| "The endpoint list could not be saved.".to_string())?;
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, text).map_err(|_| "The endpoint list could not be saved.".to_string())?;
        fs::rename(&tmp, &self.path)
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
