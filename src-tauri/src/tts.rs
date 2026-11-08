//! Optional speech runtime. No inference code or model is linked into Folio.
use reqwest::{redirect::Policy, Client};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};

const PACK: &str = "pocket-v4-alba-1";
const MAX_AUDIO: usize = 12 * 1024 * 1024;

#[derive(Clone, Deserialize)]
pub struct Artifact {
    pub name: String,
    pub url: String,
    pub size: u64,
    pub sha256: String,
}
#[derive(Deserialize)]
struct Catalog {
    engines: HashMap<String, Artifact>,
    assets: Vec<Artifact>,
}
fn catalog() -> Catalog {
    serde_json::from_str(include_str!("tts_catalog.json")).expect("bundled speech catalog")
}
pub fn platform() -> String {
    let arch = std::env::consts::ARCH;
    let os = match std::env::consts::OS {
        "linux" => "unknown-linux-gnu",
        "macos" => "apple-darwin",
        "windows" => "pc-windows-msvc",
        _ => "unsupported",
    };
    format!("{arch}-{os}")
}
fn executable(dir: &Path) -> PathBuf {
    dir.join(if cfg!(windows) {
        "pocket-tts.exe"
    } else {
        "pocket-tts"
    })
}

#[derive(Clone, Default, Serialize)]
pub struct Status {
    pub supported: bool,
    pub installed: bool,
    pub phase: String,
    pub downloaded: u64,
    pub total: u64,
    pub message: String,
}
#[derive(Deserialize, Serialize)]
struct Installation {
    engine_size: u64,
    engine_sha256: String,
}
struct Engine {
    child: Child,
    port: u16,
}
impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
#[derive(Default)]
pub struct TtsManager {
    status: Mutex<Status>,
    engine: Mutex<Option<Engine>>,
    generation: AtomicU64,
    download_generation: AtomicU64,
    operation: tokio::sync::Mutex<()>,
}
impl Drop for TtsManager {
    fn drop(&mut self) {
        self.stop();
    }
}

pub fn verify_file(path: &Path, size: u64, expected: &str) -> Result<(), String> {
    if fs::metadata(path)
        .map_err(|_| "A speech download is missing.")?
        .len()
        != size
    {
        return Err("Speech download has an incorrect size. Retry the download.".into());
    }
    if file_hash(path)? != expected {
        return Err(
            "Speech download failed its SHA-256 integrity check. Retry the download.".into(),
        );
    }
    Ok(())
}
fn file_hash(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|_| "Could not read the speech download.")?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        let n = file
            .read(&mut buffer)
            .map_err(|_| "Could not verify the speech download.")?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
