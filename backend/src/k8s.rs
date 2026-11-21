//! Kubernetes access via `kube`. No cluster is assumed to exist; this only builds a
//! client from the ambient kubeconfig when one is available.

use kube::Client;

/// One-line description used by `/api/health`.
pub async fn describe() -> String {
    match Client::try_default().await {
        Ok(_) => "client ok (kubeconfig found)".to_string(),
        Err(_) => "no cluster configured".to_string(),
    }
}
