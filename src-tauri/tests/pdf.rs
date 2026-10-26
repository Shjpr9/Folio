use folio::pdf::{read_pdf_file, startup_paths};
use folio::settings::{save, Settings};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "folio-pdf-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../tests/fixtures/reading.pdf")
        .canonicalize()
        .unwrap()
}

#[test]
fn reads_a_real_pdf_without_changing_it() {
    let path = fixture();
    let bytes = read_pdf_file(&path).unwrap();
    assert!(bytes.starts_with(b"%PDF-"));
    assert_eq!(bytes, std::fs::read(path).unwrap());
}

#[test]
fn rejects_missing_non_pdf_and_oversized_files() {
    let directory = Directory::new();
    assert!(read_pdf_file(&directory.0.join("missing.pdf")).is_err());
    assert!(read_pdf_file(&directory.0).is_err());
    let path = directory.0.join("invalid.pdf");
    std::fs::write(&path, "not a PDF").unwrap();
    assert!(read_pdf_file(&path).unwrap_err().contains("not a PDF"));
    std::fs::File::create(&path)
        .unwrap()
        .set_len(100 * 1024 * 1024 + 1)
        .unwrap();
    assert!(read_pdf_file(&path).unwrap_err().contains("100 MiB"));
}

#[test]
fn restores_the_saved_pdf_but_never_opens_it_when_disabled() {
    let directory = Directory::new();
    assert!(startup_paths(&directory.0).unwrap().is_empty());
    let path = fixture();
    let mut settings = Settings::default();
    settings.last_pdf_path = Some(path.to_str().unwrap().into());
    save(&directory.0, &settings).unwrap();
    assert_eq!(startup_paths(&directory.0).unwrap(), vec![path]);
    settings.reopen_last_pdf = false;
    settings.last_pdf_path = Some(directory.0.join("deleted.pdf").to_str().unwrap().into());
    save(&directory.0, &settings).unwrap();
    assert!(startup_paths(&directory.0).unwrap().is_empty());
}

#[test]
fn missing_startup_pdf_reports_a_notice_without_damaging_settings() {
    let directory = Directory::new();
    let mut settings = Settings::default();
    settings.last_pdf_path = Some(directory.0.join("missing.pdf").to_str().unwrap().into());
    settings.api_key = "test-key".into();
    save(&directory.0, &settings).unwrap();
    assert!(read_pdf_file(&startup_paths(&directory.0).unwrap()[0])
        .unwrap_err()
        .contains("missing or inaccessible"));
    assert_eq!(
        folio::settings::load(&directory.0).unwrap().api_key,
        "test-key"
    );
}

#[test]
fn startup_paths_migrate_the_last_pdf_and_preserve_tab_order_including_missing_files() {
    let directory = Directory::new();
    let mut settings = Settings::default();
    settings.last_pdf_path = Some(fixture().to_str().unwrap().into());
    save(&directory.0, &settings).unwrap();
    assert_eq!(startup_paths(&directory.0).unwrap(), vec![fixture()]);
    let missing = directory.0.join("missing.pdf");
    settings.open_pdf_paths = Some(vec![
        missing.to_str().unwrap().into(),
        fixture().to_str().unwrap().into(),
    ]);
    save(&directory.0, &settings).unwrap();
    assert_eq!(
        startup_paths(&directory.0).unwrap(),
        vec![missing, fixture()]
    );
    settings.open_pdf_paths = Some(vec![]);
    save(&directory.0, &settings).unwrap();
    assert!(startup_paths(&directory.0).unwrap().is_empty());
}

#[test]
fn session_reads_only_paths_authorized_by_the_native_picker_or_restore() {
    let session = folio::pdf::PdfSession::default();
    let path = fixture();
    assert!(session.selected_path(path.to_str().unwrap()).is_err());
    session.authorize(path.clone()).unwrap();
    assert_eq!(session.selected_path(path.to_str().unwrap()).unwrap(), path);
    assert!(session.selected_path("/tmp/unselected.pdf").is_err());
}
