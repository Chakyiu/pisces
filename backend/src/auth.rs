//! Local operator password (argon2) and a short-lived JWT in an httpOnly cookie.
//!
//! The hash and the signing secret come from the environment. Nothing here reads
//! or writes a secret file.

use argon2::password_hash::phc::PasswordHash;
use argon2::password_hash::{PasswordHasher, PasswordVerifier};
use argon2::Argon2;
use axum::http::HeaderMap;
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};

pub const COOKIE: &str = "pisces_session";
const SESSION_SECS: u64 = 8 * 60 * 60;

#[derive(Clone)]
pub struct AuthConfig {
    pub username: String,
    pub password_hash: String,
    pub jwt_secret: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct Claims {
    sub: String,
    exp: u64,
}

/// Reads the operator credentials. `PISCES_PASSWORD_HASH` wins when set; otherwise
/// `PISCES_PASSWORD` is hashed once here and only the hash is kept in memory. The
/// plaintext value is never printed.
pub fn load_from_env() -> Result<AuthConfig, &'static str> {
    let username = std::env::var("PISCES_USERNAME").unwrap_or_default();
    let username = username.trim().to_string();
    if username.is_empty() {
        return Err("Set PISCES_USERNAME to the operator name.");
    }
    let jwt_secret = std::env::var("PISCES_JWT_SECRET").unwrap_or_default();
    if jwt_secret.len() < 32 {
        return Err("Set PISCES_JWT_SECRET to 32 or more characters.");
    }
    let (password_hash, source) = resolve_password_hash(
        std::env::var("PISCES_PASSWORD_HASH").ok(),
        std::env::var("PISCES_PASSWORD").ok(),
    )?;
    println!("pisces auth: user {username}, password from {source}");
    Ok(AuthConfig {
        username,
        password_hash,
        jwt_secret,
    })
}

fn resolve_password_hash(
    hash: Option<String>,
    password: Option<String>,
) -> Result<(String, &'static str), &'static str> {
    let hash = hash.unwrap_or_default();
    let hash = hash.trim();
    if !hash.is_empty() {
        if PasswordHash::new(hash).is_err() {
            return Err("PISCES_PASSWORD_HASH is not an argon2 PHC string.");
        }
        return Ok((hash.to_string(), "PISCES_PASSWORD_HASH"));
    }
    match password {
        None => Err("Set PISCES_PASSWORD_HASH (an argon2 PHC string) or PISCES_PASSWORD."),
        Some(password) if password.is_empty() => {
            Err("PISCES_PASSWORD is empty; set a password or PISCES_PASSWORD_HASH.")
        }
        Some(password) => hash_password(&password)
            .map(|hash| (hash, "PISCES_PASSWORD (hashed at startup)"))
            .map_err(|_| "could not hash PISCES_PASSWORD"),
    }
}

pub fn hash_password(password: &str) -> Result<String, String> {
    Argon2::default()
        .hash_password(password.as_bytes())
        .map(|hash| hash.to_string())
        .map_err(|_| "could not hash the password".to_string())
}

pub fn verify_password(password: &str, phc: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(phc) else {
        return false;
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

pub fn issue_token(auth: &AuthConfig) -> Result<String, String> {
    let claims = Claims {
        sub: auth.username.clone(),
        exp: jsonwebtoken::get_current_timestamp() + SESSION_SECS,
    };
    let key = EncodingKey::from_secret(auth.jwt_secret.as_bytes())
        .map_err(|_| "could not sign the session".to_string())?;
    encode(&Header::default(), &claims, &key).map_err(|_| "could not sign the session".to_string())
}

pub fn username_from_token(auth: &AuthConfig, token: &str) -> Option<String> {
    let mut validation = Validation::new(jsonwebtoken::Algorithm::HS256);
    validation.validate_exp = true;
    let key = DecodingKey::from_secret(auth.jwt_secret.as_bytes()).ok()?;
    let data = decode::<Claims>(token, &key, &validation).ok()?;
    if data.claims.sub == auth.username {
        Some(data.claims.sub)
    } else {
        None
    }
}

pub fn token_from_headers(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(axum::http::header::COOKIE)?.to_str().ok()?;
    for part in raw.split(';') {
        let mut kv = part.trim().splitn(2, '=');
        if kv.next() == Some(COOKIE) {
            let value = kv.next().unwrap_or("").trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

pub fn set_cookie(token: &str) -> String {
    format!("{COOKIE}={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age={SESSION_SECS}")
}

pub fn clear_cookie() -> String {
    format!("{COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(hash: &str) -> AuthConfig {
        AuthConfig {
            username: "operator".into(),
            password_hash: hash.into(),
            jwt_secret: "test-secret-test-secret-test-secret".into(),
        }
    }

    #[test]
    fn password_hash_wins_over_plain_password() {
        let hash = hash_password("correct horse").unwrap();
        let (resolved, source) =
            resolve_password_hash(Some(hash.clone()), Some("ignored".into())).unwrap();
        assert_eq!(resolved, hash);
        assert_eq!(source, "PISCES_PASSWORD_HASH");
    }

    #[test]
    fn plain_password_is_hashed_at_startup() {
        let (hash, source) = resolve_password_hash(None, Some("correct horse".into())).unwrap();
        assert_eq!(source, "PISCES_PASSWORD (hashed at startup)");
        assert!(verify_password("correct horse", &hash));
        assert!(!verify_password("wrong horse", &hash));
    }

    #[test]
    fn rejects_missing_empty_and_non_phc_secrets() {
        assert!(resolve_password_hash(None, None)
            .unwrap_err()
            .contains("PISCES_PASSWORD_HASH"));
        assert!(resolve_password_hash(Some(String::new()), None)
            .unwrap_err()
            .contains("PISCES_PASSWORD"));
        assert!(
            resolve_password_hash(Some(String::new()), Some(String::new()))
                .unwrap_err()
                .contains("empty")
        );
        assert_eq!(
            resolve_password_hash(Some("not-a-hash".into()), None).unwrap_err(),
            "PISCES_PASSWORD_HASH is not an argon2 PHC string."
        );
    }

    #[test]
    fn password_and_token_roundtrip() {
        let hash = hash_password("correct horse").unwrap();
        let auth = config(&hash);
        assert!(verify_password("correct horse", &hash));
        assert!(!verify_password("wrong horse", &hash));

        let token = issue_token(&auth).unwrap();
        assert_eq!(
            username_from_token(&auth, &token).as_deref(),
            Some("operator")
        );
        let mut tampered = token.clone();
        tampered.pop();
        tampered.push('x');
        assert!(username_from_token(&auth, &tampered).is_none());
    }
}