pub fn validate_text(text: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("There is no text to read aloud.".into());
    }
    if text.chars().count() > 600 {
        return Err("Read-aloud chunks must be at most 600 characters.".into());
    }
    Ok(())
}
fn installed(dir: &Path) -> Option<Installation> {
    let bytes = fs::read(dir.join("installation.json")).ok()?;
    if bytes.len() > 1024 {
        return None;
    }
    let manifest: Installation = serde_json::from_slice(&bytes).ok()?;
    if manifest.engine_size == 0
        || fs::metadata(executable(dir)).ok()?.len() != manifest.engine_size
    {
        return None;
    }
    for asset in catalog().assets {
        if fs::metadata(dir.join(asset.name)).ok()?.len() != asset.size {
            return None;
        }
    }
    if !dir.join("model.yaml").is_file() {
        return None;
    }
    Some(manifest)
}
fn client() -> Result<Client, String> {
    Client::builder()
        .user_agent("Folio/0.2 speech-download")
        .https_only(true)
        .redirect(Policy::limited(10))
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(45))
        .timeout(Duration::from_secs(900))
        .build()
        .map_err(|_| "Could not initialize speech downloads.".into())
}
fn local_client() -> Result<Client, String> {
    Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_millis(500))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|_| "Could not initialize the speech connection.".into())
}
impl TtsManager {
    pub fn status(&self, base: &Path) -> Status {
        let mut state = self
            .status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let catalog = catalog();
        let engine = catalog.engines.get(&platform());
        state.supported = engine.is_some();
        state.total =
            engine.map_or(0, |a| a.size) + catalog.assets.iter().map(|a| a.size).sum::<u64>();
        state.installed = installed(&base.join(PACK)).is_some();
        if state.phase.is_empty() {
            state.phase = "idle".into();
        }
        state
    }
    fn update(&self, phase: &str, message: &str) {
        let mut state = self.status.lock().unwrap_or_else(|e| e.into_inner());
        state.phase = phase.into();
        state.message = message.into();
    }
    pub fn is_current(&self, generation: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == generation
    }
    fn check(&self, generation: u64) -> Result<(), String> {
        if self.is_current(generation) {
            Ok(())
        } else {
            Err("Read aloud cancelled.".into())
        }
    }
    async fn cancelled(&self, generation: u64) {
        while self.download_generation.load(Ordering::SeqCst) == generation {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    fn check_download(&self, generation: u64) -> Result<(), String> {
        if self.download_generation.load(Ordering::SeqCst) == generation {
            Ok(())
        } else {
            Err("Read aloud download cancelled.".into())
        }
    }
    pub fn cancel_install(&self) {
        self.download_generation.fetch_add(1, Ordering::SeqCst);
    }
    pub fn stop(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.engine.lock().unwrap_or_else(|e| e.into_inner()).take();
    }
    pub fn begin(&self) -> u64 {
        self.stop();
        self.generation.load(Ordering::SeqCst)
    }

    pub async fn install(&self, base: &Path) -> Result<(), String> {
        let _operation = self
            .operation
            .try_lock()
            .map_err(|_| "Another speech operation is still finishing. Try again.")?;
        let cat = catalog();
        let artifact = cat
            .engines
            .get(&platform())
            .ok_or("Read aloud is not available for this operating system or CPU yet.")?;
        if installed(&base.join(PACK)).is_some() {
            return Ok(());
        }
        self.stop();
        let generation = self.download_generation.load(Ordering::SeqCst);
        self.status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .downloaded = 0;
        self.update("installing", "Downloading the speech engine…");
        let staging = base.join(format!("{PACK}.partial"));
        let result = async {
            fs::create_dir_all(base).map_err(|_| {
                "Could not create speech storage. Check available disk space and permissions."
            })?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(base, fs::Permissions::from_mode(0o700))
                    .map_err(|_| "Could not protect speech storage.")?;
            }
            if staging.exists() {
                fs::remove_dir_all(&staging)
                    .map_err(|_| "Could not clear an interrupted speech download.")?;
            }
            fs::create_dir(&staging).map_err(|_| "Could not create speech download storage.")?;
            let http = client()?;
            self.download(&http, artifact, &staging.join("engine.archive"), generation)
                .await?;
            self.check_download(generation)?;
            extract_engine(
                &staging.join("engine.archive"),
                &executable(&staging),
                artifact.name.ends_with(".zip"),
            )?;
            fs::remove_file(staging.join("engine.archive"))
                .map_err(|_| "Could not finish the speech engine download.")?;
            for asset in &cat.assets {
                self.update(
                    "installing",
                    &format!("Downloading English voice: {}…", asset.name),
                );
                self.download(&http, asset, &staging.join(&asset.name), generation)
                    .await?;
            }
            self.check_download(generation)?;
            let final_dir = base.join(PACK);
            write_config(&staging, &final_dir)?;
            fs::write(
                staging.join("LICENSE.txt"),
                include_str!("pocket-tts-LICENSE.txt"),
            )
            .map_err(|_| "Could not save the speech engine license.")?;
            let manifest = Installation {
                engine_size: fs::metadata(executable(&staging))
                    .map_err(|_| "Speech engine is missing.")?
                    .len(),
                engine_sha256: file_hash(&executable(&staging))?,
            };
            fs::write(
                staging.join("installation.json"),
                serde_json::to_vec(&manifest).unwrap(),
            )
            .map_err(|_| "Could not finish speech installation.")?;
            if final_dir.exists() {
                fs::remove_dir_all(&final_dir)
                    .map_err(|_| "Could not replace the incomplete speech pack.")?;
            }
            self.check_download(generation)?;
            fs::rename(&staging, &final_dir)
                .map_err(|_| "Could not finish speech installation. Check disk space.")?;
            Ok::<_, String>(())
        }
        .await;
        if result.is_err() {
            let _ = fs::remove_dir_all(&staging);
        }
        self.update(
            "idle",
            if result.is_ok() {
                "English · Alba is ready. Speech stays on your device."
            } else {
                "Download stopped. You can retry."
            },
        );
        result
    }

    pub async fn download(
        &self,
        http: &Client,
        asset: &Artifact,
        destination: &Path,
        generation: u64,
    ) -> Result<(), String> {
        self.check_download(generation)?;
        let mut response = tokio::select! {
            result = http.get(&asset.url).send() => result.map_err(|_| "Could not download speech files. Check your connection and retry.")?,
            _ = self.cancelled(generation) => return Err("Read aloud cancelled.".into()),
        };
        if !response.status().is_success() {
            return Err(format!(
                "Speech download returned HTTP {}. Retry later.",
                response.status().as_u16()
            ));
        }
        let mut file = File::create(destination)
            .map_err(|_| "Could not save the speech download. Check disk space.")?;
        let mut size = 0;
        let mut hash = Sha256::new();
        loop {
            let next = tokio::select! {
                next = response.chunk() => next.map_err(|_| "Speech download was interrupted. Retry the download.")?,
                _ = tokio::time::sleep(Duration::from_millis(150)) => { self.check_download(generation)?; continue; }
            };
            let Some(chunk) = next else {
                break;
            };
            self.check_download(generation)?;
            size += chunk.len() as u64;
            if size > asset.size {
                return Err("Speech download exceeded its expected size.".into());
            }
            file.write_all(&chunk)
                .map_err(|_| "Could not save speech files. Check available disk space.")?;
            hash.update(&chunk);
            self.status
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .downloaded += chunk.len() as u64;
        }
        self.check_download(generation)?;
        if size != asset.size || format!("{:x}", hash.finalize()) != asset.sha256 {
            return Err("Speech download failed its integrity check. Retry the download.".into());
        }
        file.sync_all()
            .map_err(|_| "Could not save the speech download.")?;
        Ok(())
    }

    pub async fn remove(&self, base: &Path) -> Result<(), String> {
        self.cancel_install();
        self.stop();
        let _operation = self.operation.lock().await;
        for dir in [base.join(PACK), base.join(format!("{PACK}.partial"))] {
            if dir.exists() {
                fs::remove_dir_all(dir).map_err(|_| {
                    "Could not remove speech files. Check permissions and try again."
                })?;
            }
        }
        self.update("idle", "Read aloud removed. You can download it again.");
        Ok(())
    }

    pub async fn synthesize(
        &self,
        base: &Path,
        text: &str,
        generation: u64,
    ) -> Result<Vec<u8>, String> {
        validate_text(text)?;
        self.check(generation)?;
        let _operation = self.operation.lock().await;
        self.check(generation)?;
        let dir = base.join(PACK);
        let manifest = installed(&dir).ok_or("Download read aloud in Settings first.")?;
        let http = local_client()?;
        let existing = self
            .engine
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|engine| engine.port);
        let port = if let Some(port) = existing {
            port
        } else {
            verify_file(
                &executable(&dir),
                manifest.engine_size,
                &manifest.engine_sha256,
            )?;
            let listener = TcpListener::bind("127.0.0.1:0")
                .map_err(|_| "Could not reserve a local speech connection.")?;
            let port = listener
                .local_addr()
                .map_err(|_| "Could not read the speech port.")?
                .port();
            let mut command = Command::new(executable(&dir));
            command
                .args([
                    "serve",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    &port.to_string(),
                    "--config",
                ])
                .arg(dir.join("model.yaml"))
                .arg("--default-voice")
                .arg(dir.join("voice.safetensors"))
                .arg("--quantize")
                .env("RAYON_NUM_THREADS", "2")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000);
            }
            drop(listener);
            {
                let mut engine = self.engine.lock().unwrap_or_else(|e| e.into_inner());
                self.check(generation)?;
                let child = command.spawn().map_err(|_| {
                    "Could not start the speech engine. Remove and download read aloud again."
                })?;
                *engine = Some(Engine { child, port });
            }
            let deadline = Instant::now() + Duration::from_secs(90);
            loop {
                self.check(generation)?;
                if http
                    .get(format!("http://127.0.0.1:{port}/health"))
                    .timeout(Duration::from_millis(700))
                    .send()
                    .await
                    .is_ok_and(|r| r.status().is_success())
                {
                    break;
                }
                let exited = self
                    .engine
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .as_mut()
                    .and_then(|e| e.child.try_wait().ok())
                    .flatten()
                    .is_some();
                if exited || Instant::now() >= deadline {
                    self.engine.lock().unwrap_or_else(|e| e.into_inner()).take();
                    return Err("The speech engine could not load the voice. Remove and download read aloud again.".into());
                }
                tokio::time::sleep(Duration::from_millis(150)).await;
            }
            port
        };
        self.check(generation)?;
        let result = async {
            let mut response = http
                .post(format!("http://127.0.0.1:{port}/tts"))
                .form(&[("text", text)])
                .send()
                .await
                .map_err(|_| "The speech engine stopped responding. Try reading again.")?;
            if !response.status().is_success() {
                return Err(
                    "The speech engine could not read this passage. Try a shorter selection."
                        .into(),
                );
            }
            let mut audio = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| "Could not receive speech audio.")?
            {
                self.check(generation)?;
                if audio.len() + chunk.len() > MAX_AUDIO {
                    return Err("The speech audio exceeded its size limit.".into());
                }
                audio.extend_from_slice(&chunk);
            }
            self.check(generation)?;
            finish_wav(&mut audio)?;
            Ok(audio)
        }
        .await;
        if result.is_err() {
            self.engine.lock().unwrap_or_else(|e| e.into_inner()).take();
        }
        result
    }
}

