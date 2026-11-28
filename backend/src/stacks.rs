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
    serde_yaml::from_str::<serde_yaml::Value>(compose).map_err(|_| {
        ApiError::validation("The Compose file is not valid YAML.")
    })?;
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

/// Present stored compose as normalized YAML for the web editor.
pub fn compose_for_editor(compose: &str) -> String {
    match serde_yaml::from_str::<serde_yaml::Value>(compose) {
        Ok(value) => serde_yaml::to_string(&value).unwrap_or_else(|_| compose.to_string()),
        Err(_) => compose.to_string(),
    }
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
    apply_changes: bool,
) -> Result<(), ApiError> {
    run(project, directory, compose_file, env_file, "up", apply_changes).await
}

pub async fn down(
    project: &str,
    directory: &Path,
    compose_file: &Path,
    env_file: Option<&Path>,
) -> Result<(), ApiError> {
    run(project, directory, compose_file, env_file, "down", false).await
}

pub async fn start(
    project: &str,
    directory: &Path,
    compose_file: &Path,
) -> Result<(), ApiError> {
    run(project, directory, compose_file, None, "start", false).await
}

pub async fn stop(
    project: &str,
    directory: &Path,
    compose_file: &Path,
) -> Result<(), ApiError> {
    run(project, directory, compose_file, None, "stop", false).await
}

pub async fn restart(
    project: &str,
    directory: &Path,
    compose_file: &Path,
    repull: bool,
) -> Result<(), ApiError> {
    if repull {
        run(project, directory, compose_file, None, "pull", false).await?;
        run(project, directory, compose_file, None, "up", true).await
    } else {
        run(project, directory, compose_file, None, "restart", false).await
    }
}

async fn run(
    project: &str,
    directory: &Path,
    compose_file: &Path,
    env_file: Option<&Path>,
    action: &str,
    apply_changes: bool,
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
    command.arg(action);
    if action == "up" {
        command.arg("--detach");
        command.arg("--remove-orphans");
        command.arg("--pull").arg("missing");
        if apply_changes {
            command.arg("--force-recreate");
        }
    }
    // Inherited stdin lets Compose wait on a registry prompt. The UI then stays
    // on Updating until the apply timeout, or longer if the process is not killed.
    command.stdin(std::process::Stdio::null());
    command.kill_on_drop(true);
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
    Err(ApiError::deploy(format!(
        "Compose failed. Some services may already have changed. {}",
        compose_failure_tail(&output.stdout, &output.stderr)
    )))
}

/// `up --detach` returns success once the container process has started, including
/// when that process has already exited. Callers that just updated a stack use this
/// to avoid saving a deploy that did not stay up.
/// shortcut: a service that is still running here and crashes later is saved,
/// revisit if a crash-after-start shows up as a silent rollback.
pub fn services_that_did_not_stay_up(ps_output: &str) -> Result<Vec<String>, ()> {
    let mut failed = Vec::new();
    for row in compose_ps_rows(ps_output)? {
        let state = ps_str(&row, "State");
        let service = {
            let service = ps_str(&row, "Service");
            if !service.is_empty() {
                service.to_string()
            } else {
                let name = ps_str(&row, "Name");
                if name.is_empty() {
                    "a service".to_string()
                } else {
                    name.to_string()
                }
            }
        };
        let code = ps_exit_code(&row);
        let health = ps_str(&row, "Health");
        if state == "running" && health == "unhealthy" {
            failed.push(format!("{service} is unhealthy"));
            continue;
        }
        let detail = match state {
            "running" | "paused" => None,
            "exited" if code == 0 => None,
            "exited" => Some(format!("{service} exited with status {code}")),
            "restarting" => Some(format!("{service} is restarting")),
            "" if code != 0 => Some(format!("{service} exited with status {code}")),
            "" => None,
            other => Some(format!("{service} is {other}")),
        };
        if let Some(detail) = detail {
            failed.push(detail);
        }
    }
    Ok(failed)
}

pub fn update_not_saved(reason: &str, restore: Result<(), &str>) -> String {
    let base = format!("{reason} The update was not saved.");
    match restore {
        Ok(()) => format!("{base} The previous stack was restored."),
        Err(error) => format!("{base} Restoring the previous stack also failed. {error}"),
    }
}

