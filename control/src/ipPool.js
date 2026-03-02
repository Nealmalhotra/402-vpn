function parseIpv4(ip) {
  const octets = ip.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  return octets;
}

export function generateIpv4PoolFrom24Cidr(cidr, startHost = 10, endHost = 250) {
  const [network, prefix] = cidr.split("/");
  if (prefix !== "24") {
    throw new Error(`Only /24 subnets are supported for v1 IP pools. Received: ${cidr}`);
  }

  const [a, b, c] = parseIpv4(network);
  const pool = [];

  for (let host = startHost; host <= endHost; host += 1) {
    pool.push(`${a}.${b}.${c}.${host}`);
  }

  return pool;
}
