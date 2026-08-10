//! HTTP to the sync endpoints.
//!
//! Thin on purpose: every decision that matters happens in [`super::engine`],
//! and this file only moves opaque strings. Nothing here can look inside a
//! blob, which makes it uninteresting — the desired property for the layer
//! that touches the network.

use crate::license::{self, LicenseError};
use serde::{Deserialize, Serialize};
use std::time::Duration;

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

fn base() -> String {
    license::base_url()
}

#[derive(Debug, Clone, Deserialize)]
pub struct SyncMeta {
    pub salt: String,
    pub verifier: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WireRecord {
    pub id: String,
    /// `None` is a tombstone.
    pub blob: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PullResponse {
    pub records: Vec<WireRecord>,
    /// The server's clock, to be used as the next `since`. Using our own would
    /// drop records whenever the two disagree, and they always disagree.
    pub now: i64,
}

fn err_from(status: u16, body: &str) -> String {
    match status {
        401 => "This Mac's licence isn't recognised.".to_string(),
        402 => "Sync needs an active Ghostly Max subscription.".to_string(),
        403 => "This licence has been revoked.".to_string(),
        404 => "not_set_up".to_string(),
        409 => "already_set_up".to_string(),
        507 => "You've reached the sync storage limit.".to_string(),
        _ => format!("Sync failed ({}): {}", status, body),
    }
}

async fn key() -> Result<String, String> {
    license::load_key_and_token()
        .map(|(k, _)| k)
        .ok_or_else(|| LicenseError::NotActivated.to_string())
}

pub async fn get_meta() -> Result<Option<SyncMeta>, String> {
    let k = key().await?;
    let resp = http()
        .get(format!("{}/sync/meta", base()))
        .bearer_auth(&k)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach sync: {}", e))?;
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    match status {
        200 => serde_json::from_str::<SyncMeta>(&body)
            .map(Some)
            .map_err(|_| "Sync returned an unreadable response.".to_string()),
        404 => Ok(None),
        _ => Err(err_from(status, &body)),
    }
}

pub async fn create_meta(salt: &str, verifier: &str) -> Result<(), String> {
    let k = key().await?;
    let resp = http()
        .post(format!("{}/sync/meta", base()))
        .bearer_auth(&k)
        .json(&serde_json::json!({ "salt": salt, "verifier": verifier }))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach sync: {}", e))?;
    let status = resp.status().as_u16();
    if status == 200 {
        Ok(())
    } else {
        Err(err_from(status, &resp.text().await.unwrap_or_default()))
    }
}

pub async fn pull(since: i64) -> Result<PullResponse, String> {
    let k = key().await?;
    let resp = http()
        .get(format!("{}/sync/records?since={}", base(), since))
        .bearer_auth(&k)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach sync: {}", e))?;
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    if status == 200 {
        serde_json::from_str::<PullResponse>(&body)
            .map_err(|_| "Sync returned an unreadable response.".to_string())
    } else {
        Err(err_from(status, &body))
    }
}

pub async fn push(records: &[WireRecord]) -> Result<(), String> {
    if records.is_empty() {
        return Ok(());
    }
    let k = key().await?;
    let resp = http()
        .post(format!("{}/sync/records", base()))
        .bearer_auth(&k)
        .json(&serde_json::json!({ "records": records }))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach sync: {}", e))?;
    let status = resp.status().as_u16();
    if status == 200 {
        Ok(())
    } else {
        Err(err_from(status, &resp.text().await.unwrap_or_default()))
    }
}

pub async fn reset() -> Result<(), String> {
    let k = key().await?;
    let resp = http()
        .delete(format!("{}/sync", base()))
        .bearer_auth(&k)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach sync: {}", e))?;
    let status = resp.status().as_u16();
    if status == 200 {
        Ok(())
    } else {
        Err(err_from(status, &resp.text().await.unwrap_or_default()))
    }
}
