//! Release gate using the same signature verifier as the official updater.
use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use std::{env, fs, path::Path};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();
    if args.len() != 5 {
        return Err("usage: verify_update PUBLIC_KEY_FILE ARTIFACT SIGNATURE_FILE VERSION".into());
    }
    let decode = |text: &str| -> Result<String, Box<dyn std::error::Error>> {
        Ok(String::from_utf8(
            base64::engine::general_purpose::STANDARD.decode(text.trim())?,
        )?)
    };
    let key = PublicKey::decode(&decode(&fs::read_to_string(&args[1])?)?)?;
    let signature = Signature::decode(&decode(&fs::read_to_string(&args[3])?)?)?;
    key.verify(&fs::read(&args[2])?, &signature, true)?;
    let fields: Vec<&str> = signature.trusted_comment().split('\t').collect();
    let version = format!("version:{}", args[4]);
    let file = format!(
        "file:{}",
        Path::new(&args[2]).file_name().unwrap().to_str().unwrap()
    );
    if !fields.contains(&version.as_str()) || !fields.contains(&file.as_str()) {
        return Err("signed version or filename mismatch".into());
    }
    println!(
        "Verified {}",
        Path::new(&args[2]).file_name().unwrap().display()
    );
    Ok(())
}
