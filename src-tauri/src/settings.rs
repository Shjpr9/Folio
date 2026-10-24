use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Deserialize, Serialize)]
#[serde(default)]
pub struct Settings {
    pub endpoint_url: String,
    pub api_key: String,
    pub model: String,
    pub theme: Theme,
    pub zoom: Option<f64>,
    pub recolor_pdf: bool,
    pub reading_positions: Vec<ReadingPosition>,
    pub reopen_last_pdf: bool,
    pub last_pdf_path: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            endpoint_url: String::new(),
            api_key: String::new(),
            model: String::new(),
            theme: Theme::default(),
            zoom: None,
            recolor_pdf: false,
            reading_positions: Vec::new(),
            reopen_last_pdf: true,
            last_pdf_path: None,
        }
    }
}

#[derive(Deserialize, Serialize)]
pub struct ReadingPosition {
    pub document_id: String,
    pub page: u32,
}

impl Settings {
    fn validate(&self) -> Result<(), String> {
        if self
            .last_pdf_path
            .as_ref()
            .is_some_and(|path| path.len() > 32768 || !Path::new(path).is_absolute())
        {
            return Err("The last PDF path must be an absolute local path.".into());
        }
        if self.reading_positions.len() > 100
            || self.reading_positions.iter().any(|position| {
                position.document_id.is_empty()
                    || position.document_id.len() > 256
                    || position.page == 0
            })
        {
            return Err("Invalid saved reading positions.".into());
        }
        if self.endpoint_url.len() > 4096 || self.api_key.len() > 16384 || self.model.len() > 512 {
            return Err("The provider settings are too long.".into());
        }
        if !self.endpoint_url.is_empty() {
            crate::ai::endpoint(&self.endpoint_url)?;
        }
        if self
            .zoom
            .is_some_and(|zoom| !zoom.is_finite() || !(0.35..=2.5).contains(&zoom))
        {
            return Err("Saved zoom must be between 35% and 250%.".into());
        }
        Ok(())
    }
}

pub fn load(directory: &Path) -> Result<Settings, String> {
    let file = match fs::File::open(directory.join("settings.json")) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Settings::default())
        }
        Err(_) => {
            return Err(
                "Could not read saved settings. Check the app config directory permissions.".into(),
            )
        }
    };
    let mut bytes = Vec::new();
    file.take(65537)
        .read_to_end(&mut bytes)
        .map_err(|_| "Could not read saved settings.")?;
    if bytes.len() > 65536 {
        return Err("The saved settings file is too large.".into());
    }
    let settings: Settings = serde_json::from_slice(&bytes)
        .map_err(|_| "The saved settings file is invalid. Open Settings to replace it.")?;
    settings.validate()?;
    Ok(settings)
}

pub fn save(directory: &Path, settings: &Settings) -> Result<(), String> {
    settings.validate()?;
    let bytes = serde_json::to_vec_pretty(settings).map_err(|_| "Could not encode settings.")?;
    if bytes.len() > 65536 {
        return Err("The encoded settings are too large.".into());
    }
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(directory)
        .map_err(|_| "Could not create the app config directory.")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
            .map_err(|_| "Could not protect the app config directory.")?;
    }
    let temporary = directory.join(format!("settings-{}.tmp", std::process::id()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|_| "Could not create the settings file. Check config directory permissions.")?;
    let result = (|| {
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, directory.join("settings.json"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|_| "Could not save settings. Your previous settings have been kept.".into())
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn load_settings(app: tauri::AppHandle) -> Result<Settings, String> {
    use tauri::Manager;
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|_| "Could not locate the app config directory.")?;
    load(&directory)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn save_settings(
    app: tauri::AppHandle,
    mut settings: Settings,
    session: tauri::State<'_, crate::pdf::PdfSession>,
) -> Result<(), String> {
    use tauri::Manager;
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|_| "Could not locate the app config directory.")?;
    // Only the native file picker/startup restore can authorize a remembered path.
    settings.last_pdf_path = session
        .opened
        .lock()
        .map_err(|_| "Could not access the open PDF.")?
        .as_ref()
        .map(|path| path.to_string_lossy().into_owned())
        .or_else(|| load(&directory).ok().and_then(|saved| saved.last_pdf_path));
    save(&directory, &settings)
}
