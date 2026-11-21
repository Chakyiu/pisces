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

pub fn load_from_env() -> Result<AuthConfig, &'static str> {
    let username = std::env::var("PISCES_USERNAME").unwrap_or_default();
    let password_hash = std::env::var("PISCES_PASSWORD_HASH").unwrap_or_default();
    let jwt_secret = std::env::var("PISCES_JWT_SECRET").unwrap_or_default();
    let username = username.trim().to_string();
    if username.is_empty() || password_hash.is_empty() || jwt_secret.len() < 32 {
        return Err(
            "Set PISCES_USERNAME, PISCES_PASSWORD_HASH, and PISCES_JWT_SECRET (32+ characters). Hash a password with: cargo run -- hash-password",
        );
    }
    if PasswordHash::new(&password_hash).is_err() {
        return Err("PISCES_PASSWORD_HASH is not an argon2 PHC string.");
    }
    Ok(AuthConfig {
        username,
        password_hash,
        jwt_secret,
    })
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
