pub mod clusters;
pub mod rgw_admin;

pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running BucketAdmin");
}
