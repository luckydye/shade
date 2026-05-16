use crate::db::library_db_conn;

#[tauri::command]
pub async fn list_collections(
    library_id: String,
) -> Result<Vec<shade_io::Collection>, String> {
    let conn = library_db_conn().await;
    shade_io::list_collections(&conn, &library_id).await
}
#[tauri::command]
pub async fn create_collection(
    library_id: String,
    name: String,
) -> Result<shade_io::Collection, String> {
    let conn = library_db_conn().await;
    shade_io::create_collection(&conn, &library_id, &name).await
}
#[tauri::command]
pub async fn rename_collection(
    collection_id: String,
    name: String,
) -> Result<(), String> {
    let conn = library_db_conn().await;
    shade_io::rename_collection(&conn, &collection_id, &name).await
}
#[tauri::command]
pub async fn delete_collection(collection_id: String) -> Result<(), String> {
    let conn = library_db_conn().await;
    shade_io::delete_collection(&conn, &collection_id).await
}
#[tauri::command]
pub async fn reorder_collection(
    collection_id: String,
    new_position: i64,
) -> Result<(), String> {
    let conn = library_db_conn().await;
    shade_io::reorder_collection(&conn, &collection_id, new_position).await
}
#[tauri::command]
pub async fn list_collection_items(
    collection_id: String,
) -> Result<Vec<shade_io::CollectionItem>, String> {
    let conn = library_db_conn().await;
    shade_io::list_collection_items(&conn, &collection_id).await
}
#[tauri::command]
pub async fn add_to_collection(
    collection_id: String,
    fingerprints: Vec<String>,
) -> Result<(), String> {
    let conn = library_db_conn().await;
    shade_io::add_collection_items(&conn, &collection_id, fingerprints).await
}
#[tauri::command]
pub async fn remove_from_collection(
    collection_id: String,
    fingerprints: Vec<String>,
) -> Result<(), String> {
    let conn = library_db_conn().await;
    shade_io::remove_collection_items(&conn, &collection_id, fingerprints).await
}
