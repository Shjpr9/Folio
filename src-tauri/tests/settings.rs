use folio::settings::{load, save, Settings};
use serde_json::json;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!(
            "folio-settings-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        )))
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn configured() -> Settings {
    serde_json::from_value(json!({ "endpoint_url": "https://example.com/v1", "api_key": "test-secret", "model": "test-model", "theme": "dark", "zoom": 1.4, "recolor_pdf": true })).unwrap()
}

#[test]
fn missing_file_uses_system_theme_and_no_saved_zoom() {
    let directory = Directory::new();
    let result = serde_json::to_value(load(&directory.0).unwrap()).unwrap();
    assert_eq!(result["theme"], "system");
    assert_eq!(result["api_key"], "");
    assert!(result["zoom"].is_null());
    assert_eq!(result["recolor_pdf"], false);
    assert_eq!(result["reopen_last_pdf"], true);
    assert!(!directory.0.exists());
}

#[test]
fn credentials_theme_and_zoom_survive_reloading_and_replacement() {
    let directory = Directory::new();
    save(&directory.0, &configured()).unwrap();
    let result = load(&directory.0).unwrap();
    assert_eq!(result.api_key, "test-secret");
    assert_eq!(result.model, "test-model");
    assert_eq!(result.endpoint_url, "https://example.com/v1");
    assert_eq!(serde_json::to_value(&result).unwrap()["theme"], "dark");
    assert_eq!(result.zoom, Some(1.4));
    assert_eq!(serde_json::to_value(&result).unwrap()["recolor_pdf"], true);
    let mut updated = result;
    updated.api_key.clear();
    save(&directory.0, &updated).unwrap();
    assert_eq!(load(&directory.0).unwrap().api_key, "");
    assert_eq!(std::fs::read_dir(&directory.0).unwrap().count(), 1);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(directory.0.join("settings.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(&directory.0)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
}

#[test]
fn invalid_settings_cannot_replace_saved_credentials() {
    let directory = Directory::new();
    save(&directory.0, &configured()).unwrap();
    for bad_zoom in [0.0, 3.0, f64::NAN] {
        let mut bad = configured();
        bad.zoom = Some(bad_zoom);
        assert!(save(&directory.0, &bad).is_err());
    }
    let mut bad = configured();
    bad.endpoint_url = "http://example.com/v1".into();
    assert!(save(&directory.0, &bad).is_err());
    assert_eq!(load(&directory.0).unwrap().api_key, "test-secret");
}

#[test]
fn corrupt_settings_report_an_error_without_overwriting_them() {
    let directory = Directory::new();
    std::fs::create_dir_all(&directory.0).unwrap();
    std::fs::write(directory.0.join("settings.json"), "not-json").unwrap();
    assert!(load(&directory.0).is_err());
    assert_eq!(
        std::fs::read_to_string(directory.0.join("settings.json")).unwrap(),
        "not-json"
    );
}

#[test]
fn appearance_can_be_saved_before_configuring_a_provider() {
    let directory = Directory::new();
    let settings: Settings = serde_json::from_value(json!({"theme":"dark"})).unwrap();
    save(&directory.0, &settings).unwrap();
    assert_eq!(
        serde_json::to_value(load(&directory.0).unwrap()).unwrap()["theme"],
        "dark"
    );
}

#[test]
fn oversized_or_invalid_saved_files_are_not_loaded() {
    let directory = Directory::new();
    std::fs::create_dir_all(&directory.0).unwrap();
    for bytes in [
        vec![b' '; 65537],
        br#"{"theme":"invalid"}"#.to_vec(),
        br#"{"zoom":10}"#.to_vec(),
    ] {
        std::fs::write(directory.0.join("settings.json"), bytes).unwrap();
        assert!(load(&directory.0).is_err());
    }
}

#[test]
fn document_positions_survive_restart_without_losing_credentials() {
    let directory = Directory::new();
    let mut value = serde_json::to_value(configured()).unwrap();
    value["reading_positions"] = json!([
        {"document_id":"pdf-one", "page":17}, {"document_id":"pdf-two", "page":4}
    ]);
    save(&directory.0, &serde_json::from_value(value).unwrap()).unwrap();
    let result = serde_json::to_value(load(&directory.0).unwrap()).unwrap();
    assert_eq!(result["reading_positions"][0]["page"], 17);
    assert_eq!(result["reading_positions"][1]["document_id"], "pdf-two");
    assert_eq!(result["api_key"], "test-secret");
}

#[test]
fn invalid_document_positions_cannot_replace_existing_settings() {
    let directory = Directory::new();
    save(&directory.0, &configured()).unwrap();
    for position in [
        json!({"document_id":"pdf", "page":0}),
        json!({"document_id":"", "page":1}),
    ] {
        let mut value = serde_json::to_value(configured()).unwrap();
        value["reading_positions"] = json!([position]);
        let settings = serde_json::from_value(value).unwrap();
        assert!(save(&directory.0, &settings).is_err());
    }
    assert_eq!(load(&directory.0).unwrap().api_key, "test-secret");
}

#[test]
fn startup_preference_and_last_path_survive_restart() {
    let directory = Directory::new();
    let mut value = serde_json::to_value(configured()).unwrap();
    value["reopen_last_pdf"] = json!(false);
    value["last_pdf_path"] = json!(directory.0.join("book.pdf").to_str().unwrap());
    save(&directory.0, &serde_json::from_value(value).unwrap()).unwrap();
    let loaded = serde_json::to_value(load(&directory.0).unwrap()).unwrap();
    assert_eq!(loaded["reopen_last_pdf"], false);
    assert_eq!(
        loaded["last_pdf_path"],
        json!(directory.0.join("book.pdf").to_str().unwrap())
    );
    assert_eq!(loaded["api_key"], "test-secret");
}

#[test]
fn open_tabs_and_active_path_survive_restart() {
    let directory = Directory::new();
    let paths = vec![directory.0.join("one.pdf"), directory.0.join("two.pdf")];
    let settings: Settings = serde_json::from_value(json!({
        "open_pdf_paths": paths, "active_pdf_path": paths[1],
        "reading_positions": [{"document_id":"one", "page":2, "scroll_top":120.0, "scroll_left":10.0, "zoom":1.5}]
    })).unwrap();
    save(&directory.0, &settings).unwrap();
    let loaded = serde_json::to_value(load(&directory.0).unwrap()).unwrap();
    assert_eq!(loaded["open_pdf_paths"], json!(paths));
    assert_eq!(loaded["active_pdf_path"], json!(paths[1]));
    assert_eq!(loaded["reading_positions"][0]["scroll_top"], 120.0);
    assert_eq!(loaded["reading_positions"][0]["zoom"], 1.5);
}

#[test]
fn invalid_tab_paths_and_scroll_positions_are_rejected() {
    let directory = Directory::new();
    for value in [
        json!({"open_pdf_paths":["relative.pdf"]}),
        json!({"active_pdf_path":"relative.pdf"}),
        json!({"reading_positions":[{"document_id":"one", "page":1, "scroll_top":-1}]}),
    ] {
        let settings: Settings = serde_json::from_value(value).unwrap();
        assert!(save(&directory.0, &settings).is_err());
    }
}