pub fn write_config(destination: &Path, final_dir: &Path) -> Result<(), String> {
    let quoted =
        |name: &str| serde_json::to_string(&final_dir.join(name).to_string_lossy()).unwrap();
    let config = include_str!("tts_english.yaml")
        .replace("__MODEL__", &quoted("model.safetensors"))
        .replace("__TOKENIZER__", &quoted("tokenizer.json"));
    fs::write(destination.join("model.yaml"), config)
        .map_err(|_| "Could not save speech configuration.".into())
}
pub fn finish_wav(audio: &mut [u8]) -> Result<(), String> {
    if audio.len() < 44 || &audio[..4] != b"RIFF" || &audio[8..12] != b"WAVE" {
        return Err("The speech engine returned invalid audio.".into());
    }
    let length = audio.len();
    audio[4..8].copy_from_slice(&((length - 8) as u32).to_le_bytes());
    let mut offset = 12;
    while offset + 8 <= length {
        if &audio[offset..offset + 4] == b"data" {
            audio[offset + 4..offset + 8]
                .copy_from_slice(&((length - offset - 8) as u32).to_le_bytes());
            return if length > offset + 8 {
                Ok(())
            } else {
                Err("The speech engine returned empty audio.".into())
            };
        }
        let size = u32::from_le_bytes(audio[offset + 4..offset + 8].try_into().unwrap()) as usize;
        offset = offset
            .checked_add(8 + size + size % 2)
            .ok_or("Invalid speech audio.")?;
    }
    Err("The speech engine returned invalid audio.".into())
}
fn copy_engine(mut input: impl Read, output: &Path) -> Result<(), String> {
    let mut file = File::create(output).map_err(|_| "Could not save the speech engine.")?;
    let count = std::io::copy(&mut input.by_ref().take(64 * 1024 * 1024 + 1), &mut file)
        .map_err(|_| "Could not extract the speech engine.")?;
    if count == 0 || count > 64 * 1024 * 1024 {
        return Err("Invalid speech engine size.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(output, fs::Permissions::from_mode(0o700))
            .map_err(|_| "Could not make the speech engine executable.")?;
    }
    Ok(())
}
pub fn extract_engine(archive: &Path, output: &Path, is_zip: bool) -> Result<(), String> {
    let file = File::open(archive).map_err(|_| "Could not open the speech engine download.")?;
    if is_zip {
        #[cfg(windows)]
        {
            let mut archive =
                zip::ZipArchive::new(file).map_err(|_| "Invalid speech engine archive.")?;
            for i in 0..archive.len() {
                let entry = archive
                    .by_index(i)
                    .map_err(|_| "Invalid speech engine archive.")?;
                if Path::new(entry.name())
                    .file_name()
                    .is_some_and(|n| n == "pocket-tts.exe")
                    && entry.is_file()
                {
                    return copy_engine(entry, output);
                }
            }
        }
        #[cfg(not(windows))]
        {
            drop(file);
        }
    } else {
        let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(file));
        for entry in archive
            .entries()
            .map_err(|_| "Invalid speech engine archive.")?
        {
            let entry = entry.map_err(|_| "Invalid speech engine archive.")?;
            if entry.header().entry_type().is_file()
                && entry
                    .path()
                    .map_err(|_| "Invalid speech engine archive.")?
                    .file_name()
                    .is_some_and(|n| n == "pocket-tts")
            {
                return copy_engine(entry, output);
            }
        }
    }
    Err("The download did not contain a speech engine for this platform.".into())
}

