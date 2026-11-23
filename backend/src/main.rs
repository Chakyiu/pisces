//! Pisces backend — authenticated Docker control, Kubernetes context names only.

mod access;
mod auth;
mod docker;
mod error;
mod http;
mod k8s;
mod page;
mod stacks;
mod store;

use std::io::{self, Read};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[tokio::main]
async fn main() {
    if std::env::args().nth(1).as_deref() == Some("hash-password") {
        hash_password_cli();
        return;
    }

    let auth = auth::load_from_env().unwrap_or_else(|message| {
        eprintln!("{message}");
        std::process::exit(1);
    });
    let dir = std::env::var("PISCES_DATA_DIR").unwrap_or_else(|_| "data".to_string());
    let data_dir = PathBuf::from(&dir);
    let store = store::Store::open(data_dir.clone()).unwrap_or_else(|message| {
        eprintln!("{message}");
        std::process::exit(1);
    });
    // A proposal left `confirmed` means the last process stopped between the
    // decision and its outcome. Settle those rows before serving, and drop what
    // retention no longer keeps. A store that cannot be read is reported and
    // left alone; the proposal routes then fail closed.
    match access::recover_proposals(&data_dir, access::now()) {
        Ok(0) => {}
        Ok(settled) => println!("settled {settled} interrupted proposal(s)"),
        Err(message) => eprintln!("{message}"),
    }
    let state = http::AppState {
        auth,
        store: Arc::new(Mutex::new(store)),
        stack_apply: Arc::new(http::StackApplyLocks::default()),
        data_dir,
    };
    let app = http::router(state);

    let addr = std::env::var("PISCES_BIND").unwrap_or_else(|_| "127.0.0.1:8787".to_string());
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| panic!("cannot bind {addr}: {e}"));
    println!("pisces backend listening on http://{addr}");
    axum::serve(listener, app).await.expect("server failed");
}

fn hash_password_cli() {
    let mut password = String::new();
    io::stdin()
        .read_to_string(&mut password)
        .expect("could not read stdin");
    let password = password.trim_end_matches(['\r', '\n']);
    if password.is_empty() {
        eprintln!("password was empty");
        std::process::exit(1);
    }
    match auth::hash_password(password) {
        Ok(hash) => println!("{hash}"),
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(1);
        }
    }
}
