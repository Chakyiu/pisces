//! Docker daemon access via `bollard`.
//!
//! On Windows the daemon is the named pipe `//./pipe/docker_engine`.
//! Every Docker endpoint uses that local engine. Socket paths are not accepted.

use std::collections::HashMap;
use std::time::Duration;

use bollard::auth::DockerCredentials;
use bollard::container::LogOutput;
use bollard::exec::{CreateExecOptions, ResizeExecOptions, StartExecOptions, StartExecResults};
use bollard::models::{
    ContainerCreateBody, ContainerInspectResponse, ContainerSummary, HostConfig, ImageSummary,
    Network, NetworkCreateRequest, PortBinding, VolumeCreateRequest,
};
use bollard::query_parameters::{
    CreateContainerOptionsBuilder, InspectContainerOptions, ListContainersOptions,
    ListImagesOptions, ListNetworksOptions, ListVolumesOptions, LogsOptionsBuilder,
    RemoveContainerOptionsBuilder, RemoveImageOptions, RemoveVolumeOptions,
};
use bollard::Docker;
use futures_util::StreamExt;
use serde::Serialize;

use crate::error::ApiError;

pub const ENGINE_DOWN: &str =
    "The engine did not answer within 10 seconds. Nothing on this page was changed.";

const TIMEOUT: Duration = Duration::from_secs(10);

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
                400 => ApiError::validation(message),
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
}

#[derive(Serialize)]
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
    pub restart_policy: String,
    pub ports: Vec<PortOut>,
    pub mounts: Vec<MountOut>,
    pub networks: Vec<NetworkAttachment>,
    pub env_count: usize,
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
        recent.sort_by(|a, b| b.created.cmp(&a.created));
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
    items.sort_by(|a, b| b.created.cmp(&a.created));
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
    let options = RemoveContainerOptionsBuilder::new().force(true).build();
    timed(docker.remove_container(id, Some(options))).await
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

pub async fn list_images() -> Result<Vec<ImageOut>, ApiError> {
    let docker = docker()?;
    let images = timed(docker.list_images(None::<ListImagesOptions>)).await?;
    let mut items: Vec<ImageOut> = images.into_iter().map(image_out).collect();
    items.sort_by(|a, b| b.created.cmp(&a.created));
    Ok(items)
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

fn container_out(summary: &ContainerSummary) -> ContainerOut {
    let name = summary
        .names
        .as_ref()
        .and_then(|names| names.first())
        .map(|name| name.trim_start_matches('/').to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| short_id(summary.id.as_deref().unwrap_or("")));
    let state = summary
        .state
        .map(|state| state.to_string())
        .filter(|state| !state.is_empty())
        .unwrap_or_else(|| "created".into());
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
        restart_policy,
        ports,
        mounts,
        networks,
        env_count: config
            .and_then(|config| config.env.as_ref())
            .map(|env| env.len())
            .unwrap_or(0),
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
                        container,
                        protocol: protocol.to_string(),
                    });
                }
            }
            _ => ports.push(PortOut {
                host: None,
                container,
                protocol: protocol.to_string(),
            }),
        }
    }
    ports.sort_by(|a, b| a.container.cmp(&b.container));
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
mod console_tests {
    use super::*;

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
}
