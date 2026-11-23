//! API error envelope: `{ error: { code, message, retryable } }`.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
    pub message_is_safe: bool,
}

impl ApiError {
    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            code: "unauthorized",
            message: message.into(),
            retryable: false,
            message_is_safe: false,
        }
    }

    pub fn validation(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "validation",
            message: message.into(),
            retryable: false,
            message_is_safe: true,
        }
    }

    pub fn unsafe_validation(message: impl Into<String>) -> Self {
        Self {
            message_is_safe: false,
            ..Self::validation(message)
        }
    }

    /// The caller is authenticated but this object or action is not allowed.
    /// The message is written for the reader and never echoes engine details.
    pub fn forbidden(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            code: "forbidden",
            message: message.into(),
            retryable: false,
            message_is_safe: true,
        }
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            code: "conflict",
            message: message.into(),
            retryable: false,
            message_is_safe: false,
        }
    }

    pub fn in_use(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            code: "in_use",
            message: message.into(),
            retryable: false,
            message_is_safe: false,
        }
    }

    pub fn gone(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::GONE,
            code: "gone",
            message: message.into(),
            retryable: false,
            message_is_safe: true,
        }
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            code: "not_found",
            message: message.into(),
            retryable: false,
            message_is_safe: false,
        }
    }

    pub fn daemon(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "daemon_unreachable",
            message: message.into(),
            retryable: true,
            message_is_safe: false,
        }
    }

    pub fn cluster(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "cluster_unreachable",
            message: message.into(),
            retryable: true,
            message_is_safe: false,
        }
    }

    /// Pisces could not read or write its own storage. Fail closed: the caller
    /// learns the request was not recorded rather than that it was.
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "storage_unavailable",
            message: message.into(),
            retryable: true,
            message_is_safe: true,
        }
    }

    pub fn deploy(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            code: "deploy_failed",
            message: message.into(),
            retryable: false,
            message_is_safe: false,
        }
    }
}

#[derive(Serialize)]
struct Envelope<'a> {
    error: Detail<'a>,
}

#[derive(Serialize)]
struct Detail<'a> {
    code: &'a str,
    message: &'a str,
    retryable: bool,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = Envelope {
            error: Detail {
                code: self.code,
                message: &self.message,
                retryable: self.retryable,
            },
        };
        (self.status, Json(body)).into_response()
    }
}
