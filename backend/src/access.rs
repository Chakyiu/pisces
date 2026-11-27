//! AI access control: the agent credential, the per-container policy, the live
//! forced locks, the refusal set, and the confirmation queue.
//!
//! Everything here fails closed: a missing or unreadable record means "no
//! credential" or "Locked", never a default grant.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::docker::{ContainerConfigOut, ContainerDetail, EnvOut, LabelOut, MountEdit};
use crate::store::replace_file;

pub const AGENT_PREFIX: &str = "pisces_agent_";
/// Absolute lifetimes an operator can choose at issue time. Anything else is rejected.
pub const TTL_8H: u64 = 8 * 60 * 60;
pub const TTL_24H: u64 = 24 * 60 * 60;
pub const TTL_7D: u64 = 7 * 24 * 60 * 60;
pub const TTL_30D: u64 = 30 * 24 * 60 * 60;
/// Default absolute lifetime. The historical name of the 8-hour step.
pub const AGENT_CRED_SECS: u64 = TTL_8H;
/// Default idle window. `0` disables idle expiry.
pub const DEFAULT_IDLE_SECS: u64 = TTL_7D;
/// `last_used_at` is not rewritten on every authenticated request.
pub const LAST_USED_THROTTLE_SECS: u64 = 60;
pub const TTL_REJECTED: &str = "TTL must be one of 28800 (8h), 86400 (24h), 604800 (7d), or 2592000 (30d). Other durations are rejected.";
pub const IDLE_REJECTED: &str = "Idle expiry must be 0 (disabled) or at most 2592000 seconds (30 days). Longer values are rejected.";
pub const AGENT_ROUTE_DENY: &str = "The agent credential may not use this route.";
pub const LONG_TTL_PROPOSAL_DENY: &str = "This credential's lifetime is longer than 24 hours, so it is limited to Read access and cannot create proposals.";
pub const PROPOSAL_SECS: u64 = 60 * 60;
/// How long a decided or expired proposal stays readable before it is dropped.
pub const PROPOSAL_GRACE_SECS: u64 = 24 * 60 * 60;
/// Hard cap on stored proposals; the newest are kept.
pub const PROPOSAL_KEEP: usize = 200;

const CREDENTIAL_FILE: &str = "agent_credential.json";
const POLICY_FILE: &str = "ai_policy.json";
const PROPOSAL_FILE: &str = "ai_proposals.json";

const CREDENTIAL_MSG: &str = "The agent credential record could not be saved.";
const POLICY_MSG: &str = "The AI access policy could not be saved.";
const PROPOSAL_MSG: &str = "The proposal list could not be saved.";
const PROPOSAL_READ_MSG: &str = "The proposal list could not be read.";
const PROPOSAL_RECOVERY_MSG: &str =
    "The confirmation was interrupted before it finished. Check the target's state before proposing again.";

/// One writer at a time for the proposal file: every decision is a
/// read-modify-write, so two concurrent confirms of one row would otherwise both
/// see it pending and both execute.
static PROPOSAL_LOCK: Mutex<()> = Mutex::new(());

fn proposal_guard() -> MutexGuard<'static, ()> {
    PROPOSAL_LOCK
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
}

/// Who is making this request. The middleware is the only producer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Principal {
    Browser { username: String },
    Agent { credential_id: String },
}

impl Principal {
    pub fn is_browser(&self) -> bool {
        matches!(self, Principal::Browser { .. })
    }

    pub fn is_agent(&self) -> bool {
        matches!(self, Principal::Agent { .. })
    }
}

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn write_atomic(path: &Path, text: &str, message: &'static str) -> Result<(), String> {
    let tmp = temp_path(path);
    fs::write(&tmp, text).map_err(|_| message.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    replace_file(&tmp, path).map_err(|_| message.to_string())
}

/// A temp name no other write can pick. The old fixed `json.tmp` name let two
/// saves of the same file overwrite each other's staging file before the rename.
fn temp_path(path: &Path) -> PathBuf {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "store".to_string());
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    path.with_file_name(format!(
        ".{name}.{}.{seq}.{nanos:x}.tmp",
        std::process::id()
    ))
}

/// Names of the temp files `temp_path` can leave behind if a write is killed.
fn temp_prefix(path: &Path) -> String {
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "store".to_string());
    format!(".{name}.")
}

// --- Credential ---------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialRecord {
    pub id: String,
    pub verifier: String,
    pub issued_at: u64,
    pub expires_at: u64,
    #[serde(default)]
    pub revoked_at: Option<u64>,
    #[serde(default)]
    pub last_used_at: Option<u64>,
    /// Chosen absolute lifetime. Absent on a record written before custom TTL:
    /// the stored `expires_at` stays the lifetime, and nothing rewrites it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl_secs: Option<u64>,
    /// Idle window. `Some(0)` and `None` both mean disabled. `None` is a record
    /// from before idle expiry existed, so loading it must not add a deadline.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idle_secs: Option<u64>,
    pub issued_by: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AccessTier {
    Read,
    Operate,
}

impl AccessTier {
    pub fn as_str(self) -> &'static str {
        match self {
            AccessTier::Read => "read",
            AccessTier::Operate => "operate",
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialView {
    pub id: String,
    pub issued_at: u64,
    pub expires_at: u64,
    pub revoked_at: Option<u64>,
    pub last_used_at: Option<u64>,
    pub ttl_secs: u64,
    pub idle_secs: u64,
    pub idle_deadline: Option<u64>,
    pub access_tier: AccessTier,
    pub state: &'static str,
}

pub struct IssuedCredential {
    pub view: CredentialView,
    pub secret: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum CredentialError {
    Rejected,
    Revoked,
    Expired,
    Idle,
}

#[derive(Clone, Copy, Debug)]
pub struct IssueParams {
    pub ttl_secs: u64,
    pub idle_secs: u64,
}

impl Default for IssueParams {
    fn default() -> Self {
        Self {
            ttl_secs: AGENT_CRED_SECS,
            idle_secs: DEFAULT_IDLE_SECS,
        }
    }
}

#[derive(Debug)]
pub enum IssueError {
    Invalid(&'static str),
    Store(&'static str),
}

/// One writer at a time for the credential file. A last-use update must not
/// replace a revoke or a newly issued record.
static CREDENTIAL_LOCK: Mutex<()> = Mutex::new(());

fn credential_guard() -> MutexGuard<'static, ()> {
    CREDENTIAL_LOCK
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
}

fn credential_path(dir: &Path) -> PathBuf {
    dir.join(CREDENTIAL_FILE)
}

pub fn load_credential(dir: &Path) -> Option<CredentialRecord> {
    let text = fs::read_to_string(credential_path(dir)).ok()?;
    let record: CredentialRecord = serde_json::from_str(&text).ok()?;
    if record.verifier.is_empty()
        || record.id.is_empty()
        || record.issued_at == 0
        || record.expires_at == 0
    {
        return None;
    }
    Some(record)
}

fn empty_credential_view() -> CredentialView {
    CredentialView {
        id: String::new(),
        issued_at: 0,
        expires_at: 0,
        revoked_at: None,
        last_used_at: None,
        ttl_secs: 0,
        idle_secs: 0,
        idle_deadline: None,
        access_tier: AccessTier::Read,
        state: "none",
    }
}

pub fn credential_lifetime_secs(record: &CredentialRecord) -> u64 {
    let window = record.expires_at.saturating_sub(record.issued_at);
    record.ttl_secs.map(|ttl| ttl.max(window)).unwrap_or(window)
}

pub fn access_tier(record: &CredentialRecord) -> AccessTier {
    if credential_lifetime_secs(record) > TTL_24H {
        AccessTier::Read
    } else {
        AccessTier::Operate
    }
}

pub fn credential_may_operate(record: &CredentialRecord) -> bool {
    access_tier(record) == AccessTier::Operate
}

/// `None` when idle expiry is disabled. Otherwise the deadline counted from the
/// last successful use, or from issue time when the credential has never been used.
pub fn idle_deadline(record: &CredentialRecord) -> Option<u64> {
    let idle = record.idle_secs.unwrap_or(0);
    if idle == 0 {
        return None;
    }
    let start = record.last_used_at.unwrap_or(record.issued_at);
    Some(start.saturating_add(idle))
}

fn credential_state(record: &CredentialRecord, now: u64) -> &'static str {
    if record.revoked_at.is_some() {
        "revoked"
    } else if record.expires_at <= now {
        "expired"
    } else if idle_deadline(record).is_some_and(|deadline| deadline <= now) {
        "idle"
    } else {
        "active"
    }
}

fn view_from(record: CredentialRecord, now: u64) -> CredentialView {
    CredentialView {
        state: credential_state(&record, now),
        ttl_secs: credential_lifetime_secs(&record),
        idle_secs: record.idle_secs.unwrap_or(0),
        idle_deadline: idle_deadline(&record),
        access_tier: access_tier(&record),
        id: record.id,
        issued_at: record.issued_at,
        expires_at: record.expires_at,
        revoked_at: record.revoked_at,
        last_used_at: record.last_used_at,
    }
}

pub fn credential_view(dir: &Path, now: u64) -> CredentialView {
    match load_credential(dir) {
        None => empty_credential_view(),
        Some(record) => view_from(record, now),
    }
}

pub fn validate_ttl_secs(ttl: u64) -> Result<u64, &'static str> {
    if matches!(ttl, TTL_8H | TTL_24H | TTL_7D | TTL_30D) {
        Ok(ttl)
    } else {
        Err(TTL_REJECTED)
    }
}

pub fn validate_idle_secs(idle: u64) -> Result<u64, &'static str> {
    if idle <= TTL_30D {
        Ok(idle)
    } else {
        Err(IDLE_REJECTED)
    }
}

fn base64url(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity((bytes.len() * 4).div_ceil(3));
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(triple >> 18) as usize & 63] as char);
        out.push(TABLE[(triple >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(TABLE[(triple >> 6) as usize & 63] as char);
        }
        if chunk.len() > 2 {
            out.push(TABLE[triple as usize & 63] as char);
        }
    }
    out
}

