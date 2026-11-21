use std::io::{self, Read, Write};

pub const MAX_MESSAGE: usize = 64 * 1024;

pub type Object = serde_json::Map<String, serde_json::Value>;

#[derive(Debug)]
pub enum FrameError {
    Eof,

    Truncated,
    Empty,
    TooLarge(u64),
    NotJson,
    Io(io::Error),
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FrameError::Eof => write!(f, "end of stream"),
            FrameError::Truncated => write!(f, "truncated frame"),
            FrameError::Empty => write!(f, "empty frame"),
            FrameError::TooLarge(n) => write!(f, "frame of {n} bytes is over the limit"),
            FrameError::NotJson => write!(f, "frame is not a UTF-8 JSON object"),
            FrameError::Io(e) => write!(f, "{e}"),
        }
    }
}

fn fill<R: Read>(reader: &mut R, buf: &mut [u8], at_boundary: bool) -> Result<(), FrameError> {
    let mut filled = 0;
    while filled < buf.len() {
        match reader.read(&mut buf[filled..]) {
            Ok(0) if filled == 0 && at_boundary => return Err(FrameError::Eof),
            Ok(0) => return Err(FrameError::Truncated),
            Ok(n) => filled += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(FrameError::Io(e)),
        }
    }
    Ok(())
}

pub fn read_frame<R: Read>(reader: &mut R) -> Result<Vec<u8>, FrameError> {
    let mut prefix = [0u8; 4];
    fill(reader, &mut prefix, true)?;
    let length = u32::from_ne_bytes(prefix) as u64;
    if length == 0 {
        return Err(FrameError::Empty);
    }
    if length > MAX_MESSAGE as u64 {
        return Err(FrameError::TooLarge(length));
    }
    let mut body = vec![0u8; length as usize];
    fill(reader, &mut body, false)?;
    Ok(body)
}

pub fn read_object<R: Read>(reader: &mut R) -> Result<Object, FrameError> {
    let body = read_frame(reader)?;
    match serde_json::from_slice::<serde_json::Value>(&body) {
        Ok(serde_json::Value::Object(map)) => Ok(map),
        _ => Err(FrameError::NotJson),
    }
}

pub fn encode(body: &[u8]) -> io::Result<Vec<u8>> {
    if body.is_empty() || body.len() > MAX_MESSAGE {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "message size"));
    }
    let mut out = Vec::with_capacity(4 + body.len());
    out.extend_from_slice(&(body.len() as u32).to_ne_bytes());
    out.extend_from_slice(body);
    Ok(out)
}

pub fn write_frame<W: Write>(writer: &mut W, body: &[u8]) -> io::Result<()> {
    writer.write_all(&encode(body)?)?;
    writer.flush()
}

pub fn write_object<W: Write>(writer: &mut W, value: &serde_json::Value) -> io::Result<()> {
    write_frame(writer, &serde_json::to_vec(value)?)
}
