//! Docker daemon access via `bollard`.
//!
//! On Windows the daemon is the named pipe `//./pipe/docker_engine`.
//! Every Docker endpoint uses that local engine. Socket paths are not accepted.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::time::Duration;

use bollard::auth::DockerCredentials;
use bollard::container::LogOutput;
use bollard::exec::{CreateExecOptions, ResizeExecOptions, StartExecOptions, StartExecResults};
use bollard::models::{
    ContainerCreateBody, ContainerInspectResponse, ContainerSummary, ContainerUpdateBody,
    EndpointSettings, HostConfig, ImageSummary, Mount, MountType, Network, NetworkCreateRequest,
    NetworkingConfig, PortBinding, RestartPolicy, RestartPolicyNameEnum, VolumeCreateRequest,
};
use bollard::query_parameters::{
    CreateContainerOptionsBuilder, CreateImageOptionsBuilder, InspectContainerOptions,
    ListContainersOptions, ListImagesOptions, ListNetworksOptions, ListVolumesOptions,
    LogsOptionsBuilder, RemoveContainerOptionsBuilder, RemoveImageOptions, RemoveVolumeOptions,
    RenameContainerOptionsBuilder, StopContainerOptions,
};
use bollard::Docker;
use futures_util::{StreamExt, TryStreamExt};
use serde::{Deserialize, Serialize};

use crate::error::ApiError;

pub const ENGINE_DOWN: &str =
    "The engine did not answer within 10 seconds. Nothing on this page was changed.";

const TIMEOUT: Duration = Duration::from_secs(10);
const PULL_TIMEOUT: Duration = Duration::from_secs(300);

const COMPOSE_PROJECT: &str = "com.docker.compose.project";
const COMPOSE_SERVICE: &str = "com.docker.compose.service";
const COMPOSE_ONEOFF: &str = "com.docker.compose.oneoff";
const COMPOSE_DEPENDS_ON: &str = "com.docker.compose.depends_on";

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

/// One-line description used by `/api/health`. Does not contact the daemon.
pub fn describe() -> String {
    match client() {
        Ok(_) => "client ok".to_string(),
        Err(e) => format!("client error: {}", scrub(&e.to_string())),
    }
}

fn docker() -> Result<Docker, ApiError> {
    client().map_err(|e| ApiError::daemon(scrub(&e.to_string())))
}

fn scrub(raw: &str) -> String {
    let lower = raw.to_ascii_lowercase();
    if lower.contains("npipe") || lower.contains("docker.sock") || lower.contains("docker_engine") {
        return ENGINE_DOWN.to_string();
    }
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        ENGINE_DOWN.to_string()
    } else {
        trimmed.chars().take(400).collect()
    }
}

fn map_err(err: bollard::errors::Error) -> ApiError {
    match err {
        bollard::errors::Error::DockerResponseServerError {
            status_code,
            message,
        } => {
            let message = scrub(&message);
            match status_code {
                404 => ApiError::not_found(message),
                409 => ApiError::in_use(message),
                400 => ApiError::unsafe_validation(message),
                _ => ApiError::daemon(message),
            }
        }
        other => ApiError::daemon(scrub(&other.to_string())),
    }
}

async fn timed<T, F>(fut: F) -> Result<T, ApiError>
where
    F: std::future::Future<Output = Result<T, bollard::errors::Error>>,
{
    match tokio::time::timeout(TIMEOUT, fut).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(err)) => Err(map_err(err)),
        Err(_) => Err(ApiError::daemon(ENGINE_DOWN)),
    }
}