pub fn verifier_for(secret: &str) -> String {
    let digest = Sha256::digest(secret.as_bytes());
    let mut hex = String::with_capacity(7 + 64);
    hex.push_str("sha256:");
    for byte in digest.iter() {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

fn constant_time_equal(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn verifier_bytes(verifier: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    let Some(hex) = verifier.strip_prefix("sha256:") else {
        return out;
    };
    if hex.len() != 64 {
        return out;
    }
    for (index, pair) in hex.as_bytes().chunks(2).enumerate() {
        let text = std::str::from_utf8(pair).unwrap_or("");
        let Ok(byte) = u8::from_str_radix(text, 16) else {
            return [0u8; 32];
        };
        out[index] = byte;
    }
    out
}

/// Issue a new credential. Any previous record is replaced in the same atomic
/// write, so two valid credentials never exist at once. A duration that is not
/// one of the allowed steps is rejected here; it is not shortened to the ceiling.
pub fn issue_credential(
    dir: &Path,
    issued_by: &str,
    now: u64,
    params: IssueParams,
) -> Result<IssuedCredential, IssueError> {
    let _guard = credential_guard();
    let ttl_secs = validate_ttl_secs(params.ttl_secs).map_err(IssueError::Invalid)?;
    let idle_secs = validate_idle_secs(params.idle_secs).map_err(IssueError::Invalid)?;
    let expires_at = now
        .checked_add(ttl_secs)
        .ok_or(IssueError::Invalid(TTL_REJECTED))?;
    let mut raw = [0u8; 32];
    getrandom::fill(&mut raw)
        .map_err(|_| IssueError::Store("The agent credential could not be generated."))?;
    let secret = format!("{AGENT_PREFIX}{}", base64url(&raw));
    let record = CredentialRecord {
        id: format!("agt_{}", crate::store::new_id()),
        verifier: verifier_for(&secret),
        issued_at: now,
        expires_at,
        revoked_at: None,
        last_used_at: None,
        ttl_secs: Some(ttl_secs),
        idle_secs: Some(idle_secs),
        issued_by: issued_by.to_string(),
    };
    let text =
        serde_json::to_string_pretty(&record).map_err(|_| IssueError::Store(CREDENTIAL_MSG))?;
    write_atomic(&credential_path(dir), &text, CREDENTIAL_MSG)
        .map_err(|_| IssueError::Store(CREDENTIAL_MSG))?;
    let view = credential_view(dir, now);
    Ok(IssuedCredential { view, secret })
}

pub fn revoke_credential(dir: &Path, now: u64) -> Result<bool, String> {
    let _guard = credential_guard();
    let Some(mut record) = load_credential(dir) else {
        return Ok(false);
    };
    if record.revoked_at.is_some() {
        return Ok(true);
    }
    record.revoked_at = Some(now);
    let text = serde_json::to_string_pretty(&record).map_err(|_| CREDENTIAL_MSG.to_string())?;
    write_atomic(&credential_path(dir), &text, CREDENTIAL_MSG)?;
    Ok(true)
}

/// Verify a presented secret. The caller has already checked the prefix; the
/// digest comparison is constant time and every rejection before that step also
/// spends the comparison so the response does not leak why it failed.
pub fn verify_credential(dir: &Path, presented: &str) -> Result<CredentialRecord, CredentialError> {
    verify_credential_at(dir, presented, now())
}

fn verify_credential_at(
    dir: &Path,
    presented: &str,
    now: u64,
) -> Result<CredentialRecord, CredentialError> {
    let record = load_credential(dir);
    let presented_digest = Sha256::digest(presented.as_bytes());
    let expected = match &record {
        Some(record) => verifier_bytes(&record.verifier),
        None => [0u8; 32],
    };
    let matches = constant_time_equal(&presented_digest, &expected);
    let Some(record) = record else {
        return Err(CredentialError::Rejected);
    };
    if !matches {
        return Err(CredentialError::Rejected);
    }
    if record.revoked_at.is_some() {
        return Err(CredentialError::Revoked);
    }
    if record.expires_at <= now {
        return Err(CredentialError::Expired);
    }
    if idle_deadline(&record).is_some_and(|deadline| deadline <= now) {
        return Err(CredentialError::Idle);
    }
    Ok(record)
}

/// Best-effort `lastUsedAt`, throttled so a busy agent is not one rewrite per
/// request. The secret is not part of the record and is never written.
pub fn touch_credential(dir: &Path, record: &CredentialRecord) {
    touch_credential_at(dir, record, now());
}

fn touch_credential_at(dir: &Path, record: &CredentialRecord, now: u64) {
    if record
        .last_used_at
        .is_some_and(|last| now.saturating_sub(last) < LAST_USED_THROTTLE_SECS)
    {
        return;
    }
    let _guard = credential_guard();
    let Some(mut updated) = load_credential(dir) else {
        return;
    };
    // The caller's copy can be older than the file. Never resurrect a revoked
    // or replaced credential, and never extend its expiry.
    if updated.id != record.id || updated.revoked_at.is_some() {
        return;
    }
    if updated
        .last_used_at
        .is_some_and(|last| now.saturating_sub(last) < LAST_USED_THROTTLE_SECS)
    {
        return;
    }
    updated.last_used_at = Some(now);
    let Ok(text) = serde_json::to_string_pretty(&updated) else {
        return;
    };
    let _ = write_atomic(&credential_path(dir), &text, CREDENTIAL_MSG);
}

// --- Policy -------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Locked,
    Read,
    Operate,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            State::Locked => "locked",
            State::Read => "read",
            State::Operate => "operate",
        }
    }

    pub fn allows_read(self) -> bool {
        matches!(self, State::Read | State::Operate)
    }

    pub fn allows_operate(self) -> bool {
        matches!(self, State::Operate)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyEntry {
    pub container_id: String,
    pub endpoint_id: String,
    pub container_name: String,
    pub state: State,
    pub updated_at: u64,
    pub updated_by: String,
}

#[derive(Default)]
pub struct PolicyFile {
    pub entries: Vec<PolicyEntry>,
    pub readable: bool,
}

fn policy_path(dir: &Path) -> PathBuf {
    dir.join(POLICY_FILE)
}

/// A missing file is an empty policy (everything Locked). An unreadable or
/// unparsable one is reported as unreadable and still grants nothing.
pub fn load_policy(dir: &Path) -> PolicyFile {
    let path = policy_path(dir);
    if !path.exists() {
        return PolicyFile {
            entries: Vec::new(),
            readable: true,
        };
    }
    match fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<PolicyEntry>>(&text).ok())
    {
        Some(entries) => PolicyFile {
            entries,
            readable: true,
        },
        None => PolicyFile {
            entries: Vec::new(),
            readable: false,
        },
    }
}

/// Docker accepts a unique prefix of a container id, so one container arrives
/// as a short id from a list and as the full id from an inspect. Both forms are
/// the same identity; nothing else is.
fn same_container_id(stored: &str, queried: &str) -> bool {
    if stored.is_empty() || queried.is_empty() {
        return false;
    }
    if stored.eq_ignore_ascii_case(queried) {
        return true;
    }
    let (short, long) = if stored.len() <= queried.len() {
        (stored, queried)
    } else {
        (queried, stored)
    };
    short.len() >= 6
        && short.chars().all(|c| c.is_ascii_hexdigit())
        && long
            .to_ascii_lowercase()
            .starts_with(&short.to_ascii_lowercase())
}

/// A stored entry names the container it was written for. An entry that shares
/// only the name belongs to a container that is gone (a Docker name is reused
/// by a remove/recreate outside Pisces), so it is replaced, never kept next to
/// the newer entry. Docker compares container names case-insensitively.
fn same_policy_target(item: &PolicyEntry, entry: &PolicyEntry) -> bool {
    if item.endpoint_id != entry.endpoint_id {
        return false;
    }
    if same_container_id(&item.container_id, &entry.container_id) {
        return true;
    }
    !entry.container_name.is_empty()
        && item
            .container_name
            .eq_ignore_ascii_case(&entry.container_name)
}

pub fn remember_policy(dir: &Path, entry: PolicyEntry) -> Result<(), String> {
    let mut file = load_policy(dir);
    file.entries
        .retain(|item| !same_policy_target(item, &entry));
    file.entries.push(entry);
    save_policy(dir, &file.entries)
}

fn save_policy(dir: &Path, entries: &[PolicyEntry]) -> Result<(), String> {
    let text = serde_json::to_string_pretty(entries).map_err(|_| POLICY_MSG.to_string())?;
    write_atomic(&policy_path(dir), &text, POLICY_MSG)
}

/// Identity, not the display name, decides which entry applies: a container
/// recreated outside Pisces gets a new id, so it starts Locked instead of
/// inheriting the policy of the container whose name it reused. Duplicate
/// entries left by an older build resolve to the newest write, and a tie
/// resolves to the most restrictive state, so the lookup never fails open.
/// No entry means Locked.
pub fn policy_state(file: &PolicyFile, endpoint_id: &str, id: &str) -> State {
    let mut chosen: Option<&PolicyEntry> = None;
    for entry in file.entries.iter().filter(|entry| {
        entry.endpoint_id == endpoint_id && same_container_id(&entry.container_id, id)
    }) {
        chosen = Some(match chosen {
            None => entry,
            Some(current) if entry.updated_at > current.updated_at => entry,
            Some(current)
                if entry.updated_at == current.updated_at
                    && restriction(entry.state) < restriction(current.state) =>
            {
                entry
            }
            Some(current) => current,
        });
    }
    chosen.map(|entry| entry.state).unwrap_or(State::Locked)
}

/// Lower is more restrictive; used only to break a same-second tie.
fn restriction(state: State) -> u8 {
    match state {
        State::Locked => 0,
        State::Read => 1,
        State::Operate => 2,
    }
}

pub fn forget_policy(dir: &Path, endpoint_id: &str, id: &str, name: &str) {
    let mut file = load_policy(dir);
    let before = file.entries.len();
    file.entries.retain(|entry| {
        !(entry.endpoint_id == endpoint_id
            && (same_container_id(&entry.container_id, id)
                || (!name.is_empty() && entry.container_name.eq_ignore_ascii_case(name))))
    });
    if file.entries.len() != before {
        let _ = save_policy(dir, &file.entries);
    }
}

/// Keep a policy entry attached to the container after a rename.
pub fn rename_policy(dir: &Path, endpoint_id: &str, id: &str, old_name: &str, new_name: &str) {
    let mut file = load_policy(dir);
    let mut changed = false;
    for entry in &mut file.entries {
        let matches = entry.endpoint_id == endpoint_id
            && (same_container_id(&entry.container_id, id)
                || (!old_name.is_empty() && entry.container_name.eq_ignore_ascii_case(old_name)));
        if matches && entry.container_name != new_name {
            entry.container_name = new_name.to_string();
            entry.updated_at = now();
            changed = true;
        }
    }
    if changed {
        let _ = save_policy(dir, &file.entries);
    }
}

/// Copy the source state to a duplicate's new id before the new container is
/// returned. A failed copy leaves the new container Locked (no entry) and the
/// caller reports the failure.
pub fn copy_policy(
    dir: &Path,
    endpoint_id: &str,
    source: &LiveAccess,
    source_id: &str,
    target_id: &str,
    target_name: &str,
) -> Result<(), String> {
    let file = load_policy(dir);
    let source_id = source.canonical_id(source_id);
    let state = policy_state(&file, endpoint_id, source_id);
    remember_policy(
        dir,
        PolicyEntry {
            container_id: target_id.to_string(),
            endpoint_id: endpoint_id.to_string(),
            container_name: target_name.to_string(),
            state,
            updated_at: now(),
            updated_by: "pisces".to_string(),
        },
    )
}

// --- Live shape and forced lock ----------------------------------------

/// The facts that decide a forced lock. Built from a live inspect, never from
/// the policy file.
#[derive(Clone, Debug, Default)]
pub struct LiveAccess {
    /// The id the engine reported for this container. Empty when unknown.
    pub id: String,
    pub name: String,
    pub mount_sources: Vec<String>,
    pub volume_names: Vec<String>,
    pub network_mode: Option<String>,
    pub pid_mode: Option<String>,
    pub ipc_mode: Option<String>,
    pub privileged: bool,
    pub devices: usize,
    pub security_opt: Vec<String>,
    pub volumes_from: Vec<String>,
    pub links: Vec<String>,
}

impl LiveAccess {
    /// Policy is keyed on the engine's id, so every read and write of a
    /// container uses one form. The queried form is the fallback for a live
    /// shape built without an inspect.
    pub fn canonical_id<'a>(&'a self, queried: &'a str) -> &'a str {
        if self.id.is_empty() {
            queried
        } else {
            &self.id
        }
    }
}

#[derive(Clone, Debug)]
pub struct ForcedLock {
    pub locked: bool,
    pub reason: String,
    pub mount: Option<String>,
}

impl ForcedLock {
    fn none() -> Self {
        Self {
            locked: false,
            reason: String::new(),
            mount: None,
        }
    }

    fn because(reason: impl Into<String>) -> Self {
        Self {
            locked: true,
            reason: reason.into(),
            mount: None,
        }
    }
}

fn canonical_path(raw: &str) -> String {
    let mut text = raw.trim().replace('\\', "/");
    // Windows canonicalize() returns a verbatim path (`\\?\C:\...`); that
    // prefix carries no meaning for the comparisons made here.
    if let Some(stripped) = text.strip_prefix("//?/") {
        text = stripped.to_string();
    }
    if text.is_empty() {
        return text;
    }
    let prefix = if text.len() >= 2 && text.as_bytes()[1] == b':' {
        let drive = text[..2].to_string();
        text = text[2..].to_string();
        drive
    } else {
        String::new()
    };
    let mut parts: Vec<&str> = Vec::new();
    for part in text.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    let joined = parts.join("/");
    format!("{prefix}/{joined}")
}

fn canonical_dir(dir: &Path) -> String {
    let resolved = fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    canonical_path(&resolved.to_string_lossy())
}

fn under_dir(source: &str, dir: &str) -> bool {
    let source = canonical_path(source);
    let dir = canonical_path(dir);
    if dir.is_empty() || dir == "/" {
        return false;
    }
    let source_lower = source.to_ascii_lowercase();
    let dir_lower = dir.to_ascii_lowercase();
    source_lower == dir_lower
        || source_lower.starts_with(&format!("{}/", dir_lower.trim_end_matches('/')))
}

/// Docker socket or a Windows named pipe.
pub fn is_socket_source(source: &str) -> bool {
    let lower = source.trim().to_ascii_lowercase();
    lower.contains("docker.sock")
        || lower.starts_with("//./pipe")
        || lower.starts_with("\\\\.\\pipe")
        || lower.starts_with("npipe:")
}

fn is_host_root(source: &str) -> bool {
    let text = source.trim();
    text == "/" || text == "\\" || canonical_path(text) == "/" || {
        let bytes = text.as_bytes();
        bytes.len() == 3 && bytes[1] == b':' && (bytes[2] == b'\\' || bytes[2] == b'/')
    }
}

fn is_data_source(source: &str, data_dir: &str) -> bool {
    under_dir(source, data_dir) || under_dir(source, "/data")
}

pub fn forced_lock(data_dir: &Path, live: &LiveAccess) -> ForcedLock {
    let data_dir = canonical_dir(data_dir);
    for source in &live.mount_sources {
        if is_socket_source(source) {
            return ForcedLock {
                locked: true,
                reason: "this container mounts the Docker socket".into(),
                mount: Some(source.clone()),
            };
        }
    }
    for source in &live.mount_sources {
        if is_host_root(source) {
            return ForcedLock {
                locked: true,
                reason: "this container mounts the host root".into(),
                mount: Some(source.clone()),
            };
        }
    }
    for source in &live.mount_sources {
        if is_data_source(source, &data_dir) {
            return ForcedLock {
                locked: true,
                reason: "this container mounts the Pisces data directory".into(),
                mount: Some(source.clone()),
            };
        }
    }
    for volume in &live.volume_names {
        if volume == "pisces-data" {
            return ForcedLock {
                locked: true,
                reason: "this container mounts the Pisces data directory".into(),
                mount: Some(volume.clone()),
            };
        }
    }
    if live.privileged {
        return ForcedLock::because("this container runs privileged");
    }
    if live.pid_mode.as_deref() == Some("host") {
        return ForcedLock::because("this container shares the host PID namespace");
    }
    if live.network_mode.as_deref() == Some("host") {
        return ForcedLock::because("this container shares the host network");
    }
    if live.ipc_mode.as_deref() == Some("host") {
        return ForcedLock::because("this container shares the host IPC namespace");
    }
    if live.devices > 0 {
        return ForcedLock::because("this container has host devices attached");
    }
    let unconfined = live.security_opt.iter().any(|opt| {
        let opt = opt.to_ascii_lowercase().replace(' ', "");
        opt.contains("seccomp=unconfined")
            || opt.contains("apparmor=unconfined")
            || opt == "label=disable"
    });
    if unconfined {
        return ForcedLock::because("this container disables a security profile");
    }
    ForcedLock::none()
}

// --- Refusal set --------------------------------------------------------

#[derive(Clone, Debug, Default)]
pub struct MountRef {
    pub source: String,
    pub mount_type: String,
}

#[derive(Clone, Debug, Default)]
pub struct Mutation {
    pub env_keys: Vec<String>,
    pub label_keys: Vec<String>,
    pub mounts: Vec<MountRef>,
    pub network_mode: Option<String>,
    pub pid_mode: Option<String>,
    pub ipc_mode: Option<String>,
    pub privileged: bool,
    pub devices: usize,
    pub security_opt: Vec<String>,
    pub volumes_from: Vec<String>,
    pub links: Vec<String>,
}

impl Mutation {
    pub fn from_edits(env: &[EnvOut], labels: &[LabelOut], mounts: &[MountEdit]) -> Self {
        Mutation {
            env_keys: env.iter().map(|item| item.key.clone()).collect(),
            label_keys: labels.iter().map(|item| item.key.clone()).collect(),
            mounts: mounts
                .iter()
                .map(|mount| MountRef {
                    source: mount.source.clone(),
                    mount_type: mount.mount_type.clone(),
                })
                .collect(),
            ..Default::default()
        }
    }
}

/// Naive but bounded Compose scan: enough to catch the refusal set without a
/// YAML dependency. Sections are tracked by indentation.
pub fn mutation_from_compose(compose: &str) -> Mutation {
    let mut mutation = Mutation::default();
    let mut section: Option<(&str, usize)> = None;
    let mut long_source = false;
    for line in compose.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        if let Some((name, at)) = section {
            if indent <= at {
                section = None;
            } else {
                match name {
                    "environment" => {
                        if let Some(key) = compose_key(trimmed) {
                            mutation.env_keys.push(key);
                        }
                    }
                    "labels" => {
                        if let Some(key) = compose_key(trimmed) {
                            mutation.label_keys.push(key);
                        }
                    }
                    "volumes" => {
                        if long_source {
                            if let Some(value) = trimmed.strip_prefix("source:") {
                                mutation.mounts.push(MountRef {
                                    source: value.trim().trim_matches('"').to_string(),
                                    mount_type: "bind".into(),
                                });
                                long_source = false;
                            } else if let Some(value) = trimmed.strip_prefix("device:") {
                                mutation.mounts.push(MountRef {
                                    source: value.trim().trim_matches('"').to_string(),
                                    mount_type: "bind".into(),
                                });
                                long_source = false;
                            }
                        } else if let Some(item) = trimmed.strip_prefix("- ") {
                            let item = item.trim().trim_matches('"');
                            if item.contains(':') {
                                let source = item.split(':').next().unwrap_or("");
                                mutation.mounts.push(MountRef {
                                    source: source.trim().to_string(),
                                    mount_type: "bind".into(),
                                });
                            }
                        } else if trimmed == "source:" || trimmed == "device:" {
                            long_source = true;
                        } else if let Some(value) = trimmed.strip_prefix("source:") {
                            mutation.mounts.push(MountRef {
                                source: value.trim().trim_matches('"').to_string(),
                                mount_type: "bind".into(),
                            });
                        }
                    }
                    _ => {}
                }
                continue;
            }
        }
        if let Some(value) = trimmed.strip_prefix("privileged:") {
            mutation.privileged |= value.trim() == "true";
        } else if let Some(value) = trimmed.strip_prefix("network_mode:") {
            mutation.network_mode = Some(value.trim().trim_matches('"').to_string());
        } else if let Some(value) = trimmed.strip_prefix("pid:") {
            mutation.pid_mode = Some(value.trim().trim_matches('"').to_string());
        } else if let Some(value) = trimmed.strip_prefix("ipc:") {
            mutation.ipc_mode = Some(value.trim().trim_matches('"').to_string());
        } else if let Some(value) = trimmed.strip_prefix("- container:") {
            mutation.volumes_from.push(value.trim().to_string());
        } else if trimmed == "environment:" || trimmed == "labels:" || trimmed == "volumes:" {
            let name = trimmed.trim_end_matches(':');
            section = Some((name, indent));
            long_source = false;
        }
    }
    mutation
}

