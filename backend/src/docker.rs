//! Docker daemon access via `bollard`.
//!
//! On Windows the daemon is reached over the named pipe `//./pipe/docker_engine`,
//! which is what Docker Desktop publishes.

use bollard::Docker;

/// Build a Docker client for the local daemon. Construction is lazy: no request is
/// made until an API call runs, so this is safe when Docker is not running.
pub fn client() -> Result<Docker, bollard::errors::Error> {
    #[cfg(windows)]
    {
        Docker::connect_with_named_pipe_defaults()
    }
    #[cfg(not(windows))]
    {
        Docker::connect_with_local_defaults()
    }
}

/// One-line description used by `/api/health`.
pub fn describe() -> String {
    match client() {
        #[cfg(windows)]
        Ok(_) => "client ok (npipe //./pipe/docker_engine)".to_string(),
        #[cfg(not(windows))]
        Ok(_) => "client ok (unix socket)".to_string(),
        Err(e) => format!("client error: {e}"),
    }
}
