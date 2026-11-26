// Qoder BYOK 本地代理 PAC（仅本机使用）
// 只把 Qoder 的 API 网关域名指到本地 MITM 代理（127.0.0.1:8788），
// 其余所有流量一律 DIRECT 直连，不影响系统其它应用。
// 撤销：sudo networksetup -setautoproxystate "<网络服务名>" off
function FindProxyForURL(url, host) {
  if (dnsDomainIs(host, "qoder.com.cn") ||
      dnsDomainIs(host, ".qoder.com.cn") ||
      dnsDomainIs(host, "qoder.sh") ||
      dnsDomainIs(host, ".qoder.sh") ||
      host === "qoder.sh" ||
      host === "qoder.com.cn") {
    return "PROXY 127.0.0.1:8788";
  }
  return "DIRECT";
}