fn compose_key(trimmed: &str) -> Option<String> {
    let item = trimmed.strip_prefix("- ").unwrap_or(trimmed);
    let key = item
        .split_once('=')
        .or_else(|| item.split_once(':'))
        .map(|(key, _)| key)
        .unwrap_or(item)
        .trim()
        .trim_matches('"')
        .to_string();
    if key.is_empty() {
        None
    } else {
        Some(key)
    }
}

/// Returns the first refusal message, or `None` when the mutation is allowed.
pub fn refusal(
    data_dir: &Path,
    mutation: &Mutation,
    reachable: &dyn Fn(&str) -> State,
) -> Option<String> {
    let data_dir = canonical_dir(data_dir);
    for mount in &mutation.mounts {
        let socket = is_socket_source(&mount.source);
        if socket {
            return Some("The agent may not mount the Docker socket.".into());
        }
        if is_host_root(&mount.source) {
            return Some("The agent may not mount the host root.".into());
        }
        if is_data_source(&mount.source, &data_dir) {
            return Some("The agent may not mount the Pisces data directory.".into());
        }
        if mount.mount_type == "volume" && mount.source == "pisces-data" {
            return Some("The agent may not mount the Pisces data directory.".into());
        }
    }
    if let Some(mode) = mutation.network_mode.as_deref() {
        if mode == "host" {
            return Some("The agent may not use host networking.".into());
        }
        if let Some(target) = mode.strip_prefix("container:") {
            if !reachable(target).allows_operate() {
                return Some(
                    "The agent may not share the network namespace of a container it cannot operate."
                        .into(),
                );
            }
        }
    }
    if mutation.pid_mode.as_deref() == Some("host") {
        return Some("The agent may not use the host PID namespace.".into());
    }
    if let Some(mode) = mutation.pid_mode.as_deref() {
        if let Some(target) = mode.strip_prefix("container:") {
            if !reachable(target).allows_operate() {
                return Some(
                    "The agent may not share the PID namespace of a container it cannot operate."
                        .into(),
                );
            }
        }
    }
    if mutation.ipc_mode.as_deref() == Some("host") {
        return Some("The agent may not use the host IPC namespace.".into());
    }
    if mutation.privileged {
        return Some("The agent may not run a privileged container.".into());
    }
    if mutation.devices > 0 {
        return Some("The agent may not pass host devices into a container.".into());
    }
    for opt in &mutation.security_opt {
        let opt = opt.to_ascii_lowercase().replace(' ', "");
        if opt.contains("seccomp=unconfined")
            || opt.contains("apparmor=unconfined")
            || opt == "label=disable"
        {
            return Some("The agent may not disable a container security profile.".into());
        }
    }
    for target in mutation.volumes_from.iter().chain(mutation.links.iter()) {
        if !reachable(target).allows_operate() {
            return Some(
                "The agent may not share volumes or links with a container it cannot operate."
                    .into(),
            );
        }
    }
    for key in &mutation.env_keys {
        if key.starts_with("PISCES_") {
            return Some("The agent may not set Pisces environment values.".into());
        }
    }
    for key in &mutation.label_keys {
        if key.starts_with("pisces.") {
            return Some("The agent may not set Pisces labels.".into());
        }
    }
    None
}

