//! HTTP routes. Docker control requires the session cookie. Health and login do not.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

use axum::body::Body;
use axum::extract::rejection::JsonRejection;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode, Uri};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::io::AsyncWriteExt;

use crate::auth::{self, AuthConfig};
use crate::docker;
use crate::error::ApiError;
use crate::k8s;
use crate::page::{self, ListPage};
use crate::stacks;
use crate::store::{self, Endpoint, Store};

#[derive(Clone)]
pub struct AppState {
    pub auth: AuthConfig,
    pub store: Arc<Mutex<Store>>,
    pub stack_apply: Arc<StackApplyLocks>,
}

type StackApplyLock = tokio::sync::Mutex<()>;
type StackApplyLockMap = HashMap<(String, String), Weak<StackApplyLock>>;

#[derive(Default)]
pub struct StackApplyLocks {
    locks: tokio::sync::Mutex<StackApplyLockMap>,
}

impl StackApplyLocks {
    async fn lock(&self, endpoint_id: &str, project: &str) -> tokio::sync::OwnedMutexGuard<()> {
        let key = (endpoint_id.to_string(), project.to_string());
        let lock = {
            let mut locks = self.locks.lock().await;
            locks.retain(|_, lock| lock.strong_count() > 0);
            if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
                lock
            } else {
                let lock = Arc::new(tokio::sync::Mutex::new(()));
                locks.insert(key, Arc::downgrade(&lock));
                lock
            }
        };
        lock.lock_owned().await
    }
}

#[derive(Deserialize)]
struct LoginBody {
    username: String,
    password: String,
}

#[derive(Serialize)]
struct SessionOut {
    username: String,
}

#[derive(Deserialize)]
struct CreateEndpointBody {
    kind: String,
    name: String,
    context: Option<String>,
}

#[derive(Serialize)]
struct EndpointOut {
    id: String,
    name: String,
    kind: String,
    status: String,
}

#[derive(Serialize)]
struct Items<T> {
    items: Vec<T>,
}

#[derive(Serialize)]
struct NameOut {
    name: String,
}

#[derive(Deserialize)]
struct ListQuery {
    q: Option<String>,
    state: Option<String>,
    limit: Option<String>,
    cursor: Option<String>,
    tail: Option<String>,
}

