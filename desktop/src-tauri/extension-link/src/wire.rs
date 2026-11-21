use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde_json::{Map, Value};

pub fn b64(data: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(data)
}

pub fn unb64(text: &str) -> Option<Vec<u8>> {
    if text.len() > 96 * 1024 {
        return None;
    }
    URL_SAFE_NO_PAD.decode(text).ok()
}

pub fn kind(object: &Map<String, Value>) -> Option<&str> {
    object.get("t")?.as_str()
}

pub fn has_exactly(object: &Map<String, Value>, fields: &[&str]) -> bool {
    object.len() == fields.len() + 1
        && object.contains_key("t")
        && fields.iter().all(|field| object.contains_key(*field))
}

pub fn bytes<const N: usize>(object: &Map<String, Value>, field: &str) -> Option<[u8; N]> {
    let text = object.get(field)?.as_str()?;
    if text.len() > N.div_ceil(3) * 4 {
        return None;
    }
    unb64(text)?.try_into().ok()
}

pub fn text<'a>(object: &'a Map<String, Value>, field: &str, max: usize) -> Option<&'a str> {
    object
        .get(field)?
        .as_str()
        .filter(|value| value.len() <= max)
}

pub fn counter(object: &Map<String, Value>) -> Option<u64> {
    object.get("c")?.as_u64()
}
