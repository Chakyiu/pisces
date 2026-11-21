//! Pisces backend — authenticated control plane for Docker and Kubernetes.
//!
//! Scope of this commit: scaffold only. No auth, no Docker/Kubernetes endpoints yet.
//! The dependencies below are wired in just far enough that `cargo check` proves the
//! picked versions compile and that the two clients can be constructed.

mod docker;
mod k8s;

use axum::{routing::get, Json, Router};
use serde::Serialize;

#[derive(Serialize)]
struct Health {
    status: &'static str,
    docker: String,
    kubernetes: String,
}

async fn health() -> Json<Health> {
    Json(Health {
        status: "ok",
        docker: docker::describe(),
        kubernetes: k8s::describe().await,
    })
}

#[tokio::main]
async fn main() {
    let app = Router::new().route("/api/health", get(health));

    let addr = std::env::var("PISCES_BIND").unwrap_or_else(|_| "127.0.0.1:8787".to_string());
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| panic!("cannot bind {addr}: {e}"));
    println!("pisces backend listening on http://{addr}");
    axum::serve(listener, app).await.expect("server failed");
}