#[derive(Deserialize)]
struct ConsoleQuery {
    shell: Option<String>,
    user: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ConsoleMessage {
    Input { data: String },
    Resize { width: u16, height: u16 },
}

#[derive(Deserialize)]
struct RunBody {
    image: String,
    name: Option<String>,
    ports: Option<Vec<RunPortBody>>,
}

#[derive(Deserialize)]
struct RunPortBody {
    host: u16,
    container: u16,
    protocol: Option<String>,
}

#[derive(Deserialize)]
struct VolumeBody {
    name: String,
    driver: Option<String>,
}

#[derive(Deserialize)]
struct ContainerSettingsBody {
    name: String,
    restart_policy: String,
    restart_maximum_retry_count: Option<i64>,
}

#[derive(Deserialize)]
struct DuplicateBody {
    name: String,
    image: Option<String>,
    command: Option<Vec<String>>,
    entrypoint: Option<Vec<String>>,
    env: Option<Vec<docker::EnvOut>>,
    labels: Option<Vec<docker::LabelOut>>,
    ports: Option<Vec<String>>,
    mounts: Option<Vec<docker::MountEdit>>,
    restart_policy: Option<String>,
}

#[derive(Deserialize)]
struct NetworkBody {
    name: String,
    driver: Option<String>,
}

#[derive(Deserialize)]
struct StackBody {
    project: String,
    compose: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StackView {
    project: String,
    origin: &'static str,
    has_file: bool,
    running: usize,
    total: usize,
    state: &'static str,
    containers: Vec<docker::StackContainerOut>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    container_details: Vec<docker::ContainerOut>,
    #[serde(skip_serializing_if = "Option::is_none")]
    compose: Option<String>,
}

fn take_json<T>(body: Result<Json<T>, JsonRejection>) -> Result<T, ApiError> {
    body.map(|Json(value)| value)
        .map_err(|_| ApiError::validation("The request body is not valid."))
}

fn safe_container_edit_error(error: ApiError) -> ApiError {
    if error.message_is_safe
        || error.message == "Recreate recovery incomplete: inspect container state before retrying."
    {
        return error;
    }
    match error.status {
        axum::http::StatusCode::BAD_REQUEST => ApiError::validation(
            "Container configuration is invalid. Environment values are excluded from errors.",
        ),
        axum::http::StatusCode::NOT_FOUND => ApiError::not_found("Container not found."),
        axum::http::StatusCode::CONFLICT => {
            ApiError::conflict("Container edit conflicts with an existing Docker resource.")
        }
        _ => ApiError::daemon(
            "Container edit failed. Check container state before retrying; environment values are excluded from errors.",
        ),
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/session", post(login).get(session).delete(logout))
        .route("/api/kubernetes/contexts", get(contexts))
        .route("/api/endpoints", get(list_endpoints).post(create_endpoint))
        .route(
            "/api/endpoints/{id}",
            axum::routing::delete(delete_endpoint),
        )
        .route("/api/endpoints/{id}/overview", get(overview))
        .route(
            "/api/endpoints/{id}/containers",
            get(list_containers).post(create_container),
        )
        .route(
            "/api/endpoints/{id}/stacks",
            get(list_stacks).post(create_stack),
        )
        .route(
            "/api/endpoints/{id}/stacks/{project}",
            get(get_stack).put(update_stack).delete(delete_stack),
        )
        .route(
            "/api/endpoints/{id}/containers/{container_id}",
            get(container_detail).delete(delete_container),
        )
        .route(
            "/api/endpoints/{id}/containers/{container_id}/logs",
            get(container_logs),
        )
        .route(
            "/api/endpoints/{id}/containers/{container_id}/logs/stream",
            get(container_logs_stream),
        )
        .route(
            "/api/endpoints/{id}/containers/{container_id}/console",
            get(container_console),
        )
        .route(
            "/api/endpoints/{id}/containers/{container_id}/start",
            post(start_container),
        )
        .route(
            "/api/endpoints/{id}/containers/{container_id}/stop",
            post(stop_container),
        )
        .route(
            "/api/endpoints/{id}/containers/{container_id}/restart",
            post(restart_container),
        )
        .route(
            "/api/endpoints/{id}/containers/{container_id}/config",
            get(container_config),
        )
        .route(
            "/api/endpoints/{id}/containers/{container_id}/settings",
            axum::routing::put(update_container_settings),
        )
        .route(
            "/api/endpoints/{id}/containers/{container_id}/duplicate",
            post(duplicate_container),
        )
        .route(
            "/api/endpoints/{id}/containers/{container_id}/recreate",
            post(recreate_container),
        )
        .route("/api/endpoints/{id}/images", get(list_images))
        .route(
            "/api/endpoints/{id}/images/{image_ref}",
            axum::routing::delete(delete_image),
        )
        .route(
            "/api/endpoints/{id}/volumes",
            get(list_volumes).post(create_volume),
        )
        .route(
            "/api/endpoints/{id}/volumes/{name}",
            axum::routing::delete(delete_volume),
        )
        .route(
            "/api/endpoints/{id}/networks",
            get(list_networks).post(create_network),
        )
        .route(
            "/api/endpoints/{id}/networks/{name}",
            axum::routing::delete(delete_network),
        )
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            require_auth,
        ))
        .layer(axum::middleware::from_fn(no_store))
        .with_state(state)
}

async fn no_store(req: Request, next: Next) -> Response {
    let mut response = next.run(req).await;
    if let Ok(value) = HeaderValue::from_str("no-store") {
        response.headers_mut().insert(header::CACHE_CONTROL, value);
    }
    response
}

async fn require_auth(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let path = req.uri().path();
    let public = path == "/api/health"
        || (path == "/api/session" && req.method() == axum::http::Method::POST);
    if public {
        return next.run(req).await;
    }
    let Some(token) = auth::token_from_headers(req.headers()) else {
        return ApiError::unauthorized("Sign in required.").into_response();
    };
    if auth::username_from_token(&state.auth, &token).is_none() {
        return ApiError::unauthorized("Your session ended. Sign in again.").into_response();
    }
    next.run(req).await
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "status": "ok",
        "docker": docker::describe(),
        "kubernetes": k8s::describe().await,
    }))
}

async fn login(
    State(state): State<AppState>,
    body: Result<Json<LoginBody>, JsonRejection>,
) -> Result<Response, ApiError> {
    let body = take_json(body)?;
    if body.username.trim().is_empty() {
        return Err(ApiError::validation("Enter a username."));
    }
    if body.password.is_empty() {
        return Err(ApiError::validation("Enter a password."));
    }
    let password_ok = auth::verify_password(&body.password, &state.auth.password_hash);
    let username_ok = body.username.trim() == state.auth.username;
    if !password_ok || !username_ok {
        return Err(ApiError::unauthorized("Those credentials were rejected."));
    }
    let token = auth::issue_token(&state.auth).map_err(ApiError::validation)?;
    Ok(session_response(
        state.auth.username.clone(),
        auth::set_cookie(&token),
        StatusCode::OK,
    ))
}

async fn session(State(state): State<AppState>) -> Json<SessionOut> {
    Json(SessionOut {
        username: state.auth.username.clone(),
    })
}

async fn logout() -> Response {
    session_response(String::new(), auth::clear_cookie(), StatusCode::NO_CONTENT)
}

fn session_response(username: String, cookie: String, status: StatusCode) -> Response {
    let mut response = if status == StatusCode::NO_CONTENT {
        status.into_response()
    } else {
        (status, Json(SessionOut { username })).into_response()
    };
    if let Ok(value) = HeaderValue::from_str(&cookie) {
        response.headers_mut().insert(header::SET_COOKIE, value);
    }
    response
}

