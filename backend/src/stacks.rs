use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::process::Command;

use crate::docker::EnvOut;
use crate::error::ApiError;

pub const MAX_COMPOSE_BYTES: usize = 1_048_576;
const APPLY_TIMEOUT: Duration = Duration::from_secs(300);

pub fn validate_project_name(project: &str) -> Result<(), ApiError> {
    if project.trim().is_empty() {
        return Err(ApiError::validation("Stack name is required"));
    }
    if project.len() > 63 {
        return Err(ApiError::validation("Use at most 63 characters."));
    }
    if project == "new" {
        return Err(ApiError::validation(
            "“new” is reserved. Pick another name.",
        ));
    }
    if !project.bytes().enumerate().all(|(index, byte)| {
        byte.is_ascii_lowercase()
            || byte.is_ascii_digit()
            || (index > 0 && matches!(byte, b'_' | b'-'))
    }) {
        return Err(ApiError::validation(
            "Use lowercase letters, digits, hyphens, and underscores, and start with a letter or digit.",
        ));
    }
    Ok(())
}

pub fn validate_compose(compose: &str) -> Result<(), ApiError> {
    if !compose.lines().any(|line| {
        let line = line.trim();
        !line.is_empty() && !line.starts_with('#')
    }) {
        return Err(ApiError::validation("Stack file content is required"));
    }
    if compose.len() > MAX_COMPOSE_BYTES {
        return Err(ApiError::validation(
            "This file is larger than 1 MB. Pisces accepts Compose files up to 1 MB.",
        ));
    }
    // These paths are resolved inside Pisces, not beside the user's file.
    for line in compose.lines() {
        let line = line.trim_start();
        if line.starts_with('#') {
            continue;
        }
        let key = line.trim_start_matches('-').trim_start();
        let (name, rest) = key.split_once(':').unwrap_or(("", ""));
        if rest.is_empty() && !key.contains(':') {
            continue;
        }
        if matches!(name.trim(), "build" | "extends") {
            return Err(ApiError::validation(format!(
                "The Compose key '{}' is not supported. Use images the engine can pull and include settings in this file.",
                name.trim()
            )));
        }
        if name.trim() == "env_file" && !line.contains("stack.env") {
            return Err(ApiError::validation(
                "Only env_file: stack.env is supported. Set environment values in the stack form instead of other env files.",
            ));
        }
    }
    Ok(())
}

pub fn validate_stack_env(entries: &[EnvOut]) -> Result<(), ApiError> {
    for entry in entries {
        if entry.key.is_empty()
            || entry.key.contains('=')
            || entry.key.contains('\n')
            || entry.key.contains('\r')
        {
            return Err(ApiError::validation(
                "Environment variable names must be non-empty and cannot contain '=', or newlines.",
            ));
        }
    }
    Ok(())
}

pub fn format_stack_env(entries: &[EnvOut]) -> String {
    entries
        .iter()
        .filter(|entry| !entry.key.trim().is_empty())
        .map(|entry| format!("{}={}", entry.key, entry.value))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

pub fn parse_stack_env(content: &str) -> Vec<EnvOut> {
    let mut entries = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = line
            .split_once('=')
            .map(|(key, value)| (key.trim(), value))
            .unwrap_or((line, ""));
        if !key.is_empty() {
            entries.push(EnvOut {
                key: key.to_string(),
                value: value.to_string(),
            });
        }
    }
    entries
}

pub async fn up(
    project: &str,
    directory: &Path,
    compose_file: &Path,
    env_file: Option<&Path>,
) -> Result<(), ApiError> {
    run(project, directory, compose_file, env_file, "up").await
}

pub async fn down(
    project: &str,
    directory: &Path,
    compose_file: &Path,
    env_file: Option<&Path>,
) -> Result<(), ApiError> {
    run(project, directory, compose_file, env_file, "down").await
}

async fn run(
    project: &str,
    directory: &Path,
    compose_file: &Path,
    env_file: Option<&Path>,
    action: &str,
) -> Result<(), ApiError> {
    let mut command = Command::new("docker");
    command
        .arg("compose")
        .arg("--project-directory")
        .arg(directory)
        .arg("--project-name")
        .arg(project)
        .arg("--file")
        .arg(compose_file);
    if let Some(path) = env_file.filter(|path| path.is_file()) {
        command.arg("--env-file").arg(path);
    }
    command
        .arg(action)
        .args(if action == "up" {
            vec!["--detach", "--remove-orphans"]
        } else {
            Vec::new()
        })
        .kill_on_drop(true);
    let child = command
        .spawn()
        .map_err(|error| ApiError::deploy(format!("Could not start Docker Compose: {error}")))?;
    let output = child.wait_with_output();
    tokio::pin!(output);
    let output = tokio::time::timeout(APPLY_TIMEOUT, &mut output)
        .await
        .map_err(|_| ApiError::deploy("Compose did not finish within five minutes. Some services may already have changed."))?
        .map_err(|error| ApiError::deploy(format!("Could not wait for Docker Compose: {error}")))?;
    if output.status.success() {
        return Ok(());
    }
    let message = String::from_utf8_lossy(&output.stderr);
    let tail = message
        .trim()
        .chars()
        .rev()
        .take(1000)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    let tail = if tail.is_empty() {
        "Compose exited unsuccessfully.".to_string()
    } else {
        tail
    };
    Err(ApiError::deploy(format!(
        "Compose failed. Some services may already have changed. {tail}"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_compose_project_names_and_rejects_unsafe_names() {
        assert!(validate_project_name("demo_1").is_ok());
        assert!(validate_project_name(&"a".repeat(63)).is_ok());
        for name in ["", " ", "new", "Upper", "-bad", "a/b", &"a".repeat(64)] {
            assert!(validate_project_name(name).is_err(), "{name:?}");
        }
    }

    #[test]
    fn validates_compose_size_content_and_unsupported_file_paths() {
        assert!(validate_compose("services:\n  web:\n    image: nginx\n").is_ok());
        assert!(validate_compose("services:\n  web:\n    build: .\n").is_err());
        assert!(validate_compose("services:\n  web:\n    env_file: .env\n").is_err());
        assert!(validate_compose("services:\n  web:\n    env_file: stack.env\n").is_ok());
        assert!(validate_compose("# comment only\n").is_err());
        assert!(validate_compose(&"x".repeat(MAX_COMPOSE_BYTES + 1)).is_err());
    }

    #[test]
    fn round_trips_stack_env_file_format() {
        let entries = vec![
            EnvOut {
                key: "TAG".into(),
                value: "v1".into(),
            },
            EnvOut {
                key: "PORT".into(),
                value: "8080".into(),
            },
        ];
        let text = format_stack_env(&entries);
        let parsed = parse_stack_env(&text);
        assert_eq!(parsed.len(), entries.len());
        for (got, expected) in parsed.iter().zip(entries.iter()) {
            assert_eq!(got.key, expected.key);
            assert_eq!(got.value, expected.value);
        }
    }
}

pub fn staged_env_file(directory: &Path) -> PathBuf {
    directory.join("stack.env.new")
}

pub fn committed_env_file(directory: &Path) -> PathBuf {
    directory.join("stack.env")
}
