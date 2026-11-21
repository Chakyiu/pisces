//! Kubernetes context names only. Cluster calls are TELE-74.
//!
//! `read` errors that include a filesystem path are not returned to the client.

use kube::config::{Kubeconfig, KubeconfigError};

pub fn context_names() -> Result<Vec<String>, &'static str> {
    match Kubeconfig::read() {
        Ok(cfg) => Ok(cfg
            .contexts
            .into_iter()
            .map(|c| c.name)
            .filter(|name| !name.is_empty())
            .collect()),
        Err(KubeconfigError::FindPath) => Ok(Vec::new()),
        Err(KubeconfigError::ReadConfig(err, _)) if err.kind() == std::io::ErrorKind::NotFound => {
            Ok(Vec::new())
        }
        Err(_) => Err("Couldn't read context names."),
    }
}

/// One-line description used by `/api/health`. No cluster is required.
pub async fn describe() -> String {
    match context_names() {
        Ok(names) if names.is_empty() => "no cluster configured".to_string(),
        Ok(names) => format!("{} context name(s) visible", names.len()),
        Err(_) => "context names unreadable".to_string(),
    }
}