pub async fn compose_ps(
    project: &str,
    directory: &Path,
    compose_file: &Path,
    env_file: Option<&Path>,
) -> Result<String, ApiError> {
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
    command.args(["ps", "--all", "--format", "json"]);
    command.stdin(std::process::Stdio::null());
    command.kill_on_drop(true);
    let child = command
        .spawn()
        .map_err(|error| ApiError::deploy(format!("Could not read Compose status: {error}")))?;
    let output = child.wait_with_output();
    tokio::pin!(output);
    let output = tokio::time::timeout(Duration::from_secs(30), &mut output)
        .await
        .map_err(|_| ApiError::deploy("Could not read Compose status."))?
        .map_err(|error| ApiError::deploy(format!("Could not read Compose status: {error}")))?;
    if !output.status.success() {
        return Err(ApiError::deploy(format!(
            "Could not read Compose status. {}",
            compose_failure_tail(&output.stdout, &output.stderr)
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn compose_failure_tail(stdout: &[u8], stderr: &[u8]) -> String {
    let err = String::from_utf8_lossy(stderr);
    let out = String::from_utf8_lossy(stdout);
    let text = if !err.trim().is_empty() {
        err.trim()
    } else {
        out.trim()
    };
    let tail: String = text.chars().rev().take(1000).collect();
    let tail: String = tail.chars().rev().collect();
    if tail.is_empty() {
        "Compose exited unsuccessfully.".to_string()
    } else {
        tail
    }
}

fn compose_ps_rows(ps_output: &str) -> Result<Vec<serde_json::Value>, ()> {
    let trimmed = ps_output.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    if trimmed.starts_with('[') {
        return serde_json::from_str(trimmed).map_err(|_| ());
    }
    let mut rows = Vec::new();
    for line in trimmed.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        rows.push(serde_json::from_str(line).map_err(|_| ())?);
    }
    Ok(rows)
}

fn ps_str<'a>(row: &'a serde_json::Value, name: &str) -> &'a str {
    row.get(name)
        .or_else(|| row.get(name.to_ascii_lowercase()))
        .and_then(|value| value.as_str())
        .unwrap_or("")
}

fn ps_exit_code(row: &serde_json::Value) -> i64 {
    let value = row
        .get("ExitCode")
        .or_else(|| row.get("exitcode"))
        .or_else(|| row.get("Exitcode"));
    match value {
        Some(value) if value.is_i64() || value.is_u64() => value.as_i64().unwrap_or(0),
        Some(value) => value.as_str().unwrap_or("0").parse().unwrap_or(0),
        None => 0,
    }
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
        assert!(validate_compose("not yaml: [[[").is_err());
        assert!(validate_compose("services:\n  web:\n    build: .\n").is_err());
        assert!(validate_compose("services:\n  web:\n    env_file: .env\n").is_err());
        assert!(validate_compose("services:\n  web:\n    env_file: stack.env\n").is_ok());
        assert!(validate_compose("# comment only\n").is_err());
        assert!(validate_compose(&"x".repeat(MAX_COMPOSE_BYTES + 1)).is_err());
    }

    #[test]
    fn compose_for_editor_normalizes_yaml() {
        let json = "{\"services\":{\"web\":{\"image\":\"nginx\"}}}";
        let yaml = compose_for_editor(json);
        assert!(yaml.contains("services:"));
        assert!(yaml.contains("image: nginx"));
    }

    #[test]
    fn editor_normalization_keeps_a_changed_image() {
        let shown = compose_for_editor("services:\n  web:\n    image: nginx:1.27\n");
        assert!(shown.contains("nginx:1.27"), "{shown}");
    }

    #[test]
    fn detach_success_is_not_saved_when_a_service_has_already_exited() {
        let ps = r#"{"Command":"\"sh -c exit 1\"","ExitCode":1,"Health":"","Name":"demo-web-1","Service":"web","State":"exited"}"#;
        let failed = services_that_did_not_stay_up(ps).unwrap();
        assert_eq!(failed, vec!["web exited with status 1".to_string()]);
        let message = update_not_saved(
            &format!("Compose finished, but {}.", failed.join("; ")),
            Ok(()),
        );
        assert!(message.contains("web exited with status 1"));
        assert!(message.contains("The update was not saved."));
        assert!(message.contains("The previous stack was restored."));
        assert!(!message.to_lowercase().contains("updated"));
    }

    #[test]
    fn a_one_shot_exit_and_a_running_service_can_be_saved() {
        let ps = "{\"Service\":\"migrate\",\"State\":\"exited\",\"ExitCode\":0}\n{\"Service\":\"web\",\"State\":\"running\",\"ExitCode\":0,\"Health\":\"starting\"}";
        assert!(services_that_did_not_stay_up(ps).unwrap().is_empty());
        assert!(services_that_did_not_stay_up("").unwrap().is_empty());
        assert!(services_that_did_not_stay_up("   \n").unwrap().is_empty());
    }

    #[test]
    fn restarting_or_unhealthy_services_fail_the_update() {
        let ps = "[{\"Service\":\"web\",\"State\":\"restarting\",\"ExitCode\":1},{\"Service\":\"api\",\"State\":\"running\",\"Health\":\"unhealthy\",\"ExitCode\":0}]";
        let failed = services_that_did_not_stay_up(ps).unwrap();
        assert_eq!(
            failed,
            vec![
                "web is restarting".to_string(),
                "api is unhealthy".to_string(),
            ]
        );
        let message = update_not_saved("Could not read Compose status.", Err("engine refused"));
        assert!(message.contains("Could not read Compose status."));
        assert!(message.contains("Restoring the previous stack also failed. engine refused"));
        assert!(message.contains("The update was not saved."));
    }

    #[test]
    fn compose_status_that_is_not_json_is_not_treated_as_success() {
        assert!(services_that_did_not_stay_up("not json").is_err());
    }

    #[test]
    fn compose_failure_uses_stdout_when_stderr_is_empty() {
        let tail = compose_failure_tail(b"container web exited (1)", b"  \n");
        assert_eq!(tail, "container web exited (1)");
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