pub fn object_ref(raw: &str) -> Result<&str, ApiError> {
    let name = raw.trim();
    let ok = !name.is_empty()
        && name.len() <= 256
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-' | ':'));
    if ok {
        Ok(name)
    } else {
        Err(ApiError::validation("That name is not valid."))
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortOut {
    pub host: Option<u16>,
    pub host_ip: Option<String>,
    pub container: u16,
    pub protocol: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerOut {
    pub id: String,
    pub name: String,
    pub image: String,
    pub state: String,
    pub status_text: String,
    pub ports: Vec<PortOut>,
    pub created: i64,
    /// `locked` / `read` / `operate` for the AI agent, when the caller asked for it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ai_access: Option<AiAccessLabel>,
}

/// The agent policy for one listed container. Forced lock is included so the
/// console can say "Locked · forced" without a second request per row.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAccessLabel {
    pub state: String,
    pub forced_locked: bool,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mount: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StackContainerOut {
    pub id: String,
    pub name: String,
    pub service: Option<String>,
    pub state: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StackOut {
    pub project: String,
    pub running: usize,
    pub total: usize,
    pub state: &'static str,
    pub containers: Vec<StackContainerOut>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MountOut {
    pub source: String,
    pub destination: String,
    pub mode: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkAttachment {
    pub name: String,
    pub ip: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerDetail {
    pub id: String,
    pub name: String,
    pub image: String,
    pub image_id: String,
    pub state: String,
    pub status_text: String,
    pub created: String,
    pub started: Option<String>,
    pub command: String,
    pub entrypoint: String,
    pub restart_policy: String,
    pub restart_maximum_retry_count: Option<i64>,
    pub ports: Vec<PortOut>,
    pub mounts: Vec<MountOut>,
    pub networks: Vec<NetworkAttachment>,
    pub env: Vec<EnvOut>,
    pub labels: Vec<LabelOut>,
}

#[derive(Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvOut {
    pub key: String,
    pub value: String,
}

#[derive(Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelOut {
    pub key: String,
    pub value: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub timestamp: String,
    pub stream: String,
    pub text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub engine: EngineOut,
    pub counts: CountsOut,
    pub recent_containers: Vec<ContainerOut>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineOut {
    pub version: String,
    pub api_version: String,
    pub os: String,
    pub cpus: i64,
    pub memory_bytes: i64,
    pub status: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CountsOut {
    pub containers_running: i64,
    pub containers_stopped: i64,
    pub images: i64,
    pub volumes: i64,
    pub networks: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageOut {
    pub id: String,
    pub tags: Vec<String>,
    pub size_bytes: i64,
    pub created: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeOut {
    pub name: String,
    pub driver: String,
    pub mountpoint: String,
    pub created: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkOut {
    pub name: String,
    pub driver: String,
    pub scope: String,
    pub subnet: String,
    pub container_count: usize,
    pub removable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedContainer {
    pub id: String,
    pub name: String,
}

pub struct RunRequest {
    pub image: String,
    pub name: Option<String>,
    pub ports: Vec<RunPort>,
}

pub struct RunPort {
    pub host: u16,
    pub container: u16,
    pub protocol: String,
}

pub async fn engine_up() -> bool {
    let Ok(docker) = docker() else {
        return false;
    };
    timed(docker.ping()).await.is_ok()
}

pub async fn overview() -> Result<Overview, ApiError> {
    let docker = docker()?;
    let work = async {
        let (version, info, containers, volumes, networks) = tokio::try_join!(
            docker.version(),
            docker.info(),
            docker.list_containers(Some(ListContainersOptions {
                all: true,
                ..Default::default()
            })),
            docker.list_volumes(None::<ListVolumesOptions>),
            docker.list_networks(None::<ListNetworksOptions>),
        )
        .map_err(map_err)?;
        let mut recent: Vec<ContainerOut> = containers.iter().map(container_out).collect();
        recent.sort_by_key(|item| std::cmp::Reverse(item.created));
        recent.truncate(5);
        let volume_count = volumes.volumes.as_ref().map(|v| v.len()).unwrap_or(0) as i64;
        Ok(Overview {
            engine: EngineOut {
                version: version.version.unwrap_or_default(),
                api_version: version.api_version.unwrap_or_default(),
                os: version.os.unwrap_or_default(),
                cpus: info.ncpu.unwrap_or(0),
                memory_bytes: info.mem_total.unwrap_or(0),
                status: "up",
            },
            counts: CountsOut {
                containers_running: info.containers_running.unwrap_or(0),
                containers_stopped: info.containers_stopped.unwrap_or(0),
                images: info.images.unwrap_or(0),
                volumes: volume_count,
                networks: networks.len() as i64,
            },
            recent_containers: recent,
        })
    };
    match tokio::time::timeout(TIMEOUT, work).await {
        Ok(result) => result,
        Err(_) => Err(ApiError::daemon(ENGINE_DOWN)),
    }
}

/// One Compose project on the engine, keyed by `com.docker.compose.project`.
/// Membership is live labels only: nothing is stored in `endpoints.json`.
pub async fn list_stacks(q: &str) -> Result<Vec<StackOut>, ApiError> {
    let docker = docker()?;
    let mut filters = HashMap::new();
    filters.insert("label".to_string(), vec![COMPOSE_PROJECT.to_string()]);
    let listed = timed(docker.list_containers(Some(ListContainersOptions {
        all: true,
        filters: Some(filters),
        ..Default::default()
    })))
    .await?;
    let rows = listed.iter().filter_map(compose_row).collect();
    let mut stacks = group_stacks(rows);
    let q = q.trim().to_ascii_lowercase();
    stacks.retain(|stack| q.is_empty() || stack.project.to_ascii_lowercase().contains(&q));
    Ok(stacks)
}

pub async fn list_containers(q: &str, state: &str) -> Result<Vec<ContainerOut>, ApiError> {
    let docker = docker()?;
    let listed = timed(docker.list_containers(Some(ListContainersOptions {
        all: true,
        ..Default::default()
    })))
    .await?;
    let q = q.trim().to_ascii_lowercase();
    let state = state.trim().to_ascii_lowercase();
    let mut items: Vec<ContainerOut> = listed
        .iter()
        .map(container_out)
        .filter(|item| {
            (state.is_empty() || state == "all" || item.state == state)
                && (q.is_empty()
                    || item.name.to_ascii_lowercase().contains(&q)
                    || item.image.to_ascii_lowercase().contains(&q))
        })
        .collect();
    items.sort_by_key(|item| std::cmp::Reverse(item.created));
    Ok(items)
}

pub async fn inspect_container(id: &str) -> Result<ContainerDetail, ApiError> {
    let docker = docker()?;
    let inspected = match timed(docker.inspect_container(id, None::<InspectContainerOptions>)).await
    {
        Ok(value) => value,
        Err(err) if err.code == "not_found" => {
            return Err(ApiError::not_found(format!("{id} was not found.")));
        }
        Err(err) => return Err(err),
    };
    let summary = list_summary(&docker, id).await.ok();
    Ok(detail_out(inspected, summary.as_ref()))
}

pub fn console_command(value: Option<&str>) -> Result<&'static str, ApiError> {
    match value.unwrap_or("sh") {
        "sh" => Ok("/bin/sh"),
        "bash" => Ok("/bin/bash"),
        "ash" => Ok("/bin/ash"),
        _ => Err(ApiError::validation("Choose a supported shell.")),
    }
}

pub fn console_user(value: Option<&str>) -> Result<Option<&'static str>, ApiError> {
    match value.unwrap_or("default") {
        "default" => Ok(None),
        "root" => Ok(Some("0")),
        _ => Err(ApiError::validation("Choose a supported user.")),
    }
}

pub async fn create_console_exec(
    container_id: &str,
    command: &'static str,
    user: Option<&'static str>,
) -> Result<(Docker, String), ApiError> {
    let docker = docker()?;
    let exec = timed(docker.create_exec(
        container_id,
        CreateExecOptions::<String> {
            cmd: Some(vec![command.to_string()]),
            user: user.map(str::to_string),
            attach_stdin: Some(true),
            attach_stdout: Some(true),
            attach_stderr: Some(true),
            tty: Some(true),
            privileged: Some(false),
            ..Default::default()
        },
    ))
    .await?;
    Ok((docker, exec.id))
}

pub async fn start_console_exec(
    docker: &Docker,
    exec_id: &str,
) -> Result<StartExecResults, ApiError> {
    timed(docker.start_exec(
        exec_id,
        Some(StartExecOptions {
            detach: false,
            tty: true,
            output_capacity: None,
        }),
    ))
    .await
}

pub async fn resize_console_exec(docker: &Docker, exec_id: &str, width: u16, height: u16) {
    if !(1..=500).contains(&width) || !(1..=500).contains(&height) {
        return;
    }
    let resize = docker.resize_exec(exec_id, ResizeExecOptions { width, height });
    let _ = tokio::time::timeout(Duration::from_secs(2), resize).await;
}

pub async fn logs(id: &str, tail: usize) -> Result<Vec<LogLine>, ApiError> {
    let docker = docker()?;
    let tail = tail.clamp(1, 200);
    let options = LogsOptionsBuilder::new()
        .stdout(true)
        .stderr(true)
        .timestamps(true)
        .tail(&tail.to_string())
        .build();
    let mut stream = docker.logs(id, Some(options));
    let collect = async {
        let mut lines = Vec::new();
        while let Some(item) = stream.next().await {
            let output = item.map_err(map_err)?;
            let (stream_name, bytes) = match output {
                LogOutput::StdErr { message } => ("stderr", message),
                LogOutput::StdOut { message } | LogOutput::Console { message } => {
                    ("stdout", message)
                }
                LogOutput::StdIn { .. } => continue,
            };
            let text = String::from_utf8_lossy(&bytes);
            for raw in text.split('\n') {
                let raw = raw.trim_end_matches('\r');
                if raw.is_empty() {
                    continue;
                }
                let (timestamp, body) = split_timestamp(raw);
                lines.push(LogLine {
                    timestamp,
                    stream: stream_name.to_string(),
                    text: body,
                });
            }
        }
        Ok(lines)
    };
    match tokio::time::timeout(TIMEOUT, collect).await {
        Ok(result) => result,
        Err(_) => Err(ApiError::daemon(ENGINE_DOWN)),
    }
}

/// Docker cuts its log stream at arbitrary byte boundaries, so one line — and even
/// one multi-byte UTF-8 character — can arrive split across two chunks. Buffers are
/// kept per stream (`stdout` / `stderr`) so interleaved frames never merge.
#[derive(Default)]
pub struct LogLines {
    buffers: HashMap<String, Vec<u8>>,
}

impl LogLines {
    pub fn push(&mut self, stream: &str, chunk: &[u8]) -> Vec<LogLine> {
        let buffer = self.buffers.entry(stream.to_string()).or_default();
        buffer.extend_from_slice(chunk);
        let mut lines = Vec::new();
        while let Some(index) = buffer.iter().position(|byte| *byte == b'\n') {
            let raw: Vec<u8> = buffer.drain(..=index).collect();
            push_line(&mut lines, stream, &raw[..raw.len() - 1]);
        }
        lines
    }

    /// Emit what is still buffered when the stream ends. Docker lines normally end
    /// with a newline; a container killed mid-line leaves one without.
    pub fn flush(&mut self) -> Vec<LogLine> {
        let mut lines = Vec::new();
        for (stream, buffer) in self.buffers.iter_mut() {
            if buffer.is_empty() {
                continue;
            }
            let raw = std::mem::take(buffer);
            push_line(&mut lines, stream, &raw);
        }
        lines
    }
}

fn push_line(lines: &mut Vec<LogLine>, stream: &str, raw: &[u8]) {
    let raw = String::from_utf8_lossy(raw);
    let raw = raw.trim_end_matches('\r');
    if raw.is_empty() {
        return;
    }
    let (timestamp, text) = split_timestamp(raw);
    lines.push(LogLine {
        timestamp,
        stream: stream.to_string(),
        text,
    });
}

/// One NDJSON record. A mid-stream failure arrives as a final
/// `{"error": true, "message": ...}` record because the response headers were
/// already sent, so the status code can no longer carry it.
pub fn encode_event(item: Result<LogLine, ApiError>) -> String {
    match item {
        Ok(line) => serde_json::to_string(&line).unwrap_or_else(|_| "{}".to_string()),
        Err(err) => serde_json::json!({ "error": true, "message": err.message }).to_string(),
    }
}

/// Follow a container's log stream. Nothing here is wrapped in `TIMEOUT`: the
/// stream lives as long as the container keeps writing. Callers drop it to stop.
pub fn follow_logs(
    id: &str,
    tail: usize,
) -> Result<impl futures_util::Stream<Item = Result<LogLine, ApiError>> + Send, ApiError> {
    let docker = docker()?;
    let tail = tail.clamp(0, 200);
    let options = LogsOptionsBuilder::new()
        .stdout(true)
        .stderr(true)
        .timestamps(true)
        .follow(true)
        .tail(&tail.to_string())
        .build();
    let upstream = docker.logs(id, Some(options));
    let state = (
        upstream,
        LogLines::default(),
        VecDeque::<Result<LogLine, ApiError>>::new(),
        false,
    );
    Ok(futures_util::stream::unfold(
        state,
        |(mut upstream, mut lines, mut pending, mut ended)| async move {
            loop {
                if let Some(item) = pending.pop_front() {
                    return Some((item, (upstream, lines, pending, ended)));
                }
                if ended {
                    return None;
                }
                match upstream.next().await {
                    Some(Ok(output)) => {
                        let (stream, bytes) = match output {
                            LogOutput::StdErr { message } => ("stderr", message),
                            LogOutput::StdOut { message } | LogOutput::Console { message } => {
                                ("stdout", message)
                            }
                            LogOutput::StdIn { .. } => continue,
                        };
                        pending.extend(lines.push(stream, &bytes).into_iter().map(Ok));
                    }
                    Some(Err(err)) => {
                        ended = true;
                        return Some((Err(map_err(err)), (upstream, lines, pending, ended)));
                    }
                    None => {
                        ended = true;
                        pending.extend(lines.flush().into_iter().map(Ok));
                    }
                }
            }
        },
    ))
}

pub async fn start_container(id: &str) -> Result<(), ApiError> {
    let docker = docker()?;
    timed(docker.start_container(id, None)).await
}

pub async fn stop_container(id: &str) -> Result<(), ApiError> {
    let docker = docker()?;
    let options = bollard::query_parameters::StopContainerOptionsBuilder::new()
        .t(5)
        .build();
    timed(docker.stop_container(id, Some(options))).await
}

pub async fn restart_container(id: &str) -> Result<(), ApiError> {
    let docker = docker()?;
    let options = bollard::query_parameters::RestartContainerOptionsBuilder::new()
        .t(5)
        .build();
    timed(docker.restart_container(id, Some(options))).await
}

pub async fn remove_container(id: &str) -> Result<(), ApiError> {
    let docker = docker()?;
    remove_container_with(&docker, id).await
}

pub async fn run_container(request: RunRequest) -> Result<CreatedContainer, ApiError> {
    if request.image.trim().is_empty() {
        return Err(ApiError::validation("Choose an image."));
    }
    for port in &request.ports {
        if port.host == 0 || port.container == 0 {
            return Err(ApiError::validation(
                "Use host:container, a single port, or leave this empty.",
            ));
        }
        if !matches!(port.protocol.as_str(), "tcp" | "udp" | "sctp") {
            return Err(ApiError::validation(
                "Use host:container, a single port, or leave this empty.",
            ));
        }
    }
    let docker = docker()?;
    let mut exposed = Vec::new();
    let mut bindings = HashMap::new();
    for port in &request.ports {
        let key = format!("{}/{}", port.container, port.protocol);
        exposed.push(key.clone());
        bindings.insert(
            key,
            Some(vec![PortBinding {
                host_ip: Some("0.0.0.0".into()),
                host_port: Some(port.host.to_string()),
            }]),
        );
    }
    let config = ContainerCreateBody {
        image: Some(request.image),
        exposed_ports: if exposed.is_empty() {
            None
        } else {
            Some(exposed)
        },
        host_config: Some(HostConfig {
            port_bindings: if bindings.is_empty() {
                None
            } else {
                Some(bindings)
            },
            ..Default::default()
        }),
        ..Default::default()
    };
    let name = request.name.clone().filter(|name| !name.trim().is_empty());
    let options = name.as_deref().map(|name| {
        CreateContainerOptionsBuilder::new()
            .name(name.trim())
            .build()
    });
    let created = timed(docker.create_container(options, config)).await?;
    if let Err(err) = timed(docker.start_container(&created.id, None)).await {
        let cleanup = RemoveContainerOptionsBuilder::new().force(true).build();
        let _ = docker.remove_container(&created.id, Some(cleanup)).await;
        return Err(err);
    }
    let name = name.unwrap_or_else(|| created.id.chars().take(12).collect());
    Ok(CreatedContainer {
        id: created.id,
        name,
    })
}

// ---- duplicate / recreate (TELE-106) -------------------------------------
//
// The engine is the source of truth: the edit dialog fetches the live config
// (`container_config`) and the duplicate/recreate calls re-inspect the source
// container server-side, then merge the submitted edits over the full inspected
// config. The client never sends a whole container spec it could tamper with.

/// Fields the edit dialog lets the user change. `None` means "carry over".
#[derive(Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MountEdit {
    pub source: String,
    pub destination: String,
    pub mount_type: String,
    pub read_only: bool,
}

#[derive(Default)]
pub struct ContainerEdits {
    pub image: Option<String>,
    pub command: Option<Vec<String>>,
    pub entrypoint: Option<Vec<String>>,
    pub env: Option<Vec<EnvOut>>,
    pub labels: Option<Vec<LabelOut>>,
    pub ports: Option<Vec<String>>,
    pub mounts: Option<Vec<MountEdit>>,
    pub restart: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerConfigOut {
    pub name: String,
    pub image: String,
    pub command: Vec<String>,
    pub entrypoint: Vec<String>,
    pub env: Vec<EnvOut>,
    pub labels: Vec<LabelOut>,
    pub ports: Vec<String>,
    pub restart_policy: String,
    pub networks: Vec<String>,
    pub mounts: Vec<MountEdit>,
}

fn inspected_name(inspected: &ContainerInspectResponse) -> String {
    inspected
        .name
        .clone()
        .unwrap_or_default()
        .trim_start_matches('/')
        .to_string()
}

/// Docker's own container-name rule: `[a-zA-Z0-9][a-zA-Z0-9_.-]*`.
pub fn checked_container_name(raw: &str) -> Result<String, ApiError> {
    let name = raw.trim();
    let ok = !name.is_empty()
        && name.len() <= 255
        && name
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'));
    if ok {
        Ok(name.to_string())
    } else {
        Err(ApiError::validation(
            "Use a name that starts with a letter or number and contains only A-Z a-z 0-9 . _ -",
        ))
    }
}

/// One port row: `host:container`, a bare port, and an optional
/// `/tcp` `/udp` `/sctp` suffix (defaults to tcp).
fn parse_port_line(line: &str) -> Result<RunPort, ApiError> {
    let line = line.trim();
    let (mapping, protocol) = match line.split_once('/') {
        Some((mapping, "tcp")) => (mapping, "tcp".to_string()),
        Some((mapping, "udp")) => (mapping, "udp".to_string()),
        Some((mapping, "sctp")) => (mapping, "sctp".to_string()),
        Some((_, _)) => {
            return Err(ApiError::validation(
                "Port mapping protocol must be tcp, udp or sctp.",
            ));
        }
        None => (line, "tcp".to_string()),
    };
    let (host, container) = match mapping.split_once(':') {
        Some((host, container)) => (host, container),
        None => (mapping, mapping),
    };
    match (host.parse::<u16>(), container.parse::<u16>()) {
        (Ok(host), Ok(container)) if host > 0 && container > 0 => Ok(RunPort {
            host,
            container,
            protocol,
        }),
        _ => Err(ApiError::validation(
            "Port mapping must use host:container and an optional /tcp, /udp or /sctp.",
        )),
    }
}

fn special_port_line(line: &str, prefix: &str) -> Result<Option<String>, ApiError> {
    let Some(value) = line.trim().strip_prefix(prefix) else {
        return Ok(None);
    };
    let (port, protocol) = value.split_once('/').unwrap_or((value, "tcp"));
    let port = port.parse::<u16>().ok().filter(|port| *port > 0);
    if port.is_none() || !matches!(protocol, "tcp" | "udp" | "sctp") {
        return Err(ApiError::validation("Port mapping is invalid."));
    }
    Ok(Some(format!("{}/{protocol}", port.unwrap())))
}

fn bind_target(spec: &str) -> Option<&str> {
    let mut parts = spec.rsplit(':');
    let last = parts.next()?;
    let is_mode = last.contains(',')
        || matches!(
            last,
            "ro" | "rw"
                | "private"
                | "rprivate"
                | "shared"
                | "rshared"
                | "slave"
                | "rslave"
                | "z"
                | "Z"
        );
    if is_mode {
        parts.next()
    } else {
        Some(last)
    }
}

fn environment_lines(entries: &[EnvOut]) -> Result<Vec<String>, ApiError> {
    entries
        .iter()
        .map(|entry| {
            if entry.key.is_empty() || entry.key.contains('=') || entry.key.contains('\n') || entry.key.contains('\r') {
                return Err(ApiError::validation(
                    "Environment variable names must be non-empty and cannot contain '=', or newlines.",
                ));
            }
            Ok(format!("{}={}", entry.key, entry.value))
        })
        .collect()
}

fn restart_policy(name: &str, previous: Option<&RestartPolicy>) -> Result<RestartPolicy, ApiError> {
    if !matches!(name, "no" | "always" | "unless-stopped" | "on-failure") {
        return Err(ApiError::validation(
            "Restart policy must be no, always, unless-stopped or on-failure.",
        ));
    }
    let parsed = match name {
        "no" => RestartPolicyNameEnum::NO,
        "always" => RestartPolicyNameEnum::ALWAYS,
        "unless-stopped" => RestartPolicyNameEnum::UNLESS_STOPPED,
        _ => RestartPolicyNameEnum::ON_FAILURE,
    };
    Ok(RestartPolicy {
        name: Some(parsed),
        maximum_retry_count: if name == "on-failure" {
            previous.and_then(|policy| policy.maximum_retry_count)
        } else {
            None
        },
    })
}

/// Copy the inspected config and host config wholesale, then apply the edits.
pub fn checked_image_ref(raw: &str) -> Result<String, ApiError> {
    // Unlike an object name, an image reference carries registry path separators
    // (searxng/searxng:latest, ghcr.io/chakyiu/pisces@sha256:...). It goes to the
    // engine as a JSON field, never as a URL segment, so the shape check only
    // needs to keep whitespace and shell-ish junk out.
    let image = raw.trim();
    let ok = !image.is_empty()
        && image.len() <= 512
        && image
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-' | '/' | ':' | '@'));
    if ok {
        Ok(image.to_string())
    } else {
        Err(ApiError::validation("Enter a valid image reference."))
    }
}

fn build_container_body(
    inspected: &ContainerInspectResponse,
    edits: &ContainerEdits,
) -> Result<ContainerCreateBody, ApiError> {
    let config = inspected.config.clone().unwrap_or_default();
    let mut host = inspected.host_config.clone().unwrap_or_default();

    let image = match edits.image.as_deref().map(str::trim) {
        Some(image) if !image.is_empty() => checked_image_ref(image)?,
        _ => config
            .image
            .clone()
            .filter(|image| !image.is_empty())
            .ok_or_else(|| {
                ApiError::validation("The original container has no image reference.")
            })?,
    };
    if let Some(policy) = &edits.restart {
        host.restart_policy = Some(restart_policy(policy.trim(), host.restart_policy.as_ref())?);
    }
    let mut exposed = config.exposed_ports.clone();
    if let Some(lines) = &edits.ports {
        let mut keys = Vec::new();
        let mut bindings: HashMap<String, Vec<PortBinding>> = HashMap::new();
        for line in lines {
            if line.trim().is_empty() {
                continue;
            }
            if let Some(key) = special_port_line(line, "expose:")? {
                keys.push(key);
                continue;
            }
            if let Some(key) = special_port_line(line, "auto:")? {
                keys.push(key.clone());
                bindings.entry(key).or_default().push(PortBinding {
                    host_ip: None,
                    host_port: None,
                });
                continue;
            }
            let port = parse_port_line(line)?;
            let key = format!("{}/{}", port.container, port.protocol);
            let host_port = port.host.to_string();
            let host_ip = inspected
                .host_config
                .as_ref()
                .and_then(|host| host.port_bindings.as_ref())
                .and_then(|original| original.get(&key))
                .and_then(|bindings| bindings.as_ref())
                .and_then(|original| {
                    original
                        .iter()
                        .find(|binding| binding.host_port.as_deref() == Some(&host_port))
                })
                .and_then(|binding| binding.host_ip.clone())
                .or_else(|| Some("0.0.0.0".into()));
            keys.push(key.clone());
            bindings.entry(key).or_default().push(PortBinding {
                host_ip,
                host_port: Some(host_port),
            });
        }
        host.port_bindings = if bindings.is_empty() {
            None
        } else {
            Some(
                bindings
                    .into_iter()
                    .map(|(key, list)| (key, Some(list)))
                    .collect(),
            )
        };
        exposed = if keys.is_empty() { None } else { Some(keys) };
    }

    // Some daemons report mounts in .Mounts but omit them from HostConfig.
    // Preserve exact existing bind/mount options where possible and reuse
    // anonymous volume names so their data survives replacement.
    if let Some(mounts) = &edits.mounts {
        let original_host = inspected.host_config.as_ref();
        let original_mounts = inspected.mounts.as_deref().unwrap_or_default();
        let mut binds = Vec::new();
        let mut configured = Vec::with_capacity(mounts.len());
        let mut tmpfs = HashMap::new();
        for mount in mounts {
            if mount.destination.is_empty() || !mount.destination.starts_with('/') {
                return Err(ApiError::validation(
                    "Each mount needs an absolute container destination.",
                ));
            }
            let typ = match mount.mount_type.as_str() {
                "bind" if !mount.source.is_empty() => MountType::BIND,
                "volume" if !mount.source.is_empty() => MountType::VOLUME,
                "tmpfs" if mount.source.is_empty() => MountType::TMPFS,
                _ => return Err(ApiError::validation("Mount type or source is invalid.")),
            };
            let same_inspect_mount = original_mounts.iter().any(|original| {
                let source = if original.typ.as_deref() == Some("volume") {
                    original.name.as_deref().or(original.source.as_deref())
                } else {
                    original.source.as_deref()
                }
                .unwrap_or_default();
                original.destination.as_deref() == Some(mount.destination.as_str())
                    && source == mount.source
                    && original.typ.as_deref() == Some(mount.mount_type.as_str())
                    && (original.rw != Some(false)) == !mount.read_only
            });
            let unchanged = original_host
                .and_then(|host| host.mounts.as_ref())
                .and_then(|original| {
                    original.iter().find(|original| {
                        original.target.as_deref() == Some(mount.destination.as_str())
                            && original.source.as_deref().unwrap_or("") == mount.source
                            && original.typ == Some(typ)
                            && original.read_only.unwrap_or(false) == mount.read_only
                    })
                })
                .cloned();
            if typ == MountType::TMPFS {
                if let Some(original) = unchanged {
                    configured.push(original);
                } else {
                    let original_options = original_host
                        .and_then(|host| host.tmpfs.as_ref())
                        .and_then(|options| options.get(&mount.destination))
                        .filter(|_| same_inspect_mount)
                        .cloned();
                    tmpfs.insert(
                        mount.destination.clone(),
                        original_options.unwrap_or_else(|| {
                            if mount.read_only {
                                "ro".into()
                            } else {
                                String::new()
                            }
                        }),
                    );
                }
                continue;
            }
            if same_inspect_mount {
                if let Some(spec) =
                    original_host
                        .and_then(|host| host.binds.as_ref())
                        .and_then(|specs| {
                            specs
                                .iter()
                                .find(|spec| bind_target(spec) == Some(mount.destination.as_str()))
                        })
                {
                    binds.push(spec.clone());
                    continue;
                }
            }
            configured.push(unchanged.unwrap_or_else(|| Mount {
                target: Some(mount.destination.clone()),
                source: (!mount.source.is_empty()).then(|| mount.source.clone()),
                typ: Some(typ),
                read_only: Some(mount.read_only),
                ..Default::default()
            }));
        }
        host.binds = (!binds.is_empty()).then_some(binds);
        host.mounts = (!configured.is_empty()).then_some(configured);
        host.tmpfs = (!tmpfs.is_empty()).then_some(tmpfs);
    } else if host.binds.as_ref().is_none_or(Vec::is_empty)
        && host.mounts.as_ref().is_none_or(Vec::is_empty)
    {
        if let Some(mounts) = &inspected.mounts {
            let mut binds = Vec::new();
            for mount in mounts {
                let source = match mount.typ.as_deref() {
                    Some("volume") => mount.name.clone().or_else(|| mount.source.clone()),
                    Some("bind") => mount.source.clone(),
                    _ => continue,
                }
                .unwrap_or_default();
                let target = mount.destination.clone().unwrap_or_default();
                if source.is_empty() || target.is_empty() {
                    continue;
                }
                let ro = if mount.rw == Some(false) { ":ro" } else { "" };
                binds.push(format!("{source}:{target}{ro}"));
            }
            if !binds.is_empty() {
                host.binds = Some(binds);
            }
        }
    }

    Ok(ContainerCreateBody {
        hostname: config.hostname,
        domainname: config.domainname,
        user: config.user,
        attach_stdin: config.attach_stdin,
        attach_stdout: config.attach_stdout,
        attach_stderr: config.attach_stderr,
        exposed_ports: exposed,
        tty: config.tty,
        open_stdin: config.open_stdin,
        stdin_once: config.stdin_once,
        env: Some(match edits.env.as_deref() {
            Some(entries) => environment_lines(entries)?,
            None => config.env.unwrap_or_default(),
        }),
        cmd: edits.command.clone().or(config.cmd),
        entrypoint: edits.entrypoint.clone().or(config.entrypoint),
        healthcheck: config.healthcheck,
        args_escaped: config.args_escaped,
        image: Some(image),
        volumes: config.volumes,
        working_dir: config.working_dir,
        network_disabled: config.network_disabled,
        on_build: config.on_build,
        labels: Some(match &edits.labels {
            Some(entries) => {
                let mut labels = HashMap::new();
                for entry in entries {
                    if entry.key.is_empty() || entry.key.contains('\n') || entry.key.contains('\r')
                    {
                        return Err(ApiError::validation(
                            "Label names must be non-empty and cannot contain newlines.",
                        ));
                    }
                    labels.insert(entry.key.clone(), entry.value.clone());
                }
                labels
            }
            None => config.labels.unwrap_or_default(),
        }),
        stop_signal: config.stop_signal,
        stop_timeout: config.stop_timeout,
        shell: config.shell,
        host_config: Some(host),
        networking_config: networking_for_create(inspected),
    })
}

/// Re-attach custom networks with their aliases, but drop the assigned IP
/// addresses: the original container may still hold them when duplicating.
fn networking_for_create(inspected: &ContainerInspectResponse) -> Option<NetworkingConfig> {
    let networks = inspected.network_settings.as_ref()?.networks.as_ref()?;
    let mut endpoints: HashMap<String, EndpointSettings> = HashMap::new();
    for (name, endpoint) in networks {
        if matches!(name.as_str(), "bridge" | "host" | "none") {
            continue;
        }
        endpoints.insert(
            name.clone(),
            EndpointSettings {
                aliases: endpoint.aliases.clone(),
                driver_opts: endpoint.driver_opts.clone(),
                ..Default::default()
            },
        );
    }
    if endpoints.is_empty() {
        return None;
    }
    Some(NetworkingConfig {
        endpoints_config: Some(endpoints),
    })
}

async fn timed_for<T, F>(budget: std::time::Duration, fut: F) -> Result<T, ApiError>
where
    F: std::future::Future<Output = Result<T, bollard::errors::Error>>,
{
    match tokio::time::timeout(budget, fut).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(err)) => Err(map_err(err)),
        Err(_) => Err(ApiError::daemon(ENGINE_DOWN)),
    }
}

async fn inspect_raw(docker: &Docker, id: &str) -> Result<ContainerInspectResponse, ApiError> {
    match timed(docker.inspect_container(id, None::<InspectContainerOptions>)).await {
        Ok(value) => Ok(value),
        Err(err) if err.code == "not_found" => {
            Err(ApiError::not_found(format!("{id} was not found.")))
        }
        Err(err) => Err(err),
    }
}

/// Facts the AI access policy needs, always read from the live inspect so a
/// policy change or an engine-side edit cannot hide them.
pub fn live_access_from(inspected: &ContainerInspectResponse) -> crate::access::LiveAccess {
    let host = inspected.host_config.as_ref();
    let mut mount_sources = Vec::new();
    let mut volume_names = Vec::new();
    for mount in inspected.mounts.as_deref().unwrap_or_default() {
        if let Some(source) = mount.source.as_deref().filter(|value| !value.is_empty()) {
            mount_sources.push(source.to_string());
        }
        if let Some(name) = mount.name.as_deref().filter(|value| !value.is_empty()) {
            volume_names.push(name.to_string());
        }
    }
    if let Some(binds) = host.and_then(|host| host.binds.as_ref()) {
        for bind in binds {
            if let Some(source) = bind_source(bind) {
                mount_sources.push(source);
            }
        }
    }
    crate::access::LiveAccess {
        id: inspected.id.clone().unwrap_or_default(),
        name: inspected_name(inspected),
        mount_sources,
        volume_names,
        network_mode: host.and_then(|host| host.network_mode.clone()),
        pid_mode: host.and_then(|host| host.pid_mode.clone()),
        ipc_mode: host.and_then(|host| host.ipc_mode.clone()),
        privileged: host.and_then(|host| host.privileged).unwrap_or(false),
        devices: host
            .and_then(|host| host.devices.as_ref())
            .map(|devices| devices.len())
            .unwrap_or(0),
        security_opt: host
            .and_then(|host| host.security_opt.clone())
            .unwrap_or_default(),
        volumes_from: host
            .and_then(|host| host.volumes_from.clone())
            .unwrap_or_default(),
        links: host.and_then(|host| host.links.clone()).unwrap_or_default(),
    }
}

/// Host side of a `host:container[:mode]` bind spec.
fn bind_source(spec: &str) -> Option<String> {
    let spec = spec.trim();
    if spec.is_empty() {
        return None;
    }
    let mut parts: Vec<&str> = spec.split(':').collect();
    if parts.len() < 2 {
        return None;
    }
    if parts.last().is_some_and(|last| {
        last.eq_ignore_ascii_case("ro") || last.eq_ignore_ascii_case("rw") || last.contains(',')
    }) {
        parts.pop();
    }
    if parts.len() < 2 {
        return None;
    }
    parts.pop();
    if parts.len() == 2 && parts[0].len() == 1 && parts[0].as_bytes()[0].is_ascii_alphabetic() {
        return Some(format!("{}:{}", parts[0], parts[1]));
    }
    Some(parts.join(":"))
}

pub async fn live_access(id: &str) -> Result<crate::access::LiveAccess, ApiError> {
    let docker = docker()?;
    let inspected = inspect_raw(&docker, id).await?;
    Ok(live_access_from(&inspected))
}

/// Create and start a new container from the inspected source plus the edits.
pub async fn duplicate_container(
    source: &str,
    name: &str,
    edits: &ContainerEdits,
) -> Result<CreatedContainer, ApiError> {
    let docker = docker()?;
    let inspected = inspect_raw(&docker, source).await?;
    let body = build_container_body(&inspected, edits)?;
    let options = CreateContainerOptionsBuilder::new().name(name).build();
    let created = timed(docker.create_container(Some(options), body)).await?;
    if let Err(err) = timed(docker.start_container(&created.id, None)).await {
        let cleanup = RemoveContainerOptionsBuilder::new().force(true).build();
        let _ = docker.remove_container(&created.id, Some(cleanup)).await;
        return Err(err);
    }
    Ok(CreatedContainer {
        id: created.id,
        name: name.to_string(),
    })
}

/// Duplicate/Edit under the same name means replace, as in Portainer: docker
/// name uniqueness is case-insensitive, so the comparison is too.
pub async fn duplicate_or_replace(
    source: &str,
    name: &str,
    edits: &ContainerEdits,
) -> Result<CreatedContainer, ApiError> {
    let docker = docker()?;
    let inspected = inspect_raw(&docker, source).await?;
    if inspected_name(&inspected).eq_ignore_ascii_case(name) {
        recreate_container(source, Some(edits)).await
    } else {
        duplicate_container(source, name, edits).await
    }
}

/// Replace a container in place: stop the original to release published ports,
/// rename it aside, start a replacement with its config under the original name,
/// then remove the backup. Failures attempt to restore the original.
pub async fn recreate_container(
    source: &str,
    edits: Option<&ContainerEdits>,
) -> Result<CreatedContainer, ApiError> {
    let docker = docker()?;
    let inspected = inspect_raw(&docker, source).await?;
    let id = inspected
        .id
        .clone()
        .ok_or_else(|| ApiError::not_found("The original container was not found."))?;
    let name = inspected_name(&inspected);
    if name.is_empty() {
        return Err(ApiError::validation(
            "The original container has no name to replace.",
        ));
    }
    let body = build_container_body(&inspected, edits.unwrap_or(&ContainerEdits::default()))?;
    let was_running = inspected
        .state
        .as_ref()
        .and_then(|state| state.status)
        .map(|status| status.to_string())
        .is_some_and(|status| status == "running" || status == "restarting");
    let stop_grace = inspected
        .config
        .as_ref()
        .and_then(|config| config.stop_timeout)
        .unwrap_or(10)
        .clamp(1, 15) as u64;
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let backup = format!("pisces-recreate-{}-{unique}", short_id(&id));

    // Release published ports before creating the replacement, but keep the old
    // container available under a temporary name until the new one is healthy.
    if was_running
        && timed_for(
            std::time::Duration::from_secs(stop_grace + 5),
            docker.stop_container(
                &id,
                Some(StopContainerOptions {
                    t: Some(stop_grace as i32),
                    ..Default::default()
                }),
            ),
        )
        .await
        .is_err()
    {
        if ensure_container_running(&docker, &id).await.is_err() {
            return Err(recreate_recovery_error());
        }
        return Err(ApiError::daemon(
            "Recreate failed; the original container remains in place.",
        ));
    }
    let rename = RenameContainerOptionsBuilder::new().name(&backup).build();
    if timed(docker.rename_container(&id, rename)).await.is_err() {
        if was_running && ensure_container_running(&docker, &id).await.is_err() {
            return Err(recreate_recovery_error());
        }
        return Err(ApiError::conflict(
            "The original container could not be moved aside.",
        ));
    }

    let options = CreateContainerOptionsBuilder::new().name(&name).build();
    let created = match timed(docker.create_container(Some(options), body)).await {
        Ok(created) => created,
        Err(_) => {
            if restore_original(&docker, &id, &name, was_running)
                .await
                .is_err()
            {
                return Err(recreate_recovery_error());
            }
            return Err(ApiError::daemon(
                "Recreate failed; the original container was restored.",
            ));
        }
    };

    if timed(docker.start_container(&created.id, None))
        .await
        .is_err()
    {
        if remove_container_with(&docker, &created.id).await.is_err() {
            let failed_name = format!("pisces-failed-{}-{unique}", short_id(&created.id));
            let rename = RenameContainerOptionsBuilder::new()
                .name(&failed_name)
                .build();
            if timed(docker.rename_container(&created.id, rename))
                .await
                .is_err()
            {
                return Err(recreate_recovery_error());
            }
        }
        if restore_original(&docker, &id, &name, was_running)
            .await
            .is_err()
        {
            return Err(recreate_recovery_error());
        }
        return Err(ApiError::daemon(
            "Recreate failed; the original container was restored.",
        ));
    }

    if remove_container_with(&docker, &id).await.is_err() {
        let stopped = timed_for(
            std::time::Duration::from_secs(stop_grace + 5),
            docker.stop_container(
                &created.id,
                Some(StopContainerOptions {
                    t: Some(stop_grace as i32),
                    ..Default::default()
                }),
            ),
        )
        .await;
        if stopped.is_err() || remove_container_with(&docker, &created.id).await.is_err() {
            return Err(recreate_recovery_error());
        }
        if restore_original(&docker, &id, &name, was_running)
            .await
            .is_err()
        {
            return Err(recreate_recovery_error());
        }
        return Err(ApiError::daemon(
            "Recreate failed; the original container was restored.",
        ));
    }
    Ok(CreatedContainer {
        id: created.id,
        name,
    })
}

async fn remove_container_with(docker: &Docker, id: &str) -> Result<(), ApiError> {
    let options = RemoveContainerOptionsBuilder::new().force(true).build();
    timed(docker.remove_container(id, Some(options))).await
}

async fn ensure_container_running(docker: &Docker, id: &str) -> Result<(), ApiError> {
    let inspected = inspect_raw(docker, id).await?;
    let running = inspected
        .state
        .as_ref()
        .and_then(|state| state.status.as_ref())
        .map(ToString::to_string)
        .is_some_and(|status| matches!(status.as_str(), "running" | "restarting"));
    if !running {
        timed(docker.start_container(id, None)).await?;
    }
    Ok(())
}

async fn restore_original(
    docker: &Docker,
    id: &str,
    original_name: &str,
    restart: bool,
) -> Result<(), ApiError> {
    let rename = RenameContainerOptionsBuilder::new()
        .name(original_name)
        .build();
    timed(docker.rename_container(id, rename)).await?;
    if restart {
        ensure_container_running(docker, id).await?;
    }
    Ok(())
}

fn recreate_recovery_error() -> ApiError {
    ApiError::daemon("Recreate recovery incomplete: inspect container state before retrying.")
}

pub async fn container_config(id: &str) -> Result<ContainerConfigOut, ApiError> {
    let docker = docker()?;
    let inspected = inspect_raw(&docker, id).await?;
    let config = inspected.config.clone().unwrap_or_default();
    let host = inspected.host_config.clone().unwrap_or_default();
    let port_bindings = host.port_bindings.unwrap_or_default();
    let bound_keys: Vec<String> = port_bindings.keys().cloned().collect();
    let mut ports: Vec<String> = port_bindings
        .into_iter()
        .map(|(key, bindings)| {
            let binding = bindings.and_then(|list| list.into_iter().next());
            match binding.and_then(|binding| binding.host_port) {
                Some(host_port) if !host_port.is_empty() => format!("{host_port}:{key}"),
                _ => format!("auto:{key}"),
            }
        })
        .collect();
    if let Some(exposed) = &config.exposed_ports {
        ports.extend(
            exposed
                .iter()
                .filter(|key| !bound_keys.contains(key))
                .map(|key| format!("expose:{key}")),
        );
    }
    ports.sort();
    let mut networks: Vec<String> = inspected
        .network_settings
        .as_ref()
        .and_then(|settings| settings.networks.as_ref())
        .map(|settings| settings.keys().cloned().collect())
        .unwrap_or_default();
    networks.sort();
    let name = inspected_name(&inspected);
    let mounts = inspected
        .mounts
        .unwrap_or_default()
        .into_iter()
        .map(|mount| MountEdit {
            source: if mount.typ.as_deref() == Some("volume") {
                mount
                    .name
                    .unwrap_or_else(|| mount.source.unwrap_or_default())
            } else if mount.typ.as_deref() == Some("tmpfs") {
                String::new()
            } else {
                mount.source.unwrap_or_default()
            },
            destination: mount.destination.unwrap_or_default(),
            mount_type: mount.typ.unwrap_or_else(|| "bind".into()),
            read_only: mount.rw == Some(false),
        })
        .collect();
    let env = config
        .env
        .as_deref()
        .unwrap_or_default()
        .iter()
        .map(|entry| {
            let (key, value) = entry.split_once('=').unwrap_or((entry, ""));
            EnvOut {
                key: key.to_string(),
                value: value.to_string(),
            }
        })
        .collect();
    let mut labels: Vec<LabelOut> = config
        .labels
        .as_ref()
        .into_iter()
        .flatten()
        .map(|(key, value)| LabelOut {
            key: key.clone(),
            value: value.clone(),
        })
        .collect();
    labels.sort_by(|a, b| a.key.cmp(&b.key));
    Ok(ContainerConfigOut {
        name,
        image: config.image.unwrap_or_default(),
        command: config.cmd.unwrap_or_default(),
        entrypoint: config.entrypoint.unwrap_or_default(),
        env,
        labels,
        ports,
        restart_policy: host
            .restart_policy
            .as_ref()
            .and_then(|policy| policy.name.as_ref())
            .map(|name| name.to_string())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| "no".into()),
        networks,
        mounts,
    })
}

pub async fn update_container_settings(
    id: &str,
    requested_name: Option<&str>,
    requested_policy: Option<&str>,
    requested_retries: Option<i64>,
) -> Result<(), ApiError> {
    let docker = docker()?;
    let inspected = inspect_raw(&docker, id).await?;
    let full_id = inspected
        .id
        .clone()
        .ok_or_else(|| ApiError::not_found(format!("{id} was not found.")))?;
    let current_name = inspected_name(&inspected);
    let next_name = requested_name.map(checked_container_name).transpose()?;
    let rename_needed = next_name
        .as_deref()
        .is_some_and(|name| name != current_name && !name.eq_ignore_ascii_case(&current_name));
    let old_policy = inspected
        .host_config
        .as_ref()
        .and_then(|host| host.restart_policy.as_ref());
    let policy = requested_policy
        .map(|name| {
            let mut policy = restart_policy(name.trim(), old_policy)?;
            if name.trim() == "on-failure" {
                let retries = requested_retries
                    .or_else(|| old_policy.and_then(|old| old.maximum_retry_count))
                    .unwrap_or(0);
                if retries < 0 {
                    return Err(ApiError::validation("Retry count cannot be negative."));
                }
                policy.maximum_retry_count = Some(retries);
            }
            Ok(policy)
        })
        .transpose()?;

    if let (true, Some(name)) = (rename_needed, next_name.as_deref()) {
        let rename = RenameContainerOptionsBuilder::new().name(name).build();
        timed(docker.rename_container(&full_id, rename)).await?;
    }
    if let Some(restart_policy) = policy {
        if let Err(error) = timed(docker.update_container(
            &full_id,
            ContainerUpdateBody {
                restart_policy: Some(restart_policy),
                ..Default::default()
            },
        ))
        .await
        {
            if rename_needed {
                let rename = RenameContainerOptionsBuilder::new()
                    .name(&current_name)
                    .build();
                if timed(docker.rename_container(&full_id, rename))
                    .await
                    .is_err()
                {
                    return Err(ApiError::daemon(
                        "Restart policy update failed and the original name could not be restored.",
                    ));
                }
            }
            return Err(error);
        }
    }
    Ok(())
}

pub async fn list_images() -> Result<Vec<ImageOut>, ApiError> {
    let docker = docker()?;
    let images = timed(docker.list_images(None::<ListImagesOptions>)).await?;
    let mut items: Vec<ImageOut> = images.into_iter().map(image_out).collect();
    items.sort_by_key(|item| std::cmp::Reverse(item.created));
    Ok(items)
}

pub async fn pull_image(reference: &str) -> Result<(), ApiError> {
    let reference = checked_image_ref(reference)?;
    let docker = docker()?;
    let options = CreateImageOptionsBuilder::default()
        .from_image(&reference)
        .build();
    let stream = docker.create_image(Some(options), None, None);
    let pull = tokio::time::timeout(PULL_TIMEOUT, stream.try_collect::<Vec<_>>());
    tokio::pin!(pull);
    match pull.await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(err)) => Err(map_err(err)),
        Err(_) => Err(ApiError::daemon(
            "The image pull did not finish within five minutes.",
        )),
    }
}

pub async fn image_for_edits(source: &str, edits: &ContainerEdits) -> Result<String, ApiError> {
    if let Some(image) = edits.image.as_deref().map(str::trim) {
        if !image.is_empty() {
            return checked_image_ref(image);
        }
    }
    let config = container_config(source).await?;
    checked_image_ref(&config.image)
}

pub async fn remove_image(reference: &str) -> Result<(), ApiError> {
    let docker = docker()?;
    let images = timed(docker.list_images(None::<ListImagesOptions>)).await?;
    if let Some(image) = images.iter().find(|image| image_matches(image, reference)) {
        if image.containers > 0 {
            let tag = display_tag(image);
            return Err(ApiError::in_use(format!(
                "{tag} is used by {} containers. Stop and remove those first.",
                image.containers
            )));
        }
    }
    timed(docker.remove_image(
        reference,
        None::<RemoveImageOptions>,
        None::<DockerCredentials>,
    ))
    .await?;
    Ok(())
}

pub async fn list_volumes(q: &str) -> Result<Vec<VolumeOut>, ApiError> {
    let docker = docker()?;
    let listed = timed(docker.list_volumes(None::<ListVolumesOptions>)).await?;
    let q = q.trim().to_ascii_lowercase();
    let mut items: Vec<VolumeOut> = listed
        .volumes
        .unwrap_or_default()
        .into_iter()
        .filter(|volume| q.is_empty() || volume.name.to_ascii_lowercase().contains(&q))
        .map(|volume| VolumeOut {
            name: volume.name.clone(),
            driver: volume.driver.clone(),
            mountpoint: volume.mountpoint.clone(),
            created: volume.created_at.unwrap_or_default(),
        })
        .collect();
    items.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(items)
}

pub async fn create_volume(name: &str, driver: &str) -> Result<(), ApiError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(ApiError::validation("Enter a volume name."));
    }
    object_ref(name)?;
    let driver = if driver.trim().is_empty() {
        "local"
    } else {
        driver.trim()
    };
    object_ref(driver)?;
    let docker = docker()?;
    timed(docker.create_volume(VolumeCreateRequest {
        name: Some(name.to_string()),
        driver: Some(driver.to_string()),
        ..Default::default()
    }))
    .await?;
    Ok(())
}

pub async fn remove_volume(name: &str) -> Result<(), ApiError> {
    let docker = docker()?;
    timed(docker.remove_volume(name, None::<RemoveVolumeOptions>)).await
}

pub async fn list_networks(q: &str) -> Result<Vec<NetworkOut>, ApiError> {
    let docker = docker()?;
    let listed = timed(docker.list_networks(None::<ListNetworksOptions>)).await?;
    let q = q.trim().to_ascii_lowercase();
    let mut items = Vec::new();
    for network in listed {
        let name = network.name.clone().unwrap_or_default();
        if !q.is_empty() && !name.to_ascii_lowercase().contains(&q) {
            continue;
        }
        // The list payload has no attachment map. One inspect fills the count.
        let count = if name.is_empty() {
            0
        } else {
            match tokio::time::timeout(Duration::from_secs(2), docker.inspect_network(&name, None))
                .await
            {
                Ok(Ok(detail)) => detail.containers.unwrap_or_default().len(),
                _ => 0,
            }
        };
        items.push(network_out(network, count));
    }
    items.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(items)
}

pub async fn create_network(name: &str, driver: &str) -> Result<(), ApiError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(ApiError::validation("Enter a network name."));
    }
    object_ref(name)?;
    let driver = if driver.trim().is_empty() {
        "bridge"
    } else {
        driver.trim()
    };
    object_ref(driver)?;
    let docker = docker()?;
    timed(docker.create_network(NetworkCreateRequest {
        name: name.to_string(),
        driver: Some(driver.to_string()),
        ..Default::default()
    }))
    .await?;
    Ok(())
}

