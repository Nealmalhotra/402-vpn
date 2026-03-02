export const ACTIVE_SESSIONS_KEY = "sessions:active";
export const REGIONS_SET_KEY = "regions:all";
export const PEER_EVENT_ACK_CHANNEL = "peer_events:ack";

export function sessionKey(sessionId) {
  return `session:${sessionId}`;
}

export function regionKey(regionId) {
  return `region:${regionId}`;
}

export function regionIpPoolKey(regionId) {
  return `region:${regionId}:ip_pool`;
}

export function regionActivePeersKey(regionId) {
  return `region:${regionId}:active_peers`;
}

export function peerEventsChannel(regionId) {
  return `peer_events:${regionId}`;
}
