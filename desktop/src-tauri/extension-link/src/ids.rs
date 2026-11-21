pub const CHROMIUM_IDS: &[&str] = &["alkkfkojagimdnneandmpodagadmmmii"];

pub const FIREFOX_IDS: &[&str] = &["nedra@zaitsv.dev"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Caller {
    Chromium(String),
    Firefox(String),
}

impl Caller {
    pub fn origin(&self) -> String {
        match self {
            Caller::Chromium(id) => format!("chrome-extension://{id}/"),
            Caller::Firefox(id) => id.clone(),
        }
    }

    pub fn from_origin(origin: &str) -> Option<Caller> {
        if let Some(id) = origin
            .strip_prefix("chrome-extension://")
            .and_then(|rest| rest.strip_suffix('/'))
        {
            return CHROMIUM_IDS
                .contains(&id)
                .then(|| Caller::Chromium(id.to_string()));
        }
        FIREFOX_IDS
            .contains(&origin)
            .then(|| Caller::Firefox(origin.to_string()))
    }
}

pub fn caller_from_args(args: &[String]) -> Option<Caller> {
    match args {
        [origin, rest @ ..] if origin.starts_with("chrome-extension://") => {
            if rest.iter().any(|arg| !arg.starts_with("--parent-window=")) || rest.len() > 1 {
                return None;
            }
            Caller::from_origin(origin).filter(|c| matches!(c, Caller::Chromium(_)))
        }
        [_manifest, id] => Caller::from_origin(id).filter(|c| matches!(c, Caller::Firefox(_))),
        _ => None,
    }
}