// --- Redaction ----------------------------------------------------------

fn redact_compose_section(lines: &mut [String], start: usize, indent: usize, section: &str) {
    for line in lines.iter_mut().skip(start + 1) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let current_indent = line.len() - line.trim_start().len();
        if current_indent <= indent {
            break;
        }
        let list_item = trimmed.strip_prefix("- ");
        let body = list_item.unwrap_or(trimmed);
        let indent_text = &line[..current_indent];
        let item_prefix = if list_item.is_some() { "- " } else { "" };
        match section {
            "environment" | "labels" => {
                let key = body
                    .split_once('=')
                    .map(|(key, _)| key)
                    .or_else(|| body.split_once(':').map(|(key, _)| key));
                if let Some(key) = key {
                    let key = key.trim_end_matches(':').trim();
                    *line = format!("{indent_text}{item_prefix}{key}:");
                }
            }
            "volumes" => {
                if body == "source:" || body == "device:" {
                    *line = format!("{indent_text}{body} <redacted>");
                } else if let Some(value) = body.strip_prefix("source:") {
                    let _ = value;
                    *line = format!("{indent_text}source: <redacted>");
                } else if let Some(value) = body.strip_prefix("device:") {
                    let _ = value;
                    *line = format!("{indent_text}device: <redacted>");
                } else if list_item.is_some() && body.contains(':') {
                    let mut parts = body.splitn(3, ':');
                    let source = parts.next().unwrap_or("");
                    let rest: Vec<&str> = parts.collect();
                    if is_socket_source(source) {
                        *line = format!("{indent_text}- <redacted>");
                    } else {
                        *line = format!("{indent_text}- <redacted>:{}", rest.join(":"));
                    }
                }
            }
            _ => {}
        }
    }
}

/// Remove environment values, label values and mount sources from a Compose body.
pub fn redact_compose(compose: &str) -> String {
    let mut lines: Vec<String> = compose.lines().map(ToString::to_string).collect();
    let wanted = ["environment", "labels", "volumes"];
    let mut index = 0;
    while index < lines.len() {
        let trimmed = lines[index].trim().to_string();
        let name = trimmed.strip_suffix(':').unwrap_or("");
        if wanted.contains(&name) {
            let indent = lines[index].len() - lines[index].trim_start().len();
            redact_compose_section(&mut lines, index, indent, name);
        }
        index += 1;
    }
    lines.join("\n")
}

pub fn redact_detail(detail: &mut ContainerDetail) {
    detail.env.clear();
    detail.labels.clear();
    for mount in &mut detail.mounts {
        mount.source.clear();
    }
}

pub fn redact_config(config: &mut ContainerConfigOut) {
    config.env.clear();
    config.labels.clear();
    config.mounts.clear();
}

// --- Proposals ----------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProposalStatus {
    Pending,
    Confirmed,
    Rejected,
    Expired,
    Failed,
    Applied,
}

impl ProposalStatus {
    #[allow(dead_code)] // Kept for the status strings the UI renders and tests assert on.
    pub fn as_str(self) -> &'static str {
        match self {
            ProposalStatus::Pending => "pending",
            ProposalStatus::Confirmed => "confirmed",
            ProposalStatus::Rejected => "rejected",
            ProposalStatus::Expired => "expired",
            ProposalStatus::Failed => "failed",
            ProposalStatus::Applied => "applied",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub id: String,
    pub action: String,
    pub endpoint_id: String,
    #[serde(default)]
    pub container_id: Option<String>,
    #[serde(default)]
    pub container_name: Option<String>,
    #[serde(default)]
    pub project: Option<String>,
    /// The credential that asked for this, shown as "Requested by" in the queue.
    #[serde(default)]
    pub credential_id: Option<String>,
    pub payload: serde_json::Value,
    pub created_at: u64,
    pub expires_at: u64,
    pub status: ProposalStatus,
    #[serde(default)]
    pub decided_by: Option<String>,
    #[serde(default)]
    pub decided_at: Option<u64>,
    #[serde(default)]
    pub message: Option<String>,
}

pub struct ProposalRequest {
    pub action: String,
    pub endpoint_id: String,
    pub container_id: Option<String>,
    pub container_name: Option<String>,
    pub project: Option<String>,
    pub payload: serde_json::Value,
}

fn proposal_path(dir: &Path) -> PathBuf {
    dir.join(PROPOSAL_FILE)
}

pub fn load_proposals(dir: &Path) -> Result<Vec<Proposal>, String> {
    let path = proposal_path(dir);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(&path).map_err(|_| PROPOSAL_READ_MSG.to_string())?;
    let mut items: Vec<Proposal> =
        serde_json::from_str(&text).map_err(|_| PROPOSAL_READ_MSG.to_string())?;
    // Records written before payloads were sanitized are scrubbed on the way in
    // so nothing that reads a proposal can see a value that was stored once.
    for item in &mut items {
        sanitize_payload(&mut item.payload);
    }
    Ok(items)
}

/// A proposal keeps the shape of the request, never the material the agent is
/// not allowed to hold: environment values, label values and mount sources are
/// blanked wherever they appear in the payload.
pub fn sanitize_payload(payload: &mut serde_json::Value) {
    match payload {
        serde_json::Value::Array(items) => items.iter_mut().for_each(sanitize_payload),
        serde_json::Value::Object(map) => {
            for (key, value) in map.iter_mut() {
                match key.as_str() {
                    "env" | "labels" => blank_values(value),
                    "mounts" => blank_mount_sources(value),
                    _ => sanitize_payload(value),
                }
            }
        }
        _ => {}
    }
}

fn blank_values(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Array(items) => {
            for item in items {
                match item {
                    serde_json::Value::Object(map) => {
                        if map.contains_key("value") {
                            map.insert("value".into(), serde_json::Value::String(String::new()));
                        }
                    }
                    serde_json::Value::String(line) => {
                        if let Some((key, _)) = line.split_once('=') {
                            *line = format!("{key}=");
                        }
                    }
                    _ => {}
                }
            }
        }
        serde_json::Value::Object(map) => {
            for item in map.values_mut() {
                *item = serde_json::Value::String(String::new());
            }
        }
        _ => {}
    }
}

fn blank_mount_sources(value: &mut serde_json::Value) {
    let serde_json::Value::Array(items) = value else {
        return;
    };
    for item in items {
        match item {
            serde_json::Value::Object(map) => {
                if map.contains_key("source") {
                    map.insert("source".into(), serde_json::Value::String(String::new()));
                }
            }
            serde_json::Value::String(line) => {
                if let Some((_, rest)) = line.split_once(':') {
                    *line = format!("<redacted>:{rest}");
                }
            }
            _ => {}
        }
    }
}

fn save_proposals(dir: &Path, proposals: &[Proposal]) -> Result<(), String> {
    let text = serde_json::to_string_pretty(proposals).map_err(|_| PROPOSAL_MSG.to_string())?;
    write_atomic(&proposal_path(dir), &text, PROPOSAL_MSG)
}

/// Drop what nobody needs any more so the file — and the raw compose text a
/// stack proposal carries — cannot grow for the life of the installation.
fn prune_proposals(proposals: &mut Vec<Proposal>, now: u64) {
    proposals.retain(|item| item.expires_at.saturating_add(PROPOSAL_GRACE_SECS) > now);
    if proposals.len() > PROPOSAL_KEEP {
        proposals.sort_by_key(|item| item.created_at);
        let excess = proposals.len() - PROPOSAL_KEEP;
        proposals.drain(..excess);
    }
}

pub fn create_proposal(
    dir: &Path,
    request: ProposalRequest,
    issuer: Option<&str>,
    now: u64,
) -> Result<Proposal, String> {
    let _guard = proposal_guard();
    let mut proposals = load_proposals(dir)?;
    let mut payload = request.payload;
    sanitize_payload(&mut payload);
    let proposal = Proposal {
        id: format!("prp_{}", crate::store::new_id()),
        action: request.action,
        endpoint_id: request.endpoint_id,
        container_id: request.container_id,
        container_name: request.container_name,
        project: request.project,
        credential_id: issuer.map(str::to_string),
        payload,
        created_at: now,
        expires_at: now + PROPOSAL_SECS,
        status: ProposalStatus::Pending,
        decided_by: None,
        decided_at: None,
        message: None,
    };
    proposals.push(proposal.clone());
    prune_proposals(&mut proposals, now);
    save_proposals(dir, &proposals)?;
    Ok(proposal)
}

