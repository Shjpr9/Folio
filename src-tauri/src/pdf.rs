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

pub fn startup_paths(directory: &Path) -> Result<Vec<PathBuf>, String> {
    let settings = crate::settings::load(directory)?;
    if !settings.reopen_last_pdf {
        return Ok(Vec::new());
    }
    Ok(settings
        .open_pdf_paths
        .unwrap_or_else(|| settings.last_pdf_path.into_iter().collect())
        .into_iter()
        .map(PathBuf::from)
        .collect())
}

#[derive(Default)]
pub struct PdfSession {
    pub authorized: std::sync::Mutex<std::collections::HashSet<PathBuf>>,
}

#[derive(serde::Serialize)]
pub struct PdfFile {
    name: String,
    path: String,
}

impl PdfSession {
    pub fn authorize(&self, path: PathBuf) -> Result<PdfFile, String> {
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("document.pdf")
            .to_owned();
        let text = path
            .to_str()
            .ok_or("The PDF path is not valid Unicode. Rename it and try again.")?
            .to_owned();
        self.authorized
            .lock()
            .map_err(|_| "Could not select the PDF.")?
            .insert(path);
        Ok(PdfFile { name, path: text })
    }

    pub fn selected_path(&self, path: &str) -> Result<PathBuf, String> {
        self.authorized
            .lock()
            .map_err(|_| "Could not access the selected PDF.")?
            .get(Path::new(path))
            .cloned()
            .ok_or("Choose a PDF with Open PDF first.".into())
    }
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn choose_pdf(session: tauri::State<'_, PdfSession>) -> Result<Option<PdfFile>, String> {
    let path = tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("Open PDF")
            .add_filter("PDF documents", &["pdf"])
            .pick_file()
    })
    .await
    .map_err(|_| "Could not open the file picker.")?;
    path.map(|path| {
        check_file(&path)?;
        let path = path
            .canonicalize()
            .map_err(|_| "Could not locate the selected PDF.")?;
        session.authorize(path)
    })
    .transpose()
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn restore_pdf(
    app: tauri::AppHandle,
    session: tauri::State<'_, PdfSession>,
) -> Result<Vec<PdfFile>, String> {
    use tauri::Manager;
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|_| "Could not locate the app config directory.")?;
    startup_paths(&directory)?
        .into_iter()
        .map(|path| session.authorize(path))
        .collect()
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn read_selected_pdf(
    path: String,
    session: tauri::State<'_, PdfSession>,
) -> Result<tauri::ipc::Response, String> {
    let path = session.selected_path(&path)?;
    let bytes = tauri::async_runtime::spawn_blocking(move || read_pdf_file(&path))
        .await
        .map_err(|_| "Could not read the PDF.")??;
    Ok(tauri::ipc::Response::new(bytes))
}
