export async function sha256Hex16(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const digestArray = Array.from(new Uint8Array(digest));
  const hex = digestArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, 16);
}