#[derive(Debug, PartialEq, Eq)]
pub enum DecideError {
    Missing,
    Expired,
    Conflict,
    /// The store could not be read or written. Fail closed rather than report a
    /// decision that was never recorded.
    Unavailable,
}

/// Atomically move a pending proposal to a decided state. Expiry is checked
/// here, not only when the list is rendered, and the whole read-modify-write
/// runs under one lock so a row can be decided exactly once.
pub fn decide_proposal(
    dir: &Path,
    id: &str,
    status: ProposalStatus,
    by: &str,
    now: u64,
    message: Option<String>,
) -> Result<Proposal, DecideError> {
    let _guard = proposal_guard();
    let mut proposals = load_proposals(dir).map_err(|_| DecideError::Unavailable)?;
    let Some(index) = proposals.iter().position(|item| item.id == id) else {
        return Err(DecideError::Missing);
    };
    if proposals[index].status != ProposalStatus::Pending {
        return Err(DecideError::Conflict);
    }
    if proposals[index].expires_at <= now {
        proposals[index].status = ProposalStatus::Expired;
        proposals[index].decided_at = Some(now);
        prune_proposals(&mut proposals, now);
        save_proposals(dir, &proposals).map_err(|_| DecideError::Unavailable)?;
        return Err(DecideError::Expired);
    }
    proposals[index].status = status;
    proposals[index].decided_by = Some(by.to_string());
    proposals[index].decided_at = Some(now);
    proposals[index].message = message.map(|text| text.chars().take(500).collect());
    let decided = proposals[index].clone();
    prune_proposals(&mut proposals, now);
    save_proposals(dir, &proposals).map_err(|_| DecideError::Unavailable)?;
    Ok(decided)
}

pub fn finish_proposal(
    dir: &Path,
    id: &str,
    status: ProposalStatus,
    message: Option<String>,
) -> Result<(), String> {
    let _guard = proposal_guard();
    let mut proposals = load_proposals(dir)?;
    let Some(item) = proposals.iter_mut().find(|item| item.id == id) else {
        return Ok(());
    };
    item.status = status;
    item.message = message.map(|text| text.chars().take(500).collect());
    prune_proposals(&mut proposals, now());
    save_proposals(dir, &proposals)
}

pub fn expire_proposals(dir: &Path, now: u64) {
    let _guard = proposal_guard();
    let Ok(mut proposals) = load_proposals(dir) else {
        return;
    };
    let mut changed = false;
    for proposal in &mut proposals {
        if proposal.status == ProposalStatus::Pending && proposal.expires_at <= now {
            proposal.status = ProposalStatus::Expired;
            proposal.decided_at = Some(now);
            changed = true;
        }
    }
    prune_proposals(&mut proposals, now);
    if changed {
        let _ = save_proposals(dir, &proposals);
    }
}

/// Startup repair. A row left `confirmed` means the process died between the
/// decision and its outcome, so its result is unknown: mark it failed rather
/// than leave a state no reader can interpret. Pending rows past expiry are
/// expired, retention is applied, and temp files from killed writes are removed.
/// A store that cannot be read is reported, never rewritten.
pub fn recover_proposals(dir: &Path, now: u64) -> Result<usize, String> {
    let _guard = proposal_guard();
    let mut proposals = load_proposals(dir)?;
    let mut reconciled = 0;
    for proposal in &mut proposals {
        if proposal.status == ProposalStatus::Confirmed {
            proposal.status = ProposalStatus::Failed;
            proposal.message = Some(PROPOSAL_RECOVERY_MSG.to_string());
            reconciled += 1;
        } else if proposal.status == ProposalStatus::Pending && proposal.expires_at <= now {
            proposal.status = ProposalStatus::Expired;
            proposal.decided_at = Some(now);
        }
    }
    prune_proposals(&mut proposals, now);
    if proposal_path(dir).exists() {
        save_proposals(dir, &proposals)?;
    }
    remove_temp_files(dir);
    Ok(reconciled)
}

/// Best effort: a write that was killed leaves its staging file behind.
fn remove_temp_files(dir: &Path) {
    let prefix = temp_prefix(&proposal_path(dir));
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(&prefix) && name.ends_with(".tmp") {
            let _ = fs::remove_file(entry.path());
        }
    }
}

// --- Route gate ---------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RouteAccess {
    Deny,
    Read,
    Mutate,
}

/// Default-deny route set for an agent request. Anything not named here is 403.
pub fn agent_route(method: &str, path: &str) -> RouteAccess {
    let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
    if parts.first() != Some(&"api") {
        return RouteAccess::Deny;
    }
    let rest = &parts[1..];
    match (method, rest) {
        ("GET", ["endpoints"]) => RouteAccess::Read,
        ("GET", ["endpoints", _, "overview"]) => RouteAccess::Read,
        ("GET", ["endpoints", _, "containers"]) => RouteAccess::Read,
        ("GET", ["endpoints", _, "containers", _]) => RouteAccess::Read,
        ("GET", ["endpoints", _, "containers", _, "config"]) => RouteAccess::Read,
        ("GET", ["endpoints", _, "containers", _, "logs"]) => RouteAccess::Read,
        ("GET", ["endpoints", _, "containers", _, "logs", "stream"]) => RouteAccess::Read,
        ("GET", ["endpoints", _, "containers", _, "stats", "stream"]) => RouteAccess::Read,
        ("GET", ["endpoints", _, "stacks"]) => RouteAccess::Read,
        ("GET", ["endpoints", _, "stacks", _]) => RouteAccess::Read,
        ("GET", ["endpoints", _, "images"]) => RouteAccess::Read,
        ("GET", ["endpoints", _, "volumes"]) => RouteAccess::Read,
        ("GET", ["endpoints", _, "networks"]) => RouteAccess::Read,
        ("POST", ["endpoints", _, "containers"]) => RouteAccess::Mutate,
        ("POST", ["endpoints", _, "containers", _, "start"]) => RouteAccess::Mutate,
        ("POST", ["endpoints", _, "containers", _, "stop"]) => RouteAccess::Mutate,
        ("POST", ["endpoints", _, "containers", _, "restart"]) => RouteAccess::Mutate,
        ("POST", ["endpoints", _, "containers", _, "duplicate"]) => RouteAccess::Mutate,
        ("POST", ["endpoints", _, "containers", _, "recreate"]) => RouteAccess::Mutate,
        ("PUT", ["endpoints", _, "containers", _, "settings"]) => RouteAccess::Mutate,
        ("POST", ["endpoints", _, "stacks"]) => RouteAccess::Mutate,
        ("PUT", ["endpoints", _, "stacks", _]) => RouteAccess::Mutate,
        _ => RouteAccess::Deny,
    }
}

fn is_container_remove(method: &str, path: &str) -> bool {
    if method != "DELETE" {
        return false;
    }
    let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
    parts.len() == 5
        && parts.first() == Some(&"api")
        && parts.get(1) == Some(&"endpoints")
        && parts.get(3) == Some(&"containers")
}

/// Why this authenticated agent call is refused, if it is. Read routes stay
/// open. A lifetime over 24 hours cannot create proposals, and container remove
/// is refused with that reason too. Every other denied route keeps the generic
/// refusal, including credential issue, so a long-lived credential cannot mint
/// the next one.
pub fn agent_call_block(
    method: &str,
    path: &str,
    record: &CredentialRecord,
) -> Option<&'static str> {
    let route = agent_route(method, path);
    if !credential_may_operate(record)
        && (route == RouteAccess::Mutate || is_container_remove(method, path))
    {
        return Some(LONG_TTL_PROPOSAL_DENY);
    }
    if route == RouteAccess::Deny {
        return Some(AGENT_ROUTE_DENY);
    }
    None
}

pub fn ensure_can_propose(dir: &Path, credential_id: &str) -> Result<(), &'static str> {
    let Some(record) = load_credential(dir) else {
        return Err("This agent credential is no longer active.");
    };
    if record.id != credential_id || record.revoked_at.is_some() {
        return Err("This agent credential is no longer active.");
    }
    let now = now();
    if record.expires_at <= now || idle_deadline(&record).is_some_and(|deadline| deadline <= now) {
        return Err("This agent credential is no longer active.");
    }
    if !credential_may_operate(&record) {
        return Err(LONG_TTL_PROPOSAL_DENY);
    }
    Ok(())
}

