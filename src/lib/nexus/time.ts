export function nowUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function floorToHour(unixSeconds: number): number {
  const hourSeconds = 3600;
  return Math.floor(unixSeconds / hourSeconds) * hourSeconds;
}

export function hoursSince(
  unixSeconds: number,
  now = nowUnixSeconds(),
): number {
  return Math.max(0, (now - unixSeconds) / 3600);
}
