use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

const MAX_PDF_BYTES: u64 = 100 * 1024 * 1024;

fn check_file(path: &Path) -> Result<(), String> {
    let metadata = fs::metadata(path)
        .map_err(|_| "The PDF is missing or inaccessible. Choose it again with Open PDF.")?;
    if !metadata.is_file() {
        return Err("Choose a PDF file, not a folder.".into());
    }
    if metadata.len() > MAX_PDF_BYTES {
        return Err("Please open a PDF smaller than 100 MiB.".into());
    }
    Ok(())
}

pub fn read_pdf_file(path: &Path) -> Result<Vec<u8>, String> {
    check_file(path)?;
    let file = fs::File::open(path).map_err(|_| "Could not read the selected PDF.")?;
    let mut bytes = Vec::new();
    file.take(MAX_PDF_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Could not read the selected PDF.")?;
    if bytes.len() as u64 > MAX_PDF_BYTES {
        return Err("Please open a PDF smaller than 100 MiB.".into());
    }
    if !bytes[..bytes.len().min(1024)]
        .windows(5)
        .any(|header| header == b"%PDF-")
    {
        return Err("The selected file is not a PDF.".into());
    }
    Ok(bytes)
}

pub fn startup_path(directory: &Path) -> Result<Option<PathBuf>, String> {
    let settings = crate::settings::load(directory)?;
    if !settings.reopen_last_pdf {
        return Ok(None);
    }
    let Some(path) = settings.last_pdf_path.map(PathBuf::from) else {
        return Ok(None);
    };
    check_file(&path)?;
    Ok(Some(path))
}

#[cfg(feature = "desktop")]
#[derive(Default)]
pub struct PdfSession {
    selected: std::sync::Mutex<Option<PathBuf>>,
    pub opened: std::sync::Mutex<Option<PathBuf>>,
}

#[cfg(feature = "desktop")]
impl PdfSession {
    fn select(&self, path: PathBuf) -> Result<String, String> {
        check_file(&path)?;
        let path = path
            .canonicalize()
            .map_err(|_| "Could not locate the selected PDF.")?;
        if path.to_str().is_none() {
            return Err("The PDF path is not valid Unicode. Rename it and try again.".into());
        }
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("document.pdf")
            .to_owned();
        *self
            .selected
            .lock()
            .map_err(|_| "Could not select the PDF.")? = Some(path);
        Ok(name)
    }
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn choose_pdf(session: tauri::State<'_, PdfSession>) -> Result<Option<String>, String> {
    let path = tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("Open PDF")
            .add_filter("PDF documents", &["pdf"])
            .pick_file()
    })
    .await
    .map_err(|_| "Could not open the file picker.")?;
    path.map(|path| session.select(path)).transpose()
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn restore_pdf(
    app: tauri::AppHandle,
    session: tauri::State<'_, PdfSession>,
) -> Result<Option<String>, String> {
    use tauri::Manager;
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|_| "Could not locate the app config directory.")?;
    startup_path(&directory)?
        .map(|path| session.select(path))
        .transpose()
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn read_selected_pdf(
    session: tauri::State<'_, PdfSession>,
) -> Result<tauri::ipc::Response, String> {
    let path = session
        .selected
        .lock()
        .map_err(|_| "Could not access the selected PDF.")?
        .clone()
        .ok_or("Choose a PDF first.")?;
    let bytes = tauri::async_runtime::spawn_blocking(move || read_pdf_file(&path))
        .await
        .map_err(|_| "Could not read the PDF.")??;
    Ok(tauri::ipc::Response::new(bytes))
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn remember_pdf(session: tauri::State<'_, PdfSession>) -> Result<(), String> {
    let path = session
        .selected
        .lock()
        .map_err(|_| "Could not access the selected PDF.")?
        .clone()
        .ok_or("Choose a PDF first.")?;
    *session
        .opened
        .lock()
        .map_err(|_| "Could not remember the PDF.")? = Some(path);
    Ok(())
}