async fn contexts() -> Result<Json<Items<NameOut>>, ApiError> {
    let names = k8s::context_names().map_err(ApiError::cluster)?;
    Ok(Json(Items {
        items: names.into_iter().map(|name| NameOut { name }).collect(),
    }))
}

async fn list_endpoints(State(state): State<AppState>) -> Json<Items<EndpointOut>> {
    let endpoints = lock(&state).list();
    let docker_up = if endpoints.iter().any(|endpoint| endpoint.kind == "docker") {
        docker::engine_up().await
    } else {
        false
    };
    Json(Items {
        items: endpoints
            .into_iter()
            .map(|endpoint| endpoint_out(endpoint, docker_up))
            .collect(),
    })
}

async fn create_endpoint(
    State(state): State<AppState>,
    body: Result<Json<CreateEndpointBody>, JsonRejection>,
) -> Result<Response, ApiError> {
    let body = take_json(body)?;
    let name = body.name.trim();
    if name.is_empty() {
        return Err(ApiError::validation("Enter an endpoint name."));
    }
    docker::object_ref(name)?;
    let kind = body.kind.trim();
    let context = match kind {
        "docker" => None,
        "kubernetes" => {
            let context = body.context.unwrap_or_default();
            let context = context.trim();
            if context.is_empty() {
                return Err(ApiError::validation("Choose a Kubernetes context."));
            }
            let known = k8s::context_names().map_err(ApiError::cluster)?;
            if !known.iter().any(|name| name == context) {
                return Err(ApiError::validation(
                    "That Kubernetes context is not visible to the server.",
                ));
            }
            Some(context.to_string())
        }
        _ => return Err(ApiError::validation("Kind must be docker or kubernetes.")),
    };
    let endpoint = Endpoint {
        id: store::new_id(),
        name: name.to_string(),
        kind: kind.to_string(),
        context,
    };
    {
        let mut guard = lock(&state);
        match guard.insert(endpoint.clone()) {
            Ok(()) => {}
            Err(message) if message.contains("already exists") => {
                return Err(ApiError::conflict(message));
            }
            Err(message) => return Err(ApiError::daemon(message)),
        }
    }
    let docker_up = endpoint.kind == "docker" && docker::engine_up().await;
    Ok((StatusCode::CREATED, Json(endpoint_out(endpoint, docker_up))).into_response())
}

