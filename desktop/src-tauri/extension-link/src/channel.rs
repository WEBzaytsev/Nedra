use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use hkdf::Hkdf;
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

pub const LABEL: &str = "nedra/extension/v1";
pub const TO_APP: u8 = 0x01;
pub const TO_EXTENSION: u8 = 0x02;

pub const MAX_MESSAGES: u64 = 1 << 32;

#[derive(Debug, PartialEq, Eq)]
pub enum ChannelError {
    WeakKey,

    Refused,
    Exhausted,
}

pub type Key = Zeroizing<[u8; 32]>;

fn lp(out: &mut Vec<u8>, data: &[u8]) {
    out.extend_from_slice(&(data.len() as u16).to_be_bytes());
    out.extend_from_slice(data);
}

fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

fn hkdf(ikm: &[u8], salt: &[u8], info: &str, out: &mut [u8]) {
    Hkdf::<Sha256>::new(Some(salt), ikm)
        .expand(info.as_bytes(), out)
        .expect("HKDF output length is valid");
}

pub fn random<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    getrandom::getrandom(&mut out).expect("the operating system's random source");
    out
}

pub fn commit(public: &[u8; 32], nonce: &[u8; 16]) -> [u8; 32] {
    let mut data = Vec::new();
    lp(&mut data, format!("{LABEL}/commit").as_bytes());
    data.extend_from_slice(public);
    data.extend_from_slice(nonce);
    sha256(&data)
}

pub fn transcript(
    browser: &str,
    extension_public: &[u8; 32],
    extension_nonce: &[u8; 16],
    app_public: &[u8; 32],
    app_nonce: &[u8; 16],
) -> [u8; 32] {
    let mut data = Vec::new();
    lp(&mut data, format!("{LABEL}/pair").as_bytes());
    lp(&mut data, browser.as_bytes());
    data.extend_from_slice(extension_public);
    data.extend_from_slice(extension_nonce);
    data.extend_from_slice(app_public);
    data.extend_from_slice(app_nonce);
    sha256(&data)
}

pub struct Exchange {
    secret: StaticSecret,
    pub public: [u8; 32],
}

impl Exchange {
    pub fn new() -> Self {
        Self::from_private(Zeroizing::new(random::<32>()))
    }

    pub fn from_private(private: Zeroizing<[u8; 32]>) -> Self {
        let secret = StaticSecret::from(*private);
        let public = PublicKey::from(&secret).to_bytes();
        Self { secret, public }
    }

    pub fn finish(&self, peer: &[u8; 32], transcript: &[u8; 32]) -> Result<Paired, ChannelError> {
        let shared = self.secret.diffie_hellman(&PublicKey::from(*peer));
        if !shared.was_contributory() {
            return Err(ChannelError::WeakKey);
        }
        let mut sas = [0u8; 4];
        hkdf(
            shared.as_bytes(),
            transcript,
            &format!("{LABEL}/sas"),
            &mut sas,
        );
        let mut key = Zeroizing::new([0u8; 32]);
        hkdf(
            shared.as_bytes(),
            transcript,
            &format!("{LABEL}/channel"),
            &mut key[..],
        );
        Ok(Paired {
            sas: format!("{:06}", u32::from_be_bytes(sas) % 1_000_000),
            key,
        })
    }
}

impl Default for Exchange {
    fn default() -> Self {
        Self::new()
    }
}

pub struct Paired {
    pub sas: String,
    pub key: Key,
}

pub fn connection_key(
    pairing_key: &[u8; 32],
    pairing_id: &[u8; 16],
    extension_nonce: &[u8; 16],
    app_nonce: &[u8; 16],
) -> Key {
    let mut salt = Vec::new();
    lp(&mut salt, format!("{LABEL}/connection").as_bytes());
    salt.extend_from_slice(pairing_id);
    salt.extend_from_slice(extension_nonce);
    salt.extend_from_slice(app_nonce);
    let mut key = Zeroizing::new([0u8; 32]);
    hkdf(
        pairing_key,
        &sha256(&salt),
        &format!("{LABEL}/connection"),
        &mut key[..],
    );
    key
}

fn nonce_and_ad(direction: u8, counter: u64) -> ([u8; 12], [u8; 9]) {
    let mut nonce = [0u8; 12];
    nonce[0] = direction;
    nonce[4..].copy_from_slice(&counter.to_be_bytes());
    let mut ad = [0u8; 9];
    ad[0] = direction;
    ad[1..].copy_from_slice(&counter.to_be_bytes());
    (nonce, ad)
}

pub fn seal(key: &[u8; 32], direction: u8, counter: u64, plaintext: &[u8]) -> Vec<u8> {
    let (nonce, ad) = nonce_and_ad(direction, counter);
    Aes256Gcm::new(key.into())
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: &ad,
            },
        )
        .expect("AES-GCM encryption of a bounded message")
}

pub fn open(
    key: &[u8; 32],
    direction: u8,
    counter: u64,
    ciphertext: &[u8],
) -> Result<Vec<u8>, ChannelError> {
    let (nonce, ad) = nonce_and_ad(direction, counter);
    Aes256Gcm::new(key.into())
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: ciphertext,
                aad: &ad,
            },
        )
        .map_err(|_| ChannelError::Refused)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Side {
    App,
    Extension,
}

pub struct Channel {
    key: Key,
    sends: u8,
    receives: u8,
    sent: u64,
    received: u64,
}

impl Channel {
    pub fn new(key: Key, side: Side) -> Self {
        let (sends, receives) = match side {
            Side::App => (TO_EXTENSION, TO_APP),
            Side::Extension => (TO_APP, TO_EXTENSION),
        };
        Self {
            key,
            sends,
            receives,
            sent: 0,
            received: 0,
        }
    }

    pub fn seal(&mut self, plaintext: &[u8]) -> Result<(u64, Vec<u8>), ChannelError> {
        if self.sent >= MAX_MESSAGES {
            return Err(ChannelError::Exhausted);
        }
        let counter = self.sent;
        self.sent += 1;
        Ok((counter, seal(&self.key, self.sends, counter, plaintext)))
    }

    pub fn open(&mut self, counter: u64, ciphertext: &[u8]) -> Result<Vec<u8>, ChannelError> {
        if counter != self.received || self.received >= MAX_MESSAGES {
            return Err(ChannelError::Refused);
        }
        let plaintext = open(&self.key, self.receives, counter, ciphertext)?;
        self.received += 1;
        Ok(plaintext)
    }
}