pub async fn remove_network(name: &str) -> Result<(), ApiError> {
    if !network_removable(name) {
        return Err(ApiError::validation(format!("{name} cannot be removed.")));
    }
    let docker = docker()?;
    timed(docker.remove_network(name)).await
}

fn container_name(summary: &ContainerSummary) -> String {
    summary
        .names
        .as_ref()
        .and_then(|names| names.first())
        .map(|name| name.trim_start_matches('/').to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| short_id(summary.id.as_deref().unwrap_or("")))
}

fn container_state(summary: &ContainerSummary) -> String {
    summary
        .state
        .map(|state| state.to_string())
        .filter(|state| !state.is_empty())
        .unwrap_or_else(|| "created".into())
}

/// A Compose-labelled container, before grouping. Kept separate from the bollard
/// model so the grouping rules are testable without a Docker daemon.
#[derive(Clone, Debug)]
struct ComposeRow {
    id: String,
    name: String,
    state: String,
    project: String,
    service: Option<String>,
    one_off: bool,
    depends_on: Vec<String>,
}

fn compose_row(summary: &ContainerSummary) -> Option<ComposeRow> {
    let labels = summary.labels.as_ref()?;
    let project = labels.get(COMPOSE_PROJECT)?.trim();
    if project.is_empty() {
        return None;
    }
    let one_off = labels
        .get(COMPOSE_ONEOFF)
        .map(|value| value.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let service = labels
        .get(COMPOSE_SERVICE)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    // `depends_on` is comma-separated `service:condition:required`; older projects omit it.
    let depends_on = labels
        .get(COMPOSE_DEPENDS_ON)
        .map(|value| {
            value
                .split(',')
                .filter_map(|part| {
                    let name = part.split(':').next().unwrap_or("").trim();
                    (!name.is_empty()).then(|| name.to_string())
                })
                .collect()
        })
        .unwrap_or_default();
    Some(ComposeRow {
        id: summary.id.clone().unwrap_or_default(),
        name: container_name(summary),
        state: container_state(summary),
        project: project.to_string(),
        service,
        one_off,
        depends_on,
    })
}

/// Group Compose-labelled containers by project. One-off containers (`compose run`)
/// never inflate a count, appear as a link, or get acted on.
fn group_stacks(rows: Vec<ComposeRow>) -> Vec<StackOut> {
    let mut by_project: BTreeMap<String, Vec<ComposeRow>> = BTreeMap::new();
    for row in rows {
        if row.one_off {
            continue;
        }
        by_project.entry(row.project.clone()).or_default().push(row);
    }
    by_project
        .into_iter()
        .map(|(project, rows)| {
            let total = rows.len();
            let running = rows.iter().filter(|row| row.state == "running").count();
            let state = if running == total {
                "Running"
            } else if running == 0 {
                "Stopped"
            } else {
                "Partial"
            };
            StackOut {
                project,
                running,
                total,
                state,
                containers: ordered_for_start(rows),
            }
        })
        .collect()
}

/// Start order: dependencies first where `depends_on` names them, otherwise the
/// display order. Older projects omit `depends_on`, and cycles are left in display
/// order too, so this is best effort rather than a deterministic guarantee.
fn ordered_for_start(rows: Vec<ComposeRow>) -> Vec<StackContainerOut> {
    let mut base = rows;
    base.sort_by(|a, b| match (&a.service, &b.service) {
        (Some(left), Some(right)) => left.cmp(right).then_with(|| a.name.cmp(&b.name)),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.name.cmp(&b.name),
    });

    let mut services: Vec<String> = Vec::new();
    for row in &base {
        if let Some(service) = &row.service {
            if !services.contains(service) {
                services.push(service.clone());
            }
        }
    }

    let mut deps: HashMap<String, HashSet<String>> = HashMap::new();
    for row in &base {
        let Some(service) = &row.service else {
            continue;
        };
        for dep in &row.depends_on {
            if dep != service && services.contains(dep) {
                deps.entry(service.clone()).or_default().insert(dep.clone());
            }
        }
    }

    let mut remaining = services.clone();
    let mut done: HashSet<String> = HashSet::new();
    let mut ordered = Vec::new();
    while !remaining.is_empty() {
        let ready = remaining.iter().position(|service| {
            deps.get(service)
                .map(|needs| needs.iter().all(|dep| done.contains(dep)))
                .unwrap_or(true)
        });
        let Some(index) = ready else { break };
        let service = remaining.remove(index);
        done.insert(service.clone());
        ordered.push(service);
    }
    // A dependency cycle keeps the remaining services in display order.
    ordered.extend(remaining);

    let mut out = Vec::new();
    for service in ordered {
        for row in base
            .iter()
            .filter(|row| row.service.as_deref() == Some(service.as_str()))
        {
            out.push(stack_container_out(row));
        }
    }
    for row in base.iter().filter(|row| row.service.is_none()) {
        out.push(stack_container_out(row));
    }
    out
}

fn stack_container_out(row: &ComposeRow) -> StackContainerOut {
    StackContainerOut {
        id: row.id.clone(),
        name: row.name.clone(),
        service: row.service.clone(),
        state: row.state.clone(),
    }
}

fn container_out(summary: &ContainerSummary) -> ContainerOut {
    let name = container_name(summary);
    let state = container_state(summary);
    ContainerOut {
        id: summary.id.clone().unwrap_or_default(),
        name,
        image: summary.image.clone().unwrap_or_default(),
        state,
        status_text: summary.status.clone().unwrap_or_default(),
        ports: summary
            .ports
            .as_ref()
            .map(|ports| {
                ports
                    .iter()
                    .map(|port| PortOut {
                        host: port.public_port,
                        host_ip: port.ip.clone(),
                        container: port.private_port,
                        protocol: port
                            .typ
                            .map(|kind| kind.to_string())
                            .filter(|kind| !kind.is_empty())
                            .unwrap_or_else(|| "tcp".into()),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        created: summary.created.unwrap_or(0),
        ai_access: None,
    }
}

async fn list_summary(docker: &Docker, id: &str) -> Result<ContainerOut, ApiError> {
    let mut filters = HashMap::new();
    filters.insert("id".to_string(), vec![id.to_string()]);
    let listed = timed(docker.list_containers(Some(ListContainersOptions {
        all: true,
        filters: Some(filters),
        ..Default::default()
    })))
    .await?;
    listed
        .iter()
        .map(container_out)
        .find(|item| item.id == id || item.id.starts_with(id) || id.starts_with(&item.id))
        .ok_or_else(|| ApiError::not_found(format!("{id} was not found.")))
}

fn detail_out(
    inspected: ContainerInspectResponse,
    summary: Option<&ContainerOut>,
) -> ContainerDetail {
    let name = inspected
        .name
        .clone()
        .unwrap_or_default()
        .trim_start_matches('/')
        .to_string();
    let name = if name.is_empty() {
        summary
            .map(|item| item.name.clone())
            .unwrap_or_else(|| short_id(inspected.id.as_deref().unwrap_or("")))
    } else {
        name
    };
    let state = inspected
        .state
        .as_ref()
        .and_then(|state| state.status)
        .map(|status| status.to_string())
        .filter(|status| !status.is_empty())
        .or_else(|| summary.map(|item| item.state.clone()))
        .unwrap_or_else(|| "created".into());
    let config = inspected.config.as_ref();
    let image = config
        .and_then(|config| config.image.clone())
        .filter(|image| !image.is_empty())
        .or_else(|| summary.map(|item| item.image.clone()))
        .unwrap_or_default();
    let command = command_line(&inspected);
    let restart_policy = inspected
        .host_config
        .as_ref()
        .and_then(|host| host.restart_policy.as_ref())
        .and_then(|policy| policy.name)
        .map(|name| name.to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "no".into());
    let ports = inspected
        .network_settings
        .as_ref()
        .and_then(|settings| settings.ports.as_ref())
        .map(ports_from_map)
        .or_else(|| summary.map(|item| item.ports.clone()))
        .unwrap_or_default();
    let mounts = inspected
        .mounts
        .unwrap_or_default()
        .into_iter()
        .map(|mount| {
            let mode = if mount.rw == Some(false) {
                "ro".to_string()
            } else {
                mount.mode.unwrap_or_default()
            };
            MountOut {
                source: mount.source.unwrap_or_default(),
                destination: mount.destination.unwrap_or_default(),
                mode,
            }
        })
        .collect();
    let mut networks: Vec<NetworkAttachment> = inspected
        .network_settings
        .as_ref()
        .and_then(|settings| settings.networks.as_ref())
        .map(|networks| {
            networks
                .iter()
                .map(|(name, settings)| NetworkAttachment {
                    name: name.clone(),
                    ip: settings.ip_address.clone().unwrap_or_default(),
                })
                .collect()
        })
        .unwrap_or_default();
    networks.sort_by(|a, b| a.name.cmp(&b.name));
    let started = inspected
        .state
        .as_ref()
        .and_then(|state| state.started_at.clone())
        .filter(|value| !value.is_empty() && !value.starts_with("0001-"));
    ContainerDetail {
        id: inspected.id.clone().unwrap_or_default(),
        name,
        image,
        image_id: inspected.image.clone().unwrap_or_default(),
        state,
        status_text: summary
            .map(|item| item.status_text.clone())
            .unwrap_or_default(),
        created: inspected.created.unwrap_or_default(),
        started,
        command,
        entrypoint: config
            .and_then(|config| config.entrypoint.as_ref())
            .map(|entrypoint| entrypoint.join(" "))
            .unwrap_or_default(),
        restart_policy,
        restart_maximum_retry_count: inspected
            .host_config
            .as_ref()
            .and_then(|host| host.restart_policy.as_ref())
            .and_then(|policy| policy.maximum_retry_count),
        ports,
        mounts,
        networks,
        env: config
            .and_then(|config| config.env.as_ref())
            .into_iter()
            .flatten()
            .map(|entry| {
                let (key, value) = entry.split_once('=').unwrap_or((entry, ""));
                EnvOut {
                    key: key.to_string(),
                    value: value.to_string(),
                }
            })
            .collect(),
        labels: {
            let mut labels: Vec<LabelOut> = config
                .and_then(|config| config.labels.as_ref())
                .into_iter()
                .flatten()
                .map(|(key, value)| LabelOut {
                    key: key.clone(),
                    value: value.clone(),
                })
                .collect();
            labels.sort_by(|a, b| a.key.cmp(&b.key));
            labels
        },
    }
}

fn command_line(inspected: &ContainerInspectResponse) -> String {
    let mut parts = Vec::new();
    if let Some(path) = inspected.path.as_ref().filter(|path| !path.is_empty()) {
        parts.push(path.clone());
    }
    if let Some(args) = &inspected.args {
        parts.extend(args.clone());
    }
    if parts.is_empty() {
        if let Some(cmd) = inspected
            .config
            .as_ref()
            .and_then(|config| config.cmd.clone())
        {
            return cmd.join(" ");
        }
    }
    parts.join(" ")
}

fn ports_from_map(map: &HashMap<String, Option<Vec<PortBinding>>>) -> Vec<PortOut> {
    let mut ports = Vec::new();
    for (key, bindings) in map {
        let (container, protocol) = key.split_once('/').unwrap_or((key.as_str(), "tcp"));
        let Ok(container) = container.parse::<u16>() else {
            continue;
        };
        match bindings {
            Some(bindings) if !bindings.is_empty() => {
                for binding in bindings {
                    ports.push(PortOut {
                        host: binding
                            .host_port
                            .as_ref()
                            .and_then(|port| port.parse().ok()),
                        host_ip: binding.host_ip.clone(),
                        container,
                        protocol: protocol.to_string(),
                    });
                }
            }
            _ => ports.push(PortOut {
                host: None,
                host_ip: None,
                container,
                protocol: protocol.to_string(),
            }),
        }
    }
    ports.sort_by_key(|port| port.container);
    ports
}

fn image_out(image: ImageSummary) -> ImageOut {
    ImageOut {
        id: image.id,
        tags: image
            .repo_tags
            .into_iter()
            .filter(|tag| !tag.is_empty())
            .collect(),
        size_bytes: image.size,
        created: image.created,
    }
}

fn image_matches(image: &ImageSummary, reference: &str) -> bool {
    image.id == reference || image.repo_tags.iter().any(|tag| tag == reference)
}

fn display_tag(image: &ImageSummary) -> String {
    image
        .repo_tags
        .iter()
        .find(|tag| !tag.is_empty() && *tag != "<none>:<none>")
        .cloned()
        .unwrap_or_else(|| "<none>:<none>".into())
}

fn network_out(network: Network, container_count: usize) -> NetworkOut {
    let name = network.name.unwrap_or_default();
    let subnet = network
        .ipam
        .as_ref()
        .and_then(|ipam| ipam.config.as_ref())
        .and_then(|config| config.iter().find_map(|item| item.subnet.clone()))
        .unwrap_or_default();
    NetworkOut {
        removable: network_removable(&name),
        container_count,
        driver: network.driver.unwrap_or_default(),
        scope: network.scope.unwrap_or_default(),
        subnet,
        name,
    }
}

fn network_removable(name: &str) -> bool {
    !matches!(name, "bridge" | "host" | "none" | "nat")
}

fn short_id(id: &str) -> String {
    id.trim_start_matches("sha256:").chars().take(12).collect()
}

fn split_timestamp(line: &str) -> (String, String) {
    if let Some((stamp, rest)) = line.split_once(' ') {
        if stamp.len() >= 20 && stamp.contains('T') {
            let time = stamp.get(11..19).unwrap_or("").to_string();
            return (time, rest.to_string());
        }
    }
    (String::new(), line.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use bollard::models::{EndpointIpamConfig, MountPoint, NetworkSettings};

    #[test]
    fn invalid_environment_keys_do_not_echo_values() {
        let error = environment_lines(&[EnvOut {
            key: "INVALID=KEY".into(),
            value: "sensitive-test-value".into(),
        }])
        .unwrap_err();
        assert!(!error.message.contains("sensitive-test-value"));
    }

    #[test]
    fn image_references_allow_registry_paths() {
        assert_eq!(
            checked_image_ref("searxng/searxng:latest").unwrap(),
            "searxng/searxng:latest"
        );
        assert!(checked_image_ref("ghcr.io/chakyiu/pisces@sha256:abc").is_ok());
        assert!(checked_image_ref("two words").is_err());
        assert!(checked_image_ref("").is_err());
    }

    #[test]
    fn mounts_rebuild_binds_when_the_daemon_leaves_them_out() {
        let mut inspected = sample_inspected();
        inspected.host_config = Some(HostConfig {
            binds: None,
            ..Default::default()
        });
        inspected.mounts = Some(vec![
            MountPoint {
                typ: Some("volume".into()),
                name: Some("t106-vol".into()),
                destination: Some("/data".into()),
                ..Default::default()
            },
            MountPoint {
                typ: Some("volume".into()),
                name: Some("f".repeat(64)),
                destination: Some("/anon".into()),
                ..Default::default()
            },
            MountPoint {
                typ: Some("bind".into()),
                source: Some("/srv/app".into()),
                destination: Some("/app".into()),
                rw: Some(false),
                ..Default::default()
            },
        ]);
        let body = build_container_body(&inspected, &ContainerEdits::default()).unwrap();
        let binds = body.host_config.unwrap().binds.unwrap();
        assert!(binds.contains(&"t106-vol:/data".to_string()));
        assert!(binds.contains(&"/srv/app:/app:ro".to_string()));
        assert!(binds.contains(&format!("{}:/anon", "f".repeat(64))));
    }

    fn row(
        project: &str,
        service: Option<&str>,
        name: &str,
        state: &str,
        one_off: bool,
        depends_on: &[&str],
    ) -> ComposeRow {
        ComposeRow {
            id: format!("id-{name}"),
            name: name.to_string(),
            state: state.to_string(),
            project: project.to_string(),
            service: service.map(str::to_string),
            one_off,
            depends_on: depends_on.iter().map(|dep| dep.to_string()).collect(),
        }
    }

    #[test]
    fn groups_by_project_and_counts_running() {
        let stacks = group_stacks(vec![
            row("web", Some("api"), "web-api-1", "running", false, &[]),
            row("web", Some("db"), "web-db-1", "exited", false, &[]),
            row(
                "cache",
                Some("redis"),
                "cache-redis-1",
                "running",
                false,
                &[],
            ),
            row(
                "idle",
                Some("worker"),
                "idle-worker-1",
                "exited",
                false,
                &[],
            ),
        ]);

        assert_eq!(
            stacks
                .iter()
                .map(|stack| (
                    stack.project.as_str(),
                    stack.running,
                    stack.total,
                    stack.state
                ))
                .collect::<Vec<_>>(),
            vec![
                ("cache", 1, 1, "Running"),
                ("idle", 0, 1, "Stopped"),
                ("web", 1, 2, "Partial"),
            ]
        );
    }

    #[test]
    fn one_off_containers_are_not_counted_or_listed() {
        let stacks = group_stacks(vec![
            row("web", Some("api"), "web-api-1", "running", false, &[]),
            row("web", Some("api"), "web-api-run-1", "exited", true, &[]),
        ]);

        assert_eq!(stacks.len(), 1);
        assert_eq!(stacks[0].total, 1);
        assert_eq!(stacks[0].running, 1);
        assert_eq!(stacks[0].containers.len(), 1);
        assert_eq!(stacks[0].containers[0].name, "web-api-1");
    }

    #[test]
    fn containers_without_a_project_are_not_a_stack() {
        let summary = ContainerSummary {
            id: Some("abc".into()),
            labels: Some(HashMap::from([(
                COMPOSE_SERVICE.to_string(),
                "api".to_string(),
            )])),
            ..Default::default()
        };
        assert!(compose_row(&summary).is_none());
    }

    #[test]
    fn display_order_is_service_then_name_with_missing_services_last() {
        let stacks = group_stacks(vec![
            row("web", None, "web-solo-1", "running", false, &[]),
            row("web", Some("z"), "web-z-1", "running", false, &[]),
            row("web", Some("a"), "web-a-2", "running", false, &[]),
            row("web", Some("a"), "web-a-1", "running", false, &[]),
        ]);
        let names: Vec<&str> = stacks[0]
            .containers
            .iter()
            .map(|container| container.name.as_str())
            .collect();
        assert_eq!(names, vec!["web-a-1", "web-a-2", "web-z-1", "web-solo-1"]);
    }

    #[test]
    fn start_order_follows_depends_on() {
        let stacks = group_stacks(vec![
            row("web", Some("api"), "web-api-1", "exited", false, &["db"]),
            row("web", Some("db"), "web-db-1", "exited", false, &[]),
            row(
                "web",
                Some("worker"),
                "web-worker-1",
                "exited",
                false,
                &["db", "api"],
            ),
        ]);
        let names: Vec<&str> = stacks[0]
            .containers
            .iter()
            .map(|container| container.name.as_str())
            .collect();
        assert_eq!(names, vec!["web-db-1", "web-api-1", "web-worker-1"]);
    }

    #[test]
    fn dependency_cycles_keep_display_order() {
        let stacks = group_stacks(vec![
            row("web", Some("a"), "web-a-1", "exited", false, &["b"]),
            row("web", Some("b"), "web-b-1", "exited", false, &["a"]),
        ]);
        let names: Vec<&str> = stacks[0]
            .containers
            .iter()
            .map(|container| container.name.as_str())
            .collect();
        assert_eq!(names, vec!["web-a-1", "web-b-1"]);
    }

    #[test]
    fn depends_on_label_is_parsed_per_service() {
        let summary = ContainerSummary {
            id: Some("abc".into()),
            state: Some(bollard::models::ContainerSummaryStateEnum::RUNNING),
            labels: Some(HashMap::from([
                (COMPOSE_PROJECT.to_string(), "web".to_string()),
                (COMPOSE_SERVICE.to_string(), "api".to_string()),
                (
                    COMPOSE_DEPENDS_ON.to_string(),
                    "db:service_started:false,cache:service_healthy:required".to_string(),
                ),
            ])),
            ..Default::default()
        };
        let parsed = compose_row(&summary).expect("compose row");
        assert_eq!(
            parsed.depends_on,
            vec!["db".to_string(), "cache".to_string()]
        );
        assert!(!parsed.one_off);
        assert_eq!(parsed.state, "running");
    }

    #[test]
    fn console_shells_are_allowlisted() {
        assert_eq!(console_command(None).ok(), Some("/bin/sh"));
        assert_eq!(console_command(Some("bash")).ok(), Some("/bin/bash"));
        assert_eq!(console_command(Some("ash")).ok(), Some("/bin/ash"));
        assert!(console_command(Some("/bin/sh -c id")).is_err());
    }

    #[test]
    fn console_users_are_allowlisted() {
        assert_eq!(console_user(None).ok(), Some(None));
        assert_eq!(console_user(Some("root")).ok(), Some(Some("0")));
        assert!(console_user(Some("0;id")).is_err());
    }

    fn joined(lines: Vec<LogLine>) -> Vec<(String, String)> {
        lines
            .into_iter()
            .map(|line| (line.stream, line.text))
            .collect()
    }

    #[test]
    fn partial_line_is_held_until_its_newline_arrives() {
        let mut lines = LogLines::default();
        assert!(lines.push("stdout", b"hel").is_empty());
        assert!(lines.push("stdout", b"lo wor").is_empty());
        assert_eq!(
            joined(lines.push("stdout", b"ld\nnext")),
            vec![("stdout".to_string(), "hello world".to_string())]
        );
        assert!(lines.push("stdout", b"").is_empty());
        assert_eq!(
            joined(lines.flush()),
            vec![("stdout".to_string(), "next".to_string())]
        );
    }

    #[test]
    fn one_chunk_can_carry_several_lines_and_crlf() {
        let mut lines = LogLines::default();
        assert_eq!(
            joined(lines.push("stderr", b"one\r\ntwo\n\nthree\n")),
            vec![
                ("stderr".to_string(), "one".to_string()),
                ("stderr".to_string(), "two".to_string()),
                ("stderr".to_string(), "three".to_string())
            ]
        );
    }

    #[test]
    fn split_multibyte_character_survives_the_chunk_boundary() {
        let mut lines = LogLines::default();
        let bytes = "héllo wörld\n".as_bytes();
        let split = bytes.iter().position(|byte| *byte == 0xc3).unwrap() + 1;
        assert!(lines.push("stdout", &bytes[..split]).is_empty());
        assert_eq!(
            joined(lines.push("stdout", &bytes[split..])),
            vec![("stdout".to_string(), "héllo wörld".to_string())]
        );
    }

    #[test]
    fn stdout_and_stderr_buffers_do_not_merge() {
        let mut lines = LogLines::default();
        assert!(lines.push("stdout", b"out").is_empty());
        assert_eq!(
            joined(lines.push("stderr", b"err\n")),
            vec![("stderr".to_string(), "err".to_string())]
        );
        assert_eq!(
            joined(lines.flush()),
            vec![("stdout".to_string(), "out".to_string())]
        );
    }

    #[test]
    fn timestamps_are_split_off_and_kept() {
        let mut lines = LogLines::default();
        let pushed = lines.push("stdout", b"2026-01-02T03:04:05.678901Z hello\n");
        assert_eq!(pushed[0].timestamp, "03:04:05");
        assert_eq!(
            joined(pushed),
            vec![("stdout".to_string(), "hello".to_string())]
        );
    }

    #[test]
    fn error_travels_as_a_final_ndjson_record() {
        let record = encode_event(Err(ApiError::daemon("engine went away")));
        let parsed: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert_eq!(parsed["error"], serde_json::json!(true));
        assert_eq!(parsed["message"], serde_json::json!("engine went away"));
        let line = encode_event(Ok(LogLine {
            timestamp: "t".to_string(),
            stream: "stdout".to_string(),
            text: "x".to_string(),
        }));
        assert!(!line.contains("\"error\""));
    }
    #[test]
    fn container_names_follow_the_docker_rule() {
        assert_eq!(
            checked_container_name(" libra-libra-2 ").unwrap(),
            "libra-libra-2"
        );
        assert_eq!(checked_container_name("a.b_c-d9").unwrap(), "a.b_c-d9");
        assert!(checked_container_name("").is_err());
        assert!(checked_container_name("_nope").is_err());
        assert!(checked_container_name("no/slash").is_err());
        assert!(checked_container_name("über").is_err());
    }

    #[test]
    fn port_lines_accept_the_usual_shapes() {
        assert_eq!(parse_port_line("8080:80/tcp").unwrap().host, 8080);
        let single = parse_port_line("443").unwrap();
        assert_eq!(
            (single.host, single.container, single.protocol.as_str()),
            (443, 443, "tcp")
        );
        assert_eq!(parse_port_line(" 53:53/udp ").unwrap().protocol, "udp");
        assert!(parse_port_line("0:80").is_err());
        assert!(parse_port_line("80:0").is_err());
        assert!(parse_port_line("8080:80/icmp").is_err());
        assert!(parse_port_line("abc:80").is_err());
        assert!(parse_port_line("99999:80").is_err());
    }

    fn sample_inspected() -> ContainerInspectResponse {
        let mut networks = HashMap::new();
        networks.insert(
            "bridge".to_string(),
            EndpointSettings {
                ipam_config: Some(EndpointIpamConfig {
                    ipv4_address: Some("172.17.0.2".into()),
                    ..Default::default()
                }),
                ..Default::default()
            },
        );
        networks.insert(
            "libra_default".to_string(),
            EndpointSettings {
                aliases: Some(vec!["libra".into()]),
                ..Default::default()
            },
        );
        ContainerInspectResponse {
            id: Some("abcdef0123".into()),
            name: Some("/libra-libra-1".into()),
            config: Some(bollard::models::ContainerConfig {
                image: Some("redis:7".into()),
                env: Some(vec!["A=1".into()]),
                cmd: Some(vec!["redis-server".into()]),
                ..Default::default()
            }),
            host_config: Some(HostConfig {
                restart_policy: Some(RestartPolicy {
                    name: Some(RestartPolicyNameEnum::UNLESS_STOPPED),
                    ..Default::default()
                }),
                network_mode: Some("libra_default".into()),
                memory: Some(268_435_456),
                ..Default::default()
            }),
            network_settings: Some(NetworkSettings {
                networks: Some(networks),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    #[test]
    fn duplicate_body_carries_the_config_and_applies_edits() {
        let inspected = sample_inspected();
        let edits = ContainerEdits {
            env: Some(vec![
                EnvOut {
                    key: "A".into(),
                    value: "2".into(),
                },
                EnvOut {
                    key: "B".into(),
                    value: "3=extra".into(),
                },
            ]),
            ports: Some(vec![
                "8080:80".into(),
                "53:53/udp".into(),
                "expose:8081/tcp".into(),
                "auto:82/tcp".into(),
            ]),
            ..Default::default()
        };
        let body = build_container_body(&inspected, &edits).unwrap();
        assert_eq!(body.image.as_deref(), Some("redis:7"));
        assert_eq!(
            body.env
                .as_deref()
                .map(|env| env.iter().map(String::as_str).collect::<Vec<_>>()),
            Some(vec!["A=2", "B=3=extra"])
        );
        let host = body.host_config.as_ref().unwrap();
        assert_eq!(host.memory, Some(268_435_456));
        assert_eq!(host.network_mode.as_deref(), Some("libra_default"));
        assert_eq!(
            host.restart_policy.as_ref().unwrap().name,
            Some(RestartPolicyNameEnum::UNLESS_STOPPED)
        );
        let bindings = host.port_bindings.as_ref().unwrap();
        assert_eq!(
            bindings
                .get("80/tcp")
                .and_then(|list| list.as_ref())
                .and_then(|list| list.first())
                .and_then(|binding| binding.host_port.as_ref())
                .map(String::as_str),
            Some("8080")
        );
        assert!(bindings.contains_key("53/udp"));
        assert_eq!(
            bindings
                .get("82/tcp")
                .and_then(Option::as_ref)
                .and_then(|items| items.first())
                .and_then(|binding| binding.host_port.as_deref()),
            None
        );
        assert!(!bindings.contains_key("8081/tcp"));
        assert_eq!(
            body.exposed_ports
                .as_deref()
                .map(|ports| ports.iter().map(String::as_str).collect::<Vec<_>>()),
            Some(vec!["80/tcp", "53/udp", "8081/tcp", "82/tcp"])
        );
        let net = body
            .networking_config
            .as_ref()
            .unwrap()
            .endpoints_config
            .as_ref()
            .unwrap();
        assert!(!net.contains_key("bridge"));
        let endpoint = net.get("libra_default").unwrap();
        assert_eq!(endpoint.aliases.as_deref().unwrap(), ["libra"]);
        assert!(endpoint.ipam_config.is_none());
    }

    #[test]
    fn restart_and_image_edits_are_validated() {
        let inspected = sample_inspected();
        let edits = ContainerEdits {
            image: Some("alpine:3.20".into()),
            restart: Some("always".into()),
            ..Default::default()
        };
        let body = build_container_body(&inspected, &edits).unwrap();
        assert_eq!(body.image.as_deref(), Some("alpine:3.20"));
        assert_eq!(
            body.host_config
                .as_ref()
                .unwrap()
                .restart_policy
                .as_ref()
                .unwrap()
                .name,
            Some(RestartPolicyNameEnum::ALWAYS)
        );
        let bad_policy = ContainerEdits {
            restart: Some("sometimes".into()),
            ..Default::default()
        };
        assert!(build_container_body(&inspected, &bad_policy).is_err());
        let bad_image = ContainerEdits {
            image: Some("bad image!".into()),
            ..Default::default()
        };
        assert!(build_container_body(&inspected, &bad_image).is_err());
        // No edits at all: the image comes from the original config.
        let untouched = build_container_body(&inspected, &ContainerEdits::default()).unwrap();
        assert_eq!(untouched.image.as_deref(), Some("redis:7"));
    }
}
