mod magic_fix;

use magic_fix::{
    magic_fix_cancel, magic_fix_diagnostics, magic_fix_run, magic_fix_status, MagicFixState,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(MagicFixState::default())
        .invoke_handler(tauri::generate_handler![
            magic_fix_status,
            magic_fix_diagnostics,
            magic_fix_run,
            magic_fix_cancel
        ])
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