async fn delete_endpoint(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let removed = lock(&state).remove(&id).map_err(ApiError::daemon)?;
    if !removed {
        return Err(ApiError::not_found("Endpoint was not found."));
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn overview(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<docker::Overview>, ApiError> {
    let endpoint = load_endpoint(&state, &id)?;
    if endpoint.kind == "kubernetes" {
        return Err(ApiError::cluster(
            "Kubernetes control is not in this build.",
        ));
    }
    require_docker_kind(&endpoint)?;
    Ok(Json(docker::overview().await?))
}

async fn list_containers(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<ListQuery>,
) -> Result<Json<ListPage<docker::ContainerOut>>, ApiError> {
    require_docker(&state, &id)?;
    let items = docker::list_containers(
        query.q.as_deref().unwrap_or(""),
        query.state.as_deref().unwrap_or(""),
    )
    .await?;
    Ok(Json(page_of(items, &query)?))
}

async fn list_stacks(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<ListQuery>,
) -> Result<Json<ListPage<StackView>>, ApiError> {
    let endpoint = require_docker(&state, &id)?;
    let live = docker::list_stacks(query.q.as_deref().unwrap_or("")).await?;
    let guard = lock(&state);
    let managed = guard.stack_projects(&endpoint.id);
    let mut items: Vec<StackView> = live
        .into_iter()
        .map(|stack| {
            let has_file = guard.stack_file(&endpoint.id, &stack.project).is_some();
            let is_managed = guard.stack_exists(&endpoint.id, &stack.project);
            StackView {
                project: stack.project,
                origin: if is_managed { "managed" } else { "discovered" },
                has_file,
                running: stack.running,
                total: stack.total,
                state: stack.state,
                containers: stack.containers,
                container_details: Vec::new(),
                compose: None,
            }
        })
        .collect();
    for project in managed {
        if !items.iter().any(|stack| stack.project == project) {
            let compose = guard.stack_file(&endpoint.id, &project);
            items.push(StackView {
                project,
                origin: "managed",
                has_file: compose.is_some(),
                running: 0,
                total: 0,
                state: "Stopped",
                containers: Vec::new(),
                container_details: Vec::new(),
                compose: None,
            });
        }
    }
    let q = query.q.as_deref().unwrap_or("").trim().to_ascii_lowercase();
    items.retain(|stack| q.is_empty() || stack.project.to_ascii_lowercase().contains(&q));
    items.sort_by(|a, b| a.project.cmp(&b.project));
    Ok(Json(page_of(items, &query)?))
}

async fn create_stack(
    State(state): State<AppState>,
    Path(id): Path<String>,
    body: Result<Json<StackBody>, JsonRejection>,
) -> Result<Response, ApiError> {
    let endpoint = require_docker(&state, &id)?;
    let body = take_json(body)?;
    stacks::validate_project_name(&body.project)?;
    stacks::validate_compose(&body.compose)?;
    let _apply = state.stack_apply.lock(&endpoint.id, &body.project).await;
    let managed_exists = lock(&state).stack_exists(&endpoint.id, &body.project);
    let live_exists = docker::list_stacks("")
        .await?
        .iter()
        .any(|stack| stack.project == body.project);
    if managed_exists || live_exists {
        return Err(ApiError::conflict(format!(
            "A stack named {} already exists.",
            body.project
        )));
    }
    let dir = lock(&state)
        .create_stack_dir(&endpoint.id, &body.project)
        .map_err(ApiError::daemon)?;
    lock(&state)
        .stage_stack_file(&endpoint.id, &body.project, &body.compose)
        .map_err(ApiError::daemon)?;
    let candidate = dir.join("compose.yaml.new");
    if let Err(error) = stacks::up(&body.project, &dir, &candidate).await {
        lock(&state).keep_failed_create(&endpoint.id, &body.project, &error.message);
        return Err(error);
    }
    lock(&state)
        .commit_stack_file(&endpoint.id, &body.project)
        .map_err(ApiError::deploy)?;
    Ok((
        StatusCode::CREATED,
        Json(serde_json::json!({ "project": body.project })),
    )
        .into_response())
}

async fn get_stack(
    State(state): State<AppState>,
    Path((id, project)): Path<(String, String)>,
) -> Result<Json<StackView>, ApiError> {
    let endpoint = require_docker(&state, &id)?;
    stacks::validate_project_name(&project)?;
    let mut live = docker::list_stacks("").await?;
    let stack = live
        .iter()
        .position(|stack| stack.project == project)
        .map(|index| live.remove(index));
    let (compose, is_managed) = {
        let guard = lock(&state);
        (
            guard.stack_file(&endpoint.id, &project),
            guard.stack_exists(&endpoint.id, &project),
        )
    };
    let exists = is_managed;
    if stack.is_none() && !exists {
        return Err(ApiError::not_found(format!("{project} was not found.")));
    }
    let view = if let Some(stack) = stack {
        let ids: std::collections::HashSet<String> = stack
            .containers
            .iter()
            .map(|container| container.id.clone())
            .collect();
        let container_details = docker::list_containers("", "")
            .await?
            .into_iter()
            .filter(|container| ids.contains(&container.id))
            .collect();
        StackView {
            project: stack.project,
            origin: if is_managed { "managed" } else { "discovered" },
            has_file: compose.is_some(),
            running: stack.running,
            total: stack.total,
            state: stack.state,
            containers: stack.containers,
            container_details,
            compose,
        }
    } else {
        StackView {
            project,
            origin: "managed",
            has_file: compose.is_some(),
            running: 0,
            total: 0,
            state: "Stopped",
            containers: Vec::new(),
            container_details: Vec::new(),
            compose,
        }
    };
    Ok(Json(view))
}

async fn update_stack(
    State(state): State<AppState>,
    Path((id, project)): Path<(String, String)>,
    body: Result<Json<StackBody>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    let endpoint = require_docker(&state, &id)?;
    let body = take_json(body)?;
    stacks::validate_project_name(&project)?;
    stacks::validate_compose(&body.compose)?;
    if body.project != project {
        return Err(ApiError::validation("The stack name cannot be changed."));
    }
    let _apply = state.stack_apply.lock(&endpoint.id, &project).await;
    let dir = {
        let guard = lock(&state);
        if guard.stack_file(&endpoint.id, &project).is_none() {
            return Err(ApiError::not_found(
                "No Compose file is stored for this stack.",
            ));
        }
        guard
            .create_stack_dir(&endpoint.id, &project)
            .map_err(ApiError::daemon)?
    };
    lock(&state)
        .stage_stack_file(&endpoint.id, &project, &body.compose)
        .map_err(ApiError::daemon)?;
    if let Err(error) = stacks::up(&project, &dir, &dir.join("compose.yaml.new")).await {
        let _ = std::fs::remove_file(dir.join("compose.yaml.new"));
        lock(&state).record_stack_error(&endpoint.id, &project, &error.message);
        return Err(error);
    }
    lock(&state)
        .commit_stack_file(&endpoint.id, &project)
        .map_err(ApiError::deploy)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_stack(
    State(state): State<AppState>,
    Path((id, project)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    let endpoint = require_docker(&state, &id)?;
    stacks::validate_project_name(&project)?;
    let _apply = state.stack_apply.lock(&endpoint.id, &project).await;
    let managed = lock(&state).stack_exists(&endpoint.id, &project);
    if managed {
        let file = lock(&state).stack_file(&endpoint.id, &project);
        if file.is_some() {
            let dir = lock(&state)
                .create_stack_dir(&endpoint.id, &project)
                .map_err(ApiError::daemon)?;
            stacks::down(&project, &dir, &dir.join("compose.yaml")).await?;
        } else if let Some(stack) = docker::list_stacks("")
            .await?
            .into_iter()
            .find(|stack| stack.project == project)
        {
            for container in stack.containers {
                docker::remove_container(&container.id).await?;
            }
        }
        lock(&state)
            .remove_stack(&endpoint.id, &project)
            .map_err(ApiError::daemon)?;
    } else {
        let stack = docker::list_stacks("")
            .await?
            .into_iter()
            .find(|stack| stack.project == project)
            .ok_or_else(|| ApiError::not_found(format!("{project} was not found.")))?;
        for container in stack.containers {
            docker::remove_container(&container.id).await?;
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn container_detail(
    State(state): State<AppState>,
    Path((id, container_id)): Path<(String, String)>,
) -> Result<Json<docker::ContainerDetail>, ApiError> {
    require_docker(&state, &id)?;
    let container_id = docker::object_ref(&container_id)?;
    Ok(Json(docker::inspect_container(container_id).await?))
}

async fn container_logs(
    State(state): State<AppState>,
    Path((id, container_id)): Path<(String, String)>,
    Query(query): Query<ListQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_docker(&state, &id)?;
    let container_id = docker::object_ref(&container_id)?;
    let tail = query
        .tail
        .as_deref()
        .unwrap_or("200")
        .parse::<usize>()
        .unwrap_or(200);
    let lines = docker::logs(container_id, tail).await?;
    Ok(Json(serde_json::json!({ "lines": lines })))
}

/// NDJSON follow stream. Deliberately not under any collection timeout, and the
/// Next proxy exempts it from its 10 s abort (`frontend/app/api/[...path]/route.ts`).
async fn container_logs_stream(
    State(state): State<AppState>,
    Path((id, container_id)): Path<(String, String)>,
    Query(query): Query<ListQuery>,
) -> Result<Response, ApiError> {
    require_docker(&state, &id)?;
    let container_id = docker::object_ref(&container_id)?;
    let tail = query
        .tail
        .as_deref()
        .unwrap_or("0")
        .parse::<usize>()
        .unwrap_or(0);
    let lines = docker::follow_logs(container_id, tail)?;
    let body = Body::from_stream(lines.map(|item| {
        Ok::<_, std::io::Error>(format!(
            "{}
",
            docker::encode_event(item)
        ))
    }));
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/x-ndjson")
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-accel-buffering", "no")
        .body(body)
        .map_err(|_| ApiError::daemon("The log stream could not be opened."))
}

async fn container_console(
    State(state): State<AppState>,
    Path((id, container_id)): Path<(String, String)>,
    Query(query): Query<ConsoleQuery>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    require_docker(&state, &id)?;
    let container_id = docker::object_ref(&container_id)?.to_string();
    if !websocket_same_origin(&headers) {
        return Err(ApiError::unauthorized(
            "Cross-origin WebSocket request rejected.",
        ));
    }
    let command = docker::console_command(query.shell.as_deref())?;
    let user = docker::console_user(query.user.as_deref())?;
    Ok(ws
        .max_message_size(64 * 1024)
        .max_frame_size(64 * 1024)
        .on_upgrade(move |socket| console_socket(socket, container_id, command, user)))
}

fn websocket_same_origin(headers: &HeaderMap) -> bool {
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<Uri>().ok());
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok());
    origin.as_ref().is_some_and(|origin| {
        matches!(origin.scheme_str(), Some("http" | "https"))
            && origin
                .path_and_query()
                .is_none_or(|path| path.as_str() == "/")
            && origin.authority().is_some_and(|authority| {
                host.is_some_and(|host| authority.as_str().eq_ignore_ascii_case(host))
            })
    })
}

async fn console_socket(
    mut socket: WebSocket,
    container_id: String,
    command: &'static str,
    user: Option<&'static str>,
) {
    let (docker, exec_id) = match docker::create_console_exec(&container_id, command, user).await {
        Ok(exec) => exec,
        Err(_) => {
            send_console_error(
                &mut socket,
                format!("Could not start {command}. Confirm the container is running and that shell is installed."),
            )
            .await;
            return;
        }
    };
    let (mut output, mut input) = match docker::start_console_exec(&docker, &exec_id).await {
        Ok(bollard::exec::StartExecResults::Attached { output, input }) => (output, input),
        Ok(bollard::exec::StartExecResults::Detached) => {
            send_console_error(&mut socket, "Docker did not attach the console.".into()).await;
            return;
        }
        Err(_) => {
            send_console_error(
                &mut socket,
                format!("Could not start {command}. Confirm the container is running and that shell is installed."),
            )
            .await;
            return;
        }
    };

    let mut disconnected = false;
    let mut first_output = true;
    loop {
        tokio::select! {
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    if let Ok(message) = serde_json::from_str::<ConsoleMessage>(&text) {
                        match message {
                            ConsoleMessage::Input { data } if data.len() <= 32 * 1024 => {
                                if input.write_all(data.as_bytes()).await.is_err() { break; }
                                let _ = input.flush().await;
                            }
                            ConsoleMessage::Resize { width, height }
                                if (1..=500).contains(&width) && (1..=500).contains(&height) => {
                                docker::resize_console_exec(&docker, &exec_id, width, height).await;
                            }
                            _ => {}
                        }
                    }
                }
                Some(Ok(Message::Ping(data))) => {
                    if socket.send(Message::Pong(data)).await.is_err() { break; }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => {
                    disconnected = true;
                    break;
                }
                _ => {}
            },
            outgoing = output.next() => match outgoing {
                Some(Ok(line)) => {
                    let bytes = line.into_bytes();
                    if first_output {
                        first_output = false;
                        if missing_console_shell(&bytes, command) {
                            send_console_error(
                                &mut socket,
                                format!("The selected shell {command} is not installed in this container. Choose another shell."),
                            )
                            .await;
                            break;
                        }
                    }
                    if socket.send(Message::Binary(bytes)).await.is_err() {
                        disconnected = true;
                        break;
                    }
                }
                Some(Err(_)) | None => break,
            }
        }
    }

    // Ctrl-C stops a foreground command; EOF then exits the interactive shell.
    // Closing both halves also releases the Docker hijacked connection.
    let _ = tokio::time::timeout(Duration::from_secs(1), input.write_all(b"\x03\x04")).await;
    let _ = tokio::time::timeout(Duration::from_secs(1), input.flush()).await;
    let _ = tokio::time::timeout(Duration::from_secs(1), input.shutdown()).await;
    if disconnected {
        let _ = tokio::time::timeout(Duration::from_secs(2), async {
            while output.next().await.is_some() {}
        })
        .await;
    }
    let _ = socket.close().await;
}

fn missing_console_shell(output: &[u8], command: &str) -> bool {
    let output = String::from_utf8_lossy(output);
    output.contains(command) && output.contains("no such file or directory")
}

async fn send_console_error(socket: &mut WebSocket, message: String) {
    let _ = socket
        .send(Message::Text(format!("{message}\r\n").into()))
        .await;
    let _ = socket.close().await;
}

async fn start_container(
    State(state): State<AppState>,
    Path((id, container_id)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    act(&state, &id, &container_id, "start").await
}

async fn stop_container(
    State(state): State<AppState>,
    Path((id, container_id)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    act(&state, &id, &container_id, "stop").await
}

async fn restart_container(
    State(state): State<AppState>,
    Path((id, container_id)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    act(&state, &id, &container_id, "restart").await
}

async fn delete_container(
    State(state): State<AppState>,
    Path((id, container_id)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    act(&state, &id, &container_id, "remove").await
}

async fn create_container(
    State(state): State<AppState>,
    Path(id): Path<String>,
    body: Result<Json<RunBody>, JsonRejection>,
) -> Result<(StatusCode, Json<docker::CreatedContainer>), ApiError> {
    let body = take_json(body)?;
    require_docker(&state, &id)?;
    if let Some(name) = body.name.as_deref().filter(|name| !name.trim().is_empty()) {
        docker::object_ref(name)?;
    }
    let created = docker::run_container(docker::RunRequest {
        image: body.image,
        name: body.name,
        ports: body
            .ports
            .unwrap_or_default()
            .into_iter()
            .map(|port| docker::RunPort {
                host: port.host,
                container: port.container,
                protocol: port.protocol.unwrap_or_else(|| "tcp".into()),
            })
            .collect(),
    })
    .await?;
    Ok((StatusCode::CREATED, Json(created)))
}

async fn list_images(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<ListQuery>,
) -> Result<Json<ListPage<docker::ImageOut>>, ApiError> {
    require_docker(&state, &id)?;
    Ok(Json(page_of(docker::list_images().await?, &query)?))
}

async fn delete_image(
    State(state): State<AppState>,
    Path((id, image_ref)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    require_docker(&state, &id)?;
    let image_ref = docker::object_ref(&image_ref)?;
    docker::remove_image(image_ref).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn container_config(
    State(state): State<AppState>,
    Path((id, container_id)): Path<(String, String)>,
) -> Result<Json<docker::ContainerConfigOut>, ApiError> {
    require_docker(&state, &id)?;
    let container_id = docker::object_ref(&container_id)?;
    Ok(Json(docker::container_config(container_id).await?))
}

async fn update_container_settings(
    State(state): State<AppState>,
    Path((id, container_id)): Path<(String, String)>,
    body: Result<Json<ContainerSettingsBody>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    let body = take_json(body)?;
    require_docker(&state, &id)?;
    let container_id = docker::object_ref(&container_id)?;
    docker::update_container_settings(
        container_id,
        Some(&body.name),
        Some(&body.restart_policy),
        body.restart_maximum_retry_count,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn duplicate_container(
    State(state): State<AppState>,
    Path((id, container_id)): Path<(String, String)>,
    body: Result<Json<DuplicateBody>, JsonRejection>,
) -> Result<(StatusCode, Json<docker::CreatedContainer>), ApiError> {
    let body = take_json(body)?;
    require_docker(&state, &id)?;
    let source = docker::object_ref(&container_id)?;
    let name = docker::checked_container_name(&body.name)?;
    let edits = docker::ContainerEdits {
        image: body.image,
        command: body.command,
        entrypoint: body.entrypoint,
        env: body.env,
        labels: body.labels,
        ports: body.ports,
        mounts: body.mounts,
        restart: body.restart_policy,
    };
    // Keeping the original name is Portainer's "Duplicate/Edit" replace path.
    let created = docker::duplicate_or_replace(source, &name, &edits)
        .await
        .map_err(safe_container_edit_error)?;
    Ok((StatusCode::CREATED, Json(created)))
}

async fn recreate_container(
    State(state): State<AppState>,
    Path((id, container_id)): Path<(String, String)>,
) -> Result<Json<docker::CreatedContainer>, ApiError> {
    require_docker(&state, &id)?;
    let source = docker::object_ref(&container_id)?;
    Ok(Json(docker::recreate_container(source, None).await?))
}

async fn list_volumes(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<ListQuery>,
) -> Result<Json<ListPage<docker::VolumeOut>>, ApiError> {
    require_docker(&state, &id)?;
    let items = docker::list_volumes(query.q.as_deref().unwrap_or("")).await?;
    Ok(Json(page_of(items, &query)?))
}

async fn create_volume(
    State(state): State<AppState>,
    Path(id): Path<String>,
    body: Result<Json<VolumeBody>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    let body = take_json(body)?;
    require_docker(&state, &id)?;
    docker::create_volume(&body.name, body.driver.as_deref().unwrap_or("local")).await?;
    Ok(StatusCode::CREATED)
}

async fn delete_volume(
    State(state): State<AppState>,
    Path((id, name)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    require_docker(&state, &id)?;
    let name = docker::object_ref(&name)?;
    docker::remove_volume(name).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_networks(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<ListQuery>,
) -> Result<Json<ListPage<docker::NetworkOut>>, ApiError> {
    require_docker(&state, &id)?;
    let items = docker::list_networks(query.q.as_deref().unwrap_or("")).await?;
    Ok(Json(page_of(items, &query)?))
}

async fn create_network(
    State(state): State<AppState>,
    Path(id): Path<String>,
    body: Result<Json<NetworkBody>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    let body = take_json(body)?;
    require_docker(&state, &id)?;
    docker::create_network(&body.name, body.driver.as_deref().unwrap_or("bridge")).await?;
    Ok(StatusCode::CREATED)
}

async fn delete_network(
    State(state): State<AppState>,
    Path((id, name)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    require_docker(&state, &id)?;
    let name = docker::object_ref(&name)?;
    docker::remove_network(name).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn act(
    state: &AppState,
    endpoint_id: &str,
    container_id: &str,
    action: &str,
) -> Result<StatusCode, ApiError> {
    require_docker(state, endpoint_id)?;
    let container_id = docker::object_ref(container_id)?;
    match action {
        "start" => docker::start_container(container_id).await?,
        "stop" => docker::stop_container(container_id).await?,
        "restart" => docker::restart_container(container_id).await?,
        "remove" => docker::remove_container(container_id).await?,
        _ => return Err(ApiError::validation("Unknown container action.")),
    }
    Ok(StatusCode::NO_CONTENT)
}

fn page_of<T>(items: Vec<T>, query: &ListQuery) -> Result<ListPage<T>, ApiError> {
    page::slice_page(items, query.limit.as_deref(), query.cursor.as_deref())
        .map_err(ApiError::validation)
}

fn lock(state: &AppState) -> std::sync::MutexGuard<'_, Store> {
    state.store.lock().unwrap_or_else(|err| err.into_inner())
}

fn load_endpoint(state: &AppState, id: &str) -> Result<Endpoint, ApiError> {
    lock(state)
        .get(id)
        .ok_or_else(|| ApiError::not_found("Endpoint was not found."))
}

fn require_docker(state: &AppState, id: &str) -> Result<Endpoint, ApiError> {
    let endpoint = load_endpoint(state, id)?;
    require_docker_kind(&endpoint)?;
    Ok(endpoint)
}

fn require_docker_kind(endpoint: &Endpoint) -> Result<(), ApiError> {
    if endpoint.kind == "docker" {
        Ok(())
    } else {
        Err(ApiError::validation(
            "This endpoint is a Kubernetes context.",
        ))
    }
}

fn endpoint_out(endpoint: Endpoint, docker_up: bool) -> EndpointOut {
    // shortcut: kubernetes status stays down until TELE-74 talks to a cluster
    let status = if endpoint.kind == "docker" && docker_up {
        "up"
    } else {
        "down"
    };
    EndpointOut {
        id: endpoint.id,
        name: endpoint.name,
        kind: endpoint.kind,
        status: status.to_string(),
    }
}

#[cfg(test)]
mod console_tests {
    use super::*;

    fn headers(host: &'static str, origin: &'static str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_static(host));
        headers.insert(header::ORIGIN, HeaderValue::from_static(origin));
        headers
    }

    #[test]
    fn websocket_requires_matching_http_origin_and_host() {
        assert!(websocket_same_origin(&headers(
            "pisces.example:3000",
            "https://pisces.example:3000"
        )));
        assert!(websocket_same_origin(&headers(
            "localhost:3000",
            "http://localhost:3000/"
        )));
        assert!(!websocket_same_origin(&headers(
            "pisces.example:3000",
            "https://attacker.example"
        )));
        assert!(!websocket_same_origin(&headers(
            "pisces.example:3000",
            "https://pisces.example:3000/other"
        )));
        let mut missing_origin = HeaderMap::new();
        missing_origin.insert(
            header::HOST,
            HeaderValue::from_static("pisces.example:3000"),
        );
        assert!(!websocket_same_origin(&missing_origin));
    }

    #[test]
    fn container_edit_errors_never_echo_engine_details() {
        let error = safe_container_edit_error(ApiError::daemon("engine echoed SECRET_VALUE"));
        assert!(!error.message.contains("SECRET_VALUE"));

        for message in [
            "Port mapping must use host:container and an optional /tcp, /udp or /sctp.",
            "Each mount needs an absolute container destination.",
        ] {
            assert_eq!(
                safe_container_edit_error(ApiError::validation(message)).message,
                message
            );
        }

        let unsafe_validation =
            safe_container_edit_error(ApiError::unsafe_validation("engine echoed SECRET_VALUE"));
        assert!(!unsafe_validation.message.contains("SECRET_VALUE"));

        let recovery = safe_container_edit_error(ApiError::daemon(
            "Recreate recovery incomplete: inspect container state before retrying.",
        ));
        assert_eq!(
            recovery.message,
            "Recreate recovery incomplete: inspect container state before retrying."
        );
    }

    #[test]
    fn reports_a_shell_that_is_not_installed() {
        assert!(missing_console_shell(
            b"kiri: cannot start container: exec /bin/bash: stat /bin/bash: no such file or directory",
            "/bin/bash"
        ));
        assert!(!missing_console_shell(
            b"/bin/bash: command not found",
            "/bin/bash"
        ));
    }

    #[tokio::test]
    async fn stack_apply_locks_are_scoped_to_endpoint_and_project() {
        let locks = StackApplyLocks::default();
        let _first = locks.lock("endpoint-1", "alpha").await;
        let _other =
            tokio::time::timeout(Duration::from_millis(100), locks.lock("endpoint-1", "beta"))
                .await
                .expect("another stack should not wait for alpha");
        assert!(
            tokio::time::timeout(Duration::from_millis(20), locks.lock("endpoint-1", "alpha"))
                .await
                .is_err()
        );
    }

    fn stack_test_state() -> (AppState, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("pisces-http-stack-{}", store::new_id()));
        let mut store = Store::open(dir.clone()).unwrap();
        store
            .insert(Endpoint {
                id: "endpoint-1".to_string(),
                name: "Test Docker".to_string(),
                kind: "docker".to_string(),
                context: None,
            })
            .unwrap();
        (
            AppState {
                auth: AuthConfig {
                    username: "test".to_string(),
                    password_hash: "unused".to_string(),
                    jwt_secret: "unused".to_string(),
                },
                store: Arc::new(Mutex::new(store)),
                stack_apply: Arc::new(StackApplyLocks::default()),
            },
            dir,
        )
    }

    #[tokio::test]
    async fn create_stack_route_rejects_invalid_project_before_docker_access() {
        let (state, dir) = stack_test_state();
        let result = create_stack(
            State(state.clone()),
            Path("endpoint-1".to_string()),
            Ok(Json(StackBody {
                project: "../unsafe".to_string(),
                compose: "services:\n  web:\n    image: nginx\n".to_string(),
            })),
        )
        .await;
        let error = result.unwrap_err();
        assert_eq!(error.code, "validation");
        assert!(!lock(&state).stack_exists("endpoint-1", "unsafe"));
        drop(state);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn update_stack_route_rejects_renaming_before_docker_access() {
        let (state, dir) = stack_test_state();
        let result = update_stack(
            State(state),
            Path(("endpoint-1".to_string(), "sample".to_string())),
            Ok(Json(StackBody {
                project: "different".to_string(),
                compose: "services:\n  web:\n    image: nginx\n".to_string(),
            })),
        )
        .await;
        let error = result.unwrap_err();
        assert_eq!(error.code, "validation");
        assert_eq!(error.message, "The stack name cannot be changed.");
        let _ = std::fs::remove_dir_all(dir);
    }
}
