#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let window_config = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .cloned()
                .ok_or("missing main window configuration")?;

            tauri::WebviewWindowBuilder::from_config(app, &window_config)?
                // Wry cancels `download` navigations unless a handler is
                // registered. Accepting the request saves to the platform's
                // Downloads folder and preserves the filename from the UI.
                .on_download(|_, _| true)
                .build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
