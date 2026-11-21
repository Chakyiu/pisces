//! In-memory pages. The local engine is the only Docker target in v1.

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListPage<T> {
    pub items: Vec<T>,
    pub total: usize,
    pub next_cursor: Option<String>,
}

pub fn slice_page<T>(
    items: Vec<T>,
    limit: Option<&str>,
    cursor: Option<&str>,
) -> Result<ListPage<T>, String> {
    let limit = match limit {
        None | Some("") => 50,
        Some(raw) => raw
            .parse::<usize>()
            .map_err(|_| "Limit must be a number.".to_string())?
            .clamp(1, 50),
    };
    let offset = match cursor {
        None | Some("") => 0,
        Some(raw) => raw
            .parse::<usize>()
            .map_err(|_| "The page cursor is not valid.".to_string())?,
    };
    let total = items.len();
    let next_cursor = if offset.saturating_add(limit) < total {
        Some((offset + limit).to_string())
    } else {
        None
    };
    let items = if offset >= total {
        Vec::new()
    } else {
        items.into_iter().skip(offset).take(limit).collect()
    };
    Ok(ListPage {
        items,
        total,
        next_cursor,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pages_and_rejects_a_bad_cursor() {
        let page = slice_page(vec!["a", "b", "c"], Some("2"), Some("0")).unwrap();
        assert_eq!(page.items, vec!["a", "b"]);
        assert_eq!(page.total, 3);
        assert_eq!(page.next_cursor.as_deref(), Some("2"));

        let last = slice_page(vec![1, 2, 3], Some("2"), Some("2")).unwrap();
        assert_eq!(last.items, vec![3]);
        assert!(last.next_cursor.is_none());

        assert!(slice_page(vec![1], None, Some("nope")).is_err());
    }
}
