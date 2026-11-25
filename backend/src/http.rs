//! HTTP routes. Docker control requires the session cookie. Health and login do not.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

use axum::body::Body;
use axum::extract::rejection::JsonRejection;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Extension, Path, Query, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode, Uri};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::io::AsyncWriteExt;

use crate::access::{self, Principal};
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
    /// Endpoint list, agent credential, AI policy and proposals all live here.
    pub data_dir: std::path::PathBuf,
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

#[derive(Deserialize, Serialize)]
struct RunBody {
    image: String,
    name: Option<String>,
    ports: Option<Vec<RunPortBody>>,
}

#[derive(Deserialize, Serialize)]
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

#[derive(Deserialize, Serialize)]
struct ContainerSettingsBody {
    name: String,
    restart_policy: String,
    restart_maximum_retry_count: Option<i64>,
}

#[derive(Clone, Deserialize, Serialize)]
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
    #[serde(default)]
    repull: bool,
}

#[derive(Deserialize, Default)]
struct StackRepullBody {
    #[serde(default)]
    repull: bool,
}

#[derive(Deserialize)]
struct NetworkBody {
    name: String,
    driver: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct StackBody {
    project: String,
    compose: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    env: Option<Vec<docker::EnvOut>>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    env: Option<Vec<docker::EnvOut>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialOut {
    id: String,
    issued_at: u64,
    expires_at: u64,
    revoked_at: Option<u64>,
    last_used_at: Option<u64>,
    ttl_secs: u64,
    idle_secs: u64,
    idle_deadline: Option<u64>,
    access_tier: access::AccessTier,
    state: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IssuedCredentialOut {
    /// Shown once, at issue time. It is not stored anywhere.
    secret: String,
    #[serde(flatten)]
    credential: CredentialOut,
}

#[derive(Deserialize)]
struct AiAccessBody {
    state: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AiAccessOut {
    state: &'static str,
    forced_locked: bool,
    reason: String,
    mount: Option<String>,
    readable: bool,
}

fn credential_out(view: access::CredentialView) -> CredentialOut {
    CredentialOut {
        id: view.id,
        issued_at: view.issued_at,
        expires_at: view.expires_at,
        revoked_at: view.revoked_at,
        last_used_at: view.last_used_at,
        ttl_secs: view.ttl_secs,
        idle_secs: view.idle_secs,
        idle_deadline: view.idle_deadline,
        access_tier: view.access_tier,
        state: view.state,
    }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IssueBody {
    #[serde(default)]
    ttl_secs: Option<u64>,
    #[serde(default)]
    idle_secs: Option<u64>,
}

fn issue_params_from_body(body: &[u8]) -> Result<access::IssueParams, ApiError> {
    if body.iter().all(|byte| byte.is_ascii_whitespace()) {
        return Ok(access::IssueParams::default());
    }
    let parsed: IssueBody = serde_json::from_slice(body)
        .map_err(|_| ApiError::validation("The request body is not valid."))?;
    let ttl_secs = parsed.ttl_secs.unwrap_or(access::AGENT_CRED_SECS);
    let idle_secs = parsed.idle_secs.unwrap_or(access::DEFAULT_IDLE_SECS);
    let ttl_secs = access::validate_ttl_secs(ttl_secs).map_err(ApiError::validation)?;
    let idle_secs = access::validate_idle_secs(idle_secs).map_err(ApiError::validation)?;
    Ok(access::IssueParams {
        ttl_secs,
        idle_secs,
    })
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
            "/api/endpoints/{id}/stacks/{project}/start",
            post(stack_start),
        )
        .route(
            "/api/endpoints/{id}/stacks/{project}/stop",
            post(stack_stop),
        )
        .route(
            "/api/endpoints/{id}/stacks/{project}/restart",
            post(stack_restart),
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
        .route(
            "/api/agent/credential",
            get(get_credential)
                .post(issue_credential)
                .delete(revoke_credential),
        )
        .route(
            "/api/ai-access/{id}/{container_id}",
            get(get_ai_access).put(put_ai_access),
        )
        .route("/api/ai-access/{id}", get(list_ai_access))
        .route("/api/proposals", get(list_proposals))
        .route("/api/proposals/{id}/confirm", post(confirm_proposal))
        .route("/api/proposals/{id}/reject", post(reject_proposal))
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

async fn require_auth(State(state): State<AppState>, mut req: Request, next: Next) -> Response {
    let path = req.uri().path().to_string();
    let public = path == "/api/health"
        || (path == "/api/session" && req.method() == axum::http::Method::POST);
    if public {
        return next.run(req).await;
    }

    let cookie = auth::token_from_headers(req.headers());
    let authorization = req
        .headers()
        .get(header::AUTHORIZATION)
        .map(|value| value.to_str().unwrap_or_default().to_string());
    if cookie.is_some() && authorization.is_some() {
        return ApiError::unauthorized(
            "Send either the session cookie or the agent credential, not both.",
        )
        .into_response();
    }

    if let Some(value) = authorization {
        // Contract: strip a case-sensitive `Bearer ` prefix, then the token must
        // carry the agent prefix. Nothing else is accepted on this header.
        let token = value.strip_prefix("Bearer ").unwrap_or_default().trim();
        if !token.starts_with(access::AGENT_PREFIX) {
            return ApiError::unauthorized("Those credentials were rejected.").into_response();
        }
        let credential_id = match access::verify_credential(&state.data_dir, token) {
            Ok(record) => {
                access::touch_credential(&state.data_dir, &record);
                if let Some(message) =
                    access::agent_call_block(req.method().as_str(), &path, &record)
                {
                    return ApiError::forbidden(message).into_response();
                }
                record.id
            }
            Err(access::CredentialError::Revoked) => {
                return ApiError::unauthorized(
                    "This agent credential was revoked. Issue a new one.",
                )
                .into_response();
            }
            Err(access::CredentialError::Expired) => {
                return ApiError::unauthorized("This agent credential expired. Issue a new one.")
                    .into_response();
            }
            Err(access::CredentialError::Idle) => {
                return ApiError::unauthorized(
                    "This agent credential was unused past its idle deadline. Issue a new one.",
                )
                .into_response();
            }
            Err(access::CredentialError::Rejected) => {
                return ApiError::unauthorized("Those credentials were rejected.").into_response();
            }
        };
        req.extensions_mut()
            .insert(Principal::Agent { credential_id });
        return next.run(req).await;
    }

    let Some(token) = cookie else {
        return ApiError::unauthorized("Sign in required.").into_response();
    };
    let Some(username) = auth::username_from_token(&state.auth, &token) else {
        return ApiError::unauthorized("Your session ended. Sign in again.").into_response();
    };
    req.extensions_mut().insert(Principal::Browser { username });
    next.run(req).await
}

fn browser_only(principal: &Principal) -> Result<(), ApiError> {
    if principal.is_browser() {
        Ok(())
    } else {
        Err(ApiError::forbidden(
            "That is a browser-only route for the AI agent.",
        ))
    }
}

/// CSRF guard for cookie-authenticated writes. The Next proxy forwards the
/// browser's Origin and its own `x-forwarded-host`, so a same-origin call
/// compares equal while a cross-site one does not. Requests without an Origin
/// are server-to-server and never carry the cookie.
fn same_origin(headers: &HeaderMap) -> bool {
    let Some(origin) = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<Uri>().ok())
    else {
        return true;
    };
    if !matches!(origin.scheme_str(), Some("http" | "https")) {
        return false;
    }
    if origin
        .path_and_query()
        .is_some_and(|path| path.as_str() != "/")
    {
        return false;
    }
    let Some(authority) = origin.authority() else {
        return false;
    };
    let matches = |candidate: Option<&str>| {
        candidate.is_some_and(|host| authority.as_str().eq_ignore_ascii_case(host))
    };
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok());
    let forwarded = headers
        .get("x-forwarded-host")
        .and_then(|value| value.to_str().ok());
    matches(host) || matches(forwarded)
}

fn same_origin_guard(headers: &HeaderMap) -> Result<(), ApiError> {
    if same_origin(headers) {
        Ok(())
    } else {
        Err(ApiError::forbidden("Cross-origin request rejected."))
    }
}

// --- AI access ----------------------------------------------------------

struct AccessState {
    state: access::State,
    forced: bool,
    reason: String,
    mount: Option<String>,
    readable: bool,
}

fn locked_access_error(value: &AccessState) -> ApiError {
    let reason = if value.reason.is_empty() {
        "This container is locked for the agent.".to_string()
    } else {
        format!(
            "This container is locked for the agent because {}.",
            value.reason
        )
    };
    ApiError::forbidden(format!("The agent has no access. {reason}"))
}

fn require_access_read(value: &AccessState) -> Result<(), ApiError> {
    if value.state.allows_read() {
        Ok(())
    } else {
        Err(locked_access_error(value))
    }
}

fn require_access_operate(value: &AccessState) -> Result<(), ApiError> {
    if value.state.allows_operate() {
        Ok(())
    } else if value.state.allows_read() {
        Err(ApiError::forbidden(
            "This container is read-only for the agent. Change the policy to Operate first.",
        ))
    } else {
        Err(locked_access_error(value))
    }
}

fn ai_access_out(value: AccessState) -> AiAccessOut {
    AiAccessOut {
        state: if value.state.allows_operate() {
            "operate"
        } else if value.state.allows_read() {
            "read"
        } else {
            "locked"
        },
        forced_locked: value.forced,
        reason: value.reason,
        mount: value.mount,
        readable: value.readable,
    }
}

/// Policy plus live forced lock. Forced lock always wins over the stored state.
async fn access_for(
    state: &AppState,
    endpoint_id: &str,
    id: &str,
    live: &access::LiveAccess,
) -> AccessState {
    let policy = access::load_policy(&state.data_dir);
    let forced = access::forced_lock(&state.data_dir, live);
    if forced.locked {
        return AccessState {
            state: access::State::Locked,
            forced: true,
            reason: forced.reason,
            mount: forced.mount,
            readable: policy.readable,
        };
    }
    let mut value = access::policy_state(&policy, endpoint_id, live.canonical_id(id));
    let mut reason = String::new();
    if value.allows_read() {
        if let Some(shared) = shared_reference_reason(state, endpoint_id, live).await {
            value = access::State::Locked;
            reason = shared;
        }
    }
    AccessState {
        state: value,
        forced: false,
        reason,
        mount: None,
        readable: policy.readable,
    }
}

async fn container_access(
    state: &AppState,
    endpoint_id: &str,
    id: &str,
) -> Result<AccessState, ApiError> {
    let live = docker::live_access(id).await?;
    Ok(access_for(state, endpoint_id, id, &live).await)
}

/// `network_mode: container:x`, `volumes_from` and `links` inherit whatever the
/// target can do. One level only: the target's own forced lock plus its policy.
async fn shared_reference_reason(
    state: &AppState,
    endpoint_id: &str,
    live: &access::LiveAccess,
) -> Option<String> {
    let mut targets: Vec<String> = Vec::new();
    for mode in [live.network_mode.as_deref(), live.pid_mode.as_deref()]
        .into_iter()
        .flatten()
    {
        if let Some(target) = mode.strip_prefix("container:") {
            targets.push(target.to_string());
        }
    }
    targets.extend(live.volumes_from.iter().cloned());
    targets.extend(live.links.iter().cloned());
    for target in targets {
        let Some(value) = reference_state(state, endpoint_id, &target).await else {
            return Some("it shares resources with a container the agent cannot resolve".into());
        };
        if !value.allows_operate() {
            return Some(format!(
                "it shares resources with {target}, which is {} for the agent",
                value.as_str()
            ));
        }
    }
    None
}

async fn reference_state(
    state: &AppState,
    endpoint_id: &str,
    target: &str,
) -> Option<access::State> {
    let target = target.split(':').next().unwrap_or(target);
    let listed = docker::list_containers("", "").await.ok()?;
    let found = listed.into_iter().find(|container| {
        container.name == target || container.id == target || container.id.starts_with(target)
    })?;
    let live = docker::live_access(&found.id).await.ok()?;
    let forced = access::forced_lock(&state.data_dir, &live);
    if forced.locked {
        return Some(access::State::Locked);
    }
    let policy = access::load_policy(&state.data_dir);
    Some(access::policy_state(
        &policy,
        endpoint_id,
        live.canonical_id(&found.id),
    ))
}

/// Every service in a stack must pass the same bar the agent needs for a single
/// container. A stack is never a way around a per-container decision.
async fn stack_guard(
    state: &AppState,
    endpoint_id: &str,
    project: &str,
    operate: bool,
) -> Result<(), ApiError> {
    let stack = docker::list_stacks("")
        .await?
        .into_iter()
        .find(|stack| stack.project == project);
    // A stack with no live service cannot be checked, so it fails closed rather
    // than skipping the per-service decision.
    let Some(stack) = stack else {
        return Err(ApiError::forbidden(
            "This stack has no running services, so its AI access cannot be verified.",
        ));
    };
    if stack.containers.is_empty() {
        return Err(ApiError::forbidden(
            "This stack has no running services, so its AI access cannot be verified.",
        ));
    }
    for container in stack.containers {
        let live = docker::live_access(&container.id).await?;
        let value = access_for(state, endpoint_id, &container.id, &live).await;
        if operate {
            require_access_operate(&value)?;
        } else {
            require_access_read(&value)?;
        }
    }
    Ok(())
}

fn refusal_for(
    state: &AppState,
    mutation: &access::Mutation,
    reachable: &std::collections::HashMap<String, access::State>,
) -> Result<(), ApiError> {
    let lookup = |target: &str| {
        let key = target.split(':').next().unwrap_or(target);
        reachable.get(key).copied().unwrap_or(access::State::Locked)
    };
    match access::refusal(&state.data_dir, mutation, &lookup) {
        None => Ok(()),
        Some(message) => Err(ApiError::forbidden(message)),
    }
}

async fn reachable_map(
    state: &AppState,
    endpoint_id: &str,
) -> std::collections::HashMap<String, access::State> {
    let mut map = std::collections::HashMap::new();
    let Ok(listed) = docker::list_containers("", "").await else {
        return map;
    };
    for container in listed {
        let Ok(live) = docker::live_access(&container.id).await else {
            continue;
        };
        let value = access_for(state, endpoint_id, &container.id, &live).await;
        map.insert(container.name.clone(), value.state);
        map.insert(container.id.clone(), value.state);
    }
    map
}

async fn access_labels(
    state: &AppState,
    endpoint_id: &str,
    items: &[docker::ContainerOut],
) -> Vec<Option<docker::AiAccessLabel>> {
    let mut labels = Vec::with_capacity(items.len());
    for item in items {
        let label = match docker::live_access(&item.id).await {
            Ok(live) => {
                let out = ai_access_out(access_for(state, endpoint_id, &item.id, &live).await);
                Some(docker::AiAccessLabel {
                    state: out.state.to_string(),
                    forced_locked: out.forced_locked,
                    reason: out.reason,
                    mount: out.mount,
                })
            }
            Err(_) => None,
        };
        labels.push(label);
    }
    labels
}

async fn get_credential(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> Result<Json<CredentialOut>, ApiError> {
    browser_only(&principal)?;
    Ok(Json(credential_out(access::credential_view(
        &state.data_dir,
        access::now(),
    ))))
}

/// Issue the one live credential. A previous record is replaced atomically, so
/// issuing again invalidates whatever the agent had.
async fn issue_credential(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
    body: String,
) -> Result<(StatusCode, Json<IssuedCredentialOut>), ApiError> {
    browser_only(&principal)?;
    same_origin_guard(&headers)?;
    let params = issue_params_from_body(body.as_bytes())?;
    let issued_by = match &principal {
        Principal::Browser { username } => username.clone(),
        Principal::Agent { .. } => String::new(),
    };
    let issued = access::issue_credential(&state.data_dir, &issued_by, access::now(), params)
        .map_err(|error| match error {
            access::IssueError::Invalid(message) => ApiError::validation(message),
            access::IssueError::Store(message) => ApiError::daemon(message),
        })?;
    Ok((
        StatusCode::CREATED,
        Json(IssuedCredentialOut {
            secret: issued.secret,
            credential: credential_out(issued.view),
        }),
    ))
}

async fn revoke_credential(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    browser_only(&principal)?;
    same_origin_guard(&headers)?;
    let now = access::now();
    let revoked = access::revoke_credential(&state.data_dir, now).map_err(ApiError::daemon)?;
    if !revoked {
        return Err(ApiError::not_found(
            "There is no agent credential to revoke.",
        ));
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn get_ai_access(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((id, container_id)): Path<(String, String)>,
) -> Result<Json<AiAccessOut>, ApiError> {
    browser_only(&principal)?;
    let endpoint = require_docker(&state, &id)?;
    let container_id = docker::object_ref(&container_id)?;
    let value = container_access(&state, &endpoint.id, container_id).await?;
    Ok(Json(ai_access_out(value)))
}

async fn put_ai_access(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((id, container_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Result<Json<AiAccessBody>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    browser_only(&principal)?;
    same_origin_guard(&headers)?;
    let body = take_json(body)?;
    let requested = match body.state.trim() {
        "locked" => access::State::Locked,
        "read" => access::State::Read,
        "operate" => access::State::Operate,
        _ => {
            return Err(ApiError::validation(
                "State must be locked, read or operate.",
            ))
        }
    };
    let username = match &principal {
        Principal::Browser { username } => username.clone(),
        Principal::Agent { .. } => String::new(),
    };
    let endpoint = require_docker(&state, &id)?;
    let container_id = docker::object_ref(&container_id)?.to_string();
    let live = docker::live_access(&container_id).await?;
    let forced = access::forced_lock(&state.data_dir, &live);
    if forced.locked {
        return Err(ApiError::conflict(format!(
            "Forced lock: {}. Revoke the access on the host; the policy cannot override it.",
            forced.reason
        )));
    }
    access::remember_policy(
        &state.data_dir,
        access::PolicyEntry {
            // The engine's id, not the form the caller used: one container
            // must not end up with a short-id and a full-id entry.
            container_id: live.canonical_id(&container_id).to_string(),
            endpoint_id: endpoint.id.clone(),
            container_name: live.name.clone(),
            state: requested,
            updated_at: access::now(),
            updated_by: username,
        },
    )
    .map_err(ApiError::daemon)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AiAccessItem {
    container_id: String,
    container_name: String,
    state: &'static str,
    forced_locked: bool,
    reason: String,
    mount: Option<String>,
}

async fn list_ai_access(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> Result<Json<Items<AiAccessItem>>, ApiError> {
    browser_only(&principal)?;
    let endpoint = require_docker(&state, &id)?;
    let containers = docker::list_containers("", "").await?;
    let mut items = Vec::new();
    for container in containers {
        let Ok(live) = docker::live_access(&container.id).await else {
            continue;
        };
        let value = access_for(&state, &endpoint.id, &container.id, &live).await;
        let out = ai_access_out(value);
        items.push(AiAccessItem {
            container_id: container.id.clone(),
            container_name: container.name.clone(),
            state: out.state,
            forced_locked: out.forced_locked,
            reason: out.reason,
            mount: out.mount,
        });
    }
    Ok(Json(Items { items }))
}

async fn list_proposals(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> Result<Json<Items<access::Proposal>>, ApiError> {
    browser_only(&principal)?;
    access::expire_proposals(&state.data_dir, access::now());
    let mut items = access::load_proposals(&state.data_dir).map_err(ApiError::unavailable)?;
    items.sort_by_key(|item| std::cmp::Reverse(item.created_at));
    Ok(Json(Items { items }))
}

fn decide_error(error: access::DecideError) -> ApiError {
    match error {
        access::DecideError::Missing => ApiError::not_found("That proposal was not found."),
        access::DecideError::Expired => {
            ApiError::gone("That proposal expired before it was decided.")
        }
        access::DecideError::Conflict => ApiError::conflict("That proposal was already decided."),
        access::DecideError::Unavailable => ApiError::unavailable(
            "The proposal queue could not be read or saved, so nothing was decided. Try again.",
        ),
    }
}

async fn confirm_proposal(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    browser_only(&principal)?;
    same_origin_guard(&headers)?;
    let username = match &principal {
        Principal::Browser { username } => username.clone(),
        Principal::Agent { .. } => String::new(),
    };
    let proposal = access::decide_proposal(
        &state.data_dir,
        &id,
        access::ProposalStatus::Confirmed,
        &username,
        access::now(),
        None,
    )
    .map_err(decide_error)?;
    match execute_proposal(&state, &proposal).await {
        Ok(()) => {
            if access::finish_proposal(
                &state.data_dir,
                &proposal.id,
                access::ProposalStatus::Applied,
                None,
            )
            .is_err()
            {
                return Err(ApiError::unavailable(
                    "The action ran, but the proposal queue could not be updated. Check the container state before doing anything else.",
                ));
            }
            Ok(Json(serde_json::json!({ "status": "applied" })))
        }
        Err(error) => {
            if access::finish_proposal(
                &state.data_dir,
                &proposal.id,
                access::ProposalStatus::Failed,
                Some(error.message.clone()),
            )
            .is_err()
            {
                return Err(ApiError::unavailable(
                    "The action failed and the proposal queue could not be updated. Check the container state before doing anything else.",
                ));
            }
            Err(error)
        }
    }
}

async fn reject_proposal(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    browser_only(&principal)?;
    same_origin_guard(&headers)?;
    let username = match &principal {
        Principal::Browser { username } => username.clone(),
        Principal::Agent { .. } => String::new(),
    };
    let proposal = access::decide_proposal(
        &state.data_dir,
        &id,
        access::ProposalStatus::Rejected,
        &username,
        access::now(),
        None,
    )
    .map_err(decide_error)?;
    drop(proposal);
    Ok(StatusCode::NO_CONTENT)
}

async fn propose(
    state: &AppState,
    principal: &Principal,
    request: access::ProposalRequest,
) -> Result<Response, ApiError> {
    if !principal.is_agent() {
        return Err(ApiError::forbidden(
            "Only the agent credential creates proposals.",
        ));
    }
    let issuer = match principal {
        Principal::Agent { credential_id } => {
            access::ensure_can_propose(&state.data_dir, credential_id)
                .map_err(ApiError::forbidden)?;
            Some(credential_id.as_str())
        }
        Principal::Browser { .. } => None,
    };
    let proposal = access::create_proposal(&state.data_dir, request, issuer, access::now())
        .map_err(ApiError::unavailable)?;
    Ok((StatusCode::ACCEPTED, Json(proposal)).into_response())
}

/// Re-run every check against live state, then (and only then) act. An agent
/// proposal is a request, not an authorization.
async fn execute_proposal(state: &AppState, proposal: &access::Proposal) -> Result<(), ApiError> {
    let endpoint = require_docker(state, &proposal.endpoint_id)?;
    let container_id = proposal.container_id.clone().unwrap_or_default();
    match proposal.action.as_str() {
        "start" | "stop" | "restart" => {
            let container_id = docker::object_ref(&container_id)?.to_string();
            let live = docker::live_access(&container_id).await?;
            let value = access_for(state, &endpoint.id, &container_id, &live).await;
            require_access_operate(&value)?;
            match proposal.action.as_str() {
                "start" => docker::start_container(&container_id).await,
                "stop" => docker::stop_container(&container_id).await,
                _ => docker::restart_container(&container_id).await,
            }
        }
        "run" => {
            let body: RunBody = serde_json::from_value(proposal.payload.clone())
                .map_err(|_| ApiError::validation("The proposed container is not valid."))?;
            let created = apply_run(state, body).await?;
            access::remember_policy(
                &state.data_dir,
                access::PolicyEntry {
                    container_id: created.id,
                    endpoint_id: endpoint.id.clone(),
                    container_name: created.name,
                    state: access::State::Locked,
                    updated_at: access::now(),
                    updated_by: "agent".to_string(),
                },
            )
            .map_err(ApiError::daemon)
        }
        "settings" => {
            let body: ContainerSettingsBody = serde_json::from_value(proposal.payload.clone())
                .map_err(|_| ApiError::validation("The proposed settings are not valid."))?;
            let container_id = docker::object_ref(&container_id)?.to_string();
            let live = docker::live_access(&container_id).await?;
            let value = access_for(state, &endpoint.id, &container_id, &live).await;
            require_access_operate(&value)?;
            docker::update_container_settings(
                &container_id,
                Some(&body.name),
                Some(&body.restart_policy),
                body.restart_maximum_retry_count,
            )
            .await?;
            access::rename_policy(
                &state.data_dir,
                &endpoint.id,
                &container_id,
                &live.name,
                &body.name,
            );
            Ok(())
        }
        "duplicate" => {
            let body: DuplicateBody = serde_json::from_value(proposal.payload.clone())
                .map_err(|_| ApiError::validation("The proposed duplicate is not valid."))?;
            let source = docker::object_ref(&container_id)?.to_string();
            let live = docker::live_access(&source).await?;
            let value = access_for(state, &endpoint.id, &source, &live).await;
            require_access_operate(&value)?;
            let reachable = reachable_map(state, &endpoint.id).await;
            // The proposal keeps no values, so the live source is the authority
            // for what the copy inherits and for the refusal set.
            let source_config = docker::container_config(&source).await?;
            let mutation = access::Mutation::from_edits(
                &source_config.env,
                &source_config.labels,
                &source_config.mounts,
            );
            refusal_for(state, &mutation, &reachable)?;
            let name = docker::checked_container_name(&body.name)?;
            let edits = docker::ContainerEdits {
                image: body.image.clone(),
                command: body.command.clone(),
                entrypoint: body.entrypoint.clone(),
                env: None,
                labels: None,
                ports: body.ports.clone(),
                mounts: None,
                restart: body.restart_policy.clone(),
            };
            if body.repull {
                let image = docker::image_for_edits(&source, &edits).await?;
                docker::pull_image(&image).await?;
            }
            let created = docker::duplicate_or_replace(&source, &name, &edits).await?;
            access::copy_policy(
                &state.data_dir,
                &endpoint.id,
                &live,
                &source,
                &created.id,
                &created.name,
            )
            .map_err(ApiError::daemon)?;
            if live.name.eq_ignore_ascii_case(&created.name) {
                access::forget_policy(&state.data_dir, &endpoint.id, &source, &live.name);
            }
            Ok(())
        }
        "recreate" => {
            let source = docker::object_ref(&container_id)?.to_string();
            let live = docker::live_access(&source).await?;
            let value = access_for(state, &endpoint.id, &source, &live).await;
            require_access_operate(&value)?;
            let created = docker::recreate_container(&source, None).await?;
            access::copy_policy(
                &state.data_dir,
                &endpoint.id,
                &live,
                &source,
                &created.id,
                &created.name,
            )
            .map_err(ApiError::daemon)?;
            access::forget_policy(&state.data_dir, &endpoint.id, &source, &live.name);
            Ok(())
        }
        "stack-create" => {
            let body: StackBody = serde_json::from_value(proposal.payload.clone())
                .map_err(|_| ApiError::validation("The proposed stack is not valid."))?;
            let reachable = reachable_map(state, &endpoint.id).await;
            let mutation = access::mutation_from_compose(&body.compose);
            refusal_for(state, &mutation, &reachable)?;
            apply_stack_create(state, &endpoint, body).await
        }
        "stack-update" => {
            let body: StackBody = serde_json::from_value(proposal.payload.clone())
                .map_err(|_| ApiError::validation("The proposed stack is not valid."))?;
            let project = proposal
                .project
                .clone()
                .unwrap_or_else(|| body.project.clone());
            stack_guard(state, &endpoint.id, &project, true).await?;
            let reachable = reachable_map(state, &endpoint.id).await;
            let mutation = access::mutation_from_compose(&body.compose);
            refusal_for(state, &mutation, &reachable)?;
            apply_stack_update(state, &endpoint, project, body).await
        }
        _ => Err(ApiError::validation("Unknown proposal action.")),
    }
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
    let endpoint = require_docker(&state, &id)?;
    let items = docker::list_containers(
        query.q.as_deref().unwrap_or(""),
        query.state.as_deref().unwrap_or(""),
    )
    .await?;
    let mut page = page_of(items, &query)?;
    let labels = access_labels(&state, &endpoint.id, &page.items).await;
    for (item, label) in page.items.iter_mut().zip(labels) {
        item.ai_access = label;
    }
    Ok(Json(page))
}

async fn list_stacks(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Query(query): Query<ListQuery>,
) -> Result<Json<ListPage<StackView>>, ApiError> {
    let endpoint = require_docker(&state, &id)?;
    let live = docker::list_stacks(query.q.as_deref().unwrap_or("")).await?;
    let q = query.q.as_deref().unwrap_or("").trim().to_ascii_lowercase();
    // The store lock is taken and released inside this helper so it never
    // lives across an await (a MutexGuard is not Send).
    let mut items = stack_views(&state, &endpoint.id, live, &q);
    if principal.is_agent() {
        // A stack is only visible when every service in it is readable; the
        // locked members stay out of the answer entirely.
        let mut allowed = Vec::with_capacity(items.len());
        for stack in items {
            let mut readable = true;
            for container in &stack.containers {
                let value = container_access(&state, &endpoint.id, &container.id).await?;
                if !value.state.allows_read() {
                    readable = false;
                    break;
                }
            }
            if readable {
                allowed.push(stack);
            }
        }
        items = allowed;
    }
    Ok(Json(page_of(items, &query)?))
}

fn stack_views(
    state: &AppState,
    endpoint_id: &str,
    live: Vec<docker::StackOut>,
    q: &str,
) -> Vec<StackView> {
    let guard = lock(state);
    let managed = guard.stack_projects(endpoint_id);
    let mut items: Vec<StackView> = live
        .into_iter()
        .map(|stack| {
            let has_file = guard.stack_file(endpoint_id, &stack.project).is_some();
            let is_managed = guard.stack_exists(endpoint_id, &stack.project);
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
                env: None,
            }
        })
        .collect();
    for project in managed {
        if !items.iter().any(|stack| stack.project == project) {
            let compose = guard.stack_file(endpoint_id, &project);
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
                env: None,
            });
        }
    }
    drop(guard);
    items.retain(|stack| q.is_empty() || stack.project.to_ascii_lowercase().contains(q));
    items.sort_by(|a, b| a.project.cmp(&b.project));
    items
}

async fn create_stack(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Result<Json<StackBody>, JsonRejection>,
) -> Result<Response, ApiError> {
    let body = take_json(body)?;
    let endpoint = require_docker(&state, &id)?;
    if principal.is_agent() {
        let reachable = reachable_map(&state, &endpoint.id).await;
        let mutation = access::mutation_from_compose(&body.compose);
        refusal_for(&state, &mutation, &reachable)?;
        return propose(
            &state,
            &principal,
            access::ProposalRequest {
                action: "stack-create".into(),
                endpoint_id: endpoint.id,
                container_id: None,
                container_name: None,
                project: Some(body.project.clone()),
                payload: serde_json::to_value(&body).unwrap_or_default(),
            },
        )
        .await;
    }
    same_origin_guard(&headers)?;
    let project = body.project.clone();
    apply_stack_create(&state, &endpoint, body).await?;
    Ok((
        StatusCode::CREATED,
        Json(serde_json::json!({ "project": project })),
    )
        .into_response())
}

fn stack_env_for_apply(dir: &std::path::Path) -> Option<std::path::PathBuf> {
    let staged = stacks::staged_env_file(dir);
    if staged.is_file() {
        return Some(staged);
    }
    let committed = stacks::committed_env_file(dir);
    committed.is_file().then_some(committed)
}

fn stage_stack_env_from_body(
    state: &AppState,
    endpoint_id: &str,
    project: &str,
    env: &[docker::EnvOut],
) -> Result<(), ApiError> {
    stacks::validate_stack_env(env)?;
    let text = stacks::format_stack_env(env);
    lock(state)
        .stage_stack_env(endpoint_id, project, &text)
        .map_err(ApiError::daemon)
}

async fn apply_stack_create(
    state: &AppState,
    endpoint: &Endpoint,
    body: StackBody,
) -> Result<(), ApiError> {
    stacks::validate_project_name(&body.project)?;
    stacks::validate_compose(&body.compose)?;
    let _apply = state.stack_apply.lock(&endpoint.id, &body.project).await;
    let managed_exists = lock(state).stack_exists(&endpoint.id, &body.project);
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
    let dir = lock(state)
        .create_stack_dir(&endpoint.id, &body.project)
        .map_err(ApiError::daemon)?;
    lock(state)
        .stage_stack_file(&endpoint.id, &body.project, &body.compose)
        .map_err(ApiError::daemon)?;
    stage_stack_env_from_body(
        state,
        &endpoint.id,
        &body.project,
        body.env.as_deref().unwrap_or_default(),
    )?;
    let candidate = dir.join("compose.yaml.new");
    let env_file = stack_env_for_apply(&dir);
    if let Err(error) = stacks::up(
        &body.project,
        &dir,
        &candidate,
        env_file.as_deref(),
        false,
    )
    .await
    {
        lock(state).keep_failed_create(&endpoint.id, &body.project, &error.message);
        return Err(error);
    }
    lock(state)
        .commit_stack_file(&endpoint.id, &body.project)
        .map_err(ApiError::deploy)?;
    Ok(())
}

async fn get_stack(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((id, project)): Path<(String, String)>,
) -> Result<Json<StackView>, ApiError> {
    let endpoint = require_docker(&state, &id)?;
    stacks::validate_project_name(&project)?;
    let mut live = docker::list_stacks("").await?;
    let stack = live
        .iter()
        .position(|stack| stack.project == project)
        .map(|index| live.remove(index));
    let (compose, stack_env, is_managed) = {
        let guard = lock(&state);
        (
            guard.stack_file(&endpoint.id, &project),
            guard.stack_env_file(&endpoint.id, &project),
            guard.stack_exists(&endpoint.id, &project),
        )
    };
    let stored_env = stack_env
        .as_deref()
        .map(stacks::parse_stack_env)
        .filter(|entries| !entries.is_empty());
    let exists = is_managed;
    if stack.is_none() && !exists {
        return Err(ApiError::not_found(format!("{project} was not found.")));
    }
    if principal.is_agent() {
        stack_guard(&state, &endpoint.id, &project, false).await?;
    }
    let mut view = if let Some(stack) = stack {
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
            env: stored_env.clone(),
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
            env: stored_env,
        }
    };
    if principal.is_agent() {
        if let Some(compose) = view.compose.take() {
            view.compose = Some(access::redact_compose(&compose));
        }
        if let Some(env) = view.env.as_mut() {
            for entry in env {
                entry.value.clear();
            }
        }
    } else if let Some(compose) = view.compose.as_mut() {
        *compose = stacks::compose_for_editor(compose);
    }
    Ok(Json(view))
}

async fn update_stack(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((id, project)): Path<(String, String)>,
    headers: HeaderMap,
    body: Result<Json<StackBody>, JsonRejection>,
) -> Result<Response, ApiError> {
    let endpoint = require_docker(&state, &id)?;
    let body = take_json(body)?;
    if principal.is_agent() {
        stacks::validate_project_name(&project)?;
        stacks::validate_compose(&body.compose)?;
        if body.project != project {
            return Err(ApiError::validation("The stack name cannot be changed."));
        }
        stack_guard(&state, &endpoint.id, &project, true).await?;
        let reachable = reachable_map(&state, &endpoint.id).await;
        let mutation = access::mutation_from_compose(&body.compose);
        refusal_for(&state, &mutation, &reachable)?;
        return propose(
            &state,
            &principal,
            access::ProposalRequest {
                action: "stack-update".into(),
                endpoint_id: endpoint.id,
                container_id: None,
                container_name: None,
                project: Some(project),
                payload: serde_json::to_value(&body).unwrap_or_default(),
            },
        )
        .await;
    }
    same_origin_guard(&headers)?;
    apply_stack_update(&state, &endpoint, project, body).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn apply_stack_update(
    state: &AppState,
    endpoint: &Endpoint,
    project: String,
    body: StackBody,
) -> Result<(), ApiError> {
    stacks::validate_project_name(&project)?;
    stacks::validate_compose(&body.compose)?;
    if body.project != project {
        return Err(ApiError::validation("The stack name cannot be changed."));
    }
    let _apply = state.stack_apply.lock(&endpoint.id, &project).await;
    let (managed_exists, has_file) = {
        let guard = lock(state);
        (
            guard.stack_exists(&endpoint.id, &project),
            guard.stack_file(&endpoint.id, &project).is_some(),
        )
    };
    if !has_file {
        let live_exists = docker::list_stacks("")
            .await?
            .iter()
            .any(|stack| stack.project == project);
        if !managed_exists && !live_exists {
            return Err(ApiError::not_found(format!("{project} was not found.")));
        }
        let dir = lock(state)
            .create_stack_dir(&endpoint.id, &project)
            .map_err(ApiError::daemon)?;
        lock(state)
            .stage_stack_file(&endpoint.id, &project, &body.compose)
            .map_err(ApiError::daemon)?;
        if body.env.is_some() {
            stage_stack_env_from_body(
                state,
                &endpoint.id,
                &project,
                body.env.as_deref().unwrap_or_default(),
            )?;
        }
        let candidate = dir.join("compose.yaml.new");
        let env_file = stack_env_for_apply(&dir);
        if let Err(error) = stacks::up(&project, &dir, &candidate, env_file.as_deref(), false)
            .await
        {
            lock(state).keep_failed_create(&endpoint.id, &project, &error.message);
            return Err(error);
        }
        lock(state)
            .commit_stack_file(&endpoint.id, &project)
            .map_err(ApiError::deploy)?;
        return Ok(());
    }
    let dir = lock(state)
        .create_stack_dir(&endpoint.id, &project)
        .map_err(ApiError::daemon)?;
    lock(state)
        .stage_stack_file(&endpoint.id, &project, &body.compose)
        .map_err(ApiError::daemon)?;
    if body.env.is_some() {
        stage_stack_env_from_body(
            state,
            &endpoint.id,
            &project,
            body.env.as_deref().unwrap_or_default(),
        )?;
    }
    let env_file = stack_env_for_apply(&dir);
    if let Err(error) = stacks::up(
        &project,
        &dir,
        &dir.join("compose.yaml.new"),
        env_file.as_deref(),
        true,
    )
    .await
    {
        let _ = std::fs::remove_file(dir.join("compose.yaml.new"));
        let _ = std::fs::remove_file(stacks::staged_env_file(&dir));
        lock(state).record_stack_error(&endpoint.id, &project, &error.message);
        return Err(error);
    }
    lock(state)
        .commit_stack_file(&endpoint.id, &project)
        .map_err(ApiError::deploy)?;
    Ok(())
}

async fn stack_compose_lifecycle(
    state: &AppState,
    endpoint: &Endpoint,
    project: &str,
    action: &str,
    repull: bool,
) -> Result<(), ApiError> {
    stacks::validate_project_name(project)?;
    let _apply = state.stack_apply.lock(&endpoint.id, project).await;
    let has_file = lock(state)
        .stack_file(&endpoint.id, project)
        .is_some();
    if !has_file {
        return Err(ApiError::validation(
            "Pisces does not have a Compose file for this stack, so Compose cannot run the whole stack. Restart the containers instead.",
        ));
    }
    let dir = lock(state)
        .create_stack_dir(&endpoint.id, project)
        .map_err(ApiError::daemon)?;
    let compose_file = dir.join("compose.yaml");
    match action {
        "start" => stacks::start(project, &dir, &compose_file).await,
        "stop" => stacks::stop(project, &dir, &compose_file).await,
        "restart" => stacks::restart(project, &dir, &compose_file, repull).await,
        _ => Err(ApiError::validation("Unknown stack action.")),
    }
}

async fn stack_start(
    State(state): State<AppState>,
    Path((id, project)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    let endpoint = require_docker(&state, &id)?;
    same_origin_guard(&headers)?;
    stack_compose_lifecycle(&state, &endpoint, &project, "start", false).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn stack_stop(
    State(state): State<AppState>,
    Path((id, project)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    let endpoint = require_docker(&state, &id)?;
    same_origin_guard(&headers)?;
    stack_compose_lifecycle(&state, &endpoint, &project, "stop", false).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn stack_restart(
    State(state): State<AppState>,
    Path((id, project)): Path<(String, String)>,
    headers: HeaderMap,
    body: Result<Json<StackRepullBody>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    let endpoint = require_docker(&state, &id)?;
    same_origin_guard(&headers)?;
    let repull = body.map(|Json(body)| body.repull).unwrap_or(false);
    stack_compose_lifecycle(&state, &endpoint, &project, "restart", repull).await?;
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
            let env_file = stack_env_for_apply(&dir);
            stacks::down(
                &project,
                &dir,
                &dir.join("compose.yaml"),
                env_file.as_deref(),
            )
            .await?;
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

/// The agent never receives environment values, label values or mount sources,
/// whatever state it holds: Operate adds proposals, not a view of secrets.
fn redact_detail_for_agent(principal: &Principal, detail: &mut docker::ContainerDetail) {
    if principal.is_agent() {
        access::redact_detail(detail);
    }
}

fn redact_config_for_agent(principal: &Principal, config: &mut docker::ContainerConfigOut) {
    if principal.is_agent() {
        access::redact_config(config);
    }
}

/// A volume mountpoint is a host filesystem path, so the agent does not see it.
fn redact_volumes_for_agent(principal: &Principal, items: &mut [docker::VolumeOut]) {
    if principal.is_agent() {
        for item in items {
            item.mountpoint.clear();
        }
    }
}

async fn container_detail(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((id, container_id)): Path<(String, String)>,
) -> Result<Json<docker::ContainerDetail>, ApiError> {
    let endpoint = require_docker(&state, &id)?;
    let container_id = docker::object_ref(&container_id)?;
    let mut detail = docker::inspect_container(container_id).await?;
    if principal.is_agent() {
        let value = container_access(&state, &endpoint.id, container_id).await?;
        require_access_read(&value)?;
    }
    redact_detail_for_agent(&principal, &mut detail);
    Ok(Json(detail))
}

async fn container_logs(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((id, container_id)): Path<(String, String)>,
    Query(query): Query<ListQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let endpoint = require_docker(&state, &id)?;
    let container_id = docker::object_ref(&container_id)?;
    if principal.is_agent() {
        let value = container_access(&state, &endpoint.id, container_id).await?;
        require_access_read(&value)?;
    }
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
    Extension(principal): Extension<Principal>,
    Path((id, container_id)): Path<(String, String)>,
    Query(query): Query<ListQuery>,
) -> Result<Response, ApiError> {
    let endpoint = require_docker(&state, &id)?;
    let container_id = docker::object_ref(&container_id)?;
    if principal.is_agent() {
        let value = container_access(&state, &endpoint.id, container_id).await?;
        require_access_read(&value)?;
    }
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
    Extension(principal): Extension<Principal>,
    Path((id, container_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    action_route(&state, &principal, &id, &container_id, "start", &headers).await
}

async fn stop_container(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((id, container_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    action_route(&state, &principal, &id, &container_id, "stop", &headers).await
}

async fn restart_container(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((id, container_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    action_route(&state, &principal, &id, &container_id, "restart", &headers).await
}

/// One path for a browser and for the agent. The agent never acts directly: an
/// allowed action becomes a pending proposal, a refused one is a 403 right away.
async fn action_route(
    state: &AppState,
    principal: &Principal,
    endpoint_id: &str,
    container_id: &str,
    action: &str,
    headers: &HeaderMap,
) -> Result<Response, ApiError> {
    let endpoint = require_docker(state, endpoint_id)?;
    let container_id = docker::object_ref(container_id)?.to_string();
    if principal.is_agent() {
        let live = docker::live_access(&container_id).await?;
        let value = access_for(state, &endpoint.id, &container_id, &live).await;
        require_access_operate(&value)?;
        return propose(
            state,
            principal,
            access::ProposalRequest {
                action: action.to_string(),
                endpoint_id: endpoint.id,
                container_id: Some(container_id),
                container_name: Some(live.name),
                project: None,
                payload: serde_json::json!({ "action": action }),
            },
        )
        .await;
    }
    same_origin_guard(headers)?;
    act(state, &endpoint.id, &container_id, action).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn delete_container(
    State(state): State<AppState>,
    Path((id, container_id)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    let endpoint = require_docker(&state, &id)?;
    let container_id = docker::object_ref(&container_id)?.to_string();
    let live = docker::live_access(&container_id).await.ok();
    act(&state, &endpoint.id, &container_id, "remove").await?;
    access::forget_policy(
        &state.data_dir,
        &endpoint.id,
        &container_id,
        live.as_ref().map(|value| value.name.as_str()).unwrap_or(""),
    );
    Ok(StatusCode::NO_CONTENT)
}

async fn create_container(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Result<Json<RunBody>, JsonRejection>,
) -> Result<Response, ApiError> {
    let body = take_json(body)?;
    let endpoint = require_docker(&state, &id)?;
    if principal.is_agent() {
        return propose(
            &state,
            &principal,
            access::ProposalRequest {
                action: "run".into(),
                endpoint_id: endpoint.id,
                container_id: None,
                container_name: body.name.clone(),
                project: None,
                payload: serde_json::to_value(&body).unwrap_or_default(),
            },
        )
        .await;
    }
    same_origin_guard(&headers)?;
    let created = apply_run(&state, body).await?;
    Ok((StatusCode::CREATED, Json(created)).into_response())
}

async fn apply_run(state: &AppState, body: RunBody) -> Result<docker::CreatedContainer, ApiError> {
    let _ = state;
    if let Some(name) = body.name.as_deref().filter(|name| !name.trim().is_empty()) {
        docker::object_ref(name)?;
    }
    docker::run_container(docker::RunRequest {
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
    .await
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
    Extension(principal): Extension<Principal>,
    Path((id, container_id)): Path<(String, String)>,
) -> Result<Json<docker::ContainerConfigOut>, ApiError> {
    let endpoint = require_docker(&state, &id)?;
    let container_id = docker::object_ref(&container_id)?;
    let mut config = docker::container_config(container_id).await?;
    if principal.is_agent() {
        let value = container_access(&state, &endpoint.id, container_id).await?;
        require_access_read(&value)?;
    }
    redact_config_for_agent(&principal, &mut config);
    Ok(Json(config))
}

async fn update_container_settings(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((id, container_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Result<Json<ContainerSettingsBody>, JsonRejection>,
) -> Result<Response, ApiError> {
    let body = take_json(body)?;
    let endpoint = require_docker(&state, &id)?;
    let container_id = docker::object_ref(&container_id)?.to_string();
    if principal.is_agent() {
        let live = docker::live_access(&container_id).await?;
        let value = access_for(&state, &endpoint.id, &container_id, &live).await;
        require_access_operate(&value)?;
        return propose(
            &state,
            &principal,
            access::ProposalRequest {
                action: "settings".into(),
                endpoint_id: endpoint.id,
                container_id: Some(container_id),
                container_name: Some(live.name),
                project: None,
                payload: serde_json::to_value(&body).unwrap_or_default(),
            },
        )
        .await;
    }
    same_origin_guard(&headers)?;
    let live = docker::live_access(&container_id).await?;
    apply_settings(&state, &endpoint.id, &container_id, &live.name, body).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn apply_settings(
    state: &AppState,
    endpoint_id: &str,
    container_id: &str,
    old_name: &str,
    body: ContainerSettingsBody,
) -> Result<(), ApiError> {
    docker::update_container_settings(
        container_id,
        Some(&body.name),
        Some(&body.restart_policy),
        body.restart_maximum_retry_count,
    )
    .await?;
    access::rename_policy(
        &state.data_dir,
        endpoint_id,
        container_id,
        old_name,
        &body.name,
    );
    Ok(())
}

async fn duplicate_container(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((id, container_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Result<Json<DuplicateBody>, JsonRejection>,
) -> Result<Response, ApiError> {
    let body = take_json(body)?;
    let endpoint = require_docker(&state, &id)?;
    let source = docker::object_ref(&container_id)?.to_string();
    if principal.is_agent() {
        reject_agent_duplicate_values(&body)?;
        let live = docker::live_access(&source).await?;
        let value = access_for(&state, &endpoint.id, &source, &live).await;
        require_access_operate(&value)?;
        let reachable = reachable_map(&state, &endpoint.id).await;
        // Confirm copies the source container's live values, so those are what
        // the refusal set has to be checked against here as well.
        let source_config = docker::container_config(&source).await?;
        let mutation = access::Mutation::from_edits(
            &source_config.env,
            &source_config.labels,
            &source_config.mounts,
        );
        refusal_for(&state, &mutation, &reachable)?;
        let body = DuplicateBody {
            env: None,
            labels: None,
            mounts: None,
            ..body
        };
        return propose(
            &state,
            &principal,
            access::ProposalRequest {
                action: "duplicate".into(),
                endpoint_id: endpoint.id,
                container_id: Some(source),
                container_name: Some(live.name),
                project: None,
                payload: serde_json::to_value(&body).unwrap_or_default(),
            },
        )
        .await;
    }
    same_origin_guard(&headers)?;
    let live = docker::live_access(&source).await.ok();
    let created = apply_duplicate(&state, &source, body).await?;
    if let Some(live) = live {
        let _ = access::copy_policy(
            &state.data_dir,
            &endpoint.id,
            &live,
            &source,
            &created.id,
            &created.name,
        );
        if live.name.eq_ignore_ascii_case(&created.name) {
            access::forget_policy(&state.data_dir, &endpoint.id, &source, &live.name);
        }
    }
    Ok((StatusCode::CREATED, Json(created)).into_response())
}

fn reject_agent_duplicate_values(body: &DuplicateBody) -> Result<(), ApiError> {
    if body.env.is_some() || body.labels.is_some() || body.mounts.is_some() {
        return Err(ApiError::conflict(
            "A duplicate copies the source container's environment, labels, and mounts. Remove those fields from the request.",
        ));
    }
    Ok(())
}

async fn apply_duplicate(
    state: &AppState,
    source: &str,
    body: DuplicateBody,
) -> Result<docker::CreatedContainer, ApiError> {
    let _ = state;
    let name = docker::checked_container_name(&body.name)?;
    let edits = docker::ContainerEdits {
        image: body.image.clone(),
        command: body.command.clone(),
        entrypoint: body.entrypoint.clone(),
        env: body.env.clone(),
        labels: body.labels.clone(),
        ports: body.ports.clone(),
        mounts: body.mounts.clone(),
        restart: body.restart_policy.clone(),
    };
    if body.repull {
        let image = docker::image_for_edits(source, &edits).await?;
        docker::pull_image(&image).await?;
    }
    // Keeping the original name is Portainer's "Duplicate/Edit" replace path.
    docker::duplicate_or_replace(source, &name, &edits)
        .await
        .map_err(safe_container_edit_error)
}

async fn recreate_container(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((id, container_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let endpoint = require_docker(&state, &id)?;
    let source = docker::object_ref(&container_id)?.to_string();
    if principal.is_agent() {
        let live = docker::live_access(&source).await?;
        let value = access_for(&state, &endpoint.id, &source, &live).await;
        require_access_operate(&value)?;
        return propose(
            &state,
            &principal,
            access::ProposalRequest {
                action: "recreate".into(),
                endpoint_id: endpoint.id,
                container_id: Some(source),
                container_name: Some(live.name),
                project: None,
                payload: serde_json::json!({ "action": "recreate" }),
            },
        )
        .await;
    }
    same_origin_guard(&headers)?;
    let live = docker::live_access(&source).await.ok();
    let created = docker::recreate_container(&source, None).await?;
    if let Some(live) = live {
        let _ = access::copy_policy(
            &state.data_dir,
            &endpoint.id,
            &live,
            &source,
            &created.id,
            &created.name,
        );
        access::forget_policy(&state.data_dir, &endpoint.id, &source, &live.name);
    }
    Ok(Json(created).into_response())
}

async fn list_volumes(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Query(query): Query<ListQuery>,
) -> Result<Json<ListPage<docker::VolumeOut>>, ApiError> {
    require_docker(&state, &id)?;
    let mut items = docker::list_volumes(query.q.as_deref().unwrap_or("")).await?;
    redact_volumes_for_agent(&principal, &mut items);
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
    fn credential_ttl_is_rejected_instead_of_clamped() {
        let defaults = issue_params_from_body(b"").unwrap();
        assert_eq!(defaults.ttl_secs, access::AGENT_CRED_SECS);
        assert_eq!(defaults.idle_secs, access::DEFAULT_IDLE_SECS);
        let spaced = issue_params_from_body(b" \n").unwrap();
        assert_eq!(spaced.ttl_secs, access::TTL_8H);
        let chosen = issue_params_from_body(br#"{"ttlSecs":604800,"idleSecs":0}"#).unwrap();
        assert_eq!(chosen.ttl_secs, access::TTL_7D);
        assert_eq!(chosen.idle_secs, 0);
        let day = issue_params_from_body(br#"{"idleSecs":86400}"#).unwrap();
        assert_eq!(day.ttl_secs, access::TTL_8H);
        assert_eq!(day.idle_secs, 86_400);

        for body in [
            r#"{"ttlSecs":2592001}"#,
            r#"{"ttlSecs":1}"#,
            r#"{"ttlSecs":28800.5}"#,
            r#"{"ttlSecs":"8h"}"#,
            r#"{"ttlSecs":-1}"#,
            r#"{"ttl":28800}"#,
            r#"{"idleSecs":2592001}"#,
            r#"{"ttlSecs":604800,"idleSecs":2592001}"#,
        ] {
            let error = issue_params_from_body(body.as_bytes())
                .expect_err("oversized or unknown durations are rejected");
            assert_eq!(error.status, StatusCode::BAD_REQUEST);
            assert!(!error.message.contains(access::AGENT_PREFIX));
        }
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
                data_dir: dir.clone(),
            },
            dir,
        )
    }

    fn same_origin_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_static("localhost:3000"));
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://localhost:3000"),
        );
        headers
    }

    #[tokio::test]
    async fn create_stack_route_rejects_invalid_project_before_docker_access() {
        let (state, dir) = stack_test_state();
        let result = create_stack(
            State(state.clone()),
            Extension(Principal::Browser {
                username: "operator".to_string(),
            }),
            Path("endpoint-1".to_string()),
            same_origin_headers(),
            Ok(Json(StackBody {
                project: "../unsafe".to_string(),
                compose: "services:\n  web:\n    image: nginx\n".to_string(),
                env: None,
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
            Extension(Principal::Browser {
                username: "operator".to_string(),
            }),
            Path(("endpoint-1".to_string(), "sample".to_string())),
            same_origin_headers(),
            Ok(Json(StackBody {
                project: "different".to_string(),
                compose: "services:\n  web:\n    image: nginx\n".to_string(),
                env: None,
            })),
        )
        .await;
        let error = result.unwrap_err();
        assert_eq!(error.code, "validation");
        assert_eq!(error.message, "The stack name cannot be changed.");
        let _ = std::fs::remove_dir_all(dir);
    }

    fn agent() -> Principal {
        Principal::Agent {
            credential_id: "agt_test".to_string(),
        }
    }

    fn browser() -> Principal {
        Principal::Browser {
            username: "operator".to_string(),
        }
    }

    fn policy_entry(
        id: &str,
        name: &str,
        state: access::State,
        updated_at: u64,
    ) -> access::PolicyEntry {
        access::PolicyEntry {
            container_id: id.to_string(),
            endpoint_id: "endpoint-1".to_string(),
            container_name: name.to_string(),
            state,
            updated_at,
            updated_by: "operator".to_string(),
        }
    }

    fn detail_with_secrets() -> docker::ContainerDetail {
        docker::ContainerDetail {
            id: "c1".into(),
            name: "web".into(),
            image: "nginx".into(),
            image_id: "sha256:1".into(),
            state: "running".into(),
            status_text: "Up".into(),
            created: String::new(),
            started: None,
            command: String::new(),
            entrypoint: String::new(),
            restart_policy: String::new(),
            restart_maximum_retry_count: None,
            ports: Vec::new(),
            mounts: vec![docker::MountOut {
                source: "/srv/secret".into(),
                destination: "/data".into(),
                mode: "rw".into(),
            }],
            networks: Vec::new(),
            env: vec![docker::EnvOut {
                key: "PISCES_PASSWORD".into(),
                value: "hunter2".into(),
            }],
            labels: vec![docker::LabelOut {
                key: "owner".into(),
                value: "secret-label".into(),
            }],
        }
    }

    #[test]
    fn agent_detail_and_config_are_redacted_even_at_operate() {
        let mut detail = detail_with_secrets();
        redact_detail_for_agent(&agent(), &mut detail);
        assert!(detail.env.is_empty());
        assert!(detail.labels.is_empty());
        assert_eq!(detail.mounts[0].source, "");
        assert_eq!(detail.mounts[0].destination, "/data");

        let mut config = docker::ContainerConfigOut {
            name: "web".into(),
            image: "nginx".into(),
            command: Vec::new(),
            entrypoint: Vec::new(),
            env: vec![docker::EnvOut {
                key: "PISCES_PASSWORD".into(),
                value: "hunter2".into(),
            }],
            labels: vec![docker::LabelOut {
                key: "owner".into(),
                value: "secret-label".into(),
            }],
            ports: Vec::new(),
            restart_policy: "no".into(),
            networks: Vec::new(),
            mounts: vec![docker::MountEdit {
                source: "/srv/secret".into(),
                destination: "/data".into(),
                mount_type: "bind".into(),
                read_only: false,
            }],
        };
        redact_config_for_agent(&agent(), &mut config);
        assert!(config.env.is_empty());
        assert!(config.labels.is_empty());
        assert!(config.mounts.is_empty());

        // The operator keeps the full view.
        let mut detail = detail_with_secrets();
        redact_detail_for_agent(&browser(), &mut detail);
        assert_eq!(detail.env[0].value, "hunter2");
        assert_eq!(detail.labels[0].value, "secret-label");
        assert_eq!(detail.mounts[0].source, "/srv/secret");
    }

    #[test]
    fn agent_duplicate_must_not_carry_values_it_would_not_use() {
        let bare = DuplicateBody {
            name: "web-copy".into(),
            image: None,
            command: None,
            entrypoint: None,
            env: None,
            labels: None,
            ports: None,
            mounts: None,
            restart_policy: None,
        };
        assert!(reject_agent_duplicate_values(&bare).is_ok());
        for body in [
            DuplicateBody {
                env: Some(vec![docker::EnvOut {
                    key: "MODE".into(),
                    value: "prod".into(),
                }]),
                ..bare.clone()
            },
            DuplicateBody {
                labels: Some(vec![docker::LabelOut {
                    key: "owner".into(),
                    value: "me".into(),
                }]),
                ..bare.clone()
            },
            DuplicateBody {
                mounts: Some(vec![docker::MountEdit {
                    source: "/srv/data".into(),
                    destination: "/data".into(),
                    mount_type: "bind".into(),
                    read_only: false,
                }]),
                ..bare.clone()
            },
        ] {
            let error = reject_agent_duplicate_values(&body).unwrap_err();
            assert_eq!(error.status, StatusCode::CONFLICT);
        }
    }

    #[test]
    fn agent_volume_listings_hide_host_mountpoints() {
        let volume = || docker::VolumeOut {
            name: "data".into(),
            driver: "local".into(),
            mountpoint: "/var/lib/docker/volumes/data/_data".into(),
            created: String::new(),
        };
        let mut items = vec![volume()];
        redact_volumes_for_agent(&agent(), &mut items);
        assert_eq!(items[0].mountpoint, "");
        let mut items = vec![volume()];
        redact_volumes_for_agent(&browser(), &mut items);
        assert_eq!(items[0].mountpoint, "/var/lib/docker/volumes/data/_data");
    }

    /// QA repro A through the handler gate: the policy file an older build left
    /// behind holds a stale Operate under a short id and a newer Locked under the
    /// full id. The agent's read and its action both refuse.
    #[tokio::test]
    async fn a_stale_grant_for_a_duplicate_id_form_does_not_open_a_locked_container() {
        let (state, dir) = stack_test_state();
        let full = "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0";
        let entries = vec![
            policy_entry(&full[..12], "web", access::State::Operate, 10),
            policy_entry(full, "web", access::State::Locked, 20),
        ];
        std::fs::write(
            dir.join("ai_policy.json"),
            serde_json::to_string(&entries).unwrap(),
        )
        .unwrap();
        let live = access::LiveAccess {
            name: "web".into(),
            id: full.into(),
            ..Default::default()
        };
        let value = access_for(&state, "endpoint-1", &full[..12], &live).await;
        assert_eq!(value.state, access::State::Locked);
        assert_eq!(
            require_access_read(&value).unwrap_err().status,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            require_access_operate(&value).unwrap_err().status,
            StatusCode::FORBIDDEN
        );
        drop(state);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// QA repro B through the handler gate: the container was removed and
    /// recreated outside Pisces, so its name is back with a new id. The grant
    /// the operator set on the old id must not follow the name.
    #[tokio::test]
    async fn a_recreated_container_with_a_reused_name_starts_locked() {
        let (state, dir) = stack_test_state();
        access::remember_policy(
            &dir,
            policy_entry("aaa111", "web", access::State::Operate, 10),
        )
        .unwrap();
        let live = access::LiveAccess {
            name: "web".into(),
            id: "bbb222".into(),
            ..Default::default()
        };
        let value = access_for(&state, "endpoint-1", "bbb222", &live).await;
        assert_eq!(value.state, access::State::Locked);
        assert_eq!(
            require_access_read(&value).unwrap_err().status,
            StatusCode::FORBIDDEN
        );
        drop(state);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A forced lock still wins over a stored grant.
    #[tokio::test]
    async fn a_forced_lock_still_beats_a_stored_operate_grant() {
        let (state, dir) = stack_test_state();
        access::remember_policy(&dir, policy_entry("c1", "web", access::State::Operate, 10))
            .unwrap();
        let live = access::LiveAccess {
            name: "web".into(),
            id: "c1".into(),
            mount_sources: vec!["/var/run/docker.sock".into()],
            ..Default::default()
        };
        let value = access_for(&state, "endpoint-1", "c1", &live).await;
        assert_eq!(value.state, access::State::Locked);
        assert!(value.forced);
        assert_eq!(
            require_access_operate(&value).unwrap_err().status,
            StatusCode::FORBIDDEN
        );
        drop(state);
        let _ = std::fs::remove_dir_all(dir);
    }
}
