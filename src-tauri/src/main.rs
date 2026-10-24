fn main() {
    tauri::Builder::default()
        .manage(folio::pdf::PdfSession::default())
        .invoke_handler(tauri::generate_handler![
            folio::ai::complete,
            folio::settings::load_settings,
            folio::settings::save_settings,
            folio::pdf::choose_pdf,
            folio::pdf::restore_pdf,
            folio::pdf::read_selected_pdf,
            folio::pdf::remember_pdf
        ])
        .run(tauri::generate_context!())
        .expect("could not start Folio");
}
