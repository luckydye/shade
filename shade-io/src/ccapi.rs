use anyhow::anyhow;
use bytes::Bytes;
use log::error;
use reqwest::Response;
use serde::{Deserialize, Deserializer};
use serde_json::Value;

#[derive(Deserialize)]
#[serde(untagged)]
enum StringOrNumber {
    String(String),
    Number(u64),
}

fn deserialize_string_or_number_as_string<'de, D>(
    deserializer: D,
) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    match StringOrNumber::deserialize(deserializer)? {
        StringOrNumber::String(value) => Ok(value),
        StringOrNumber::Number(value) => Ok(value.to_string()),
    }
}

fn deserialize_string_or_number_as_u64<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    match StringOrNumber::deserialize(deserializer)? {
        StringOrNumber::String(value) => {
            value.parse::<u64>().map_err(serde::de::Error::custom)
        }
        StringOrNumber::Number(value) => Ok(value),
    }
}

#[derive(Deserialize, Debug)]
pub struct Storage {
    pub name: String,
    pub path: String,
    pub accesscapability: String,
    pub maxsize: usize,
    pub spacesize: usize,
    pub contentsnumber: usize,
}

#[derive(Deserialize, Debug)]
pub struct StorageList {
    pub storagelist: Vec<Storage>,
}

#[derive(Deserialize, Debug)]
pub struct Folder {
    pub path: Vec<String>,
}

#[derive(Deserialize, Debug)]
pub struct Info {
    pub lastmodifieddate: String,
    #[serde(deserialize_with = "deserialize_string_or_number_as_string")]
    pub rating: String,
    #[serde(deserialize_with = "deserialize_string_or_number_as_u64")]
    pub filesize: u64,
}

#[derive(Deserialize, Debug)]
pub struct Endpoint {
    pub path: String,
    pub post: Option<bool>,
    pub get: Option<bool>,
}

#[derive(Deserialize, Debug)]
pub struct Index {
    pub ver100: Option<Vec<Endpoint>>,
    pub ver110: Option<Vec<Endpoint>>,
}

pub struct CCAPI {
    host: String,
}

static APP_USER_AGENT: &str =
    concat!(env!("CARGO_PKG_NAME"), "/", env!("CARGO_PKG_VERSION"),);

fn extract_error_message(payload: &str) -> String {
    serde_json::from_str::<Value>(payload)
        .ok()
        .and_then(|value| {
            value
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| payload.to_string())
}

fn format_request_error(
    host: &str,
    endpoint: &str,
    error: reqwest::Error,
) -> anyhow::Error {
    let target = format!("http://{host}{endpoint}");
    if error.is_connect() {
        return anyhow!("camera unavailable at {target}: {}", error);
    }
    if error.is_timeout() {
        return anyhow!("camera request timed out at {target}");
    }
    anyhow!("camera request failed at {target}: {}", error)
}

impl CCAPI {
    pub fn new(host: &str) -> CCAPI {
        CCAPI {
            host: host.to_string(),
        }
    }

    async fn fetch(&self, endpoint: &str) -> Result<Response, anyhow::Error> {
        self.fetch_with_logging(endpoint, true).await
    }

    async fn fetch_with_logging(
        &self,
        endpoint: &str,
        log_errors: bool,
    ) -> Result<Response, anyhow::Error> {
        let request_url = format!("http://{}{}", self.host, endpoint);
        let client = reqwest::Client::builder()
            .user_agent(APP_USER_AGENT)
            .build()?;

        let response = client
            .get(&request_url)
            .send()
            .await
            .map_err(|error| format_request_error(&self.host, endpoint, error))?;

        if response.status() != 200 {
            let txt = response.text().await?;
            let message = extract_error_message(&txt);
            if log_errors {
                error!(
                    "CCAPI request failed for {}{}: {}",
                    self.host, endpoint, message
                );
            }
            return Err(anyhow!(
                "camera request failed for {}{}: {}",
                self.host,
                endpoint,
                message
            ));
        }

        Ok(response)
    }

    async fn fetch_json<T: for<'de> Deserialize<'de>>(
        &self,
        endpoint: &str,
    ) -> Result<T, anyhow::Error> {
        let response = self.fetch(endpoint).await?;
        let payload = response.text().await?;
        serde_json::from_str(&payload).map_err(|error| {
            error!(
                "Failed to decode CCAPI response from {}{}: {}. Payload: {}",
                self.host, endpoint, error, payload
            );
            anyhow!(
                "failed to decode CCAPI response from {}{}: {}",
                self.host,
                endpoint,
                error
            )
        })
    }

    pub async fn index(&self) -> Result<Index, anyhow::Error> {
        self.fetch_json("/ccapi").await
    }

    pub async fn probe(&self) -> bool {
        self.fetch_with_logging("/ccapi", false).await.is_ok()
    }

    pub async fn storage(&self) -> Result<StorageList, anyhow::Error> {
        self.fetch_json("/ccapi/ver110/devicestatus/storage").await
    }

    pub async fn files(&self, storage: &Storage) -> Result<Vec<String>, anyhow::Error> {
        let folders: Folder = self.fetch_json(&storage.path).await?;

        let mut file_paths = Vec::new();
        for folder in folders.path {
            let files: Folder = self.fetch_json(&folder).await?;

            for file in files.path {
                file_paths.push(file);
            }
        }

        Ok(file_paths)
    }

    pub async fn info(&self, file_path: &str) -> Result<Info, anyhow::Error> {
        self.fetch_json(&format!("{}?kind=info", file_path)).await
    }

    pub async fn thumbnail(&self, file_path: &str) -> Result<Bytes, anyhow::Error> {
        let res = self.fetch(&format!("{}?kind=thumbnail", file_path)).await?;
        let data = res.bytes().await?;
        Ok(data)
    }

    pub async fn original(&self, file_path: &str) -> Result<Bytes, anyhow::Error> {
        let res = self.fetch(file_path).await?;
        let data = res.bytes().await?;
        Ok(data)
    }
}

#[tokio::test]
async fn my_test() -> Result<(), anyhow::Error> {
    let api = CCAPI::new("127.0.0.1:3000");

    let storage = api.storage().await?;
    let res = api.files(&storage.storagelist[0]).await?;
    let file = &res[0];
    let info = api.info(file).await?;

    let original = api.original(file).await?;

    std::fs::write("original.CR3", original)?;

    println!("{:?}", info);

    Ok(())
}
