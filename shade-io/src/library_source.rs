use chrono::DateTime;
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use quick_xml::de::from_str;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

const S3_URI_ENCODE_SET: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');
const EMPTY_SHA256_HEX: &str =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const APP_USER_AGENT: &str =
    concat!(env!("CARGO_PKG_NAME"), "/", env!("CARGO_PKG_VERSION"));

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct LocalLibraryConfig {
    pub path: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct CameraLibraryConfig {
    pub host: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct PeerLibraryConfig {
    pub peer_id: String,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq, Eq)]
pub struct S3LibraryConfig {
    pub id: String,
    pub name: Option<String>,
    pub endpoint: String,
    pub bucket: String,
    pub region: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub prefix: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct AddS3LibraryParams {
    pub name: Option<String>,
    pub endpoint: String,
    pub bucket: String,
    pub region: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub prefix: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibraryConfig {
    Local(LocalLibraryConfig),
    S3(S3LibraryConfig),
    Camera(CameraLibraryConfig),
    Peer(PeerLibraryConfig),
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LibraryMode {
    #[default]
    Browse,
    Sync,
}

#[derive(Debug, Clone)]
pub struct S3ObjectEntry {
    pub key: String,
    pub modified_at: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct S3ObjectListPage {
    pub objects: Vec<S3ObjectEntry>,
    pub next_continuation_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ListBucketResult {
    #[serde(default)]
    contents: Vec<ListBucketObject>,
    #[serde(default)]
    is_truncated: bool,
    next_continuation_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ListBucketObject {
    key: String,
    last_modified: Option<String>,
}

struct SignedRequest {
    url: String,
    authorization: String,
    amz_date: String,
    content_sha256: String,
    extra_headers: Vec<(String, String)>,
}

pub fn local_library_id(path: &Path) -> String {
    format!("dir:{}", path.display())
}

pub fn camera_library_id(host: &str) -> String {
    format!("ccapi:{host}")
}

pub fn peer_library_id(peer_id: &str) -> String {
    format!("peer:{peer_id}")
}

pub fn s3_library_id(source_id: &str) -> String {
    format!("s3:{source_id}")
}

pub fn resolve_s3_source_id_from_library_id(library_id: &str) -> Result<&str, String> {
    let source_id = library_id
        .strip_prefix("s3:")
        .ok_or_else(|| format!("unknown S3 media library: {library_id}"))?;
    if source_id.is_empty() {
        return Err(format!("unknown S3 media library: {library_id}"));
    }
    Ok(source_id)
}

pub fn media_path_for_s3_object(source_id: &str, key: &str) -> String {
    format!("s3://{source_id}/{key}")
}

pub fn parse_s3_media_path(path: &str) -> Result<(&str, &str), String> {
    let path = path
        .strip_prefix("s3://")
        .ok_or_else(|| format!("invalid S3 media path: {path}"))?;
    let slash_index = path
        .find('/')
        .ok_or_else(|| format!("invalid S3 media path: s3://{path}"))?;
    let (source_id, key_with_slash) = path.split_at(slash_index);
    let key = &key_with_slash[1..];
    if source_id.is_empty() || key.is_empty() {
        return Err(format!("invalid S3 media path: s3://{path}"));
    }
    Ok((source_id, key))
}

pub fn library_config_id(config: &LibraryConfig) -> String {
    match config {
        LibraryConfig::Local(config) => local_library_id(Path::new(&config.path)),
        LibraryConfig::S3(config) => s3_library_id(&config.id),
        LibraryConfig::Camera(config) => camera_library_id(&config.host),
        LibraryConfig::Peer(config) => peer_library_id(&config.peer_id),
    }
}

pub fn display_s3_library_name(config: &S3LibraryConfig) -> String {
    if let Some(name) = config.name.as_deref() {
        return name.to_string();
    }
    match config.prefix.as_deref() {
        Some(prefix) => format!("{}/{}", config.bucket, prefix),
        None => config.bucket.clone(),
    }
}

pub fn format_s3_library_detail(config: &S3LibraryConfig) -> String {
    match config.prefix.as_deref() {
        Some(prefix) => {
            format!("s3://{}/{} @ {}", config.bucket, prefix, config.endpoint)
        }
        None => format!("s3://{} @ {}", config.bucket, config.endpoint),
    }
}

pub fn normalize_s3_library_input(
    params: AddS3LibraryParams,
) -> Result<S3LibraryConfig, String> {
    let endpoint = normalize_endpoint(&params.endpoint)?;
    let bucket = require_trimmed("bucket", &params.bucket)?;
    let region = require_trimmed("region", &params.region)?;
    let access_key_id = require_trimmed("access key ID", &params.access_key_id)?;
    let secret_access_key =
        require_trimmed("secret access key", &params.secret_access_key)?;
    let prefix = normalize_optional_path(&params.prefix);
    let name = normalize_optional_value(&params.name);
    let id = hash_source_identity(&endpoint, &bucket, &region, prefix.as_deref());
    Ok(S3LibraryConfig {
        id,
        name,
        endpoint,
        bucket,
        region,
        access_key_id,
        secret_access_key,
        prefix,
    })
}

pub async fn list_s3_objects(
    config: &S3LibraryConfig,
) -> Result<Vec<S3ObjectEntry>, String> {
    let mut continuation_token: Option<String> = None;
    let mut objects = Vec::new();
    loop {
        let page = list_s3_objects_page(config, continuation_token.as_deref()).await?;
        objects.extend(page.objects);
        if page.next_continuation_token.is_none() {
            break;
        }
        continuation_token = page.next_continuation_token;
    }
    Ok(objects)
}

pub async fn list_s3_objects_page(
    config: &S3LibraryConfig,
    continuation_token: Option<&str>,
) -> Result<S3ObjectListPage, String> {
    let client = http_client()?;
    let mut query = vec![
        ("list-type", "2".to_string()),
        ("max-keys", "1000".to_string()),
    ];
    if let Some(prefix) = config.prefix.as_ref() {
        query.push(("prefix", prefix.clone()));
    }
    if let Some(token) = continuation_token {
        query.push(("continuation-token", token.to_string()));
    }
    let request = signed_request("GET", config, None, &query, EMPTY_SHA256_HEX, &[])?;
    let response = client
        .get(&request.url)
        .header("authorization", request.authorization)
        .header("x-amz-content-sha256", request.content_sha256)
        .header("x-amz-date", request.amz_date)
        .send()
        .await
        .map_err(|error| {
            format!("S3 request failed for {}: {}", config.endpoint, error)
        })?;
    let response = response.error_for_status().map_err(|error| {
        format!(
            "S3 list request failed for bucket {} at {}: {}",
            config.bucket, config.endpoint, error
        )
    })?;
    let payload = response.text().await.map_err(|error| error.to_string())?;
    let listing: ListBucketResult = from_str(&payload)
        .map_err(|error| format!("invalid S3 list response: {error}"))?;
    let mut objects = Vec::with_capacity(listing.contents.len());
    for item in listing.contents {
        objects.push(S3ObjectEntry {
            key: item.key,
            modified_at: parse_last_modified(item.last_modified.as_deref())?,
        });
    }
    if listing.is_truncated && listing.next_continuation_token.is_none() {
        return Err("S3 listing was truncated without a continuation token".to_string());
    }
    Ok(S3ObjectListPage {
        objects,
        next_continuation_token: listing.next_continuation_token,
    })
}

pub async fn get_s3_object_bytes(
    config: &S3LibraryConfig,
    key: &str,
) -> Result<Vec<u8>, String> {
    let _permit = s3_get_semaphore()
        .acquire()
        .await
        .map_err(|e| e.to_string())?;
    let client = http_client()?;
    let request = signed_request("GET", config, Some(key), &[], EMPTY_SHA256_HEX, &[])?;
    let response = client
        .get(&request.url)
        .header("authorization", request.authorization)
        .header("x-amz-content-sha256", request.content_sha256)
        .header("x-amz-date", request.amz_date)
        .send()
        .await
        .map_err(|error| {
            format!("S3 request failed for {}: {}", config.endpoint, error)
        })?;
    let response = response.error_for_status().map_err(|error| {
        format!(
            "S3 object request failed for s3://{}/{} at {}: {}",
            config.bucket, key, config.endpoint, error
        )
    })?;
    response
        .bytes()
        .await
        .map(|bytes| bytes.to_vec())
        .map_err(|error| error.to_string())
}

pub async fn put_s3_object_bytes(
    config: &S3LibraryConfig,
    key: &str,
    bytes: &[u8],
) -> Result<(), String> {
    put_s3_object_bytes_with_modified(config, key, bytes, None).await
}

pub async fn put_s3_object_bytes_with_modified(
    config: &S3LibraryConfig,
    key: &str,
    bytes: &[u8],
    modified_at: Option<u64>,
) -> Result<(), String> {
    let client = http_client()?;
    let content_sha256 = sha256_hex(bytes);
    let extra: Vec<(String, String)> = modified_at
        .map(|ms| vec![("x-amz-meta-modified-at".to_string(), ms.to_string())])
        .unwrap_or_default();
    let request = signed_request("PUT", config, Some(key), &[], &content_sha256, &extra)?;
    let mut builder = client
        .put(&request.url)
        .header("authorization", request.authorization)
        .header("x-amz-content-sha256", request.content_sha256)
        .header("x-amz-date", request.amz_date);
    for (name, value) in &request.extra_headers {
        builder = builder.header(name, value);
    }
    builder
        .body(bytes.to_vec())
        .send()
        .await
        .map_err(|error| {
            format!(
                "S3 upload request failed for {}: {}",
                config.endpoint, error
            )
        })?
        .error_for_status()
        .map_err(|error| {
            format!(
                "S3 upload failed for s3://{}/{} at {}: {}",
                config.bucket, key, config.endpoint, error
            )
        })?;
    Ok(())
}

pub async fn put_s3_object_bytes_with_atime(
    config: &S3LibraryConfig,
    key: &str,
    bytes: &[u8],
    atime: Option<u64>,
) -> Result<(), String> {
    let client = http_client()?;
    let content_sha256 = sha256_hex(bytes);
    let extra: Vec<(String, String)> = atime
        .map(|ms| vec![("x-amz-meta-atime".to_string(), ms.to_string())])
        .unwrap_or_default();
    let request = signed_request("PUT", config, Some(key), &[], &content_sha256, &extra)?;
    let mut builder = client
        .put(&request.url)
        .header("authorization", request.authorization)
        .header("x-amz-content-sha256", request.content_sha256)
        .header("x-amz-date", request.amz_date);
    for (name, value) in &request.extra_headers {
        builder = builder.header(name, value);
    }
    builder
        .body(bytes.to_vec())
        .send()
        .await
        .map_err(|error| {
            format!(
                "S3 upload request failed for {}: {}",
                config.endpoint, error
            )
        })?
        .error_for_status()
        .map_err(|error| {
            format!(
                "S3 upload failed for s3://{}/{} at {}: {}",
                config.bucket, key, config.endpoint, error
            )
        })?;
    Ok(())
}

pub async fn head_s3_object_modified_at(
    config: &S3LibraryConfig,
    key: &str,
) -> Result<Option<u64>, String> {
    let _permit = s3_head_semaphore()
        .acquire()
        .await
        .map_err(|e| e.to_string())?;
    let client = http_client()?;
    let request = signed_request("HEAD", config, Some(key), &[], EMPTY_SHA256_HEX, &[])?;
    let response = client
        .head(&request.url)
        .header("authorization", request.authorization)
        .header("x-amz-content-sha256", request.content_sha256)
        .header("x-amz-date", request.amz_date)
        .send()
        .await
        .map_err(|error| format!("S3 request failed for {}: {}", config.endpoint, error))?
        .error_for_status()
        .map_err(|error| {
            format!(
                "S3 head request failed for s3://{}/{} at {}: {}",
                config.bucket, key, config.endpoint, error
            )
        })?;
    let Some(value) = response.headers().get("x-amz-meta-atime") else {
        return Ok(None);
    };
    let value_str = value
        .to_str()
        .map_err(|error| format!("invalid x-amz-meta-atime header: {error}"))?;
    let trimmed = value_str.trim();
    if let Ok(ms) = trimmed.parse::<u64>() {
        return Ok(Some(ms));
    }
    // Legacy: atime was stored as RFC 3339 string — convert to ms since epoch
    DateTime::parse_from_rfc3339(trimmed)
        .map(|dt| Some(dt.timestamp_millis() as u64))
        .map_err(|error| format!("invalid x-amz-meta-atime value `{value_str}`: {error}"))
}

pub async fn delete_s3_object(config: &S3LibraryConfig, key: &str) -> Result<(), String> {
    let client = http_client()?;
    let request = signed_request("DELETE", config, Some(key), &[], EMPTY_SHA256_HEX, &[])?;
    client
        .delete(&request.url)
        .header("authorization", request.authorization)
        .header("x-amz-content-sha256", request.content_sha256)
        .header("x-amz-date", request.amz_date)
        .send()
        .await
        .map_err(|error| {
            format!(
                "S3 delete request failed for {}: {}",
                config.endpoint, error
            )
        })?
        .error_for_status()
        .map_err(|error| {
            format!(
                "S3 delete failed for s3://{}/{} at {}: {}",
                config.bucket, key, config.endpoint, error
            )
        })?;
    Ok(())
}

fn http_client() -> Result<reqwest::Client, String> {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    Ok(CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .user_agent(APP_USER_AGENT)
                .http1_only()
                .build()
                .expect("failed to build S3 HTTP client")
        })
        .clone())
}

// Separate semaphores so indexing (HEAD) and downloads (GET) never block each other.
fn s3_head_semaphore() -> &'static tokio::sync::Semaphore {
    static SEM: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
    SEM.get_or_init(|| tokio::sync::Semaphore::new(8))
}

fn s3_get_semaphore() -> &'static tokio::sync::Semaphore {
    static SEM: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
    SEM.get_or_init(|| tokio::sync::Semaphore::new(4))
}

fn normalize_endpoint(endpoint: &str) -> Result<String, String> {
    let trimmed = endpoint.trim();
    if trimmed.is_empty() {
        return Err("S3 endpoint cannot be empty".to_string());
    }
    let parsed = reqwest::Url::parse(trimmed)
        .map_err(|error| format!("invalid S3 endpoint `{trimmed}`: {error}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        scheme => return Err(format!("unsupported S3 endpoint scheme: {scheme}")),
    }
    if parsed.host_str().is_none() {
        return Err(format!("invalid S3 endpoint `{trimmed}`"));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("S3 endpoint must not embed credentials".to_string());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("S3 endpoint must not include a query string or fragment".to_string());
    }
    if parsed.path() != "/" && !parsed.path().is_empty() {
        return Err("S3 endpoint must point at the service root".to_string());
    }
    Ok(parsed.to_string().trim_end_matches('/').to_string())
}

fn require_trimmed(field: &str, value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{field} cannot be empty"));
    }
    Ok(trimmed.to_string())
}

fn normalize_optional_value(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn normalize_optional_path(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .map(|value| value.trim_matches('/'))
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn hash_source_identity(
    endpoint: &str,
    bucket: &str,
    region: &str,
    prefix: Option<&str>,
) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(endpoint.as_bytes());
    hasher.update(b"\n");
    hasher.update(bucket.as_bytes());
    hasher.update(b"\n");
    hasher.update(region.as_bytes());
    hasher.update(b"\n");
    hasher.update(prefix.unwrap_or_default().as_bytes());
    hasher.finalize().to_hex()[..16].to_string()
}

fn parse_last_modified(value: Option<&str>) -> Result<Option<u64>, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let parsed = DateTime::parse_from_rfc3339(value).map_err(|error| {
        format!("invalid S3 LastModified timestamp `{value}`: {error}")
    })?;
    u64::try_from(parsed.timestamp_millis())
        .map(Some)
        .map_err(|error| error.to_string())
}

fn signed_request(
    method: &str,
    config: &S3LibraryConfig,
    key: Option<&str>,
    query: &[(&str, String)],
    content_sha256: &str,
    extra_headers: &[(String, String)],
) -> Result<SignedRequest, String> {
    let endpoint = reqwest::Url::parse(&config.endpoint)
        .map_err(|error| format!("invalid S3 endpoint `{}`: {error}", config.endpoint))?;
    let host = endpoint
        .host_str()
        .ok_or_else(|| format!("invalid S3 endpoint `{}`", config.endpoint))?;
    let authority = match endpoint.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    };
    let canonical_uri = object_canonical_uri(&config.bucket, key);
    let canonical_query = canonical_query_string(query);
    let now = chrono::Utc::now();
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let date_stamp = now.format("%Y%m%d").to_string();
    let mut header_entries = vec![
        ("host".to_string(), authority.clone()),
        ("x-amz-content-sha256".to_string(), content_sha256.to_string()),
        ("x-amz-date".to_string(), amz_date.clone()),
    ];
    for (name, value) in extra_headers {
        header_entries.push((name.to_lowercase(), value.clone()));
    }
    header_entries.sort_by(|a, b| a.0.cmp(&b.0));
    let canonical_headers = header_entries
        .iter()
        .map(|(k, v)| format!("{k}:{v}\n"))
        .collect::<String>();
    let signed_headers = header_entries
        .iter()
        .map(|(k, _)| k.as_str())
        .collect::<Vec<_>>()
        .join(";");
    let canonical_request = format!(
        "{method}\n{canonical_uri}\n{canonical_query}\n{canonical_headers}\n{signed_headers}\n{content_sha256}"
    );
    let extra_headers_out: Vec<(String, String)> = extra_headers.to_vec();
    let credential_scope = format!("{date_stamp}/{}/s3/aws4_request", config.region);
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{credential_scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );
    let signing_key = signing_key(&config.secret_access_key, &date_stamp, &config.region);
    let signature = hex::encode(hmac_sha256(&signing_key, string_to_sign.as_bytes()));
    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
        config.access_key_id, credential_scope, signed_headers, signature
    );
    let query_suffix = if canonical_query.is_empty() {
        String::new()
    } else {
        format!("?{canonical_query}")
    };
    Ok(SignedRequest {
        url: format!(
            "{}://{}{}{}",
            endpoint.scheme(),
            authority,
            canonical_uri,
            query_suffix
        ),
        authorization,
        amz_date,
        content_sha256: content_sha256.to_string(),
        extra_headers: extra_headers_out,
    })
}

fn object_canonical_uri(bucket: &str, key: Option<&str>) -> String {
    match key {
        Some(key) => format!(
            "/{}/{}",
            encode_path_segment(bucket),
            encode_object_key(key)
        ),
        None => format!("/{}", encode_path_segment(bucket)),
    }
}

fn encode_object_key(key: &str) -> String {
    key.split('/')
        .map(encode_path_segment)
        .collect::<Vec<_>>()
        .join("/")
}

fn encode_path_segment(value: &str) -> String {
    utf8_percent_encode(value, S3_URI_ENCODE_SET).to_string()
}

fn canonical_query_string(query: &[(&str, String)]) -> String {
    let mut pairs = query
        .iter()
        .map(|(name, value)| (encode_path_segment(name), encode_path_segment(value)))
        .collect::<Vec<_>>();
    pairs.sort();
    pairs
        .into_iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("&")
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn signing_key(secret_access_key: &str, date_stamp: &str, region: &str) -> [u8; 32] {
    let date_key = hmac_sha256(
        format!("AWS4{secret_access_key}").as_bytes(),
        date_stamp.as_bytes(),
    );
    let region_key = hmac_sha256(&date_key, region.as_bytes());
    let service_key = hmac_sha256(&region_key, b"s3");
    hmac_sha256(&service_key, b"aws4_request")
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    const BLOCK_SIZE: usize = 64;
    let mut normalized_key = [0_u8; BLOCK_SIZE];
    if key.len() > BLOCK_SIZE {
        let mut hasher = Sha256::new();
        hasher.update(key);
        let digest = hasher.finalize();
        normalized_key[..digest.len()].copy_from_slice(&digest);
    } else {
        normalized_key[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0x36_u8; BLOCK_SIZE];
    let mut opad = [0x5c_u8; BLOCK_SIZE];
    for index in 0..BLOCK_SIZE {
        ipad[index] ^= normalized_key[index];
        opad[index] ^= normalized_key[index];
    }
    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(data);
    let inner_digest = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner_digest);
    outer.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::{
        canonical_query_string, media_path_for_s3_object, normalize_s3_library_input,
        parse_s3_media_path, resolve_s3_source_id_from_library_id, s3_library_id,
        AddS3LibraryParams,
    };

    #[test]
    fn normalizes_s3_library_input() {
        let config = normalize_s3_library_input(AddS3LibraryParams {
            name: Some("  Archive ".into()),
            endpoint: "https://s3.example.test/".into(),
            bucket: " photos ".into(),
            region: " us-east-1 ".into(),
            access_key_id: " key ".into(),
            secret_access_key: " secret ".into(),
            prefix: Some("/raw/2025/".into()),
        })
        .expect("valid config");
        assert_eq!(config.name.as_deref(), Some("Archive"));
        assert_eq!(config.endpoint, "https://s3.example.test");
        assert_eq!(config.bucket, "photos");
        assert_eq!(config.region, "us-east-1");
        assert_eq!(config.prefix.as_deref(), Some("raw/2025"));
        assert_eq!(
            resolve_s3_source_id_from_library_id(&s3_library_id(&config.id)).unwrap(),
            config.id
        );
    }

    #[test]
    fn parses_s3_media_paths() {
        let path = media_path_for_s3_object("abcd1234", "folder/image 01.CR3");
        let (source_id, key) = parse_s3_media_path(&path).expect("valid path");
        assert_eq!(source_id, "abcd1234");
        assert_eq!(key, "folder/image 01.CR3");
    }

    #[test]
    fn sorts_and_encodes_query_pairs() {
        let canonical = canonical_query_string(&[
            ("prefix", "raw uploads/".into()),
            ("list-type", "2".into()),
        ]);
        assert_eq!(canonical, "list-type=2&prefix=raw%20uploads%2F");
    }
}

fn general_http_client() -> Result<reqwest::Client, String> {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    Ok(CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .user_agent(APP_USER_AGENT)
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .expect("failed to build HTTP client")
        })
        .clone())
}