#[cfg(feature = "desktop")]
fn directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("tts"))
        .map_err(|_| "Could not locate speech storage.".into())
}
#[cfg(feature = "desktop")]
#[tauri::command]
pub fn tts_status(
    app: tauri::AppHandle,
    manager: tauri::State<'_, TtsManager>,
) -> Result<Status, String> {
    Ok(manager.status(&directory(&app)?))
}
#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn tts_install(
    app: tauri::AppHandle,
    manager: tauri::State<'_, TtsManager>,
) -> Result<(), String> {
    manager.install(&directory(&app)?).await
}
#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn tts_remove(
    app: tauri::AppHandle,
    manager: tauri::State<'_, TtsManager>,
) -> Result<(), String> {
    manager.remove(&directory(&app)?).await
}
#[cfg(feature = "desktop")]
#[tauri::command]
pub fn tts_stop(manager: tauri::State<'_, TtsManager>) {
    manager.stop();
}
#[cfg(feature = "desktop")]
#[tauri::command]
pub fn tts_cancel_install(manager: tauri::State<'_, TtsManager>) {
    manager.cancel_install();
}
#[cfg(feature = "desktop")]
#[tauri::command]
pub fn tts_begin(manager: tauri::State<'_, TtsManager>) -> u64 {
    manager.begin()
}
#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn tts_synthesize(
    app: tauri::AppHandle,
    manager: tauri::State<'_, TtsManager>,
    text: String,
    generation: u64,
) -> Result<tauri::ipc::Response, String> {
    manager
        .synthesize(&directory(&app)?, &text, generation)
        .await
        .map(tauri::ipc::Response::new)
}
