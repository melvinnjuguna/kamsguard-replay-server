export function buildDeviceUrl(deviceUrl, path) {
  return `${deviceUrl.replace(/\/$/, "")}${path}`;
}

export function sanitizeUrlForLogging(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

export function isValidVpartPath(vpartPath) {
  if (!vpartPath || typeof vpartPath !== "string") return false;
  if (vpartPath.toLowerCase().includes("unavailable")) return false;
  if (vpartPath.toLowerCase().includes("null")) return false;
  if (!vpartPath.includes(".")) return false;
  return true;
}

export function isValidAddress(address) {
  if (!address || typeof address !== "string") return false;
  const trimmed = address.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return true;
  const ipRegex = /^(\d{1,3}\.){3}\d{1,3}(:\d+)?$/;
  return ipRegex.test(trimmed);
}