// --- Tests --------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pisces-access-{}", crate::store::new_id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn live(name: &str, mounts: &[&str]) -> LiveAccess {
        LiveAccess {
            name: name.to_string(),
            mount_sources: mounts.iter().map(|item| item.to_string()).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn secret_is_shown_once_and_stored_only_as_a_verifier() {
        let dir = test_dir();
        let issued = issue_credential(&dir, "operator", now(), IssueParams::default()).unwrap();
        assert!(issued.secret.starts_with(AGENT_PREFIX));
        assert_eq!(issued.secret.len(), AGENT_PREFIX.len() + 43);
        assert_eq!(issued.view.state, "active");
        let raw = fs::read_to_string(credential_path(&dir)).unwrap();
        assert!(!raw.contains(&issued.secret));
        assert!(raw.contains("sha256:"));
        assert_eq!(verifier_for(&issued.secret).len(), 7 + 64);
        let view = credential_view(&dir, now());
        assert_eq!(view.id, issued.view.id);
        assert_eq!(view.state, "active");
        assert!(verify_credential(&dir, &issued.secret).is_ok());
        assert_eq!(
            verify_credential(&dir, "pisces_agent_wrong").unwrap_err(),
            CredentialError::Rejected
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn issuing_again_revokes_the_previous_secret_atomically() {
        let dir = test_dir();
        let first = issue_credential(&dir, "operator", now(), IssueParams::default()).unwrap();
        let second = issue_credential(&dir, "operator", now() + 1, IssueParams::default()).unwrap();
        assert_eq!(
            verify_credential(&dir, &first.secret).unwrap_err(),
            CredentialError::Rejected
        );
        assert!(verify_credential(&dir, &second.secret).is_ok());
        let records: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().into_string().unwrap())
            .filter(|name| name.starts_with("agent_credential"))
            .collect();
        // agent_credential.json only (the temp file is renamed away)
        assert_eq!(records, vec!["agent_credential.json".to_string()]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn revocation_and_expiry_are_distinct_and_effective() {
        let dir = test_dir();
        let issued = issue_credential(&dir, "operator", now(), IssueParams::default()).unwrap();
        assert!(revoke_credential(&dir, now()).unwrap());
        assert_eq!(
            verify_credential(&dir, &issued.secret).unwrap_err(),
            CredentialError::Revoked
        );
        assert_eq!(credential_view(&dir, now()).state, "revoked");

        fs::remove_dir_all(&dir).unwrap();
        fs::create_dir_all(&dir).unwrap();
        let issued = issue_credential(&dir, "operator", 1000, IssueParams::default()).unwrap();
        assert_eq!(
            verify_credential(&dir, &issued.secret).unwrap_err(),
            CredentialError::Expired
        );
        assert_eq!(credential_view(&dir, now()).state, "expired");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn unreadable_credential_grants_nothing() {
        let dir = test_dir();
        fs::write(credential_path(&dir), "{not json").unwrap();
        assert_eq!(credential_view(&dir, 0).state, "none");
        assert_eq!(
            verify_credential(&dir, "pisces_agent_anything").unwrap_err(),
            CredentialError::Rejected
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn ttl_steps_are_the_only_accepted_durations() {
        for ttl in [TTL_8H, TTL_24H, TTL_7D, TTL_30D] {
            assert_eq!(validate_ttl_secs(ttl), Ok(ttl));
        }
        for ttl in [
            0,
            1,
            TTL_8H - 1,
            TTL_8H + 1,
            TTL_24H + 1,
            TTL_30D + 1,
            u64::MAX,
        ] {
            assert_eq!(validate_ttl_secs(ttl), Err(TTL_REJECTED));
        }
        assert_eq!(validate_idle_secs(0), Ok(0));
        assert_eq!(validate_idle_secs(TTL_30D), Ok(TTL_30D));
        assert_eq!(validate_idle_secs(TTL_30D + 1), Err(IDLE_REJECTED));

        let dir = test_dir();
        let issued_at = 1_700_000_000;
        for (ttl, idle) in [(TTL_30D + 5, 0), (TTL_8H, TTL_30D + 1)] {
            let rejected = issue_credential(
                &dir,
                "operator",
                issued_at,
                IssueParams {
                    ttl_secs: ttl,
                    idle_secs: idle,
                },
            );
            assert!(rejected.is_err());
            assert!(
                !credential_path(&dir).exists(),
                "a rejected duration must not be stored or clamped"
            );
        }
        let mut last_secret = String::new();
        for ttl in [TTL_8H, TTL_24H, TTL_7D, TTL_30D] {
            let issued = issue_credential(
                &dir,
                "operator",
                issued_at,
                IssueParams {
                    ttl_secs: ttl,
                    idle_secs: 0,
                },
            )
            .unwrap();
            assert_eq!(issued.view.expires_at, issued_at + ttl);
            assert_eq!(issued.view.ttl_secs, ttl);
            assert_eq!(issued.view.idle_deadline, None);
            let tier = if ttl > TTL_24H {
                AccessTier::Read
            } else {
                AccessTier::Operate
            };
            assert_eq!(issued.view.access_tier, tier);
            let raw = fs::read_to_string(credential_path(&dir)).unwrap();
            assert!(!raw.contains(AGENT_PREFIX));
            last_secret = issued.secret;
        }
        // Idle 0 does not invent a 7-day deadline on a 30-day credential.
        assert!(verify_credential_at(&dir, &last_secret, issued_at + TTL_7D + 1).is_ok());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn absolute_expiry_follows_the_chosen_ttl() {
        let dir = test_dir();
        let issued_at = 1_700_000_000;
        let issued = issue_credential(
            &dir,
            "operator",
            issued_at,
            IssueParams {
                ttl_secs: TTL_24H,
                idle_secs: TTL_7D,
            },
        )
        .unwrap();
        assert!(verify_credential_at(&dir, &issued.secret, issued_at + TTL_24H - 1).is_ok());
        assert_eq!(
            verify_credential_at(&dir, &issued.secret, issued_at + TTL_24H).unwrap_err(),
            CredentialError::Expired
        );
        assert_eq!(credential_view(&dir, issued_at + TTL_24H).state, "expired");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn idle_expiry_stops_auth_and_last_use_is_throttled() {
        let dir = test_dir();
        let issued_at = 1_800_000_000;
        let issued = issue_credential(
            &dir,
            "operator",
            issued_at,
            IssueParams {
                ttl_secs: TTL_30D,
                idle_secs: TTL_7D,
            },
        )
        .unwrap();
        assert_eq!(issued.view.idle_deadline, Some(issued_at + TTL_7D));
        assert!(verify_credential_at(&dir, &issued.secret, issued_at + TTL_7D - 1).is_ok());
        assert_eq!(
            verify_credential_at(&dir, &issued.secret, issued_at + TTL_7D).unwrap_err(),
            CredentialError::Idle
        );
        assert_eq!(credential_view(&dir, issued_at + TTL_7D).state, "idle");

        let used_at = issued_at + 3 * 24 * 60 * 60;
        let record = verify_credential_at(&dir, &issued.secret, used_at).unwrap();
        touch_credential_at(&dir, &record, used_at);
        let touched = load_credential(&dir).unwrap();
        assert_eq!(touched.last_used_at, Some(used_at));
        assert_eq!(touched.expires_at, issued_at + TTL_30D);
        // The copy from before the write must not punch through the throttle.
        touch_credential_at(&dir, &record, used_at + LAST_USED_THROTTLE_SECS - 1);
        assert_eq!(load_credential(&dir).unwrap().last_used_at, Some(used_at));
        touch_credential_at(&dir, &touched, used_at + LAST_USED_THROTTLE_SECS);
        assert_eq!(
            load_credential(&dir).unwrap().last_used_at,
            Some(used_at + LAST_USED_THROTTLE_SECS)
        );
        let raw = fs::read_to_string(credential_path(&dir)).unwrap();
        assert!(!raw.contains(AGENT_PREFIX));

        let slid = used_at + LAST_USED_THROTTLE_SECS;
        assert!(verify_credential_at(&dir, &issued.secret, slid + TTL_7D - 1).is_ok());
        assert_eq!(
            verify_credential_at(&dir, &issued.secret, slid + TTL_7D).unwrap_err(),
            CredentialError::Idle
        );
        // A recent use does not move absolute expiry.
        let current = load_credential(&dir).unwrap();
        touch_credential_at(&dir, &current, issued_at + TTL_30D - 10);
        assert_eq!(
            verify_credential_at(&dir, &issued.secret, issued_at + TTL_30D).unwrap_err(),
            CredentialError::Expired
        );
        assert!(!LONG_TTL_PROPOSAL_DENY.contains(AGENT_PREFIX));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn long_ttl_cannot_create_lifecycle_proposals() {
        let dir = test_dir();
        let at = now();
        let short = issue_credential(
            &dir,
            "operator",
            at,
            IssueParams {
                ttl_secs: TTL_24H,
                idle_secs: 0,
            },
        )
        .unwrap();
        let short_record = load_credential(&dir).unwrap();
        assert!(agent_call_block(
            "POST",
            "/api/endpoints/e1/containers/c1/restart",
            &short_record
        )
        .is_none());
        assert!(agent_call_block(
            "POST",
            "/api/endpoints/e1/containers/c1/stop",
            &short_record
        )
        .is_none());
        assert_eq!(
            agent_call_block("DELETE", "/api/endpoints/e1/containers/c1", &short_record),
            Some(AGENT_ROUTE_DENY)
        );
        assert_eq!(
            agent_call_block("POST", "/api/agent/credential", &short_record),
            Some(AGENT_ROUTE_DENY)
        );
        assert!(ensure_can_propose(&dir, &short.view.id).is_ok());

        let long = issue_credential(
            &dir,
            "operator",
            at,
            IssueParams {
                ttl_secs: TTL_7D,
                idle_secs: TTL_7D,
            },
        )
        .unwrap();
        assert_eq!(long.view.access_tier, AccessTier::Read);
        let long_record = load_credential(&dir).unwrap();
        for (method, path) in [
            ("POST", "/api/endpoints/e1/containers/c1/restart"),
            ("POST", "/api/endpoints/e1/containers/c1/stop"),
            ("POST", "/api/endpoints/e1/containers/c1/start"),
            ("DELETE", "/api/endpoints/e1/containers/c1"),
            ("POST", "/api/endpoints/e1/stacks"),
            ("PUT", "/api/endpoints/e1/containers/c1/settings"),
        ] {
            assert_eq!(
                agent_call_block(method, path, &long_record),
                Some(LONG_TTL_PROPOSAL_DENY),
                "{method} {path}"
            );
        }
        assert!(
            agent_call_block("GET", "/api/endpoints/e1/containers/c1/logs", &long_record).is_none()
        );
        assert_eq!(
            agent_call_block("POST", "/api/agent/credential", &long_record),
            Some(AGENT_ROUTE_DENY)
        );
        assert_eq!(
            ensure_can_propose(&dir, &long.view.id),
            Err(LONG_TTL_PROPOSAL_DENY)
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn legacy_credential_keeps_stored_expiry_and_gains_no_idle_deadline() {
        let dir = test_dir();
        let secret = "pisces_agent_anything";
        let issued_at = 1_700_000_000u64;
        let expires_at = issued_at + TTL_8H;
        let legacy = serde_json::json!({
            "id": "agt_legacy",
            "verifier": verifier_for(secret),
            "issuedAt": issued_at,
            "expiresAt": expires_at,
            "revokedAt": null,
            "lastUsedAt": null,
            "issuedBy": "operator"
        });
        fs::write(
            credential_path(&dir),
            serde_json::to_string_pretty(&legacy).unwrap(),
        )
        .unwrap();
        let loaded = load_credential(&dir).unwrap();
        assert_eq!(loaded.expires_at, expires_at);
        assert_eq!(loaded.ttl_secs, None);
        assert_eq!(loaded.idle_secs, None);
        assert_eq!(access_tier(&loaded), AccessTier::Operate);
        assert_eq!(idle_deadline(&loaded), None);
        assert!(verify_credential_at(&dir, secret, expires_at - 1).is_ok());
        assert_eq!(
            verify_credential_at(&dir, secret, expires_at).unwrap_err(),
            CredentialError::Expired
        );
        touch_credential_at(&dir, &loaded, issued_at + 10);
        let after = load_credential(&dir).unwrap();
        assert_eq!(after.expires_at, expires_at);
        assert_eq!(after.ttl_secs, None);
        assert_eq!(after.idle_secs, None);
        assert_eq!(after.last_used_at, Some(issued_at + 10));
        let raw = fs::read_to_string(credential_path(&dir)).unwrap();
        assert!(!raw.contains("ttlSecs"));
        assert!(!raw.contains("idleSecs"));
        assert!(!raw.contains(AGENT_PREFIX));

        let long_expiry = issued_at + TTL_30D;
        let legacy_long = serde_json::json!({
            "id": "agt_legacy",
            "verifier": verifier_for(secret),
            "issuedAt": issued_at,
            "expiresAt": long_expiry,
            "issuedBy": "operator"
        });
        fs::write(
            credential_path(&dir),
            serde_json::to_string_pretty(&legacy_long).unwrap(),
        )
        .unwrap();
        let long = load_credential(&dir).unwrap();
        assert_eq!(access_tier(&long), AccessTier::Read);
        assert!(verify_credential_at(&dir, secret, issued_at + TTL_7D + 1).is_ok());
        touch_credential_at(&dir, &long, issued_at + TTL_7D);
        let raw = fs::read_to_string(credential_path(&dir)).unwrap();
        assert!(!raw.contains("idleSecs"));
        assert!(!raw.contains("ttlSecs"));
        assert_eq!(load_credential(&dir).unwrap().expires_at, long_expiry);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn policy_defaults_to_locked_and_corrupt_policy_is_not_a_startup_error() {
        let dir = test_dir();
        let file = load_policy(&dir);
        assert!(file.readable);
        assert_eq!(policy_state(&file, "e1", "c1"), State::Locked);
        fs::write(policy_path(&dir), "{oops").unwrap();
        let file = load_policy(&dir);
        assert!(!file.readable);
        assert_eq!(policy_state(&file, "e1", "c1"), State::Locked);
        remember_policy(
            &dir,
            PolicyEntry {
                container_id: "c1".into(),
                endpoint_id: "e1".into(),
                container_name: "web".into(),
                state: State::Operate,
                updated_at: 10,
                updated_by: "operator".into(),
            },
        )
        .unwrap();
        let file = load_policy(&dir);
        assert!(file.readable);
        assert_eq!(policy_state(&file, "e1", "c1"), State::Operate);
        assert_eq!(policy_state(&file, "e2", "c1"), State::Locked);
        fs::remove_dir_all(dir).unwrap();
    }

    fn entry(id: &str, name: &str, state: State, updated_at: u64) -> PolicyEntry {
        PolicyEntry {
            container_id: id.to_string(),
            endpoint_id: "e1".into(),
            container_name: name.to_string(),
            state,
            updated_at,
            updated_by: "operator".into(),
        }
    }

    /// QA repro A: the same container reached as a short id and as a full id
    /// must be one policy entry, so the newer Locked wins over a stale Operate.
    #[test]
    fn duplicate_id_forms_collapse_to_the_newest_write() {
        let dir = test_dir();
        let full = "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0";
        let short = &full[..12];
        remember_policy(&dir, entry(short, "web", State::Operate, 10)).unwrap();
        remember_policy(&dir, entry(full, "web", State::Locked, 20)).unwrap();
        let file = load_policy(&dir);
        assert_eq!(file.entries.len(), 1);
        assert_eq!(policy_state(&file, "e1", full), State::Locked);
        assert_eq!(policy_state(&file, "e1", short), State::Locked);
        assert_eq!(policy_state(&file, "e1", &full[..6]), State::Locked);
        fs::remove_dir_all(dir).unwrap();
    }

    /// QA repro B: a container removed and recreated outside Pisces keeps the
    /// old name with a new id. The stale grant must not follow the name.
    #[test]
    fn a_reused_name_never_inherits_the_old_grant() {
        let dir = test_dir();
        remember_policy(&dir, entry("aaa111", "web", State::Operate, 10)).unwrap();
        let file = load_policy(&dir);
        assert_eq!(policy_state(&file, "e1", "bbb222"), State::Locked);
        remember_policy(&dir, entry("bbb222", "web", State::Locked, 20)).unwrap();
        let file = load_policy(&dir);
        assert_eq!(file.entries.len(), 1);
        assert_eq!(policy_state(&file, "e1", "aaa111"), State::Locked);
        assert_eq!(policy_state(&file, "e1", "bbb222"), State::Locked);
        fs::remove_dir_all(dir).unwrap();
    }

    /// A policy file written by an older build can hold two entries for one
    /// container. The lookup takes the newest, and a tie the most restrictive.
    #[test]
    fn stale_duplicate_entries_resolve_to_the_restrictive_one() {
        let dir = test_dir();
        let full = "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0";
        let legacy = vec![
            entry(&full[..12], "web", State::Operate, 20),
            entry(full, "web", State::Locked, 20),
        ];
        fs::write(policy_path(&dir), serde_json::to_string(&legacy).unwrap()).unwrap();
        let file = load_policy(&dir);
        assert_eq!(policy_state(&file, "e1", full), State::Locked);
        let older = vec![
            entry(full, "web", State::Read, 5),
            entry(&full[..12], "web", State::Operate, 9),
        ];
        fs::write(policy_path(&dir), serde_json::to_string(&older).unwrap()).unwrap();
        let file = load_policy(&dir);
        assert_eq!(policy_state(&file, "e1", full), State::Operate);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_short_id_below_six_characters_is_not_an_identity() {
        let dir = test_dir();
        remember_policy(&dir, entry("abcdef12", "web", State::Operate, 10)).unwrap();
        let file = load_policy(&dir);
        assert_eq!(policy_state(&file, "e1", "abc"), State::Locked);
        assert_eq!(policy_state(&file, "e1", "abcdef12"), State::Operate);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn forced_lock_sees_every_dangerous_shape() {
        let dir = test_dir();
        assert!(forced_lock(&dir, &live("web", &["/var/run/docker.sock"])).locked);
        assert!(forced_lock(&dir, &live("web", &["//./pipe/docker_engine"])).locked);
        assert!(forced_lock(&dir, &live("web", &["/"])).locked);
        assert!(forced_lock(&dir, &live("web", &["C:\\"])).locked);
        let mount = format!("{}/stacks", dir.display());
        assert!(forced_lock(&dir, &live("web", &[mount.as_str()])).locked);
        assert!(forced_lock(&dir, &live("web", &["/data"])).locked);
        let mut volume = live("web", &[]);
        volume.volume_names.push("pisces-data".into());
        assert!(forced_lock(&dir, &volume).locked);
        let mut privileged = live("web", &["/srv/static"]);
        privileged.privileged = true;
        assert!(forced_lock(&dir, &privileged).locked);
        let mut net = live("web", &[]);
        net.network_mode = Some("host".into());
        assert!(forced_lock(&dir, &net).locked);
        let mut pid = live("web", &[]);
        pid.pid_mode = Some("host".into());
        assert!(forced_lock(&dir, &pid).locked);
        assert!(!forced_lock(&dir, &live("web", &["/srv/static"])).locked);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn refusal_set_names_each_class() {
        let dir = test_dir();
        let allowed = |_: &str| State::Operate;
        let locked = |_: &str| State::Locked;
        let mount = |source: &str| Mutation {
            mounts: vec![MountRef {
                source: source.into(),
                mount_type: "bind".into(),
            }],
            ..Default::default()
        };
        assert!(refusal(&dir, &mount("/var/run/docker.sock"), &allowed)
            .unwrap()
            .contains("Docker socket"));
        assert!(refusal(&dir, &mount("//./pipe/docker_engine"), &allowed)
            .unwrap()
            .contains("Docker socket"));
        assert!(refusal(&dir, &mount("/"), &allowed)
            .unwrap()
            .contains("host root"));
        let data = format!("{}/stacks", dir.display());
        assert!(refusal(&dir, &mount(&data), &allowed)
            .unwrap()
            .contains("data directory"));
        let mut privileged = Mutation {
            privileged: true,
            ..Default::default()
        };
        assert!(refusal(&dir, &privileged, &allowed).is_some());
        privileged.privileged = false;
        privileged.network_mode = Some("host".into());
        assert!(refusal(&dir, &privileged, &allowed).is_some());
        privileged.network_mode = Some("container:web".into());
        assert!(refusal(&dir, &privileged, &allowed).is_none());
        assert!(refusal(&dir, &privileged, &locked).is_some());
        let mut env = Mutation::default();
        env.env_keys.push("PISCES_JWT_SECRET".into());
        assert!(refusal(&dir, &env, &allowed)
            .unwrap()
            .contains("environment"));
        let mut labels = Mutation::default();
        labels.label_keys.push("pisces.ai.state".into());
        assert!(refusal(&dir, &labels, &allowed).unwrap().contains("labels"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn compose_mutation_and_redaction_keep_secrets_out() {
        let compose = "services:\n  web:\n    image: nginx\n    environment:\n      - PISCES_JWT_SECRET=abc\n      - NORMAL=hidden\n    labels:\n      pisces.ai.state: operate\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n      - ./data:/data\n";
        let mutation = mutation_from_compose(compose);
        assert!(mutation
            .env_keys
            .iter()
            .any(|key| key == "PISCES_JWT_SECRET"));
        assert!(mutation
            .label_keys
            .iter()
            .any(|key| key == "pisces.ai.state"));
        assert!(mutation
            .mounts
            .iter()
            .any(|mount| mount.source == "/var/run/docker.sock"));
        let allowed = |_: &str| State::Operate;
        assert!(refusal(Path::new("./data"), &mutation, &allowed)
            .unwrap()
            .contains("Docker socket"));
        let redacted = redact_compose(compose);
        assert!(!redacted.contains("abc"));
        assert!(!redacted.contains("hidden"));
        assert!(!redacted.contains("operate"));
        assert!(!redacted.contains("/var/run/docker.sock"));
        assert!(!redacted.contains("./data"));
        assert!(redacted.contains("/data"));
        assert!(redacted.contains("PISCES_JWT_SECRET"));
    }

    #[test]
    fn proposal_payloads_keep_the_shape_but_not_the_values() {
        let dir = test_dir();
        let request = ProposalRequest {
            action: "duplicate".into(),
            endpoint_id: "e1".into(),
            container_id: Some("c1".into()),
            container_name: Some("web".into()),
            project: None,
            payload: serde_json::json!({
                "name": "web-copy",
                "env": [
                    {"key": "DB_PASSWORD", "value": "hunter2"},
                    {"key": "MODE", "value": "prod"}
                ],
                "labels": [{"key": "owner", "value": "secret-label"}],
                "mounts": [{
                    "source": "/srv/secret",
                    "destination": "/data",
                    "mountType": "bind",
                    "readOnly": false
                }],
                "ports": ["8080:80"],
                "restartPolicy": "no"
            }),
        };
        let proposal = create_proposal(&dir, request, Some("agt_1"), 100).unwrap();
        let payload = &proposal.payload;
        assert_eq!(payload["name"], "web-copy");
        assert_eq!(payload["env"][0]["key"], "DB_PASSWORD");
        assert_eq!(payload["env"][0]["value"], "");
        assert_eq!(payload["labels"][0]["value"], "");
        assert_eq!(payload["mounts"][0]["source"], "");
        assert_eq!(payload["mounts"][0]["destination"], "/data");
        assert_eq!(payload["ports"][0], "8080:80");
        let raw = fs::read_to_string(proposal_path(&dir)).unwrap();
        assert!(!raw.contains("hunter2"));
        assert!(!raw.contains("secret-label"));
        assert!(!raw.contains("/srv/secret"));

        // A record an older build wrote is scrubbed on the way in.
        let legacy = serde_json::json!([{
            "id": "prp_legacy",
            "action": "duplicate",
            "endpointId": "e1",
            "payload": {
                "env": ["DB_PASSWORD=hunter2"],
                "labels": ["owner=secret-label"],
                "mounts": ["/srv/secret:/data:rw"]
            },
            "createdAt": 1,
            "expiresAt": 2,
            "status": "pending"
        }]);
        fs::write(proposal_path(&dir), serde_json::to_string(&legacy).unwrap()).unwrap();
        let loaded = load_proposals(&dir).unwrap();
        let payload = &loaded[0].payload;
        assert_eq!(payload["env"][0], "DB_PASSWORD=");
        assert_eq!(payload["labels"][0], "owner=");
        assert_eq!(payload["mounts"][0], "<redacted>:/data:rw");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn proposal_lifecycle_expiry_and_double_decision() {
        let dir = test_dir();
        let proposal = create_proposal(
            &dir,
            ProposalRequest {
                action: "start".into(),
                endpoint_id: "e1".into(),
                container_id: Some("c1".into()),
                container_name: Some("web".into()),
                project: None,
                payload: serde_json::json!({}),
            },
            Some("agt_test"),
            1000,
        )
        .unwrap();
        assert_eq!(proposal.status, ProposalStatus::Pending);
        let decided = decide_proposal(
            &dir,
            &proposal.id,
            ProposalStatus::Confirmed,
            "operator",
            1001,
            None,
        )
        .unwrap();
        assert_eq!(decided.status, ProposalStatus::Confirmed);
        assert_eq!(
            decide_proposal(
                &dir,
                &proposal.id,
                ProposalStatus::Confirmed,
                "operator",
                1002,
                None
            )
            .unwrap_err(),
            DecideError::Conflict
        );
        let stale = create_proposal(
            &dir,
            ProposalRequest {
                action: "stop".into(),
                endpoint_id: "e1".into(),
                container_id: Some("c1".into()),
                container_name: Some("web".into()),
                project: None,
                payload: serde_json::json!({}),
            },
            None,
            2000,
        )
        .unwrap();
        assert_eq!(
            decide_proposal(
                &dir,
                &stale.id,
                ProposalStatus::Confirmed,
                "operator",
                2000 + PROPOSAL_SECS + 1,
                None
            )
            .unwrap_err(),
            DecideError::Expired
        );
        let listed = load_proposals(&dir).unwrap();
        assert_eq!(
            listed
                .iter()
                .find(|item| item.id == stale.id)
                .unwrap()
                .status,
            ProposalStatus::Expired
        );
        fs::write(proposal_path(&dir), "[broken").unwrap();
        assert!(load_proposals(&dir).is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    fn request(action: &str) -> ProposalRequest {
        ProposalRequest {
            action: action.into(),
            endpoint_id: "e1".into(),
            container_id: Some("c1".into()),
            container_name: Some("web".into()),
            project: None,
            payload: serde_json::json!({}),
        }
    }

    /// Two confirms of one row reach the store together; exactly one may win.
    #[test]
    fn a_proposal_can_be_decided_only_once_under_concurrent_confirms() {
        let dir = test_dir();
        let proposal = create_proposal(&dir, request("start"), Some("agt"), 1000).unwrap();
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let dir = dir.clone();
                let id = proposal.id.clone();
                std::thread::spawn(move || {
                    decide_proposal(&dir, &id, ProposalStatus::Confirmed, "operator", 1001, None)
                })
            })
            .collect();
        let results: Vec<Result<Proposal, DecideError>> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|item| item.is_ok()).count(), 1);
        assert!(results
            .iter()
            .filter_map(|item| item.as_ref().err())
            .all(|error| *error == DecideError::Conflict));
        let listed = load_proposals(&dir).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].status, ProposalStatus::Confirmed);
        fs::remove_dir_all(dir).unwrap();
    }

    /// Concurrent creation must not lose a row to a clobbered read-modify-write
    /// or to the temp file two saves used to share.
    #[test]
    fn concurrent_creates_do_not_clobber_the_proposal_file() {
        let dir = test_dir();
        let workers: Vec<_> = (0..12)
            .map(|index| {
                let dir = dir.clone();
                std::thread::spawn(move || {
                    create_proposal(&dir, request("start"), Some("agt"), 1000 + index).map(|_| ())
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap().unwrap();
        }
        let listed = load_proposals(&dir).unwrap();
        assert_eq!(listed.len(), 12);
        let mut ids: Vec<String> = listed.iter().map(|item| item.id.clone()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), 12);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_corrupt_store_fails_closed_instead_of_reporting_a_missing_row() {
        let dir = test_dir();
        fs::write(proposal_path(&dir), "[{").unwrap();
        assert!(load_proposals(&dir).is_err());
        assert_eq!(
            decide_proposal(
                &dir,
                "prp_any",
                ProposalStatus::Confirmed,
                "operator",
                1000,
                None
            )
            .unwrap_err(),
            DecideError::Unavailable
        );
        assert!(create_proposal(&dir, request("start"), None, 1000).is_err());
        assert!(recover_proposals(&dir, 1000).is_err());
        // The unreadable file is left untouched for a human to inspect.
        assert_eq!(fs::read_to_string(proposal_path(&dir)).unwrap(), "[{");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn startup_recovery_settles_an_interrupted_confirmation() {
        let dir = test_dir();
        let proposal = create_proposal(&dir, request("start"), Some("agt"), 1000).unwrap();
        decide_proposal(
            &dir,
            &proposal.id,
            ProposalStatus::Confirmed,
            "operator",
            1001,
            None,
        )
        .unwrap();
        assert_eq!(recover_proposals(&dir, 1002).unwrap(), 1);
        let listed = load_proposals(&dir).unwrap();
        assert_eq!(listed[0].status, ProposalStatus::Failed);
        assert!(listed[0]
            .message
            .as_deref()
            .unwrap()
            .contains("interrupted"));
        // A second start finds nothing to settle and replays nothing.
        assert_eq!(recover_proposals(&dir, 1003).unwrap(), 0);
        assert_eq!(
            load_proposals(&dir).unwrap()[0].status,
            ProposalStatus::Failed
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn retention_drops_rows_past_grace_and_caps_the_file() {
        let dir = test_dir();
        let start = 10_000;
        for index in 0..(PROPOSAL_KEEP as u64 + 5) {
            create_proposal(&dir, request("start"), None, start + index).unwrap();
        }
        let listed = load_proposals(&dir).unwrap();
        assert_eq!(listed.len(), PROPOSAL_KEEP);
        let oldest = listed.iter().map(|item| item.created_at).min().unwrap();
        assert_eq!(oldest, start + 5);
        // Everything ends up past expiry plus grace, including retained compose.
        let later = start + PROPOSAL_KEEP as u64 + PROPOSAL_SECS + PROPOSAL_GRACE_SECS + 10;
        assert_eq!(recover_proposals(&dir, later).unwrap(), 0);
        assert!(load_proposals(&dir).unwrap().is_empty());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn agent_route_set_is_deny_by_default() {
        for (method, path, expected) in [
            ("GET", "/api/endpoints", RouteAccess::Read),
            (
                "GET",
                "/api/endpoints/e1/containers/c1/logs",
                RouteAccess::Read,
            ),
            (
                "GET",
                "/api/endpoints/e1/containers/c1/logs/stream",
                RouteAccess::Read,
            ),
            (
                "GET",
                "/api/endpoints/e1/containers/c1/stats/stream",
                RouteAccess::Read,
            ),
            ("GET", "/api/endpoints/e1/stacks", RouteAccess::Read),
            (
                "POST",
                "/api/endpoints/e1/containers/c1/start",
                RouteAccess::Mutate,
            ),
            (
                "PUT",
                "/api/endpoints/e1/containers/c1/settings",
                RouteAccess::Mutate,
            ),
            ("POST", "/api/endpoints/e1/stacks", RouteAccess::Mutate),
            ("PUT", "/api/endpoints/e1/stacks/web", RouteAccess::Mutate),
            (
                "GET",
                "/api/endpoints/e1/containers/c1/console",
                RouteAccess::Deny,
            ),
            (
                "GET",
                "/api/endpoints/e1/containers/c1/attach",
                RouteAccess::Deny,
            ),
            (
                "DELETE",
                "/api/endpoints/e1/containers/c1",
                RouteAccess::Deny,
            ),
            ("POST", "/api/proposals/abc/confirm", RouteAccess::Deny),
            ("GET", "/api/agent/credential", RouteAccess::Deny),
            ("GET", "/api/ai-access/e1/c1", RouteAccess::Deny),
            ("POST", "/api/endpoints", RouteAccess::Deny),
        ] {
            assert_eq!(agent_route(method, path), expected, "{method} {path}");
        }
    }

    #[test]
    fn redaction_removes_secret_values_and_mount_sources() {
        let mut detail = ContainerDetail {
            id: "c1".into(),
            name: "web".into(),
            image: "nginx".into(),
            image_id: "sha256:1".into(),
            state: "running".into(),
            status_text: "Up".into(),
            created: String::new(),
            started: None,
            command: "nginx".into(),
            entrypoint: String::new(),
            restart_policy: "no".into(),
            restart_maximum_retry_count: None,
            ports: Vec::new(),
            mounts: vec![crate::docker::MountOut {
                source: "/var/run/docker.sock".into(),
                destination: "/var/run/docker.sock".into(),
                mode: "rw".into(),
            }],
            networks: Vec::new(),
            env: vec![EnvOut {
                key: "PISCES_JWT_SECRET".into(),
                value: "abc".into(),
            }],
            labels: vec![LabelOut {
                key: "pisces.ai".into(),
                value: "operate".into(),
            }],
        };
        redact_detail(&mut detail);
        assert!(detail.env.is_empty());
        assert!(detail.labels.is_empty());
        assert!(detail.mounts[0].source.is_empty());
        assert_eq!(detail.mounts[0].destination, "/var/run/docker.sock");
    }
}
