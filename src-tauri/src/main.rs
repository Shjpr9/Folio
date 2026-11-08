fn main() {
    tauri::Builder::default()
        .manage(folio::pdf::PdfSession::default())
        .manage(folio::tts::TtsManager::default())
        .invoke_handler(tauri::generate_handler![
            folio::ai::complete,
            folio::settings::load_settings,
            folio::settings::save_settings,
            folio::pdf::choose_pdf,
            folio::pdf::restore_pdf,
            folio::pdf::read_selected_pdf,
            folio::tts::tts_status,
            folio::tts::tts_install,
            folio::tts::tts_remove,
            folio::tts::tts_begin,
            folio::tts::tts_stop,
            folio::tts::tts_cancel_install,
            folio::tts::tts_synthesize
        ])
        .build(tauri::generate_context!())
        .expect("could not start Folio")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                use tauri::Manager;
                app.state::<folio::tts::TtsManager>().stop();
            }
        });
}
