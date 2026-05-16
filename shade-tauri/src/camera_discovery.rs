use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use tauri::Manager;

pub(crate) async fn ccapi_host_is_online(host: &str) -> bool {
    let api = shade_io::ccapi::CCAPI::new(host);
    tokio::time::timeout(std::time::Duration::from_millis(1200), api.probe())
        .await
        .is_ok_and(|result| result)
}
pub(crate) fn ipv4_to_u32(ip: Ipv4Addr) -> u32 {
    u32::from_be_bytes(ip.octets())
}
pub(crate) fn u32_to_ipv4(value: u32) -> Ipv4Addr {
    Ipv4Addr::from(value.to_be_bytes())
}
pub(crate) fn local_ipv4_scan_ranges() -> Result<Vec<(Ipv4Addr, Ipv4Addr)>, String> {
    let mut ranges = Vec::new();
    for iface in if_addrs::get_if_addrs().map_err(|e| e.to_string())? {
        let if_addrs::IfAddr::V4(addr) = iface.addr else {
            continue;
        };
        if addr.ip.is_loopback() {
            continue;
        }
        let mask = ipv4_to_u32(addr.netmask);
        let network = ipv4_to_u32(addr.ip) & mask;
        let broadcast = network | !mask;
        if broadcast <= network + 1 {
            continue;
        }
        ranges.push((u32_to_ipv4(network + 1), u32_to_ipv4(broadcast - 1)));
    }
    ranges.sort_unstable();
    ranges.dedup();
    Ok(ranges)
}
pub(crate) async fn host_has_open_port_8080(ip: Ipv4Addr) -> bool {
    tokio::time::timeout(
        std::time::Duration::from_millis(200),
        tokio::net::TcpStream::connect(SocketAddr::new(IpAddr::V4(ip), 8080)),
    )
    .await
    .is_ok_and(|result| result.is_ok())
}
pub(crate) async fn scan_ccapi_hosts_on_local_subnets() -> Result<Vec<String>, String> {
    let semaphore = Arc::new(tokio::sync::Semaphore::new(128));
    let mut join_set = tokio::task::JoinSet::new();
    for (start, end) in local_ipv4_scan_ranges()? {
        let mut current = ipv4_to_u32(start);
        let end = ipv4_to_u32(end);
        while current <= end {
            let ip = u32_to_ipv4(current);
            let permit = semaphore
                .clone()
                .acquire_owned()
                .await
                .expect("camera discovery semaphore closed");
            join_set.spawn(async move {
                let _permit = permit;
                if !host_has_open_port_8080(ip).await {
                    return None;
                }
                let host = format!("{ip}:8080");
                if !ccapi_host_is_online(&host).await {
                    return None;
                }
                Some(host)
            });
            current += 1;
        }
    }
    let mut hosts = Vec::new();
    while let Some(result) = join_set.join_next().await {
        let host = result.map_err(|e| e.to_string())?;
        if let Some(host) = host {
            hosts.push(host);
        }
    }
    hosts.sort();
    hosts.dedup();
    Ok(hosts)
}
pub fn spawn_camera_discovery<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        let _ = app;
    }

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    tauri::async_runtime::spawn(async move {
        let mut last_hosts: Vec<String> = Vec::new();
        loop {
            let hosts = scan_ccapi_hosts_on_local_subnets()
                .await
                .expect("camera discovery scan failed");
            let mut sorted = hosts.clone();
            sorted.sort();
            app.state::<crate::CameraDiscoveryService>()
                .0
                .replace_hosts(hosts)
                .await;
            if sorted != last_hosts {
                last_hosts = sorted.clone();
                crate::channel_server::channel_from_app(&app)
                    .send(crate::ChannelMessage::CameraHostsChanged { hosts: sorted })
                    .await;
            }
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        }
    });
}
