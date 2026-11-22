//! HTTP routes. Docker control requires the session cookie. Health and login do not.

use std::sync::{Arc, Mutex};

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
use crate::store::{self, Endpoint, Store};

#[derive(Clone)]
pub struct AppState {
    pub auth: AuthConfig,
    pub store: Arc<Mutex<Store>>,
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
struct NetworkBody {
    name: String,
    driver: Option<String>,
}

fn take_json<T>(body: Result<Json<T>, JsonRejection>) -> Result<T, ApiError> {
    body.map(|Json(value)| value)
        .map_err(|_| ApiError::validation("The request body is not valid."))
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
        .route("/api/endpoints/{id}/stacks", get(list_stacks))
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
    let names = k8s::context_names().map_err(|message| ApiError::cluster(message))?;
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
            let known = k8s::context_names().map_err(|message| ApiError::cluster(message))?;
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
    let removed = lock(&state)
        .remove(&id)
        .map_err(|message| ApiError::daemon(message))?;
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
) -> Result<Json<ListPage<docker::StackOut>>, ApiError> {
    require_docker(&state, &id)?;
    let items = docker::list_stacks(query.q.as_deref().unwrap_or("")).await?;
    Ok(Json(page_of(items, &query)?))
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
}