/// Fetch raw bytes from an arbitrary HTTP(S) URL.
/// If the response is HTML, extracts the `og:image` meta tag and follows it.
pub async fn fetch_url_bytes(url: &str) -> Result<(Vec<u8>, String), String> {
    let client = general_http_client()?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("fetch failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("fetch returned status {}", response.status()));
    }
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("failed to read response body: {e}"))?;

    if content_type.contains("text/html") {
        let html = String::from_utf8_lossy(&bytes);
        let og_images = extract_og_images(&html);
        if og_images.is_empty() {
            return Err(format!("no og:image found in HTML response from {url}"));
        }
        let index = parse_img_index(url).unwrap_or(1).max(1) as usize;
        let og_url = og_images
            .get(index - 1)
            .or(og_images.last())
            .unwrap();
        return fetch_url_bytes_direct(&client, og_url).await;
    }

    Ok((bytes.to_vec(), content_type))
}

async fn fetch_url_bytes_direct(
    client: &reqwest::Client,
    url: &str,
) -> Result<(Vec<u8>, String), String> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("fetch failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("fetch returned status {}", response.status()));
    }
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("failed to read response body: {e}"))?;
    Ok((bytes.to_vec(), content_type))
}

fn extract_og_images(html: &str) -> Vec<String> {
    // Collect all <meta property="og:image" content="..."> values.
    // Handles both quote styles and varying attribute order.
    let lower = html.to_lowercase();
    let mut results = Vec::new();
    let mut search_from = 0;
    while let Some(rel) = lower[search_from..].find("og:image") {
        let pos = search_from + rel;
        let Some(tag_start) = lower[..pos].rfind('<') else {
            break;
        };
        let Some(rel_end) = lower[pos..].find('>') else {
            break;
        };
        let tag_end = pos + rel_end;
        let tag = &html[tag_start..=tag_end];
        if let Some(content_pos) = tag.to_lowercase().find("content=") {
            let after_eq = &tag[content_pos + 8..];
            if let Some(quote) = after_eq.chars().next() {
                if quote == '"' || quote == '\'' {
                    if let Some(end) = after_eq[1..].find(quote) {
                        let url = after_eq[1..1 + end].replace("&amp;", "&");
                        if !url.is_empty() {
                            results.push(url);
                        }
                    }
                }
            }
        }
        search_from = tag_end + 1;
    }
    results
}

fn parse_img_index(url: &str) -> Option<u32> {
    let query = url.split('?').nth(1)?;
    for pair in query.split('&') {
        let mut kv = pair.splitn(2, '=');
        if kv.next()? == "img_index" {
            return kv.next()?.parse().ok();
        }
    }
    None
}
